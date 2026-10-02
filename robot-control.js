(() => {
  window.ROBOT_CONTROL_BUILD = "2026-10-02-official-route-task-cache-v2";
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
    latestTask: null,
    orientationPermissionReady: false,
    cameraPermissionReady: false,
    robotStatus: "disconnected",
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

  function setDebugAvailability(isOnTask) {
    const debugButton = $("cameraDebugButton");
    if (debugButton) {
      debugButton.hidden = !isOnTask;
      debugButton.disabled = !isOnTask;
    }

    const switchButton = $("cameraSwitchButton");
    if (switchButton) {
      switchButton.hidden = !isOnTask;
      switchButton.disabled = !isOnTask;
    }

    if (isOnTask) {
      updateCameraSwitchButton();
    }

    if (!isOnTask) {
      closeCameraDebug();
    }
  }

  function openCameraDebug() {
    if (controlState.robotStatus !== "on_task") {
      setMessage("Debug camera chỉ mở khi robot đang ON TASK.", true);
      return;
    }

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

      const setText = (id, text, className = "") => {
        const el = $(id);
        if (!el) return;
        el.textContent = text;
        if (className) el.className = className;
      };

      const leftLabel = frame?.leftFound
        ? `x=${Math.round(frame.leftX)} · ${(frame.leftConfidence * 100).toFixed(0)}%${frame.leftInferred ? " · ước lượng" : ""}`
        : (frame?.leftInferred ? "Ước lượng từ lane width" : "Không thấy");

      const rightLabel = frame?.rightFound
        ? `x=${Math.round(frame.rightX)} · ${(frame.rightConfidence * 100).toFixed(0)}%${frame.rightInferred ? " · ước lượng" : ""}`
        : (frame?.rightInferred ? "Ước lượng từ lane width" : "Không thấy");

      setText(
        "visionLeftState",
        leftLabel,
        frame?.leftFound ? "good" : (frame?.leftInferred ? "warn" : "bad")
      );

      setText(
        "visionRightState",
        rightLabel,
        frame?.rightFound ? "good" : (frame?.rightInferred ? "warn" : "bad")
      );

      setText(
        "visionCenterState",
        frame?.laneCenter != null
          ? `x=${frame.laneCenter.toFixed(1)}`
          : "-",
        frame?.hasLane ? "good" : "warn"
      );

      setText(
        "visionErrorState",
        frame?.lineError != null
          ? `${frame.lineError >= 0 ? "+" : ""}${frame.lineError.toFixed(1)} px`
          : "-",
        frame?.lineError != null && Math.abs(frame.lineError) < 25
          ? "good"
          : "warn"
      );

      setText(
        "visionRawCenterState",
        frame?.rawLaneCenter != null
          ? `x=${frame.rawLaneCenter.toFixed(1)}`
          : "-"
      );

      setText(
        "visionRawErrorState",
        frame?.rawLineError != null
          ? `${frame.rawLineError >= 0 ? "+" : ""}${frame.rawLineError.toFixed(1)} px`
          : "-"
      );

      const thresholdText = Array.isArray(frame?.thresholds)
        ? frame.thresholds.map((value) => Math.round(value)).join(" / ")
        : "-";

      setText(
        "visionThresholdState",
        `${thresholdText} · dark ${((frame?.darkRatio || 0) * 100).toFixed(1)}%`
      );

      const laneConfidence = Number(frame?.laneConfidence) || 0;
      setText(
        "visionConfidenceState",
        `${(laneConfidence * 100).toFixed(0)}% · pair ${((frame?.pairCoverage || 0) * 100).toFixed(0)}%`,
        laneConfidence >= (Number(navConfig.VISION_GOOD_CONFIDENCE) || 0.78)
          ? "good"
          : laneConfidence >= (Number(navConfig.VISION_MIN_CONFIDENCE) || 0.38)
            ? "warn"
            : "bad"
      );

      setText(
        "visionLaneWidthState",
        frame?.laneWidth != null
          ? `${frame.laneWidth.toFixed(1)} px`
          : "-"
      );

      const controlHeading =
        frame?.bevHeadingDeg != null
          ? Number(frame.bevHeadingDeg)
          : frame?.controlHeadingErrorDeg != null
            ? Number(frame.controlHeadingErrorDeg)
            : frame?.headingErrorDeg != null
              ? Number(frame.headingErrorDeg)
              : null;

      setText(
        "visionHeadingState",
        controlHeading != null && Number.isFinite(controlHeading)
          ? `${controlHeading >= 0 ? "+" : ""}${controlHeading.toFixed(1)}° · yellow=0°`
          : "-"
      );

      setText(
        "visionCurvatureState",
        frame?.targetCurvature != null
          ? `${frame.targetCurvature >= 0 ? "+" : ""}${frame.targetCurvature.toFixed(3)} κ`
          : "-"
      );

      setText(
        "visionBlueCurveState",
        frame?.blueCurveSeverity != null
          ? `${frame.blueCurveDirection || "STRAIGHT"} · ${(frame.blueCurveSeverity * 100).toFixed(0)}%`
          : "-"
      );

      setText(
        "visionTargetState",
        frame?.adaptiveLookaheadCenter != null
          ? `x=${frame.adaptiveLookaheadCenter.toFixed(1)} · u=${Number(frame.adaptiveLookaheadU || 0).toFixed(2)}`
          : "-"
      );
    },
    onQr: (qr) => {
      const text = String(qr?.text || "").trim();
      const normalizedText = text.toLowerCase();
      const areaPercent = Number(qr?.areaPercent);
      const areaPx = Number(qr?.areaPx);

      const currentTable = Number(
        navigation?.task?.table ??
        navigation?.task?.table_number ??
        controlState.currentDispatch?.table ??
        0
      );

      const tablePrefix = String(
        navConfig.TABLE_QR_PREFIX || "ban_"
      ).toLowerCase();

      const expectedTableQr = currentTable > 0
        ? `${tablePrefix}${currentTable}`
        : "";

      const junctionQr = String(
        navConfig.JUNCTION_QR_TEXT ||
        navConfig.T_JUNCTION_QR_TEXT ||
        "nga_re"
      ).toLowerCase();

      let threshold = null;
      let actionLabel = "chỉ nhận diện";

      if (expectedTableQr && normalizedText === expectedTableQr) {
        threshold = Number(navConfig.TABLE_QR_STOP_AREA_PERCENT) || 4;
        actionLabel = `dừng bàn ${currentTable}`;
      }
      else if (normalizedText === junctionQr) {
        threshold = Number(
          navConfig.JUNCTION_QR_TRIGGER_AREA_PERCENT ??
          navConfig.T_JUNCTION_STOP_AREA_PERCENT
        ) || 12;
        actionLabel = "rẽ 90°";
      }

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
          const thresholdText = Number.isFinite(threshold)
            ? ` · ${actionLabel} ≥ ${threshold}%`
            : ` · ${actionLabel}`;

          areaEl.textContent =
            `${areaPercent.toFixed(2)}% · ${Math.round(areaPx)} px²${thresholdText}`;

          areaEl.className =
            Number.isFinite(threshold) && areaPercent >= threshold
              ? "good"
              : "warn";
        } else {
          areaEl.textContent = "-";
          areaEl.className = "muted";
        }
      }

      // Khi luồng BẮT ĐẦU chính thức đang chạy, QR được xử lý hoàn toàn
      // bằng protocol topic/status 0..5, không chuyển cho RobotNavigation cũ.
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
        return;
      }

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
      controlState.robotStatus = "on_task";
      setDebugAvailability(true);
      controlState.pendingDelivery = null;
      $("pendingDeliveryCard").hidden = true;

      controlState.latestTask = { ...task };
      controlState.navigationTaskKey = buildNavigationTaskKey(task);
      controlState.blockedResumeTaskKey = null;

      // Protocol điều khiển chính thức mới: không tự chạy motor/navigation cũ.
      // Người dùng chủ động bấm BẮT ĐẦU để mở camera sau và gửi payload 3.
      setMessage("ESP32 đã lưu task. Nhiệm vụ sẵn sàng; nhấn BẮT ĐẦU để chạy.");
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
  //   - gặp QR ban_<table>: STOP và kết thúc
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
    phase: "idle",
    token: 0,
    targetTable: 0,
    targetTableQr: "",
    turnDirection: null,
    turnAngle: 90,
    junctionHandled: false,
    tableStopSent: false,
    startYaw: null,
    previousYaw: null,
    angleTurned: 0,
    turnTimer: null
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

  function resetOfficialRouteSession({ keepButtonMessage = false } = {}) {
    clearOfficialTurnTimer();
    officialRouteSession.active = false;
    officialRouteSession.phase = "idle";
    officialRouteSession.token += 1;
    officialRouteSession.targetTable = 0;
    officialRouteSession.targetTableQr = "";
    officialRouteSession.turnDirection = null;
    officialRouteSession.turnAngle = 90;
    officialRouteSession.junctionHandled = false;
    officialRouteSession.tableStopSent = false;
    officialRouteSession.startYaw = null;
    officialRouteSession.previousYaw = null;
    officialRouteSession.angleTurned = 0;
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

  async function ensureRearCameraRunning() {
    // config hiện tại đã mặc định environment, nhưng vẫn ép đúng camera sau
    // để không phụ thuộc trạng thái người dùng từng chuyển camera trước đó.
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

  async function stopOfficialRouteAtTable(qrText) {
    if (!officialRouteSession.active || officialRouteSession.tableStopSent) return;

    officialRouteSession.tableStopSent = true;
    officialRouteSession.phase = "stopping_at_table";
    const table = officialRouteSession.targetTable;

    try {
      await publishStatusCommandAsync(DEBUG_COMMAND.STOP);
      log(`OFFICIAL ROUTE TABLE STOP qr=${qrText} table=${table}`);
      setMessage(`Đã thấy ${qrText}. Robot đã dừng tại bàn ${table}.`);
      try { vision.stop(); } catch (_) {}
      resetOfficialRouteSession({ keepButtonMessage: true });
    } catch (error) {
      officialRouteSession.tableStopSent = false;
      officialRouteSession.phase = "line_follow";
      setMessage(`Đã thấy ${qrText} nhưng gửi STOP lỗi: ${error.message}`, true);
      setOfficialStartButtonState(true, "Lỗi STOP bàn");
    }
  }

  async function runOfficialJunctionTurn() {
    if (!officialRouteSession.active) return;

    const sessionToken = officialRouteSession.token;
    const direction = officialRouteSession.turnDirection;
    const targetAngle = officialRouteSession.turnAngle;

    if (direction !== "LEFT" && direction !== "RIGHT") {
      officialRouteSession.phase = "error";
      setMessage("Đã gặp QR nga_re nhưng nhiệm vụ không có thông tin Rẽ trái/Rẽ phải. Robot giữ STOP.", true);
      setOfficialStartButtonState(false, "Thiếu hướng rẽ");
      officialRouteSession.active = false;
      return;
    }

    officialRouteSession.phase = "junction_stop";

    try {
      // Yêu cầu bắt buộc: gặp nga_re thì dừng trước.
      await publishStatusCommandAsync(DEBUG_COMMAND.STOP);
      if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) return;

      setMessage(
        `Đã thấy nga_re. Đang chuẩn bị quay ${direction === "LEFT" ? "trái" : "phải"} ${targetAngle}°.`
      );

      // Lấy yaw bắt đầu ngay trước thời điểm gửi lệnh quay.
      const startYaw = await waitForYaw(2200);
      if (startYaw == null) {
        throw new Error("Không đọc được gyroscope để lấy góc bắt đầu.");
      }

      if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) return;

      officialRouteSession.startYaw = Number(startYaw);
      officialRouteSession.previousYaw = Number(startYaw);
      officialRouteSession.angleTurned = 0;
      officialRouteSession.phase = "turning";

      const turnCommand = direction === "LEFT"
        ? DEBUG_COMMAND.TURN_LEFT
        : DEBUG_COMMAND.TURN_RIGHT;

      // startYaw đã được chụp ngay phía trên, sau đó mới publish 1/2.
      await publishStatusCommandAsync(turnCommand);
      if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) return;

      log(
        `OFFICIAL ROUTE TURN START direction=${direction} command=${turnCommand} ` +
        `target=${targetAngle} startYaw=${Number(startYaw).toFixed(1)}`
      );
      setMessage(
        `Đang quay ${direction === "LEFT" ? "trái" : "phải"}: 0/${targetAngle}°.`
      );

      const startedAt = performance.now();
      const timeoutMs = Math.max(12000, targetAngle * 350);

      clearOfficialTurnTimer();
      officialRouteSession.turnTimer = window.setInterval(async () => {
        if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) {
          clearOfficialTurnTimer();
          return;
        }
        if (officialRouteSession.phase !== "turning") return;

        const yaw = orientation.getYaw();
        if (yaw == null || officialRouteSession.previousYaw == null) {
          return;
        }

        const delta = window.RobotOrientation.deltaDegrees(
          Number(yaw),
          Number(officialRouteSession.previousYaw)
        );
        officialRouteSession.previousYaw = Number(yaw);

        const deltaAbs = Math.abs(Number(delta) || 0);

        // Cùng cách web_2: bỏ jitter nhỏ và spike bất thường.
        if (deltaAbs >= 0.08 && deltaAbs <= 45) {
          officialRouteSession.angleTurned += deltaAbs;
        }

        const turned = officialRouteSession.angleTurned;
        setMessage(
          `Đang quay ${direction === "LEFT" ? "trái" : "phải"}: ` +
          `${turned.toFixed(1)}/${targetAngle}°.`
        );

        if (turned >= targetAngle) {
          officialRouteSession.phase = "turn_complete";
          clearOfficialTurnTimer();

          try {
            // Đạt góc đích -> STOP trước rồi mới tiếp tục bám line.
            await publishStatusCommandAsync(DEBUG_COMMAND.STOP);
            if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) return;

            log(`OFFICIAL ROUTE TURN DONE angle=${turned.toFixed(1)}/${targetAngle}`);
            setMessage(`Đã quay ${turned.toFixed(1)}°. Đang tiếp tục bám line...`);

            await new Promise((resolve) => setTimeout(resolve, 120));
            await publishStatusCommandAsync(DEBUG_COMMAND.LINE_FOLLOW);
            if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) return;

            officialRouteSession.phase = "line_follow";
            setOfficialStartButtonState(true, `Đang tìm ban_${officialRouteSession.targetTable}`);
            setMessage(
              `Đã rẽ xong. Tiếp tục bám line và chờ QR ban_${officialRouteSession.targetTable}.`
            );
          } catch (error) {
            officialRouteSession.phase = "error";
            officialRouteSession.active = false;
            setOfficialStartButtonState(false, "Lỗi sau khi quay");
            setMessage(`Lỗi khi hoàn tất rẽ: ${error.message}`, true);
          }
          return;
        }

        if (performance.now() - startedAt > timeoutMs) {
          clearOfficialTurnTimer();
          officialRouteSession.phase = "error";
          try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
          officialRouteSession.active = false;
          setOfficialStartButtonState(false, "Timeout góc quay");
          setMessage(
            `Timeout: robot mới quay ${turned.toFixed(1)}/${targetAngle}°. Đã gửi STOP.`,
            true
          );
        }
      }, 50);
    } catch (error) {
      clearOfficialTurnTimer();
      try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
      officialRouteSession.phase = "error";
      officialRouteSession.active = false;
      setOfficialStartButtonState(false, "Không thể rẽ");
      setMessage(`Không thể xử lý ngã rẽ: ${error.message}`, true);
    }
  }

  function handleOfficialRouteQr(qr) {
    if (!officialRouteSession.active) return false;

    const text = String(qr?.text || "").trim().toLowerCase();
    if (!text) return true;

    // Trong lúc quay, không xử lý thêm QR nào để tránh lặp lệnh.
    if (officialRouteSession.phase === "turning" ||
        officialRouteSession.phase === "junction_stop" ||
        officialRouteSession.phase === "turn_complete") {
      return true;
    }

    if (text === officialRouteSession.targetTableQr) {
      void stopOfficialRouteAtTable(text);
      return true;
    }

    if (
      text === "nga_re" &&
      officialRouteSession.junctionHandled === false
    ) {
      officialRouteSession.junctionHandled = true;
      void runOfficialJunctionTurn();
      return true;
    }

    // Khi phiên chính thức đang chạy, không chuyển QR sang navigation cũ.
    return true;
  }

  async function startOfficialRoute() {
    if (officialRouteSession.active) {
      return;
    }

    if (!mqttBridge?.connected) {
      alert("MQTT chưa kết nối tới ESP32.");
      setMessage("Không thể bắt đầu: MQTT WebSocket chưa connected.", true);
      return;
    }

    let taskSnapshot;
    try {
      // BẮT ĐẦU luôn GET status mới nhất từ backend, lấy tasks của robot đang chọn
      // và lưu vào localStorage trước khi dùng cho toàn bộ hành trình.
      taskSnapshot = await fetchAndCacheOfficialTask();
    } catch (error) {
      alert(`Không lấy được nhiệm vụ hiện tại: ${error.message}`);
      setMessage(`Không thể bắt đầu: ${error.message}`, true);
      return;
    }

    const routeInfo = getOfficialRouteInfo(taskSnapshot);
    if (!routeInfo.table) {
      alert("Nhiệm vụ đã tải nhưng không có số bàn đích.");
      setMessage("Không thể bắt đầu: nhiệm vụ backend thiếu trường table/table_number.", true);
      return;
    }

    // Nếu route có ngã rẽ, xin quyền gyro ngay trong user gesture của nút BẮT ĐẦU.
    if (routeInfo.turnDirection) {
      const orientationOk = controlState.orientationPermissionReady
        ? (orientation.start(), true)
        : await requestOrientationPermission();

      if (!orientationOk) {
        alert("Cần quyền Gyroscope để robot quay đúng góc tại ngã rẽ.");
        return;
      }
    }

    // Ngăn controller cũ gửi PWM trong khi protocol mới đang chạy.
    stopLocalNavigationForDebug("official route start");

    resetOfficialRouteSession();
    officialRouteSession.active = true;
    officialRouteSession.phase = "starting";
    officialRouteSession.token += 1;
    officialRouteSession.targetTable = routeInfo.table;
    officialRouteSession.targetTableQr = `ban_${routeInfo.table}`;
    officialRouteSession.turnDirection = routeInfo.turnDirection;
    officialRouteSession.turnAngle = routeInfo.turnAngle;
    officialRouteSession.junctionHandled = false;
    officialRouteSession.tableStopSent = false;

    const sessionToken = officialRouteSession.token;
    setOfficialStartButtonState(true, "Đang mở camera sau");

    try {
      await ensureRearCameraRunning();
      if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) return;

      // Sau khi camera sau sẵn sàng mới gửi lệnh bám line.
      await publishStatusCommandAsync(DEBUG_COMMAND.LINE_FOLLOW);
      if (!officialRouteSession.active || sessionToken !== officialRouteSession.token) return;

      officialRouteSession.phase = "line_follow";
      setOfficialStartButtonState(true, `Đang tìm ${officialRouteSession.targetTableQr}`);

      const turnText = routeInfo.turnDirection
        ? `; tại nga_re sẽ quay ${routeInfo.turnDirection === "LEFT" ? "trái" : "phải"} ${routeInfo.turnAngle}°`
        : "";

      setMessage(
        `Đã bắt đầu: camera sau + BÁM LINE (3). ` +
        `Đích ${officialRouteSession.targetTableQr}${turnText}.`
      );
      log(
        `OFFICIAL ROUTE START table=${routeInfo.table} ` +
        `turn=${routeInfo.turnDirection || "NONE"} angle=${routeInfo.turnAngle}`
      );
    } catch (error) {
      try { await publishStatusCommandAsync(DEBUG_COMMAND.STOP); } catch (_) {}
      try { vision.stop(); } catch (_) {}
      resetOfficialRouteSession();
      setMessage(`Không thể bắt đầu nhiệm vụ: ${error.message}`, true);
      alert(`Không thể bắt đầu: ${error.message}`);
    }
  }

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
    setDebugAvailability(false);
    controlState.pendingDelivery = null;
    controlState.currentDispatch = null;
    controlState.navigationStarting = false;
    controlState.navigationTaskKey = null;
    controlState.blockedResumeTaskKey = null;
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

  window.addEventListener("robot:status-updated", async (event) => {
    const robot = Number(event.detail?.robot || 0);
    if (robot !== controlState.robot) {
      return;
    }

    const status = String(event.detail?.status || "disconnected").toLowerCase();
    const robotData = event.detail?.robotData || {};

    controlState.robotStatus = status;
    setDebugAvailability(status === "on_task");

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

    if (status === "on_task") {
      // Protocol chính thức mới KHÔNG tự khởi động controller PWM cũ.
      // Chỉ lưu task; robot bắt đầu khi người dùng bấm BẮT ĐẦU.
      return;
    }

    // Nếu status không phải on_task nhưng backend vẫn còn tasks, giữ snapshot
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

    if (controlState.robotStatus !== "on_task") {
      setDebugAvailability(false);
      return;
    }

    const ok = await ensureDebugCamera();
    if (ok) {
      openCameraDebug();
    }
  });

  $("cameraDebugCloseButton")?.addEventListener("click", closeCameraDebug);

  $("cameraSwitchButton")?.addEventListener("click", async () => {
    if (controlState.robotStatus !== "on_task") {
      setMessage("Chỉ đổi camera khi robot đang ON TASK.", true);
      return;
    }

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
        button.disabled = controlState.robotStatus !== "on_task";
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
    alert("tính năng hỗ trợ chưa phát triển");
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
    mqttBridge.close();
  });

  async function boot() {
    setDebugAvailability(false);
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
    preparePermissions,
    manualTurn,
    manualSteer,
    manualLineFollow,
    manualStop,
    startOfficialRoute,
    officialRouteSession
  };
})();
