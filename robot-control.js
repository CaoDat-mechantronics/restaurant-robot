(() => {
  window.ROBOT_CONTROL_BUILD = "2026-10-07-food-delivery-state-machine-v26";
  const $ = (id) => document.getElementById(id);
  const config = window.APP_CONFIG || {};
  const navConfig = config.NAVIGATION || {};

  const controlState = {
    robot: Number($("robotSelect")?.value || config.DEFAULT_ROBOT || 1),
    pendingDelivery: null,
    taskReplacement: null,
    dispatching: false,
    sensors: {
      ir2: false,
      ir3: false,
      ir5: false,
      has_food: false
    },
    // Database mặc định has_food=false.
    // Frontend cũng mặc định KHÔNG CÓ MÓN cho tới khi robot gửi topic/mon.
    // Giá trị này chỉ dùng để tránh gọi API lưu trữ lặp lại.
    lastSyncedHasFood: false,
    currentDispatch: null,
    latestTask: null,
    orientationPermissionReady: false,
    cameraPermissionReady: false,
    robotStatus: "disconnected",

    // Presence mới do frontend xác định trực tiếp từ MQTT ESP32.
    // Mặc định là disconnected cho tới khi nhận được message từ robot.
    alive: "disconnected",
    lastSyncedAlive: "disconnected",
    lastRobotMessageAt: 0,
    lastRobotTopic: "",
    aliveMonitorStartedAt: 0,
    aliveNextProbeAt: 0,
    aliveProbeSentAt: 0,
    aliveMonitorTimer: null,

    cameraDebugOpen: false,

    // Điều khiển manual trong bảng Debug.
    manualTurnTimer: null,
    manualTurnToken: 0,
    manualSavedTask: null,

    // Dùng để đồng bộ task đang có ở backend với RobotNavigation local.
    navigationStarting: false,
    navigationTaskKey: null,

    // Nếu người dùng bấm DỪNG ROBOT, không tự khởi động lại đúng task đó
    // chỉ vì backend vẫn còn báo ON TASK. Task mới vẫn được phép tự resume.
    blockedResumeTaskKey: null
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

  function buildNavigationTaskKey(task) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      return null;
    }

    const hasTask = Object.keys(task).length > 0;
    if (!hasTask) {
      return null;
    }

    return [
      task.command_id ?? "",
      task.table ?? task.table_number ?? "",
      task.line ?? "",
      task.stop_index ?? "",
      task.junction_turn ?? ""
    ].join(":");
  }

  function updateCameraSwitchButton() {
    const button = $("cameraSwitchButton");
    if (!button) return;

    const facingMode = vision?.getFacingMode?.() ||
      navConfig.CAMERA_FACING_MODE ||
      "user";

    const usingRearCamera = facingMode === "environment";
    button.textContent = usingRearCamera ? "CAMERA TRƯỚC" : "CAMERA SAU";
    button.title = usingRearCamera
      ? "Chuyển sang camera trước"
      : "Chuyển sang camera sau";
  }

  // Camera debug là công cụ local của điện thoại/trình duyệt nên luôn cho phép
  // sử dụng trong Debug Mode, kể cả khi ESP32/robot đang DISCONNECTED.
  function setDebugAvailability(_isOnTask) {
    const debugButton = $("cameraDebugButton");
    if (debugButton) {
      debugButton.hidden = false;
      debugButton.disabled = false;
    }

    const switchButton = $("cameraSwitchButton");
    if (switchButton) {
      switchButton.hidden = false;
      switchButton.disabled = false;
    }

    updateCameraSwitchButton();
  }

  function openCameraDebug() {
    const panel = $("cameraDebugPanel");
    if (!panel) return;

    controlState.cameraDebugOpen = true;
    panel.classList.remove("debug-collapsed");
    panel.setAttribute("aria-hidden", "false");

    const button = $("cameraDebugButton");
    if (button) button.textContent = "ẨN DEBUG CAMERA";
  }

  function closeCameraDebug() {
    const panel = $("cameraDebugPanel");
    controlState.cameraDebugOpen = false;

    if (panel) {
      panel.classList.add("debug-collapsed");
      panel.setAttribute("aria-hidden", "true");
    }

    const button = $("cameraDebugButton");
    if (button) button.textContent = "DEBUG CAMERA";
  }

  async function ensureDebugCamera() {
    if (vision.running) {
      return true;
    }

    try {
      await vision.start(
        $("robotCamera"),
        $("visionOverlay")
      );
      controlState.cameraPermissionReady = true;
      updateCameraSwitchButton();
      return true;
    }
    catch (error) {
      setMessage(`Không mở được camera debug: ${error.message}`, true);
      log(`DEBUG CAMERA ERROR: ${error.message}`);
      return false;
    }
  }

  const ALIVE_SILENCE_BEFORE_PROBE_MS = 30000;
  const ALIVE_RESPONSE_TIMEOUT_MS = 15000;
  const ALIVE_MONITOR_TICK_MS = 1000;

  function emitAliveUiState(reason = "") {
    window.dispatchEvent(
      new CustomEvent(
        "robot:alive-local",
        {
          detail: {
            robot: controlState.robot,
            alive: controlState.alive,
            lastRobotMessageAt: controlState.lastRobotMessageAt || 0,
            lastRobotTopic: controlState.lastRobotTopic || "",
            probeSentAt: controlState.aliveProbeSentAt || 0,
            awaitingResponse: controlState.aliveProbeSentAt > 0,
            reason
          }
        }
      )
    );
  }

  async function syncAliveStateToBackend(alive) {
    const normalized =
      String(alive || "disconnected").toLowerCase() === "alive"
        ? "alive"
        : "disconnected";

    // Database mặc định disconnected. Chỉ gọi API khi frontend thấy state đổi.
    if (controlState.lastSyncedAlive === normalized) {
      return;
    }

    if (!token()) {
      log(`ALIVE DB skip: chưa đăng nhập, alive=${normalized}`);
      return;
    }

    try {
      const result = await api(
        "/robot-ai/alive-state",
        {
          method: "POST",
          body: JSON.stringify({
            robot: controlState.robot,
            alive: normalized
          })
        }
      );

      controlState.lastSyncedAlive = normalized;

      log(
        `ALIVE DB alive=${normalized}` +
        (result?.changed != null ? ` changed=${Boolean(result.changed)}` : "")
      );
    }
    catch (error) {
      log(`ALIVE DB sync error: ${error.message}`);
    }
  }

  function setLocalAlive(nextAlive, reason = "") {
    const normalized = nextAlive === "alive" ? "alive" : "disconnected";
    const previous = controlState.alive;

    controlState.alive = normalized;
    emitAliveUiState(reason);

    if (previous !== normalized) {
      log(`ALIVE ${previous} -> ${normalized} | ${reason}`);
      void syncAliveStateToBackend(normalized);
    }
  }

  function recordRobotActivity({ topic, receivedAt = Date.now() } = {}) {
    const now = Number(receivedAt) || Date.now();

    controlState.lastRobotMessageAt = now;
    controlState.lastRobotTopic = String(topic || "unknown");

    // Bất kỳ message robot -> frontend nào trong thời gian chờ response đều
    // được coi là xác nhận robot còn sống, không bắt buộc phải là topic/res.
    controlState.aliveProbeSentAt = 0;
    controlState.aliveNextProbeAt = now + ALIVE_SILENCE_BEFORE_PROBE_MS;

    setLocalAlive("alive", `RX ${controlState.lastRobotTopic}`);
  }

  function startAliveMonitor() {
    const now = Date.now();

    if (!controlState.aliveMonitorStartedAt) {
      controlState.aliveMonitorStartedAt = now;
    }

    if (!controlState.aliveNextProbeAt) {
      const anchor =
        controlState.lastRobotMessageAt ||
        controlState.aliveMonitorStartedAt;

      controlState.aliveNextProbeAt =
        anchor + ALIVE_SILENCE_BEFORE_PROBE_MS;
    }

    if (controlState.aliveMonitorTimer) {
      emitAliveUiState("MQTT connected");
      return;
    }

    controlState.aliveMonitorTimer = window.setInterval(
      serviceAliveMonitor,
      ALIVE_MONITOR_TICK_MS
    );

    emitAliveUiState("Alive monitor started");
  }

  function serviceAliveMonitor() {
    const now = Date.now();

    // Đang chờ phản hồi cho topic/req = 1.
    if (controlState.aliveProbeSentAt > 0) {
      if (
        now - controlState.aliveProbeSentAt >=
        ALIVE_RESPONSE_TIMEOUT_MS
      ) {
        controlState.aliveProbeSentAt = 0;
        controlState.aliveNextProbeAt =
          now + ALIVE_SILENCE_BEFORE_PROBE_MS;

        setLocalAlive(
          "disconnected",
          "Không nhận được message robot trong 15s sau topic/req=1"
        );
      } else {
        emitAliveUiState("Đang chờ phản hồi robot");
      }

      return;
    }

    if (
      controlState.aliveNextProbeAt > 0 &&
      now >= controlState.aliveNextProbeAt
    ) {
      // Gửi đúng 1 request cho một chu kỳ im lặng. Sau đó chờ tối đa 15 giây.
      mqttBridge.publishAliveRequest();
      controlState.aliveProbeSentAt = now;
      controlState.aliveNextProbeAt = 0;

      emitAliveUiState("Đã gửi topic/req=1");
      return;
    }

    // Chỉ để UI cập nhật tuổi của message cuối, không gọi API.
    emitAliveUiState("Alive monitor tick");
  }

  function stopAliveMonitor() {
    if (controlState.aliveMonitorTimer) {
      clearInterval(controlState.aliveMonitorTimer);
      controlState.aliveMonitorTimer = null;
    }
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

    if (state === "connected") {
      startAliveMonitor();
    }
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
    // QR-only: không còn xử lý/detect line ở frontend.
    onFrame: () => {},
    onQr: (qr) => {
      const text = String(qr?.text || "").trim();
      const areaPercent = Number(qr?.areaPercent);
      const areaPx = Number(qr?.areaPx);

      const el = $("qrState");
      if (el) {
        el.textContent = text || "-";
      }

      const debugQr = $("visionQrState");
      if (debugQr) {
        debugQr.textContent = text || "-";
      }

      const areaEl = $("visionQrAreaState");
      if (areaEl) {
        if (Number.isFinite(areaPercent) && Number.isFinite(areaPx)) {
          areaEl.textContent =
            `${areaPercent.toFixed(2)}% · ${Math.round(areaPx)} px²`;
          areaEl.className = "good";
        } else {
          areaEl.textContent = "-";
          areaEl.className = "muted";
        }
      }

      // Luồng BẮT ĐẦU chính thức dùng QR để điều khiển protocol topic/status.
      if (handleOfficialRouteQr(qr)) {
        return;
      }

      navigation?.handleQr(qr);
    },
    onDebug: log
  });

  const mqttBridge = new window.RobotMqttBridge({
    config,
    onState: setMqttUi,

    onRobotMessage: (message) => {
      recordRobotActivity(message);
    },

    onReq: (payload, topic) => {
      // Frontend cũng subscribe topic/req nên sẽ nhận lại request do chính nó
      // publish. Không được tính đây là message từ robot.
      log(`MQTT RX ${topic} payload=${JSON.stringify(payload)} (ignore for alive)`);
    },

    onRes: (payload, topic) => {
      log(`MQTT RX ${topic} payload=${JSON.stringify(payload)}`);
    },

    onSensor: (payload) => {
      // topicX/sensors chỉ còn cập nhật các cảm biến cũ.
      // Tuyệt đối không lấy has_food từ payload.has_food hoặc ir5 nữa.
      // has_food chỉ do topic/mon từ ESP32 quyết định.
      controlState.sensors = {
        ...controlState.sensors,
        ir2: Boolean(payload.ir2),
        ir3: Boolean(payload.ir3),
        ir5: Boolean(payload.ir5)
      };

      updateSensorUi();
      navigation?.updateSensors(controlState.sensors);
    },

    onMon: (payload, topic) => {
      const before = Number(payload?.before);
      const current = Number(payload?.current);

      // ESP32 chỉ được gửi 0 hoặc 1.
      if (
        ![0, 1].includes(before) ||
        ![0, 1].includes(current)
      ) {
        log(
          `MON payload không hợp lệ topic=${topic} payload=${JSON.stringify(payload)}`
        );
        return;
      }

      // Nguồn sự thật của giao diện là current do ESP32 gửi:
      //   current = 0 -> vật che cảm biến -> CÓ MÓN
      //   current = 1 -> không bị che      -> KHÔNG CÓ MÓN
      //
      // Không return khi before === current vì message khởi động có thể là:
      //   {before:1,current:1} -> KHÔNG CÓ MÓN
      //   {before:0,current:0} -> CÓ MÓN
      const hasFood = current === 0;
      const previousHasFood = controlState.sensors.has_food;

      // Cập nhật giao diện NGAY từ robot, không đọc has_food từ backend.
      controlState.sensors = {
        ...controlState.sensors,
        has_food: hasFood
      };

      updateSensorUi();
      navigation?.updateSensors(controlState.sensors);

      log(
        `MON ${before} -> ${current} | has_food=${hasFood}` +
        (previousHasFood !== hasFood ? " | UI_CHANGED" : " | UI_SAME")
      );

      // Backend chỉ là nơi lưu trữ trạng thái gần nhất.
      // Hàm này tự bỏ qua nếu trạng thái đã được sync thành công trước đó.
      // Vì lastSyncedHasFood mặc định false:
      //   startup 1->1 => không gọi API;
      //   startup 0->0 => gọi API true để lưu trạng thái có món.
      void syncFoodStateFromRobot(hasFood);

      // Luồng thay task RECEIVED TASK: phải thấy món cũ được lấy ra rồi món mới
      // được đặt vào trước khi backend thực sự thay task.
      if (controlState.taskReplacement) {
        void handleTaskReplacementSensor(previousHasFood, hasFood);
      } else if (
        controlState.pendingDelivery &&
        hasFood &&
        !controlState.dispatching
      ) {
        // Nếu đang có nhiệm vụ mới ở AVAILABLE, topic/mon current=0 là trigger
        // commit dispatch chính thức vào database.
        commitPendingDelivery();
      }

      // Chỉ transition CÓ MÓN -> KHÔNG CÓ MÓN khi đang ON TARGET mới được
      // hiểu là khách đã nhấc món khỏi robot. Chưa đánh dấu delivered ở đây.
      if (
        previousHasFood === true &&
        hasFood === false &&
        officialRouteSession.active
      ) {
        if (controlState.robotStatus === "on_target") {
          if (officialRouteSession.supportPhase === "arrival_announcement") {
            officialRouteSession.foodTakenAtTargetPending = true;
          } else {
            void handleFoodTakenAtTarget();
          }
        } else if (
          officialRouteSession.phase === "stopping_at_table" ||
          officialRouteSession.phase === "table_uturn_prepare" ||
          officialRouteSession.phase === "table_uturn"
        ) {
          officialRouteSession.foodRemovedDuringArrival = true;
        }
      }
    },

    onStatus: (payload) => {
      if (payload?.type === "motor_state") {
        const left = Number(payload.left ?? 0);
        const right = Number(payload.right ?? 0);
        const lf = Number(payload.lf ?? left);
        const lr = Number(payload.lr ?? left);
        const rf = Number(payload.rf ?? right);
        const rr = Number(payload.rr ?? right);
        const seq = Number(payload.seq ?? 0);
        const fw = String(payload.firmware_build || "unknown");

        const sideText = `L=${left} · R=${right} · seq=${seq}`;
        const motorText = `LF=${lf} · LR=${lr} · RF=${rf} · RR=${rr}`;

        if ($("appliedSideState")) $("appliedSideState").textContent = sideText;
        if ($("visionAppliedSideState")) $("visionAppliedSideState").textContent = sideText;

        if ($("appliedMotorsState")) $("appliedMotorsState").textContent = motorText;
        if ($("visionAppliedMotorsState")) $("visionAppliedMotorsState").textContent = motorText;

        if ($("firmwareBuildState")) $("firmwareBuildState").textContent = fw;
        if ($("visionFirmwareBuildState")) $("visionFirmwareBuildState").textContent = fw;

        return;
      }

      if (payload?.type === "heartbeat" && payload?.firmware_build) {
        const fw = String(payload.firmware_build);
        if ($("firmwareBuildState")) $("firmwareBuildState").textContent = fw;
        if ($("visionFirmwareBuildState")) $("visionFirmwareBuildState").textContent = fw;
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

      // Hiển thị luôn lệnh motor trong panel DEBUG CAMERA để đo thực nghiệm.
      if ($("visionMotorLeftState")) {
        $("visionMotorLeftState").textContent = String(left);
      }
      if ($("visionMotorRightState")) {
        $("visionMotorRightState").textContent = String(right);
      }
    },
    onDebug: log
  });

  async function syncFoodStateFromRobot(hasFood) {
    const normalized = Boolean(hasFood);

    // Chống gọi API lặp lại khi ESP32 gửi lại cùng trạng thái.
    if (controlState.lastSyncedHasFood === normalized) {
      return;
    }

    if (!token()) {
      log(`FOOD DB skip: chưa đăng nhập, has_food=${normalized}`);
      return;
    }

    try {
      const result = await api(
        "/robot-ai/food-state",
        {
          method: "POST",
          body: JSON.stringify({
            robot: controlState.robot,
            has_food: normalized
          })
        }
      );

      // Chỉ ghi nhận đã sync sau khi API thành công.
      // Nếu API lỗi, lần topic/mon kế tiếp cùng trạng thái vẫn có thể retry.
      controlState.lastSyncedHasFood = normalized;

      log(
        `FOOD DB has_food=${normalized}` +
        (result?.changed != null ? ` changed=${Boolean(result.changed)}` : "")
      );
    }
    catch (error) {
      log(`FOOD DB sync error: ${error.message}`);
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
        `Đang chờ cảm biến món từ ESP32.`;
    }

    setMessage("Đã nhận yêu cầu. Hãy mau đặt món lên robot; topic/mon từ ESP32 sẽ kích hoạt dispatch.");
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

    if (controlState.alive !== "alive") {
      setMessage("Hãy bật robot lên. Đang giữ yêu cầu và chờ robot ALIVE.", true);
      return;
    }

    if (!controlState.sensors.has_food) {
      return;
    }

    controlState.dispatching = true;
    setMessage("Đã có món. Đang xác nhận và lưu nhiệm vụ vào database...");

    try {
      const confirmed = await api(
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

      // Không còn truyền nội dung task xuống ESP32 và không chờ command ACK.
      // Backend + frontend giữ nhiệm vụ/route; ESP32 chỉ là tầng chấp hành
      // và nhận lệnh tức thời qua topic/status.
      controlState.currentDispatch = confirmed;
      controlState.robotStatus = "received_task";
      setDebugAvailability(true);
      controlState.pendingDelivery = null;
      $("pendingDeliveryCard").hidden = true;

      controlState.latestTask = { ...task };
      controlState.navigationTaskKey = buildNavigationTaskKey(task);
      controlState.blockedResumeTaskKey = null;

      setMessage(
        "Nhiệm vụ đã được lưu. Trạng thái RECEIVED TASK; nhấn BẮT ĐẦU để thực thi."
      );
    }
    catch (error) {
      log(`DISPATCH ERROR: ${error.message}`);
      setMessage(`Dispatch lỗi: ${error.message}`, true);
    }
    finally {
      controlState.dispatching = false;
    }
  }

  function beginTaskReplacement(result) {
    const oldTask = result?.old_task && typeof result.old_task === "object"
      ? { ...result.old_task }
      : null;

    if (!oldTask?.command_id) {
      setMessage("Không thể thay task: thiếu task cũ/command_id.", true);
      return;
    }

    controlState.pendingDelivery = null;
    controlState.taskReplacement = {
      old_task: oldTask,
      old_command_id: String(oldTask.command_id),
      item_id: Number(result.item_id),
      table_number: Number(result.table_number || result.table),
      food_name: String(result.food_name || "Món mới"),
      route: result.route || {},
      phase: controlState.sensors.has_food
        ? "waiting_remove_old_food"
        : "waiting_new_food",
      committing: false
    };

    const replacement = controlState.taskReplacement;
    // Prompt ban đầu do chính turn tool-response của Gemini nói (field prompt
    // trong prepare_task_replacement) để tránh hai câu nói chồng lên nhau.
    // Các prompt tiếp theo sau thay đổi cảm biến vẫn do frontend phát tự động.
    if (replacement.phase === "waiting_remove_old_food") {
      setMessage("Đang thay task: chờ lấy món cũ khỏi robot.");
    } else {
      setMessage("Đang thay task: chờ đặt món mới lên robot.");
    }
  }

  async function handleTaskReplacementSensor(previousHasFood, hasFood) {
    const replacement = controlState.taskReplacement;
    if (!replacement || replacement.committing) return;

    if (
      replacement.phase === "waiting_remove_old_food" &&
      previousHasFood === true &&
      hasFood === false
    ) {
      replacement.phase = "waiting_new_food";
      requestRobotSpeech(
        `Vâng ạ, bây giờ hãy đặt món ${replacement.food_name} của bàn ${replacement.table_number} lên robot ạ.`,
        "replace_add_new_food",
        false
      );
      setMessage("Đã lấy món cũ ra. Đang chờ món mới được đặt lên robot.");
      return;
    }

    if (
      replacement.phase === "waiting_new_food" &&
      hasFood === true
    ) {
      await commitTaskReplacement();
    }
  }

  async function commitTaskReplacement() {
    const replacement = controlState.taskReplacement;
    if (!replacement || replacement.committing || !controlState.sensors.has_food) return;

    if (controlState.alive !== "alive") {
      setMessage("Chưa thể thay task: hãy bật robot lên và chờ trạng thái ALIVE.", true);
      return;
    }

    replacement.committing = true;
    setMessage("Đã có món mới. Đang thay nhiệm vụ trong database...");

    try {
      const result = await api(
        "/robot-ai/replace-dispatch",
        {
          method: "POST",
          body: JSON.stringify({
            robot: controlState.robot,
            old_command_id: replacement.old_command_id,
            new_item_id: replacement.item_id,
            new_table_number: replacement.table_number,
            has_food: true
          })
        }
      );

      const task = {
        ...(result.task || {}),
        ...(result.route || {}),
        command_id: result.command_id,
        table: result.table,
        food_name: result.food_name
      };

      controlState.currentDispatch = result;
      controlState.latestTask = { ...task };
      controlState.navigationTaskKey = buildNavigationTaskKey(task);
      controlState.blockedResumeTaskKey = null;
      controlState.robotStatus = "received_task";
      controlState.taskReplacement = null;

      setMessage(
        `Đã thay task thành ${task.food_name || "món mới"} → bàn ${task.table || "-"}. ` +
        "Robot đang RECEIVED TASK."
      );
      requestRobotSpeech(
        "Vâng ạ, em đã sẵn sàng. Hãy bấm Bắt đầu hoặc ra lệnh giao món đi ạ.",
        "replacement_ready",
        false
      );
      window.dispatchEvent(new CustomEvent("robot:refresh-status"));
    } catch (error) {
      replacement.committing = false;
      replacement.phase = "error";
      setMessage(`Thay task lỗi: ${error.message}`, true);
      log(`REPLACE TASK ERROR: ${error.message}`);
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

    // Camera luôn chạy để điều hướng, nhưng hình debug chỉ hiện khi
    // người dùng bấm DEBUG CAMERA trong trạng thái ON TASK.
    await vision.start(
      $("robotCamera"),
      $("visionOverlay")
    );
    updateCameraSwitchButton();

    navigation.updateSensors(controlState.sensors);
    navigation.start(task);
    setMessage("Đang PATH_FOLLOW. Điểm hồng quyết định hướng cua; QR ban_<bàn> dùng để dừng tại bàn, QR nga_re dùng để rẽ 90°; IR2/IR3 vẫn bảo vệ biên.");
  }

  async function resumeNavigationFromRobotStatus(robotData) {
    const task = robotData?.tasks;
    const taskKey = buildNavigationTaskKey(task);

    // Backend chưa có task thực sự.
    if (!taskKey) {
      return;
    }

    // Đang dispatch ngay trên frontend này thì để commitPendingDelivery()
    // hoàn thành luồng ACK + startNavigation(), tránh start trùng.
    if (controlState.dispatching) {
      return;
    }

    // Đã có một lần resume/start đang chạy.
    if (controlState.navigationStarting) {
      return;
    }

    // Người dùng vừa bấm DỪNG ROBOT cho đúng task này.
    // Không được tự chạy lại chỉ vì backend vẫn ON TASK.
    if (controlState.blockedResumeTaskKey === taskKey) {
      log(`AUTO RESUME BLOCKED task=${taskKey}`);
      return;
    }

    const navigationAlreadyRunning =
      controlState.navigationTaskKey === taskKey &&
      navigation.state !== "IDLE" &&
      navigation.state !== "STOPPED" &&
      navigation.state !== "ERROR";

    if (navigationAlreadyRunning) {
      return;
    }

    controlState.navigationStarting = true;

    try {
      controlState.currentDispatch = {
        task,
        route: task,
        restored_from_status: true
      };

      setMessage(
        `Phát hiện task đang chạy: bàn ${task.table ?? task.table_number ?? "-"} · ` +
        `Line ${task.line ?? "-"}. Đang khôi phục điều hướng...`
      );

      log(`RESUME NAVIGATION FROM STATUS ${JSON.stringify(task)}`);

      await startNavigation(task);

      controlState.navigationTaskKey = taskKey;
      controlState.blockedResumeTaskKey = null;

      log(`RESUME NAVIGATION OK task=${taskKey}`);
    }
    catch (error) {
      log(`RESUME NAVIGATION ERROR: ${error.message}`);

      setMessage(
        `Backend đang ON TASK nhưng chưa khởi động được navigation: ${error.message}`,
        true
      );
    }
    finally {
      controlState.navigationStarting = false;
    }
  }

  function setManualControlState(message, cls = "") {
    const el = $("manualControlState");
    if (!el) return;
    el.textContent = message;
    el.className = `manual-control-state${cls ? ` ${cls}` : ""}`;
  }

  function formatManualAngle(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0°";
    const rounded = Math.round(num * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}°`;
  }

  function setManualAngleDisplay(target = 0, current = 0) {
    const targetEl = $("manualTargetAngleDisplay");
    const currentEl = $("manualCurrentAngleDisplay");
    if (targetEl) targetEl.textContent = formatManualAngle(target);
    if (currentEl) currentEl.textContent = formatManualAngle(current);
  }

  // =========================================================
  // DEBUG CONTROL PROTOCOL - theo web_2.zip
  // topic/status:
  //   0 = STOP
  //   1 = QUAY TRÁI
  //   2 = QUAY PHẢI
  //   3 = BÁM LINE
  //   4 = RẼ TRÁI
  //   5 = RẼ PHẢI
  // =========================================================

  const DEBUG_STATUS_TOPIC = "topic/status";
  const DEBUG_COMMAND = Object.freeze({
    STOP: "0",
    TURN_LEFT: "1",
    TURN_RIGHT: "2",
    LINE_FOLLOW: "3",
    STEER_LEFT: "4",
    STEER_RIGHT: "5"
  });

  // =========================================================
  // LUỒNG NHIỆM VỤ CHÍNH THỨC
  //
  // BẮT ĐẦU:
  //   - mở camera sau
  //   - gửi "3" để ESP32 bám line
  //   - nếu gặp QR nga_re: STOP -> quay trái/phải 1/2 theo route + turnAngle
  //   - đạt góc: STOP -> gửi lại "3"
  //   - QR chỉ kích hoạt hành động khi areaPercent >= QR_ACTION_MIN_AREA_PERCENT
  //   - gặp QR ban_<table>: STOP -> quay đầu bằng uTurnAngle theo hướng ngược hướng rẽ -> STOP
  // =========================================================

  // Snapshot tạm của nhiệm vụ được lấy trực tiếp từ backend khi bấm BẮT ĐẦU.
  // Không phụ thuộc trạng thái robot là on_task hay disconnected; chỉ cần backend
  // còn trả về object tasks cho robot đang chọn.
  const OFFICIAL_TASK_STORAGE_KEY = "robot_task_temp";

  function isNonEmptyObject(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    );
  }

  function saveOfficialTaskTemp(task, robotData = null) {
    if (!isNonEmptyObject(task)) return null;

    const snapshot = {
      robot: Number(controlState.robot) || 1,
      fetchedAt: new Date().toISOString(),
      table: task.table ?? task.table_number ?? null,
      line: task.line ?? null,
      stop_index: task.stop_index ?? null,
      junction_turn: task.junction_turn ?? null,
      junction_turn_vi: task.junction_turn_vi ?? null,
      food_name: task.food_name ?? null,
      command_id: task.command_id ?? null,
      robot_status: robotData?.status ?? controlState.robotStatus ?? null,
      task: { ...task }
    };

    try {
      localStorage.setItem(OFFICIAL_TASK_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      log(`OFFICIAL TASK localStorage SAVE ERROR: ${error?.message || error}`);
    }

    return snapshot;
  }

  function readOfficialTaskTemp() {
    try {
      const raw = localStorage.getItem(OFFICIAL_TASK_STORAGE_KEY);
      if (!raw) return null;
      const snapshot = JSON.parse(raw);
      if (!snapshot || Number(snapshot.robot) !== Number(controlState.robot)) return null;
      return snapshot;
    } catch (_) {
      return null;
    }
  }

  async function fetchAndCacheOfficialTask() {
    const data = await api("/robot-ai/status");
    const robotNumber = Number(controlState.robot) || 1;
    const robots = data?.robots || {};
    const robotData =
      robots[`robot_${robotNumber}`] ||
      robots[String(robotNumber)] ||
      null;

    const task = robotData?.tasks;
    if (!isNonEmptyObject(task)) {
      throw new Error(`Backend chưa trả về nhiệm vụ cho Robot ${robotNumber}.`);
    }

    controlState.latestTask = { ...task };
    controlState.currentDispatch = {
      task: { ...task },
      route: { ...task },
      restored_from_status: true,
      fetched_on_start: true
    };
    controlState.navigationTaskKey = buildNavigationTaskKey(task);

    const snapshot = saveOfficialTaskTemp(task, robotData);
    log(
      `OFFICIAL TASK FETCH robot=${robotNumber} ` +
      `table=${task.table ?? task.table_number ?? "-"} ` +
      `turn=${task.junction_turn ?? task.junction_turn_vi ?? "-"}`
    );
    return snapshot;
  }

  const officialRouteSession = {
    active: false,
    mode: "outbound",
    phase: "idle",
    token: 0,
    task: null,
    targetTable: 0,
    targetTableQr: "",
    waitingStationQr: "waiting_station_left",
    turnDirection: null,
    turnAngle: 90,
    uTurnAngle: 180,
    junctionHandled: false,
    tableStopSent: false,
    waitingStationHandled: false,
    startYaw: null,
    previousYaw: null,
    angleTurned: 0,
    turnTimer: null,
    supportTimer: null,
    supportPhase: "idle",
    foodRemovedDuringArrival: false,
    foodTakenAtTargetPending: false,
    finalizing: false
  };

  function normalizeRouteTurn(value) {
    const raw = String(value || "").trim();
    const plain = raw
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();

    if (plain.includes("LEFT") || plain.includes("TRAI")) return "LEFT";
    if (plain.includes("RIGHT") || plain.includes("PHAI")) return "RIGHT";
    return null;
  }

  function oppositeDirection(direction) {
    return direction === "LEFT"
      ? "RIGHT"
      : direction === "RIGHT"
        ? "LEFT"
        : null;
  }

  function readOfficialTurnAngle() {
    try {
      const raw = localStorage.getItem("robot_setting_official");
      const saved = raw ? JSON.parse(raw) : null;
      const angle = Number(saved?.turnAngle);
      if (Number.isFinite(angle)) {
        return Math.max(1, Math.min(180, angle));
      }
    } catch (_) {}
    return 90;
  }

  function readOfficialUTurnAngle() {
    try {
      const raw = localStorage.getItem("robot_setting_official");
      const saved = raw ? JSON.parse(raw) : null;
      const angle = Number(saved?.uTurnAngle);
      if (Number.isFinite(angle)) {
        return Math.max(1, Math.min(360, angle));
      }
    } catch (_) {}
    return 180;
  }

  // Ngưỡng QR lấy ưu tiên từ localStorage (robot_setting_official).
  function getQrActionMinAreaPercent() {
    const configValue = Number(navConfig.QR_ACTION_MIN_AREA_PERCENT);
    const fallback = Number.isFinite(configValue) && configValue >= 0
      ? configValue
      : 2.1;

    try {
      const raw = localStorage.getItem("robot_setting_official");
      const saved = raw ? JSON.parse(raw) : null;
      const storedValue = Number(saved?.qrActionMinAreaPercent);
      if (Number.isFinite(storedValue) && storedValue >= 0) {
        return Math.min(100, storedValue);
      }
    } catch (_) {}

    return fallback;
  }

  function parseTableNumber(value) {
    const direct = Number(value);
    if (Number.isFinite(direct) && direct > 0) return Math.round(direct);

    const match = String(value || "").match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  }

  function getOfficialRouteInfo(taskSnapshot = null) {
    const stored = taskSnapshot || readOfficialTaskTemp() || {};
    const storedTask = isNonEmptyObject(stored?.task) ? stored.task : stored;
    const dispatch = controlState.currentDispatch || {};
    const statusTask = controlState.latestTask || {};
    const navTask = navigation?.task || {};
    const route = dispatch.route || dispatch.task || {};

    const table =
      parseTableNumber(storedTask.table) ||
      parseTableNumber(storedTask.table_number) ||
      parseTableNumber(stored.table) ||
      parseTableNumber(statusTask.table) ||
      parseTableNumber(statusTask.table_number) ||
      parseTableNumber(dispatch.table) ||
      parseTableNumber(route.table) ||
      parseTableNumber(route.table_number) ||
      parseTableNumber(navTask.table) ||
      parseTableNumber(navTask.table_number) ||
      parseTableNumber($("robotTaskTable")?.textContent) ||
      parseTableNumber($("routeTable")?.textContent);

    const turnRaw =
      storedTask.junction_turn ??
      storedTask.junction_turn_vi ??
      stored.junction_turn ??
      stored.junction_turn_vi ??
      statusTask.junction_turn ??
      statusTask.junction_turn_vi ??
      route.junction_turn ??
      route.junction_turn_vi ??
      navTask.junction_turn ??
      navTask.junction_turn_vi ??
      $("robotTaskTurn")?.textContent ??
      $("routeTurn")?.textContent ??
      "";

    return {
      table,
      turnDirection: normalizeRouteTurn(turnRaw),
      turnRaw: String(turnRaw || ""),
      turnAngle: readOfficialTurnAngle(),
      uTurnAngle: readOfficialUTurnAngle(),
      task: { ...storedTask }
    };
  }

  function setOfficialStartButtonState(running, label = null) {
    const button = $("robotStartButton");
    if (!button) return;

    button.disabled = Boolean(running);
    button.classList.toggle("active", Boolean(running));

    const strong = button.querySelector("strong");
    const small = button.querySelector("small");

    if (strong) strong.textContent = running ? "ĐANG CHẠY" : "BẮT ĐẦU";
    if (small) {
      small.textContent = label || (running ? "Đang theo dõi QR" : "Chạy nhiệm vụ");
    }
  }

  function clearOfficialTurnTimer() {
    if (officialRouteSession.turnTimer) {
      clearInterval(officialRouteSession.turnTimer);
      officialRouteSession.turnTimer = null;
    }
  }

  function clearOfficialSupportTimer() {
    if (officialRouteSession.supportTimer) {
      clearTimeout(officialRouteSession.supportTimer);
      officialRouteSession.supportTimer = null;
    }
  }

  function resetOfficialRouteSession({ keepButtonMessage = false } = {}) {
    clearOfficialTurnTimer();
    clearOfficialSupportTimer();
    officialRouteSession.active = false;
    officialRouteSession.mode = "outbound";
    officialRouteSession.phase = "idle";
    officialRouteSession.token += 1;
    officialRouteSession.task = null;
    officialRouteSession.targetTable = 0;
    officialRouteSession.targetTableQr = "";
    officialRouteSession.waitingStationQr = "waiting_station_left";
    officialRouteSession.turnDirection = null;
    officialRouteSession.turnAngle = 90;
    officialRouteSession.uTurnAngle = 180;
    officialRouteSession.junctionHandled = false;
    officialRouteSession.tableStopSent = false;
    officialRouteSession.waitingStationHandled = false;
    officialRouteSession.startYaw = null;
    officialRouteSession.previousYaw = null;
    officialRouteSession.angleTurned = 0;
    officialRouteSession.supportPhase = "idle";
    officialRouteSession.foodRemovedDuringArrival = false;
    officialRouteSession.foodTakenAtTargetPending = false;
    officialRouteSession.finalizing = false;
    setOfficialStartButtonState(false, keepButtonMessage ? "Đã hoàn tất" : null);
  }

  function publishStatusCommandAsync(command) {
    return new Promise((resolve, reject) => {
      try {
        publishDebugStatusCommand(command, (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function requestRobotSpeech(text, tag, listen = false) {
    window.dispatchEvent(
      new CustomEvent("robot:speak-request", {
        detail: {
          text: String(text || ""),
          tag: String(tag || ""),
          listen: Boolean(listen)
        }
      })
    );
  }

  async function updateOfficialWorkStatus(status) {
    const result = await api(
      "/robot-ai/work-status",
      {
        method: "POST",
        body: JSON.stringify({
          robot: controlState.robot,
          status
        })
      }
    );
    controlState.robotStatus = status;
    window.dispatchEvent(new CustomEvent("robot:refresh-status"));
    return result;
  }

  async function ensureRearCameraRunning() {
    if (vision.getFacingMode?.() !== "environment") {
      const facing = await vision.switchCamera();
      if (facing !== "environment") {
        throw new Error("Không chuyển được sang camera sau.");
      }
    }

    if (!vision.running) {
      await vision.start($("robotCamera"), $("visionOverlay"));
    }

    updateCameraSwitchButton();
    controlState.cameraPermissionReady = true;
  }

  async function rotateOfficialByGyro(direction, targetAngle, phaseName, label) {
    if (!officialRouteSession.active) {
      throw new Error("Phiên điều hướng đã kết thúc.");
    }
    if (direction !== "LEFT" && direction !== "RIGHT") {
      throw new Error("Không xác định được chiều quay.");
    }

    const sessionToken = officialRouteSession.token;
    const startYaw = await waitForYaw(2200);
    if (startYaw == null) {
      throw new Error("Không đọc được gyroscope để lấy góc bắt đầu.");
    }
    if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) {
      throw new Error("Phiên điều hướng đã thay đổi.");
    }

    officialRouteSession.startYaw = Number(startYaw);
    officialRouteSession.previousYaw = Number(startYaw);
    officialRouteSession.angleTurned = 0;
    officialRouteSession.phase = phaseName;

    const turnCommand = direction === "LEFT"
      ? DEBUG_COMMAND.TURN_LEFT
      : DEBUG_COMMAND.TURN_RIGHT;

    await publishStatusCommandAsync(turnCommand);
    if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) {
      throw new Error("Phiên điều hướng đã thay đổi.");
    }

    log(
      `OFFICIAL ROTATE START phase=${phaseName} direction=${direction} ` +
      `command=${turnCommand} target=${targetAngle} startYaw=${Number(startYaw).toFixed(1)}`
    );

    const startedAt = performance.now();
    const timeoutMs = Math.max(15000, Number(targetAngle) * 350);

    return await new Promise((resolve, reject) => {
      clearOfficialTurnTimer();
      officialRouteSession.turnTimer = window.setInterval(async () => {
        if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) {
          clearOfficialTurnTimer();
          reject(new Error("Phiên điều hướng đã kết thúc trong lúc quay."));
          return;
        }
        if (officialRouteSession.phase !== phaseName) return;

        const yaw = orientation.getYaw();
        if (yaw == null || officialRouteSession.previousYaw == null) return;

        const delta = window.RobotOrientation.deltaDegrees(
          Number(yaw),
          Number(officialRouteSession.previousYaw)
        );
        officialRouteSession.previousYaw = Number(yaw);

        const deltaAbs = Math.abs(Number(delta) || 0);
        if (deltaAbs >= 0.08 && deltaAbs <= 45) {
          officialRouteSession.angleTurned += deltaAbs;
        }

        const turned = officialRouteSession.angleTurned;
        setMessage(
          `${label}: ${turned.toFixed(1)}/${Number(targetAngle).toFixed(0)}°.`
        );

        if (turned >= targetAngle) {
          clearOfficialTurnTimer();
          try {
            await publishStatusCommandAsync(DEBUG_COMMAND.STOP);
            resolve(turned);
          } catch (error) {
            reject(error);
          }
          return;
        }

        if (performance.now() - startedAt > timeoutMs) {
          clearOfficialTurnTimer();
          try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
          reject(
            new Error(
              `Timeout góc quay ${turned.toFixed(1)}/${Number(targetAngle).toFixed(0)}°. Robot đã STOP.`
            )
          );
        }
      }, 50);
    });
  }

  async function runOfficialJunctionTurn() {
    if (!officialRouteSession.active) return;

    const originalDirection = officialRouteSession.turnDirection;
    const direction = officialRouteSession.mode === "home"
      ? oppositeDirection(originalDirection)
      : originalDirection;
    const targetAngle = officialRouteSession.turnAngle;

    if (!direction) {
      setMessage("Đã gặp QR nga_re nhưng task thiếu hướng rẽ. Robot giữ STOP.", true);
      try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
      return;
    }

    officialRouteSession.phase = "junction_stop";

    try {
      await publishStatusCommandAsync(DEBUG_COMMAND.STOP);
      setMessage(
        `Đã thấy nga_re. Chuẩn bị quay ${direction === "LEFT" ? "trái" : "phải"} ${targetAngle}° ` +
        `(${officialRouteSession.mode === "home" ? "chiều về" : "chiều đi"}).`
      );

      await rotateOfficialByGyro(
        direction,
        targetAngle,
        "turning",
        `Đang quay ${direction === "LEFT" ? "trái" : "phải"}`
      );

      await new Promise((resolve) => setTimeout(resolve, 120));
      await publishStatusCommandAsync(DEBUG_COMMAND.LINE_FOLLOW);

      officialRouteSession.phase = "line_follow";
      if (officialRouteSession.mode === "home") {
        setOfficialStartButtonState(true, `Đang tìm ${officialRouteSession.waitingStationQr}`);
        setMessage(
          `Đã rẽ chiều về. Tiếp tục bám line và chờ QR ${officialRouteSession.waitingStationQr}.`
        );
      } else {
        setOfficialStartButtonState(true, `Đang tìm ban_${officialRouteSession.targetTable}`);
        setMessage(
          `Đã rẽ xong. Tiếp tục bám line và chờ QR ban_${officialRouteSession.targetTable}.`
        );
      }
    } catch (error) {
      officialRouteSession.phase = "error";
      try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
      setMessage(`Không thể xử lý ngã rẽ: ${error.message}`, true);
      setOfficialStartButtonState(true, "Lỗi ngã rẽ");
    }
  }

  async function stopOfficialRouteAtTable(qrText) {
    if (
      !officialRouteSession.active ||
      officialRouteSession.mode !== "outbound" ||
      officialRouteSession.tableStopSent
    ) return;

    officialRouteSession.tableStopSent = true;
    officialRouteSession.phase = "stopping_at_table";
    const table = officialRouteSession.targetTable;
    const uTurnDirection = oppositeDirection(officialRouteSession.turnDirection);

    try {
      await publishStatusCommandAsync(DEBUG_COMMAND.STOP);
      log(`OFFICIAL ROUTE TABLE STOP qr=${qrText} table=${table}`);

      if (!uTurnDirection) {
        throw new Error("Task không có junction_turn để xác định chiều quay đầu tại bàn.");
      }

      officialRouteSession.phase = "table_uturn_prepare";
      const turned = await rotateOfficialByGyro(
        uTurnDirection,
        officialRouteSession.uTurnAngle,
        "table_uturn",
        `Đang quay đầu tại bàn ${uTurnDirection === "LEFT" ? "trái" : "phải"}`
      );

      log(
        `OFFICIAL TABLE UTURN DONE table=${table} direction=${uTurnDirection} ` +
        `angle=${turned.toFixed(1)}`
      );

      try { vision.stop(); } catch (_) {}
      await updateOfficialWorkStatus("on_target");
      officialRouteSession.phase = "on_target_wait_food";
      officialRouteSession.supportPhase = "arrival_announcement";
      officialRouteSession.foodTakenAtTargetPending = false;
      setOfficialStartButtonState(true, "Đang giao món tại bàn");
      setMessage(`Đã đến bàn ${table}, quay đầu xong và đang ON TARGET.`);

      const task = officialRouteSession.task || {};
      requestRobotSpeech(
        `Xin gửi tới quý khách bàn số ${table} món ${task.food_name || "của quý khách"} ạ.`,
        "arrived_target",
        true
      );

      if (officialRouteSession.foodRemovedDuringArrival) {
        officialRouteSession.foodRemovedDuringArrival = false;
        officialRouteSession.foodTakenAtTargetPending = true;
      }
    } catch (error) {
      officialRouteSession.tableStopSent = false;
      officialRouteSession.phase = "error";
      try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
      setMessage(`Xử lý tại bàn lỗi: ${error.message}`, true);
      setOfficialStartButtonState(true, "Lỗi tại bàn");
    }
  }

  function startTableSupportTimer() {
    clearOfficialSupportTimer();
    if (
      !officialRouteSession.active ||
      controlState.robotStatus !== "on_target"
    ) return;

    officialRouteSession.supportPhase = "waiting_customer";
    officialRouteSession.supportTimer = window.setTimeout(() => {
      officialRouteSession.supportTimer = null;
      void endTableSupport("timeout_10s");
    }, 10000);
    setMessage("Khách đã lấy món. Đang chờ yêu cầu hỗ trợ thêm trong 10 giây...");
  }

  async function handleFoodTakenAtTarget() {
    if (
      !officialRouteSession.active ||
      controlState.robotStatus !== "on_target" ||
      officialRouteSession.supportPhase !== "idle"
    ) return;

    officialRouteSession.supportPhase = "prompting_support";
    requestRobotSpeech(
      "Nếu quý khách cần hỗ trợ thêm gì hãy nhấn nút hỗ trợ hoặc cho em biết ạ.",
      "table_support_invite",
      true
    );
  }

  async function endTableSupport(reason = "no_more_help") {
    if (
      !officialRouteSession.active ||
      controlState.robotStatus !== "on_target" ||
      ["farewell", "starting_home", "home"].includes(officialRouteSession.supportPhase)
    ) return;

    clearOfficialSupportTimer();
    officialRouteSession.supportPhase = "farewell";
    log(`TABLE SUPPORT END reason=${reason}`);
    requestRobotSpeech(
      "Nếu quý khách không có yêu cầu hỗ trợ gì thêm, em xin phép, chúc quý khách ngon miệng ạ.",
      "table_support_farewell",
      false
    );
  }

  async function beginReturnHome() {
    if (!officialRouteSession.active) return;
    if (controlState.robotStatus !== "on_target") return;

    officialRouteSession.supportPhase = "starting_home";
    clearOfficialSupportTimer();

    // Lời chào tại bàn đã phát xong. Tắt mic Live khi robot bắt đầu chạy về
    // để tránh tiếng động cơ/nhà hàng tạo thêm turn ngoài ý muốn. Wake phrase
    // được app bật lại nên quản lý vẫn có thể gọi robot khi cần.
    window.dispatchEvent(new CustomEvent("robot:stop-gemini-mic"));

    try {
      await updateOfficialWorkStatus("on_home");
      officialRouteSession.mode = "home";
      officialRouteSession.phase = "starting_home";
      officialRouteSession.junctionHandled = false;
      officialRouteSession.waitingStationHandled = false;

      await ensureRearCameraRunning();
      await publishStatusCommandAsync(DEBUG_COMMAND.LINE_FOLLOW);

      officialRouteSession.phase = "line_follow";
      officialRouteSession.supportPhase = "home";
      setOfficialStartButtonState(true, "Đang trở về vị trí chờ");
      setMessage(
        `Robot đang ON HOME, bám line trở về. Chờ QR nga_re rồi ${officialRouteSession.waitingStationQr}.`
      );
    } catch (error) {
      try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
      officialRouteSession.phase = "error";
      setMessage(`Không thể bắt đầu hành trình trở về: ${error.message}`, true);
    }
  }

  async function stopOfficialRouteAtWaitingStation(qrText) {
    if (
      !officialRouteSession.active ||
      officialRouteSession.mode !== "home" ||
      officialRouteSession.waitingStationHandled
    ) return;

    officialRouteSession.waitingStationHandled = true;
    officialRouteSession.phase = "waiting_station_stop";

    // Theo đặc tả: tại station quay cùng hướng junction_turn gốc.
    const stationUTurnDirection = officialRouteSession.turnDirection;

    try {
      await publishStatusCommandAsync(DEBUG_COMMAND.STOP);
      if (!stationUTurnDirection) {
        throw new Error("Task thiếu junction_turn để quay đầu tại waiting station.");
      }

      officialRouteSession.phase = "waiting_station_uturn_prepare";
      const turned = await rotateOfficialByGyro(
        stationUTurnDirection,
        officialRouteSession.uTurnAngle,
        "waiting_station_uturn",
        `Đang quay đầu tại station ${stationUTurnDirection === "LEFT" ? "trái" : "phải"}`
      );

      log(
        `OFFICIAL WAITING STATION UTURN DONE qr=${qrText} ` +
        `direction=${stationUTurnDirection} angle=${turned.toFixed(1)}`
      );
      try { vision.stop(); } catch (_) {}
      officialRouteSession.phase = "waiting_station_complete";
      setOfficialStartButtonState(true, "Đã về vị trí chờ");

      const task = officialRouteSession.task || {};
      requestRobotSpeech(
        `Thưa quản lý, em đã hoàn thành giao món ${task.food_name || ""} đến bàn ${task.table || officialRouteSession.targetTable}`,
        "delivery_complete_manager",
        false
      );
    } catch (error) {
      try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
      officialRouteSession.phase = "error";
      setMessage(`Xử lý waiting station lỗi: ${error.message}`, true);
    }
  }

  async function finalizeCompletedDelivery() {
    if (
      !officialRouteSession.active ||
      officialRouteSession.finalizing ||
      officialRouteSession.phase !== "waiting_station_complete"
    ) return;

    const task = { ...(officialRouteSession.task || {}) };
    const itemId = Number(task.item_id);
    const commandId = String(task.command_id || "").trim();

    if (!Number.isFinite(itemId) || itemId <= 0 || !commandId) {
      setMessage("Không thể hoàn tất: task thiếu item_id hoặc command_id.", true);
      return;
    }

    officialRouteSession.finalizing = true;
    setMessage("Đang cập nhật món từ ĐANG GIAO → ĐÃ GIAO...");

    try {
      // Bắt buộc update món trước, nhưng giữ task robot cho tới API complete-task.
      await api(
        `/order-items/${itemId}/delivered`,
        {
          method: "PATCH",
          body: JSON.stringify({
            delivered: true,
            keep_robot_task: true
          })
        }
      );

      setMessage("Món đã được cập nhật ĐÃ GIAO. Đang xóa task và đưa robot về AVAILABLE...");

      await api(
        "/robot-ai/complete-task",
        {
          method: "POST",
          body: JSON.stringify({
            robot: controlState.robot,
            command_id: commandId,
            item_id: itemId
          })
        }
      );

      controlState.robotStatus = "available";
      controlState.latestTask = null;
      controlState.currentDispatch = null;
      controlState.pendingDelivery = null;
      controlState.taskReplacement = null;
      controlState.navigationTaskKey = null;
      controlState.blockedResumeTaskKey = null;
      controlState.manualSavedTask = null;
      try { localStorage.removeItem(OFFICIAL_TASK_STORAGE_KEY); } catch (_) {}

      resetOfficialRouteSession({ keepButtonMessage: true });
      setMessage("Giao món hoàn tất. Robot AVAILABLE và task đã được xóa.");
      window.dispatchEvent(new CustomEvent("robot:refresh-status"));
    } catch (error) {
      officialRouteSession.finalizing = false;
      setMessage(
        `Robot đã về station nhưng chưa thể hoàn tất database: ${error.message}. Task được giữ nguyên để retry.`,
        true
      );
      log(`FINALIZE DELIVERY ERROR: ${error.message}`);
    }
  }

  function normalizeSupportText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isNoMoreHelpText(value) {
    const text = normalizeSupportText(value);
    if (!text) return false;
    return [
      "khong can",
      "khong can nua",
      "khong can them",
      "cam on",
      "thoi",
      "duoc roi",
      "the thoi",
      "xong roi"
    ].some((phrase) => text.includes(phrase));
  }

  function handleOfficialRouteQr(qr) {
    if (!officialRouteSession.active) return false;

    const text = String(qr?.text || "").trim().toLowerCase();
    const areaPercent = Number(qr?.areaPercent);
    if (!text) return true;

    const blockedPhases = new Set([
      "turning",
      "junction_stop",
      "table_uturn_prepare",
      "table_uturn",
      "stopping_at_table",
      "waiting_station_stop",
      "waiting_station_uturn_prepare",
      "waiting_station_uturn",
      "waiting_station_complete"
    ]);
    if (blockedPhases.has(officialRouteSession.phase)) {
      return true;
    }

    const minAreaPercent = getQrActionMinAreaPercent();
    if (!Number.isFinite(areaPercent) || areaPercent < minAreaPercent) {
      if (
        text === "nga_re" ||
        text === officialRouteSession.targetTableQr ||
        text === officialRouteSession.waitingStationQr
      ) {
        log(
          `OFFICIAL QR IGNORE text=${text} area=${Number.isFinite(areaPercent) ? areaPercent.toFixed(2) : "?"}% ` +
          `< min=${minAreaPercent.toFixed(2)}%`
        );
      }
      return true;
    }

    if (officialRouteSession.mode === "outbound") {
      if (
        text === officialRouteSession.targetTableQr &&
        officialRouteSession.junctionHandled === true
      ) {
        log(`OFFICIAL QR TABLE ACCEPT text=${text} area=${areaPercent.toFixed(2)}%`);
        void stopOfficialRouteAtTable(text);
        return true;
      }

      if (
        text === officialRouteSession.targetTableQr &&
        officialRouteSession.junctionHandled === false
      ) {
        log(`OFFICIAL QR TABLE IGNORE before junction text=${text}`);
        return true;
      }

      if (text === "nga_re" && officialRouteSession.junctionHandled === false) {
        officialRouteSession.junctionHandled = true;
        log(`OFFICIAL QR JUNCTION OUTBOUND ACCEPT area=${areaPercent.toFixed(2)}%`);
        void runOfficialJunctionTurn();
        return true;
      }
    }

    if (officialRouteSession.mode === "home") {
      if (
        text === officialRouteSession.waitingStationQr &&
        officialRouteSession.junctionHandled === true
      ) {
        log(`OFFICIAL QR WAITING STATION ACCEPT area=${areaPercent.toFixed(2)}%`);
        void stopOfficialRouteAtWaitingStation(text);
        return true;
      }

      if (
        text === officialRouteSession.waitingStationQr &&
        officialRouteSession.junctionHandled === false
      ) {
        log(`OFFICIAL QR WAITING STATION IGNORE before return junction`);
        return true;
      }

      if (text === "nga_re" && officialRouteSession.junctionHandled === false) {
        officialRouteSession.junctionHandled = true;
        log(`OFFICIAL QR JUNCTION HOME ACCEPT area=${areaPercent.toFixed(2)}%`);
        void runOfficialJunctionTurn();
        return true;
      }
    }

    return true;
  }

  async function startOfficialRoute() {
    if (officialRouteSession.active) {
      return;
    }

    if (controlState.alive !== "alive") {
      alert("Robot chưa ALIVE. Hãy bật robot lên trước khi bắt đầu giao món.");
      setMessage("Không thể bắt đầu: robot chưa ALIVE.", true);
      return;
    }

    if (!mqttBridge?.connected) {
      alert("MQTT chưa kết nối tới ESP32.");
      setMessage("Không thể bắt đầu: MQTT WebSocket chưa connected.", true);
      return;
    }

    let taskSnapshot;
    try {
      taskSnapshot = await fetchAndCacheOfficialTask();
    } catch (error) {
      alert(`Không lấy được nhiệm vụ hiện tại: ${error.message}`);
      setMessage(`Không thể bắt đầu: ${error.message}`, true);
      return;
    }

    const backendStatus = String(taskSnapshot?.robot_status || controlState.robotStatus || "")
      .trim()
      .toLowerCase();
    if (backendStatus !== "received_task") {
      alert(`Robot chưa ở RECEIVED TASK (hiện tại: ${backendStatus || "không xác định"}).`);
      setMessage("Chỉ bắt đầu nhiệm vụ khi backend đang RECEIVED TASK.", true);
      return;
    }

    const routeInfo = getOfficialRouteInfo(taskSnapshot);
    if (!routeInfo.table) {
      alert("Nhiệm vụ đã tải nhưng không có số bàn đích.");
      setMessage("Không thể bắt đầu: nhiệm vụ backend thiếu table.", true);
      return;
    }

    if (routeInfo.turnDirection) {
      const orientationOk = controlState.orientationPermissionReady
        ? (orientation.start(), true)
        : await requestOrientationPermission();

      if (!orientationOk) {
        alert("Cần quyền Gyroscope để robot quay đúng góc.");
        return;
      }
    }

    stopLocalNavigationForDebug("official route start");

    resetOfficialRouteSession();
    officialRouteSession.active = true;
    officialRouteSession.mode = "outbound";
    officialRouteSession.phase = "starting";
    officialRouteSession.token += 1;
    officialRouteSession.task = { ...routeInfo.task };
    officialRouteSession.targetTable = routeInfo.table;
    officialRouteSession.targetTableQr = `ban_${routeInfo.table}`;
    officialRouteSession.turnDirection = routeInfo.turnDirection;
    officialRouteSession.turnAngle = routeInfo.turnAngle;
    officialRouteSession.uTurnAngle = routeInfo.uTurnAngle;
    officialRouteSession.junctionHandled = false;
    officialRouteSession.tableStopSent = false;
    officialRouteSession.waitingStationHandled = false;
    officialRouteSession.supportPhase = "idle";
    officialRouteSession.foodRemovedDuringArrival = false;
    officialRouteSession.foodTakenAtTargetPending = false;

    const sessionToken = officialRouteSession.token;
    setOfficialStartButtonState(true, "Đang mở camera sau");

    try {
      await ensureRearCameraRunning();
      if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) return;

      await publishStatusCommandAsync(DEBUG_COMMAND.LINE_FOLLOW);
      if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) return;

      try {
        await updateOfficialWorkStatus("on_task");
      } catch (statusError) {
        log(`WORK STATUS UPDATE ERROR: ${statusError.message}`);
      }

      officialRouteSession.phase = "line_follow";
      setOfficialStartButtonState(true, `Đang tìm ${officialRouteSession.targetTableQr}`);

      const turnText = routeInfo.turnDirection
        ? `; tại nga_re sẽ quay ${routeInfo.turnDirection === "LEFT" ? "trái" : "phải"} ${routeInfo.turnAngle}°`
        : "";

      const qrMinArea = getQrActionMinAreaPercent();
      setMessage(
        `Đã bắt đầu: camera sau + BÁM LINE (3). ` +
        `Đích ${officialRouteSession.targetTableQr}${turnText}. ` +
        `QR chỉ kích hoạt khi diện tích ≥ ${qrMinArea.toFixed(2)}%.`
      );
      log(
        `OFFICIAL ROUTE START table=${routeInfo.table} ` +
        `turn=${routeInfo.turnDirection || "NONE"} turnAngle=${routeInfo.turnAngle} ` +
        `uTurnAngle=${routeInfo.uTurnAngle} qrMinArea=${qrMinArea}`
      );
    } catch (error) {
      try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
      try { vision.stop(); } catch (_) {}
      resetOfficialRouteSession();
      setMessage(`Không thể bắt đầu nhiệm vụ: ${error.message}`, true);
      alert(`Không thể bắt đầu: ${error.message}`);
    }
  }

  window.addEventListener("robot:speech-complete", (event) => {
    const tag = String(event?.detail?.tag || "");

    if (tag === "arrived_target") {
      if (officialRouteSession.supportPhase === "arrival_announcement") {
        officialRouteSession.supportPhase = "idle";
        if (
          officialRouteSession.foodTakenAtTargetPending ||
          controlState.sensors.has_food === false
        ) {
          officialRouteSession.foodTakenAtTargetPending = false;
          void handleFoodTakenAtTarget();
        }
      }
      return;
    }
    if (tag === "table_support_invite") {
      startTableSupportTimer();
      return;
    }
    if (tag === "table_support_farewell") {
      void beginReturnHome();
      return;
    }
    if (tag === "delivery_complete_manager") {
      void finalizeCompletedDelivery();
    }
  });

  window.addEventListener("robot:speech-failed", (event) => {
    const tag = String(event?.detail?.tag || "");
    // Không để lỗi Gemini làm robot kẹt vĩnh viễn ở bàn/station.
    if (tag === "arrived_target") {
      officialRouteSession.supportPhase = "idle";
      if (
        officialRouteSession.foodTakenAtTargetPending ||
        controlState.sensors.has_food === false
      ) {
        officialRouteSession.foodTakenAtTargetPending = false;
        void handleFoodTakenAtTarget();
      }
    } else if (tag === "table_support_invite") {
      startTableSupportTimer();
    } else if (tag === "table_support_farewell") {
      void beginReturnHome();
    } else if (tag === "delivery_complete_manager") {
      void finalizeCompletedDelivery();
    }
  });

  window.addEventListener("robot:user-transcript", (event) => {
    if (
      !officialRouteSession.active ||
      controlState.robotStatus !== "on_target"
    ) return;

    const text = String(event?.detail?.text || "");
    if (!text) return;

    if (isNoMoreHelpText(text)) {
      clearOfficialSupportTimer();
      officialRouteSession.supportPhase = "finish_requested";
      setMessage("Khách không cần hỗ trợ thêm. Đang kết thúc lượt hội thoại tại bàn...");
      return;
    }

    if (officialRouteSession.supportPhase === "waiting_customer") {
      clearOfficialSupportTimer();
      officialRouteSession.supportPhase = "handling_request";
      setMessage("Đang xử lý yêu cầu hỗ trợ thêm của khách...");
    }
  });

  window.addEventListener("robot:gemini-turn-complete", (event) => {
    const tag = String(event?.detail?.tag || "");
    if (tag) return;

    if (
      officialRouteSession.active &&
      controlState.robotStatus === "on_target" &&
      officialRouteSession.supportPhase === "finish_requested"
    ) {
      void endTableSupport("gemini_tool");
      return;
    }

    if (
      officialRouteSession.active &&
      controlState.robotStatus === "on_target" &&
      officialRouteSession.supportPhase === "handling_request"
    ) {
      startTableSupportTimer();
    }
  });

  window.addEventListener("robot:finish-table-support", () => {
    if (
      officialRouteSession.active &&
      controlState.robotStatus === "on_target" &&
      !["farewell", "starting_home", "home"].includes(officialRouteSession.supportPhase)
    ) {
      // Chờ tool-response turn kết thúc rồi mới gửi câu farewell tự động, tránh
      // tag turnComplete của tool bị nhầm với tag của câu farewell.
      clearOfficialSupportTimer();
      officialRouteSession.supportPhase = "finish_requested";
    }
  });

  window.addEventListener("robot:start-delivery-request", () => {
    void startOfficialRoute();
  });

  window.addEventListener("robot:prepare-task-replacement", (event) => {
    beginTaskReplacement(event?.detail || {});
  });

  // Dùng đúng tên key và cách lưu riêng từng giá trị như web_2.zip.
  const DEBUG_TURN_STORAGE_KEYS = Object.freeze({
    direction: "robot_turn_direction",
    targetAngle: "robot_turn_target_angle",
    stopLead: "robot_turn_stop_lead"
  });

  const debugTurnSession = {
    active: false,
    stopSent: false,
    command: null,
    targetAngle: 0,
    stopLead: 0,
    startYaw: null,
    previousYaw: null,
    angleTurned: 0
  };

  function normalizeDebugStopLead(value) {
    const lead = Number(value);
    if (!Number.isFinite(lead)) return 0;
    return Math.max(0, Math.min(30, lead));
  }

  function readSavedDebugTurnSettings() {
    try {
      const direction = localStorage.getItem(DEBUG_TURN_STORAGE_KEYS.direction);
      const targetAngle = Number(localStorage.getItem(DEBUG_TURN_STORAGE_KEYS.targetAngle));
      const stopLead = normalizeDebugStopLead(
        localStorage.getItem(DEBUG_TURN_STORAGE_KEYS.stopLead)
      );

      return {
        direction,
        targetAngle: Number.isFinite(targetAngle) ? targetAngle : 0,
        stopLead
      };
    } catch (_) {
      return { direction: null, targetAngle: 0, stopLead: 0 };
    }
  }

  function saveDebugTurnSettings(direction, targetAngle, stopLead = 0) {
    try {
      localStorage.setItem(
        DEBUG_TURN_STORAGE_KEYS.direction,
        String(direction)
      );
      localStorage.setItem(
        DEBUG_TURN_STORAGE_KEYS.targetAngle,
        String(targetAngle)
      );
      localStorage.setItem(
        DEBUG_TURN_STORAGE_KEYS.stopLead,
        String(normalizeDebugStopLead(stopLead))
      );
    } catch (error) {
      log(`DEBUG localStorage SAVE ERROR: ${error?.message || error}`);
    }
  }

  function clearSavedDebugTurnSettings() {
    try {
      // Chỉ xóa 3 key của phiên quay/rẽ, không dùng localStorage.clear().
      localStorage.removeItem(DEBUG_TURN_STORAGE_KEYS.direction);
      localStorage.removeItem(DEBUG_TURN_STORAGE_KEYS.targetAngle);
      localStorage.removeItem(DEBUG_TURN_STORAGE_KEYS.stopLead);
    } catch (error) {
      log(`DEBUG localStorage CLEAR ERROR: ${error?.message || error}`);
    }
  }

  function resetDebugTurnSession({ clearStorage = true } = {}) {
    debugTurnSession.active = false;
    debugTurnSession.stopSent = false;
    debugTurnSession.command = null;
    debugTurnSession.targetAngle = 0;
    debugTurnSession.stopLead = 0;
    debugTurnSession.startYaw = null;
    debugTurnSession.previousYaw = null;
    debugTurnSession.angleTurned = 0;

    if (clearStorage) {
      clearSavedDebugTurnSettings();
    }
  }

  function publishDebugStatusCommand(command, callback = null) {
    if (!mqttBridge?.client || !mqttBridge.connected) {
      throw new Error("MQTT WebSocket chưa connected.");
    }

    const payload = String(command);
    mqttBridge.client.publish(
      DEBUG_STATUS_TOPIC,
      payload,
      { qos: 1, retain: false },
      (error) => {
        if (error) {
          log(`DEBUG MQTT PUB ERROR ${DEBUG_STATUS_TOPIC}: ${error.message}`);
        }
        if (callback) callback(error || null);
      }
    );

    log(`DEBUG MQTT PUB ${DEBUG_STATUS_TOPIC} payload=${payload}`);
    return true;
  }

  function rememberManualTask() {
    const task = navigation?.task;
    if (task && task.manual_control !== true) {
      controlState.manualSavedTask = { ...task };
    }
  }

  // Chỉ dừng timer điều khiển frontend cũ; KHÔNG gửi left/right PWM.
  // Bảng Debug từ đây chỉ điều khiển ESP32 qua topic/status với payload 0..5.
  function stopLocalNavigationForDebug(reason) {
    rememberManualTask();

    if (controlState.navigationTaskKey) {
      controlState.blockedResumeTaskKey = controlState.navigationTaskKey;
    }

    if (navigation?.controlTimer) {
      clearInterval(navigation.controlTimer);
      navigation.controlTimer = null;
    }

    try { navigation?.setMotorReason?.("STOPPED", reason); } catch (_) {}
    try {
      navigation?.setState?.("STOPPED", reason);
    } catch (_) {
      if (navigation) navigation.state = "STOPPED";
    }
  }

  function cancelManualTurn({ sendStop = false, clearStorage = true } = {}) {
    const wasActive = debugTurnSession.active;

    controlState.manualTurnToken += 1;
    if (controlState.manualTurnTimer) {
      clearInterval(controlState.manualTurnTimer);
      controlState.manualTurnTimer = null;
    }

    if (
      sendStop &&
      wasActive &&
      debugTurnSession.stopSent === false &&
      mqttBridge?.connected
    ) {
      debugTurnSession.stopSent = true;
      try { publishDebugStatusCommand(DEBUG_COMMAND.STOP); } catch (_) {}
    }

    resetDebugTurnSession({ clearStorage });
  }

  async function waitForYaw(timeoutMs = 1800) {
    let yaw = orientation.getYaw();
    if (yaw != null) return yaw;

    if (!controlState.orientationPermissionReady) {
      await requestOrientationPermission();
    } else {
      orientation.start();
    }

    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      yaw = orientation.getYaw();
      if (yaw != null) return yaw;
    }

    return null;
  }

  async function runManualAngleCommand({
    mode,
    direction,
    rawAngle,
    command,
    maxAngle = 360
  }) {
    const requested = Number(rawAngle);
    const targetAngle = Math.max(
      1,
      Math.min(maxAngle, Number.isFinite(requested) ? requested : 90)
    );
    const dir = direction === "LEFT" ? "LEFT" : "RIGHT";
    const actionVi = mode === "turn"
      ? (dir === "LEFT" ? "quay trái" : "quay phải")
      : (dir === "LEFT" ? "rẽ trái" : "rẽ phải");

    if (!mqttBridge.connected) {
      setManualControlState("MQTT chưa kết nối", "bad");
      setMessage(`Không thể ${actionVi}: MQTT WebSocket chưa connected.`, true);
      return;
    }

    // Đọc trước stopLead nếu web_2 đã từng lưu giá trị này.
    // Sau đó mới reset phiên cũ để không làm mất cấu hình bù dừng.
    const persistedBeforeStart = readSavedDebugTurnSettings();

    // Nếu đang có một phiên quay/rẽ khác, STOP phiên đó trước.
    if (debugTurnSession.active) {
      cancelManualTurn({ sendStop: true, clearStorage: true });
    } else {
      cancelManualTurn({ sendStop: false, clearStorage: true });
    }
    stopLocalNavigationForDebug(`debug ${mode}_${dir.toLowerCase()}`);

    setManualAngleDisplay(targetAngle, 0);
    setManualControlState(`Đang lấy góc ban đầu · ${targetAngle}°`, "warn");

    const startYaw = await waitForYaw();
    if (startYaw == null) {
      setManualControlState("Chưa có dữ liệu gyro", "bad");
      setMessage(`Không thể ${actionVi} theo góc vì chưa đọc được yaw. Hãy cho phép Gyroscope.`, true);
      return;
    }

    // Cách lưu localStorage giống web_2.zip.
    // stopLead chưa có ô nhập ở UI này, nên dùng giá trị đã lưu trước đó nếu hợp lệ,
    // nếu chưa từng có thì mặc định 0°.
    const stopLead = Math.min(
      normalizeDebugStopLead(persistedBeforeStart.stopLead),
      Math.max(0, targetAngle - 0.5)
    );
    saveDebugTurnSettings(command, targetAngle, stopLead);

    // Chụp yaw bắt đầu TRƯỚC khi publish lệnh chuyển động.
    debugTurnSession.active = true;
    debugTurnSession.stopSent = false;
    debugTurnSession.command = String(command);
    debugTurnSession.targetAngle = targetAngle;
    debugTurnSession.stopLead = stopLead;
    debugTurnSession.startYaw = Number(startYaw);
    debugTurnSession.previousYaw = Number(startYaw);
    debugTurnSession.angleTurned = 0;

    const token = ++controlState.manualTurnToken;
    const startedAt = performance.now();
    const timeoutMs = Math.max(12000, targetAngle * 350);

    try {
      // Chỉ gửi lệnh quay/rẽ đúng MỘT lần.
      publishDebugStatusCommand(command, (error) => {
        if (!error) return;
        if (token !== controlState.manualTurnToken) return;

        if (controlState.manualTurnTimer) {
          clearInterval(controlState.manualTurnTimer);
          controlState.manualTurnTimer = null;
        }
        resetDebugTurnSession({ clearStorage: true });
        setManualControlState("Không gửi được lệnh", "bad");
        setMessage(`Không gửi được lệnh ${actionVi}. Đã reset phiên.`, true);
      });
    } catch (error) {
      resetDebugTurnSession({ clearStorage: true });
      setManualControlState("Không gửi được lệnh", "bad");
      setMessage(error.message, true);
      return;
    }

    setManualControlState(`Đang ${actionVi} 0/${targetAngle}°`, "warn");
    setMessage(
      `Debug: đã gửi ${command} = ${actionVi.toUpperCase()}. ` +
      `Mục tiêu ${targetAngle}°${stopLead > 0 ? `, bù dừng ${stopLead}°` : ""}.`
    );
    log(
      `DEBUG ANGLE START command=${command} target=${targetAngle} ` +
      `startYaw=${Number(startYaw).toFixed(1)} stopLead=${stopLead}`
    );

    const completeAndStop = (completedAngle) => {
      if (token !== controlState.manualTurnToken) return;
      if (debugTurnSession.stopSent) return;

      // Khóa trước để tick tiếp theo không thể gửi STOP lần 2.
      debugTurnSession.stopSent = true;
      debugTurnSession.active = false;

      if (controlState.manualTurnTimer) {
        clearInterval(controlState.manualTurnTimer);
        controlState.manualTurnTimer = null;
      }

      setManualAngleDisplay(targetAngle, completedAngle);
      setManualControlState(`Hoàn tất ${completedAngle.toFixed(1)}°`, "good");

      try {
        publishDebugStatusCommand(DEBUG_COMMAND.STOP, (error) => {
          if (error) {
            resetDebugTurnSession({ clearStorage: true });
            setMessage("Đạt góc nhưng publish STOP báo lỗi. Đã reset dữ liệu frontend.", true);
            return;
          }

          // Giống web_2: STOP thành công thì xóa 3 key localStorage của phiên.
          resetDebugTurnSession({ clearStorage: true });
          setMessage(
            `Hoàn tất ở ${completedAngle.toFixed(1)}°. ` +
            `Đã gửi topic/status = 0 và xóa dữ liệu phiên khỏi localStorage.`
          );
          log(`DEBUG ANGLE DONE command=${command} angle=${completedAngle.toFixed(1)}/${targetAngle}`);
        });
      } catch (error) {
        resetDebugTurnSession({ clearStorage: true });
        setMessage(`Đạt góc nhưng không gửi được STOP: ${error.message}`, true);
      }
    };

    const tick = () => {
      if (token !== controlState.manualTurnToken) return;
      if (!debugTurnSession.active) return;

      const yaw = orientation.getYaw();
      if (yaw == null) {
        cancelManualTurn({ sendStop: true, clearStorage: true });
        setManualControlState("Mất dữ liệu gyro", "bad");
        setMessage(`Debug ${actionVi} đã dừng vì mất dữ liệu yaw.`, true);
        return;
      }

      if (debugTurnSession.previousYaw == null) {
        debugTurnSession.previousYaw = Number(yaw);
        return;
      }

      // Thuật toán giống web_2.zip: lấy delta ngắn nhất giữa 2 mẫu liên tiếp,
      // nên đi qua mốc 359° -> 0° vẫn chỉ được tính là vài độ.
      const delta = window.RobotOrientation.deltaDegrees(
        Number(yaw),
        debugTurnSession.previousYaw
      );
      debugTurnSession.previousYaw = Number(yaw);

      const deltaAbs = Math.abs(Number(delta) || 0);

      // Lọc jitter rất nhỏ giống web_2.zip.
      if (deltaAbs < 0.08) {
        setManualAngleDisplay(targetAngle, debugTurnSession.angleTurned);
        return;
      }

      // Bỏ qua spike sensor phi thực tế giống web_2.zip.
      if (deltaAbs > 45) {
        setManualAngleDisplay(targetAngle, debugTurnSession.angleTurned);
        return;
      }

      debugTurnSession.angleTurned += deltaAbs;
      const angleTurned = debugTurnSession.angleTurned;

      setManualAngleDisplay(targetAngle, angleTurned);
      setManualControlState(
        `Đang ${actionVi} ${angleTurned.toFixed(1)}/${targetAngle}°`,
        "warn"
      );

      const stopThreshold = Math.max(
        0.5,
        targetAngle - debugTurnSession.stopLead
      );

      if (
        angleTurned >= stopThreshold &&
        debugTurnSession.stopSent === false
      ) {
        completeAndStop(angleTurned);
        return;
      }

      if (performance.now() - startedAt > timeoutMs) {
        const timedOutAngle = angleTurned;
        cancelManualTurn({ sendStop: true, clearStorage: true });
        setManualAngleDisplay(targetAngle, timedOutAngle);
        setManualControlState(`Timeout ${timedOutAngle.toFixed(1)}/${targetAngle}°`, "bad");
        setMessage(`Debug ${actionVi} timeout trước khi đạt ${targetAngle}°.`, true);
        log(`DEBUG ANGLE TIMEOUT command=${command} angle=${timedOutAngle.toFixed(1)}/${targetAngle}`);
      }
    };

    tick();
    controlState.manualTurnTimer = window.setInterval(tick, 50);
  }

  async function manualTurn(direction, rawAngle) {
    const dir = direction === "LEFT" ? "LEFT" : "RIGHT";
    return runManualAngleCommand({
      mode: "turn",
      direction: dir,
      rawAngle,
      command: dir === "LEFT" ? DEBUG_COMMAND.TURN_LEFT : DEBUG_COMMAND.TURN_RIGHT,
      maxAngle: 360
    });
  }

  async function manualSteer(direction, rawAngle) {
    const dir = direction === "LEFT" ? "LEFT" : "RIGHT";
    return runManualAngleCommand({
      mode: "steer",
      direction: dir,
      rawAngle,
      command: dir === "LEFT" ? DEBUG_COMMAND.STEER_LEFT : DEBUG_COMMAND.STEER_RIGHT,
      maxAngle: 180
    });
  }

  function manualLineFollow() {
    if (!mqttBridge.connected) {
      setManualControlState("MQTT chưa kết nối", "bad");
      setMessage("Không thể bám line: MQTT WebSocket chưa connected.", true);
      return;
    }

    // Nếu đang quay/rẽ thì STOP phiên đó trước, sau đó mới chuyển sang bám line.
    if (debugTurnSession.active) {
      cancelManualTurn({ sendStop: true, clearStorage: true });
    } else {
      cancelManualTurn({ sendStop: false, clearStorage: true });
    }
    stopLocalNavigationForDebug("debug line follow");

    try {
      // web_2 lưu direction hiện tại; với bám line direction = 3.
      saveDebugTurnSettings(DEBUG_COMMAND.LINE_FOLLOW, 0, 0);
      publishDebugStatusCommand(DEBUG_COMMAND.LINE_FOLLOW, (error) => {
        if (!error) return;
        clearSavedDebugTurnSettings();
        setManualControlState("Không gửi được lệnh", "bad");
        setMessage("Không gửi được lệnh bám line. Đã xóa dữ liệu phiên.", true);
      });

      setManualAngleDisplay(0, 0);
      setManualControlState("Đang bám line", "good");
      setMessage('Debug: đã gửi BÁM LINE (topic/status = "3"). ESP32 tự điều khiển bám line.');
      log("DEBUG LINE FOLLOW command=3");
    } catch (error) {
      clearSavedDebugTurnSettings();
      setManualControlState("Không gửi được lệnh", "bad");
      setMessage(error.message, true);
    }
  }

  function manualStop() {
    // STOP khẩn cấp: hủy cả phiên BẮT ĐẦU chính thức để không có timer/QR nào
    // gửi lệnh chạy lại sau khi STOP. Sau đó gửi payload 0 lên topic/status.
    const wasOfficialActive = officialRouteSession.active;
    if (wasOfficialActive) {
      try { vision.stop(); } catch (_) {}
      resetOfficialRouteSession();
    }

    const wasActive = debugTurnSession.active;
    controlState.manualTurnToken += 1;
    if (controlState.manualTurnTimer) {
      clearInterval(controlState.manualTurnTimer);
      controlState.manualTurnTimer = null;
    }
    debugTurnSession.active = false;
    debugTurnSession.stopSent = true;

    stopLocalNavigationForDebug("debug STOP");

    try {
      publishDebugStatusCommand(DEBUG_COMMAND.STOP, (error) => {
        clearSavedDebugTurnSettings();
        resetDebugTurnSession({ clearStorage: false });

        if (error) {
          setManualControlState("STOP lỗi", "bad");
          setMessage("Publish STOP báo lỗi; đã reset dữ liệu frontend.", true);
          return;
        }

        setManualAngleDisplay(0, 0);
        setManualControlState("Đã STOP", "bad");
        setMessage('Debug: đã gửi STOP (topic/status = "0") và xóa dữ liệu phiên localStorage.');
        log(`DEBUG STOP command=0 debugActiveBefore=${wasActive} officialActiveBefore=${wasOfficialActive}`);
      });
    } catch (error) {
      clearSavedDebugTurnSettings();
      resetDebugTurnSession({ clearStorage: false });
      setManualControlState("STOP lỗi", "bad");
      setMessage(error.message, true);
    }
  }

  function stopEverything(reason = "manual") {
    // DỪNG ROBOT theo protocol mới: luôn gửi payload 0 lên topic/status.
    // Đồng thời hủy mọi phiên gyro/QR ở frontend để không thể tự gửi 1/2/3/4/5 lại.
    cancelManualTurn({ sendStop: false, clearStorage: true });
    clearOfficialTurnTimer();
    if (officialRouteSession.active) {
      resetOfficialRouteSession();
    }

    stopLocalNavigationForDebug(reason);

    try {
      if (mqttBridge?.connected) {
        publishDebugStatusCommand(DEBUG_COMMAND.STOP, (error) => {
          if (error) {
            setMessage(`STOP lỗi: ${error.message}`, true);
            return;
          }
          setMessage(`Robot đã dừng (${reason}) · topic/status = 0.`);
          log(`GLOBAL STOP command=0 reason=${reason}`);
        });
      } else {
        setMessage(`Đã hủy điều khiển frontend (${reason}), nhưng MQTT chưa kết nối để gửi STOP.`, true);
      }
    } catch (error) {
      setMessage(`Không gửi được STOP: ${error.message}`, true);
    }

    try { vision.stop(); } catch (_) {}
    closeCameraDebug();
  }

  function resetRuntimeStateAfterServerReset() {
    // Chỉ xóa state nhiệm vụ local SAU KHI backend reset thành công.
    // Không thay đổi has_food: đó là trạng thái vật lý do ESP32/topic/mon quyết định.
    cancelManualTurn({ sendStop: false, clearStorage: true });
    clearOfficialTurnTimer();
    if (officialRouteSession.active || officialRouteSession.phase !== "idle") {
      resetOfficialRouteSession();
    } else {
      setOfficialStartButtonState(false);
    }

    stopLocalNavigationForDebug("reset robot");

    controlState.pendingDelivery = null;
    controlState.taskReplacement = null;
    controlState.currentDispatch = null;
    controlState.latestTask = null;
    controlState.dispatching = false;
    controlState.robotStatus = "available";
    controlState.navigationStarting = false;
    controlState.navigationTaskKey = null;
    controlState.blockedResumeTaskKey = null;
    controlState.manualSavedTask = null;

    try { localStorage.removeItem(OFFICIAL_TASK_STORAGE_KEY); } catch (_) {}
    clearSavedDebugTurnSettings();

    const pendingCard = $("pendingDeliveryCard");
    if (pendingCard) pendingCard.hidden = true;

    try { vision.stop(); } catch (_) {}
    closeCameraDebug();
    setManualAngleDisplay(0, 0);
    setManualControlState("Sẵn sàng");
    setDebugAvailability(true);
    setMessage("Đã reset nhiệm vụ. Robot đang AVAILABLE và chưa có task.");
    log(`LOCAL RESET COMPLETE robot=${controlState.robot}`);
  }

  function switchRobot(robotNumber) {
    const next = Number(robotNumber) || 1;

    if (officialRouteSession.active) {
      try { publishDebugStatusCommand(DEBUG_COMMAND.STOP); } catch (_) {}
      try { vision.stop(); } catch (_) {}
      resetOfficialRouteSession();
    }

    cancelManualTurn({ sendStop: true, clearStorage: true });
    controlState.manualSavedTask = null;
    try { localStorage.removeItem(OFFICIAL_TASK_STORAGE_KEY); } catch (_) {}
    setManualAngleDisplay(0, 0);
    setManualControlState("Sẵn sàng");

    if (navigation.state === "LINE_FOLLOW" || navigation.state === "TURNING") {
      stopEverything("đổi robot");
    }

    controlState.robot = next;
    controlState.robotStatus = "disconnected";
    setDebugAvailability(true);
    controlState.pendingDelivery = null;
    controlState.taskReplacement = null;
    controlState.currentDispatch = null;
    controlState.navigationStarting = false;
    controlState.navigationTaskKey = null;
    controlState.blockedResumeTaskKey = null;
    // Robot mới được chọn bắt đầu với giả định database/UI là chưa có món.
    // topic/mon của ESP32 sẽ cập nhật lại ngay khi có message.
    controlState.lastSyncedHasFood = false;
    controlState.sensors = {
      ir2: false,
      ir3: false,
      ir5: false,
      has_food: false
    };
    updateSensorUi();

    // Presence local được tính lại cho robot vừa chọn.
    controlState.alive = "disconnected";
    controlState.lastSyncedAlive = "disconnected";
    controlState.lastRobotMessageAt = 0;
    controlState.lastRobotTopic = "";
    controlState.aliveProbeSentAt = 0;
    controlState.aliveMonitorStartedAt = Date.now();
    controlState.aliveNextProbeAt =
      controlState.aliveMonitorStartedAt + ALIVE_SILENCE_BEFORE_PROBE_MS;
    emitAliveUiState("Robot selection changed");

    mqttBridge.switchRobot(next);
    log(`CONTROL SELECT Robot ${next}`);
  }

  window.addEventListener("robot:prepare-delivery", (event) => {
    showPendingDelivery(event.detail || {});
  });

  window.addEventListener("robot:selected", (event) => {
    switchRobot(event.detail?.robot);
  });

  window.addEventListener("robot:status-updated", async (event) => {
    const robot = Number(event.detail?.robot || 0);
    if (robot !== controlState.robot) {
      return;
    }

    const status = String(event.detail?.status || "disconnected").toLowerCase();
    const robotData = event.detail?.robotData || {};

    controlState.robotStatus = status;
    setDebugAvailability(true);

    // Backend có thể vẫn trả tasks ngay cả khi trường status đang là
    // disconnected (đúng như ảnh/log hiện tại). Vì vậy không được chỉ lưu task
    // khi status === on_task.
    const task = robotData?.tasks;
    if (isNonEmptyObject(task)) {
      controlState.latestTask = { ...task };
      controlState.currentDispatch = {
        task: { ...task },
        route: { ...task },
        restored_from_status: true
      };
      controlState.navigationTaskKey = buildNavigationTaskKey(task);
    }

    if (status === "received_task" || status === "on_task") {
      // RECEIVED TASK: robot đã nhận task nhưng chưa chạy.
      // ON TASK: robot đã bắt đầu thực thi.
      // Cả hai đều chỉ giữ snapshot; không tự khởi động controller PWM cũ.
      return;
    }

    // Nếu status không phải received_task/on_task nhưng backend vẫn còn tasks, giữ snapshot
    // để giao diện và nút BẮT ĐẦU có thể sử dụng. Chỉ xóa khi thực sự không có task.
    if (!isNonEmptyObject(task)) {
      controlState.latestTask = null;
      controlState.currentDispatch = null;
      controlState.navigationTaskKey = null;
      controlState.blockedResumeTaskKey = null;
      controlState.manualSavedTask = null;
    }
  });

  $("cameraDebugButton")?.addEventListener("click", async () => {
    if (controlState.cameraDebugOpen) {
      closeCameraDebug();
      return;
    }

    const ok = await ensureDebugCamera();
    if (ok) {
      openCameraDebug();
    }
  });

  $("cameraDebugCloseButton")?.addEventListener("click", closeCameraDebug);

  $("cameraSwitchButton")?.addEventListener("click", async () => {
    const button = $("cameraSwitchButton");
    if (button) {
      button.disabled = true;
      button.textContent = "ĐANG ĐỔI...";
    }

    try {
      if (!vision.running) {
        const ok = await ensureDebugCamera();
        if (!ok) return;
      }

      const facingMode = await vision.switchCamera();
      controlState.cameraPermissionReady = true;
      updateCameraSwitchButton();

      const cameraName = facingMode === "environment"
        ? "camera sau"
        : "camera trước";

      setMessage(`Đã chuyển sang ${cameraName}.`);
      log(`CAMERA SWITCH -> ${cameraName}`);
    }
    catch (error) {
      updateCameraSwitchButton();
      setMessage(`Không đổi được camera: ${error.message}`, true);
      log(`CAMERA SWITCH ERROR: ${error.message}`);
    }
    finally {
      if (button) {
        button.disabled = false;
      }
    }
  });

  try {
    const rawSettings = localStorage.getItem("robot_setting_official");
    const savedSettings = rawSettings ? JSON.parse(rawSettings) : null;
    const savedTurnAngle = Math.max(
      1,
      Math.min(180, Number(savedSettings?.turnAngle) || 90)
    );
    if ($("manualSteerLeftAngle")) $("manualSteerLeftAngle").value = String(savedTurnAngle);
    if ($("manualSteerRightAngle")) $("manualSteerRightAngle").value = String(savedTurnAngle);
  } catch (_) {}


  // Khôi phục giá trị tạm theo đúng 3 key của web_2.zip nếu phiên trước còn dang dở.
  // Chỉ khôi phục ô nhập; KHÔNG tự gửi lại lệnh cho ESP32 sau reload.
  try {
    const savedDebug = readSavedDebugTurnSettings();
    const savedAngle = Number(savedDebug.targetAngle);
    if (Number.isFinite(savedAngle) && savedAngle >= 1) {
      if (savedDebug.direction === DEBUG_COMMAND.TURN_LEFT && $("manualTurnLeftAngle")) {
        $("manualTurnLeftAngle").value = String(Math.min(360, savedAngle));
      } else if (savedDebug.direction === DEBUG_COMMAND.TURN_RIGHT && $("manualTurnRightAngle")) {
        $("manualTurnRightAngle").value = String(Math.min(360, savedAngle));
      } else if (savedDebug.direction === DEBUG_COMMAND.STEER_LEFT && $("manualSteerLeftAngle")) {
        $("manualSteerLeftAngle").value = String(Math.min(180, savedAngle));
      } else if (savedDebug.direction === DEBUG_COMMAND.STEER_RIGHT && $("manualSteerRightAngle")) {
        $("manualSteerRightAngle").value = String(Math.min(180, savedAngle));
      }
    }
  } catch (_) {}

  $("robotStartButton")?.addEventListener("click", () => {
    void startOfficialRoute();
  });

  $("robotSupportButton")?.addEventListener("click", () => {
    // Nút HỖ TRỢ dùng chung luồng mở Gemini với nút NHẬN LỆNH.
    $("commandButton")?.click();
  });

  $("manualTurnLeftButton")?.addEventListener("click", () => {
    manualTurn("LEFT", $("manualTurnLeftAngle")?.value);
  });

  $("manualTurnRightButton")?.addEventListener("click", () => {
    manualTurn("RIGHT", $("manualTurnRightAngle")?.value);
  });

  $("manualSteerLeftButton")?.addEventListener("click", () => {
    manualSteer("LEFT", $("manualSteerLeftAngle")?.value);
  });

  $("manualSteerRightButton")?.addEventListener("click", () => {
    manualSteer("RIGHT", $("manualSteerRightAngle")?.value);
  });

  $("manualLineFollowButton")?.addEventListener("click", () => {
    manualLineFollow();
  });

  $("manualStopButton")?.addEventListener("click", manualStop);

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
      // Không để thao tác Debug theo góc tiếp tục chạy khi tab bị đưa nền.
      cancelManualTurn({ sendStop: true, clearStorage: true });
    }
  });

  window.addEventListener("beforeunload", () => {
    cancelManualTurn({ sendStop: true, clearStorage: true });
    vision.stop();
    stopAliveMonitor();
    mqttBridge.close();
  });

  async function boot() {
    setDebugAvailability(true);
    setManualAngleDisplay(0, 0);
    setManualControlState("Sẵn sàng");
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
    resetRuntimeStateAfterServerReset,
    preparePermissions,
    manualTurn,
    manualSteer,
    manualLineFollow,
    manualStop,
    startOfficialRoute,
    officialRouteSession
  };
})();
