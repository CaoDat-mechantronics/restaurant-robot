(() => {
  class RobotMqttBridge {
    constructor({
      config,
      onState = () => {},
      onSensor = () => {},
      onStatus = () => {},
      onDebug = () => {}
    }) {
      this.config = config || {};
      this.onState = onState;
      this.onSensor = onSensor;
      this.onStatus = onStatus;
      this.onDebug = onDebug;

      this.client = null;
      this.robot = 1;
      this.connected = false;
      this.ackWaiters = new Map();
      this.motorSeq = 0;
    }

    topic(robot, suffix) {
      return `topic${Number(robot)}/${suffix}`;
    }

    configurationReady() {
      const url = String(this.config.MQTT_WS_URL || "");
      const user = String(this.config.MQTT_USERNAME || "");
      const pass = String(this.config.MQTT_PASSWORD || "");

      return Boolean(
        url &&
        user &&
        pass &&
        !url.includes("YOUR_HIVEMQ_HOST") &&
        !user.includes("YOUR_FRONTEND_MQTT_USERNAME") &&
        !pass.includes("YOUR_FRONTEND_MQTT_PASSWORD")
      );
    }

    async connect(robotNumber = 1) {
      this.robot = Number(robotNumber) || 1;

      if (!this.configurationReady()) {
        this.onState("not_configured");
        throw new Error(
          "Chưa cấu hình MQTT_WS_URL / MQTT_USERNAME / MQTT_PASSWORD trong config.js"
        );
      }

      if (!window.mqtt) {
        this.onState("error");
        throw new Error("Không tải được MQTT.js.");
      }

      if (this.client) {
        try {
          this.client.end(true);
        } catch (_) {}
        this.client = null;
      }

      this.onState("connecting");

      const clientId =
        `robot-web-${this.robot}-` +
        Math.random().toString(16).slice(2, 10);

      this.client = window.mqtt.connect(
        this.config.MQTT_WS_URL,
        {
          clientId,
          username: this.config.MQTT_USERNAME,
          password: this.config.MQTT_PASSWORD,
          clean: true,
          reconnectPeriod: 1500,
          connectTimeout: 10000,
          keepalive: 20
        }
      );

      this.client.on("connect", () => {
        this.connected = true;
        this.onState("connected");
        this.onDebug(`MQTT WSS connected as ${clientId}`);
        this.subscribeRobotTopics();
      });

      this.client.on("reconnect", () => {
        this.connected = false;
        this.onState("reconnecting");
      });

      this.client.on("close", () => {
        this.connected = false;
        this.onState("disconnected");
      });

      this.client.on("error", (error) => {
        this.connected = false;
        this.onState("error");
        this.onDebug(`MQTT ERROR: ${error.message}`);
      });

      this.client.on("message", (topic, buffer) => {
        this.handleMessage(topic, buffer);
      });
    }

    subscribeRobotTopics() {
      if (!this.client || !this.connected) {
        return;
      }

      const topics = [
        this.topic(this.robot, "status"),
        this.topic(this.robot, "sensors")
      ];

      this.client.subscribe(topics, { qos: 0 }, (error) => {
        if (error) {
          this.onDebug(`MQTT subscribe error: ${error.message}`);
          return;
        }

        this.onDebug(`MQTT SUB ${topics.join(", ")}`);
      });
    }

    switchRobot(robotNumber) {
      const next = Number(robotNumber) || 1;
      if (next === this.robot) {
        return;
      }

      const previous = this.robot;
      this.robot = next;

      if (!this.client || !this.connected) {
        return;
      }

      this.client.unsubscribe([
        this.topic(previous, "status"),
        this.topic(previous, "sensors")
      ]);

      this.subscribeRobotTopics();
    }

    handleMessage(topic, buffer) {
      let payload;

      try {
        payload = JSON.parse(buffer.toString());
      } catch (_) {
        this.onDebug(`MQTT non-JSON ${topic}`);
        return;
      }

      if (topic.endsWith("/sensors")) {
        this.onSensor(payload, topic);
        return;
      }

      if (topic.endsWith("/status")) {
        this.onStatus(payload, topic);

        if (
          payload &&
          payload.type === "command_ack" &&
          payload.command_id
        ) {
          const key = String(payload.command_id);
          const waiter = this.ackWaiters.get(key);

          if (waiter) {
            clearTimeout(waiter.timer);
            this.ackWaiters.delete(key);
            waiter.resolve(payload);
          }
        }
      }
    }

    publishTask(task) {
      if (!this.client || !this.connected) {
        throw new Error("MQTT WebSocket chưa kết nối.");
      }

      const payload = {
        type: "delivery_task",
        command_id: String(task.command_id || ""),
        table: Number(task.table),
        line: Number(task.line),
        stop_index: Number(task.stop_index)
      };

      this.client.publish(
        this.topic(this.robot, "task"),
        JSON.stringify(payload),
        { qos: 1, retain: false }
      );

      this.onDebug(
        `MQTT PUB ${this.topic(this.robot, "task")} ${JSON.stringify(payload)}`
      );
    }

    waitForTaskAck(commandId, timeoutMs = 4000) {
      const key = String(commandId || "");
      if (!key) {
        return Promise.reject(new Error("Thiếu command_id."));
      }

      return new Promise((resolve, reject) => {
        const old = this.ackWaiters.get(key);
        if (old) {
          clearTimeout(old.timer);
          this.ackWaiters.delete(key);
        }

        const timer = window.setTimeout(() => {
          this.ackWaiters.delete(key);
          reject(new Error("ESP32 không ACK task trong thời gian cho phép."));
        }, timeoutMs);

        this.ackWaiters.set(key, {
          resolve,
          reject,
          timer
        });
      });
    }

    publishMotor(left, right) {
      if (!this.client || !this.connected) {
        return false;
      }

      const clamp = (value) =>
        Math.max(-255, Math.min(255, Math.round(Number(value) || 0)));

      const payload = {
        type: "motor",
        left: clamp(left),
        right: clamp(right),
        seq: ++this.motorSeq,
        ts: Date.now()
      };

      this.client.publish(
        this.topic(this.robot, "motor"),
        JSON.stringify(payload),
        { qos: 0, retain: false }
      );

      return true;
    }

    stopMotor() {
      this.publishMotor(0, 0);
    }

    close() {
      for (const waiter of this.ackWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("MQTT bridge đã đóng."));
      }
      this.ackWaiters.clear();

      if (this.client) {
        try {
          this.client.end(true);
        } catch (_) {}
      }

      this.client = null;
      this.connected = false;
      this.onState("disconnected");
    }
  }

  window.RobotMqttBridge = RobotMqttBridge;
})();
