(() => {
  window.ROBOT_MQTT_BUILD = "2026-10-03-frontend-alive-probe-v1";
  class RobotMqttBridge {
    constructor({
      config,
      onState = () => {},
      onSensor = () => {},
      onStatus = () => {},
      onMon = () => {},
      onReq = () => {},
      onRes = () => {},
      onRobotMessage = () => {},
      onLineSpeedReport = () => {},
      onTurnSpeedReport = () => {},
      onDebug = () => {}
    }) {
      this.config = config || {};
      this.onState = onState;
      this.onSensor = onSensor;
      this.onStatus = onStatus;
      this.onMon = onMon;
      this.onReq = onReq;
      this.onRes = onRes;
      this.onRobotMessage = onRobotMessage;
      this.onLineSpeedReport = onLineSpeedReport;
      this.onTurnSpeedReport = onTurnSpeedReport;
      this.onDebug = onDebug;

      this.client = null;
      this.robot = 1;
      this.connected = false;
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
        this.topic(this.robot, "sensors"),

        // Cảm biến món do ESP32 publish trực tiếp.
        // Payload: {"before":0|1,"current":0|1}
        "topic/mon",

        // Frontend + ESP32 cùng subscribe hai topic presence mới.
        // Frontend publish topic/req = 1 khi im lặng 30 giây.
        // ESP32 phản hồi topic/res = 1 ngay khi nhận request.
        "topic/req",
        "topic/res",
        // Tốc độ PWM đang được ESP32 dùng (topic chung, có robot_id).
        "setting/esp32_tocdo",
        "setting/esp32_quay"
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
      const raw = buffer.toString();
      let payload;

      try {
        payload = JSON.parse(raw);
      } catch (_) {
        payload = raw;
      }

      // ESP32 phản hồi profile PWM bám line mỗi 30 giây, hoặc khi GET/SET.
      if (topic === "setting/esp32_tocdo") {
        if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
            payload.type !== "actual_line_speed" ||
            payload.robot_id !== `robot${this.robot}`) return;
        this.onRobotMessage({ topic, payload, raw, receivedAt: Date.now() });
        this.onLineSpeedReport(payload, topic);
        return;
      }

      // PWM quay không được tính là tín hiệu alive để giữ nguyên giám sát cũ.
      if (topic === "setting/esp32_quay") {
        if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
            payload.type !== "actual_turn_speed" ||
            payload.robot_id !== `robot${this.robot}`) return;
        this.onTurnSpeedReport(payload, topic);
        return;
      }

      // topic/req là request do frontend publish. Vì frontend cũng subscribe
      // topic/req nên có thể nhận lại chính message của mình; TUYỆT ĐỐI không
      // được tính message này là activity của ESP32.
      if (topic === "topic/req") {
        this.onReq(payload, topic, raw);
        return;
      }

      // Các topic dưới đây là luồng robot -> frontend trong kiến trúc hiện tại.
      // Mọi message hợp lệ nhận được từ chúng đều reset bộ đếm alive.
      const robotOriginTopic =
        topic === "topic/mon" ||
        topic === "topic/res" ||
        topic.endsWith("/sensors") ||
        topic.endsWith("/status");

      if (robotOriginTopic) {
        this.onRobotMessage({
          topic,
          payload,
          raw,
          receivedAt: Date.now()
        });
      }

      if (topic === "topic/res") {
        this.onRes(payload, topic, raw);
        return;
      }

      if (topic === "topic/mon") {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          this.onDebug(`MQTT invalid MON payload ${raw}`);
          return;
        }

        this.onMon(payload, topic);
        return;
      }

      if (topic.endsWith("/sensors")) {
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          this.onSensor(payload, topic);
        }
        return;
      }

      if (topic.endsWith("/status")) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return;
        }

        this.onStatus(payload, topic);
      }
    }

    publishLineSpeedProfile(profile, seq) {
      if (!this.client || !this.connected) return false;
      const payload = {
        type: "set",
        robot_id: `robot${this.robot}`,
        base_speed: profile.base_speed,
        soft_fast_speed: profile.soft_fast_speed,
        soft_slow_speed: profile.soft_slow_speed,
        hard_fast_speed: profile.hard_fast_speed,
        hard_slow_speed: profile.hard_slow_speed,
        seq
      };
      this.client.publish("setting/tocdo", JSON.stringify(payload),
        { qos: 0, retain: false });
      return true; // Chỉ gửi lên MQTT; cần telemetry để xác nhận ESP32 đã áp dụng.
    }

    requestLineSpeedProfile() {
      if (!this.client || !this.connected) return false;
      this.client.publish("setting/tocdo",
        JSON.stringify({ type: "get", robot_id: `robot${this.robot}` }),
        { qos: 0, retain: false });
      return true;
    }

    publishTurnSpeedProfile(profile, seq) {
      if (!this.client || !this.connected) return false;
      this.client.publish("setting/quay", JSON.stringify({
        type: "set", robot_id: `robot${this.robot}`,
        forward_speed: profile.forward_speed,
        reverse_speed: profile.reverse_speed,
        seq
      }), { qos: 0, retain: false });
      return true; // Chỉ xác nhận khi ESP32 phản hồi status=applied, seq tương ứng.
    }

    requestTurnSpeedProfile() {
      if (!this.client || !this.connected) return false;
      this.client.publish("setting/quay", JSON.stringify({
        type: "get", robot_id: `robot${this.robot}`
      }), { qos: 0, retain: false });
      return true;
    }

    publishAliveRequest() {
      if (!this.client || !this.connected) {
        this.onDebug("ALIVE REQ skip: MQTT WebSocket chưa connected");
        return false;
      }

      this.client.publish(
        "topic/req",
        "1",
        {
          qos: 0,
          retain: false
        }
      );

      this.onDebug("MQTT PUB topic/req payload=1");
      return true;
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
