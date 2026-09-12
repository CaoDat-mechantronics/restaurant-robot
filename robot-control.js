(() => {
  const $ = (id) => document.getElementById(id);
  const config = window.APP_CONFIG || {};
  const navConfig = config.NAVIGATION || {};

  const controlState = {
    robot: Number($("robotSelect")?.value || config.DEFAULT_ROBOT || 1),
    pendingDelivery: null,
    dispatching: false,
    sensors: {
      ir2: false,
      ir3: false,
      ir5: false,
      has_food: false
    },
    lastSyncedHasFood: null,
    currentDispatch: null,
    orientationPermissionReady: false,
    cameraPermissionReady: false
  };

  function token() {
    return localStorage.getItem("restaurant_access_token") || "";
  }

  async function api(path, options = {}) {
    const authToken = token();
    if (!authToken) {
      throw new Error("Chưa đăng nhập backend.");
    }

    const response = await fetch(
      String(config.API_BASE_URL || "").replace(/\/+$/, "") + path,
      {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`,
          ...(options.headers || {})
        }
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        data.detail || data.message || `HTTP ${response.status}`
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] CONTROL ${message}`;
    const pre = $("debugLog");
    if (pre) {
      pre.textContent = `${pre.textContent || ""}\n${line}`.trim();
      pre.scrollTop = pre.scrollHeight;
    }
  }

  function setMessage(message, bad = false) {
    const el = $("controlMessage");
    if (!el) return;
    el.textContent = message;
    el.className = bad
      ? "control-message bad"
      : "muted control-message";
  }

  function setMqttUi(state) {
    const el = $("mqttWsState");
    if (!el) return;

    const map = {
      connected: ["Connected", "good"],
      connecting: ["Connecting", "warn"],
      reconnecting: ["Reconnecting", "warn"],
      disconnected: ["Disconnected", "bad"],
      not_configured: ["Chưa cấu hình", "warn"],
      error: ["Error", "bad"]
    };

    const [text, cls] = map[state] || [String(state), "muted"];
    el.textContent = text;
    el.className = cls;
  }

  function updateSensorUi() {
    const set = (id, active) => {
      const el = $(id);
      if (!el) return;
      el.textContent = active ? "1" : "0";
      el.className = active ? "good" : "muted";
    };

    set("ir2State", controlState.sensors.ir2);
    set("ir3State", controlState.sensors.ir3);
    set("ir5State", controlState.sensors.ir5);

    const food = $("robotFoodState");
    if (food) {
      food.textContent = controlState.sensors.has_food
        ? "CÓ MÓN"
        : "KHÔNG CÓ MÓN";
      food.className = controlState.sensors.has_food
        ? "good"
        : "muted";
    }
  }

  const orientation = new window.RobotOrientation({
    onUpdate: ({ yaw }) => {
      const el = $("yawState");
      if (el) {
        el.textContent = `${yaw.toFixed(1)}°`;
      }
    },
    onDebug: log
  });

  let navigation = null;

  const vision = new window.RobotVision({
    config: navConfig,
    onFrame: (frame) => {
      navigation?.updateVision(frame);
    },
    onQr: ({ text }) => {
      const el = $("qrState");
      if (el) {
        el.textContent = text;
      }
      navigation?.handleQr(text);
    },
    onDebug: log
  });

  const mqttBridge = new window.RobotMqttBridge({
    config,
    onState: setMqttUi,
    onSensor: (payload) => {
      const hasFood =
        payload.has_food != null
          ? Boolean(payload.has_food)
          : Boolean(payload.ir5);

      controlState.sensors = {
        ir2: Boolean(payload.ir2),
        ir3: Boolean(payload.ir3),
        ir5: Boolean(payload.ir5),
        has_food: hasFood
      };

      updateSensorUi();
      navigation?.updateSensors(controlState.sensors);

      syncHasFood(hasFood);

      if (
        controlState.pendingDelivery &&
        hasFood &&
        !controlState.dispatching
      ) {
        commitPendingDelivery();
      }
    },
    onStatus: (payload) => {
      if (payload?.type === "command_ack") {
        log(
          `ESP32 ACK command=${payload.command_id} ` +
          `table=${payload.table} line=${payload.line} stop=${payload.stop_index}`
        );
      }
    },
    onDebug: log
  });

  navigation = new window.RobotNavigation({
    config: navConfig,
    mqttBridge,
    vision,
    orientation,
    onState: ({ state, detail }) => {
      const el = $("navState");
      if (el) {
        el.textContent = detail ? `${state} · ${detail}` : state;
        el.className = state === "ERROR" ? "bad" : "good";
      }

      if (state === "ERROR") {
        setMessage(detail || "Navigation error", true);
      }
    },
    onMotor: ({ left, right }) => {
      if ($("leftMotorState")) $("leftMotorState").textContent = String(left);
      if ($("rightMotorState")) $("rightMotorState").textContent = String(right);
    },
    onDebug: log
  });

  async function syncHasFood(hasFood) {
    if (controlState.lastSyncedHasFood === hasFood) {
      return;
    }

    controlState.lastSyncedHasFood = hasFood;

    if (!token()) {
      return;
    }

    try {
      await api(
        "/robot-ai/sensor-state",
        {
          method: "POST",
          body: JSON.stringify({
            robot: controlState.robot,
            has_food: hasFood
          })
        }
      );
      log(`DB has_food=${hasFood}`);
    }
    catch (error) {
      log(`SYNC has_food error: ${error.message}`);
    }
  }

  function showPendingDelivery(result) {
    controlState.pendingDelivery = {
      item_id: Number(result.item_id),
      table_number: Number(result.table_number || result.table),
      food_name: String(result.food_name || "Món ăn"),
      route: result.route || {},
      robot: controlState.robot
    };

    const card = $("pendingDeliveryCard");
    if (card) card.hidden = false;

    const text = $("pendingDeliveryText");
    if (text) {
      const route = controlState.pendingDelivery.route;
      text.textContent =
        `${controlState.pendingDelivery.food_name} · bàn ${controlState.pendingDelivery.table_number} · ` +
        `Line ${route.line ?? "-"} · ${route.junction_turn_vi || route.junction_turn || "-"}. ` +
        `Đang chờ IR5 = 1.`;
    }

    setMessage("Đã nhận nhiệm vụ. Hãy đặt món lên robot; IR5 sẽ kích hoạt dispatch.");
    log(`PENDING ${JSON.stringify(controlState.pendingDelivery)}`);

    if (controlState.sensors.has_food && !controlState.dispatching) {
      commitPendingDelivery();
    }
  }

  async function commitPendingDelivery() {
    const pending = controlState.pendingDelivery;
    if (!pending || controlState.dispatching) {
      return;
    }

    if (!mqttBridge.connected) {
      setMessage("IR5 đã có món nhưng MQTT WebSocket chưa connected.", true);
      return;
    }

    if (!controlState.sensors.has_food) {
      return;
    }

    controlState.dispatching = true;
    setMessage("Đã có món. Đang cập nhật database và gửi task trực tiếp tới ESP32...");

    let confirmed = null;

    try {
      confirmed = await api(
        "/robot-ai/confirm-dispatch",
        {
          method: "POST",
          body: JSON.stringify({
            item_id: pending.item_id,
            table_number: pending.table_number,
            robot: pending.robot,
            has_food: true
          })
        }
      );

      const task = {
        ...(confirmed.task || {}),
        ...(confirmed.route || {}),
        command_id: confirmed.command_id,
        table: confirmed.table,
        food_name: confirmed.food_name
      };

      // ESP32 chỉ cần lưu table, line, stop_index.
      const ackPromise = mqttBridge.waitForTaskAck(
        confirmed.command_id,
        4500
      );

      mqttBridge.publishTask({
        command_id: confirmed.command_id,
        table: confirmed.table,
        line: confirmed.route.line,
        stop_index: confirmed.route.stop_index
      });

      await ackPromise;

      controlState.currentDispatch = confirmed;
      controlState.pendingDelivery = null;
      $("pendingDeliveryCard").hidden = true;

      setMessage("ESP32 đã lưu task. Đang bật camera và bắt đầu bám line.");
      await startNavigation(task);
    }
    catch (error) {
      log(`DISPATCH ERROR: ${error.message}`);
      setMessage(`Dispatch lỗi: ${error.message}`, true);
      mqttBridge.stopMotor();

      if (confirmed?.command_id) {
        try {
          await api(
            "/robot-ai/cancel-dispatch",
            {
              method: "POST",
              body: JSON.stringify({
                item_id: pending.item_id,
                robot: pending.robot,
                command_id: confirmed.command_id
              })
            }
          );
          log("Dispatch database đã rollback.");
        }
        catch (rollbackError) {
          log(`ROLLBACK ERROR: ${rollbackError.message}`);
        }
      }
    }
    finally {
      controlState.dispatching = false;
    }
  }

  async function requestOrientationPermission() {
    try {
      await orientation.requestPermission();
      orientation.start();
      controlState.orientationPermissionReady = true;
      log("Motion/orientation permission ready");
      return true;
    }
    catch (error) {
      controlState.orientationPermissionReady = false;
      setMessage(
        `Chưa có quyền gyro/orientation: ${error.message}. Hãy bấm Cho phép Gyro/Camera.`,
        true
      );
      return false;
    }
  }

  async function prepareCameraPermission() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Browser không hỗ trợ getUserMedia.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: navConfig.CAMERA_FACING_MODE || "user" }
        },
        audio: false
      });

      for (const track of stream.getTracks()) {
        track.stop();
      }

      controlState.cameraPermissionReady = true;
      log("Camera permission ready");
      return true;
    }
    catch (error) {
      controlState.cameraPermissionReady = false;
      setMessage(`Chưa có quyền camera: ${error.message}`, true);
      return false;
    }
  }

  async function preparePermissions() {
    setMessage("Đang xin quyền Gyro/Camera...");

    const orientationOk = await requestOrientationPermission();
    const cameraOk = await prepareCameraPermission();

    if (orientationOk && cameraOk) {
      setMessage("Gyro và Camera đã sẵn sàng. Có thể nhận nhiệm vụ.");
    }
  }

  async function startNavigation(task) {
    if (!controlState.orientationPermissionReady) {
      // Android thường không cần requestPermission và có thể start trực tiếp.
      orientation.start();
    }

    if (orientation.getYaw() == null) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const cameraStage = $("cameraStage");
    if (cameraStage) cameraStage.hidden = false;

    await vision.start(
      $("robotCamera"),
      $("visionOverlay")
    );

    navigation.updateSensors(controlState.sensors);
    navigation.start(task);
    setMessage("Đang LINE_FOLLOW. Camera tìm 2 vạch đen, QR và IR2/IR3 cùng hỗ trợ điều hướng.");
  }

  function stopEverything(reason = "manual") {
    try {
      navigation.stop(reason);
    } catch (_) {}

    try {
      mqttBridge.stopMotor();
    } catch (_) {}

    vision.stop();

    const cameraStage = $("cameraStage");
    if (cameraStage) cameraStage.hidden = true;

    setMessage(`Robot đã dừng (${reason}).`);
  }

  function switchRobot(robotNumber) {
    const next = Number(robotNumber) || 1;

    if (navigation.state === "LINE_FOLLOW" || navigation.state === "TURNING") {
      stopEverything("đổi robot");
    }

    controlState.robot = next;
    controlState.pendingDelivery = null;
    controlState.currentDispatch = null;
    controlState.lastSyncedHasFood = null;
    controlState.sensors = {
      ir2: false,
      ir3: false,
      ir5: false,
      has_food: false
    };
    updateSensorUi();

    mqttBridge.switchRobot(next);
    log(`CONTROL SELECT Robot ${next}`);
  }

  window.addEventListener("robot:prepare-delivery", (event) => {
    showPendingDelivery(event.detail || {});
  });

  window.addEventListener("robot:selected", (event) => {
    switchRobot(event.detail?.robot);
  });

  $("motionPermissionButton")?.addEventListener("click", preparePermissions);

  $("stopRobotButton")?.addEventListener("click", () => {
    stopEverything("nút DỪNG ROBOT");
  });

  // Trên iOS, motion permission cần user gesture. Nút Nhận lệnh là một
  // user gesture tự nhiên, nên thử xin quyền sớm ở đây.
  $("commandButton")?.addEventListener("click", () => {
    if (!controlState.orientationPermissionReady) {
      requestOrientationPermission();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // Không để robot tiếp tục chạy nếu tab bị đưa nền.
      mqttBridge.stopMotor();
    }
  });

  window.addEventListener("beforeunload", () => {
    mqttBridge.stopMotor();
    vision.stop();
    mqttBridge.close();
  });

  async function boot() {
    updateSensorUi();
    setMqttUi("connecting");

    try {
      await mqttBridge.connect(controlState.robot);
    }
    catch (error) {
      log(error.message);
      setMessage(error.message, true);
    }
  }

  boot();

  // Chỉ để debug từ Console khi chạy thử.
  window.ROBOT_CONTROL = {
    state: controlState,
    mqttBridge,
    navigation,
    vision,
    orientation,
    stop: stopEverything,
    preparePermissions
  };
})();
