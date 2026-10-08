(() => {
  // =====================================================
  // CONFIG
  // =====================================================

  const API =
    window.APP_CONFIG
      .API_BASE_URL
      .replace(/\/+$/, "");

  const $ =
    (id) =>
      document.getElementById(id);

  const state = {
    robot:
      Number(
        window.APP_CONFIG
          .DEFAULT_ROBOT || 1
      ),

    live: null,

    robots: {},

    // Presence hiển thị trực tiếp từ heartbeat MQTT của frontend,
    // không đọc field alive từ backend để quyết định UI.
    robotAlive: {},
    robotAliveMeta: {},

    statusRefreshing: false,

    statusRefreshTimer: null,

    // Wake phrase chạy độc lập với Gemini Live. Khi Gemini đang nghe,
    // SpeechRecognition này sẽ được pause để tránh tranh microphone.
    wakeRecognition: null,
    wakeShouldListen: false,
    wakeActive: false,
    wakeRestartTimer: null,

    logs: [],

    // Ghép một yêu cầu nói tự động của robot với turnComplete tương ứng.
    pendingRobotSpeechTags: []
  };

  // =====================================================
  // TOKEN
  // =====================================================

  function getToken() {
    return (
      localStorage.getItem(
        "restaurant_access_token"
      ) || ""
    );
  }

  function setToken(token) {
    localStorage.setItem(
      "restaurant_access_token",
      token
    );
  }

  function clearToken() {
    localStorage.removeItem(
      "restaurant_access_token"
    );

    localStorage.removeItem(
      "restaurant_user"
    );
  }

  // =====================================================
  // API
  // =====================================================

  async function api(
    path,
    options = {},
    auth = true
  ) {
    const headers = {
      "Content-Type":
        "application/json",

      ...(options.headers || {})
    };

    const token =
      getToken();

    if (
      auth &&
      token
    ) {
      headers.Authorization =
        `Bearer ${token}`;
    }

    let response;

    try {
      response =
        await fetch(
          API + path,
          {
            ...options,
            headers
          }
        );
    } catch (error) {
      const networkError =
        new Error(
          "Không kết nối được tới backend."
        );

      networkError.network =
        true;

      throw networkError;
    }

    const data =
      await response
        .json()
        .catch(() => ({}));

    if (!response.ok) {
      const error =
        new Error(
          data.detail ||
          data.message ||
          `HTTP ${response.status}`
        );

      error.status =
        response.status;

      error.data =
        data;

      throw error;
    }

    return data;
  }

  // =====================================================
  // DEBUG LOG
  // =====================================================

  function log(message) {
    const time =
      new Date()
        .toLocaleTimeString();

    state.logs.push(
      `[${time}] ${message}`
    );

    if (
      state.logs.length > 80
    ) {
      state.logs.splice(
        0,
        state.logs.length - 80
      );
    }

    $("debugLog").textContent =
      state.logs.join("\n");

    $("debugLog").scrollTop =
      $("debugLog").scrollHeight;
  }

  // =====================================================
  // LOGIN OVERLAY
  // =====================================================

  function showLogin(
    message = ""
  ) {
    $("loginOverlay")
      .classList
      .remove("hidden");

    $("loginError")
      .textContent =
      message;
  }

  function hideLogin() {
    $("loginOverlay")
      .classList
      .add("hidden");

    $("loginError")
      .textContent =
      "";
  }

  // =====================================================
  // INVALID SESSION
  // =====================================================

  function invalidateSession(
    message =
      "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại."
  ) {
    if (state.live) {
      state.live.close();
      state.live = null;
    }

    pauseWakeRecognition();

    clearToken();

    showLogin(
      message
    );

    setMode(
      "closed"
    );

    log(
      "AUTH: " +
      message
    );
  }

  // =====================================================
  // UI MODE
  // =====================================================

  function setMode(mode) {
    const stage =
      $("faceStage");

    const dot =
      $("liveDot");

    const button =
      $("commandButton");

    stage.classList.remove(
      "speaking"
    );

    dot.className =
      "dot";

    button.classList.remove(
      "active"
    );

    const map = {
      connecting: [
        "ĐANG KẾT NỐI",
        "Đang mở Gemini Live..."
      ],

      ready: [
        "SẴN SÀNG",
        "Gemini Live đã sẵn sàng."
      ],

      listening: [
        "ĐANG NGHE",
        "Tôi đang nghe lệnh giao món."
      ],

      thinking: [
        "ĐANG KIỂM TRA",
        "Đang kiểm tra dữ liệu bàn và món."
      ],

      speaking: [
        "ĐANG TRẢ LỜI",
        "Gemini đang trả lời..."
      ],

      error: [
        "LỖI",
        "Không thể kết nối Gemini Live."
      ],

      closed: [
        "CHỜ LỆNH",
        "Nói “nhân viên phục vụ” hoặc nhấn Nhận lệnh."
      ]
    };

    const [
      label,
      status
    ] =
      map[mode] ||
      map.ready;

    $("speechLabel")
      .textContent =
      label;

    $("sessionStatus")
      .textContent =
      status;

    // ===============================================
    // DOT
    // ===============================================

    if (
      mode === "connecting" ||
      mode === "ready" ||
      mode === "thinking" ||
      mode === "speaking"
    ) {
      dot.classList.add(
        "online"
      );
    }

    if (
      mode === "listening"
    ) {
      dot.classList.add(
        "listening"
      );

      button.classList.add(
        "active"
      );
    }

    if (
      mode === "error"
    ) {
      dot.classList.add(
        "error"
      );
    }

    // ===============================================
    // FACE
    // ===============================================

    if (
      mode === "speaking"
    ) {
      stage.classList.add(
        "speaking"
      );
    }

    // ===============================================
    // BUTTON
    // ===============================================

    if (
      mode === "listening"
    ) {
      button
        .querySelector("strong")
        .textContent =
        "DỪNG NGHE";

      button
        .querySelector("small")
        .textContent =
        "Đóng microphone";
    } else {
      button
        .querySelector("strong")
        .textContent =
        "NHẬN LỆNH";

      button
        .querySelector("small")
        .textContent =
        "Bật Gemini Live";
    }
  }

  // =====================================================
  // TRANSCRIPT
  // =====================================================

  function transcript(
    role,
    text
  ) {
    const value =
      String(text || "")
        .trim();

    if (!value) {
      return;
    }

    const div =
      document.createElement(
        "div"
      );

    div.className =
      `msg ${role}`;

    const small =
      document.createElement(
        "small"
      );

    small.textContent =
      role === "user"
        ? "Bạn"
        : "Robot";

    const paragraph =
      document.createElement(
        "p"
      );

    paragraph.textContent =
      value;

    div.appendChild(
      small
    );

    div.appendChild(
      paragraph
    );

    $("transcript")
      .appendChild(div);

    $("transcript")
      .scrollTop =
      $("transcript")
        .scrollHeight;

    if (
      role ===
      "assistant"
    ) {
      $("assistantText")
        .textContent =
        value;
    }

    if (role === "user") {
      window.dispatchEvent(
        new CustomEvent("robot:user-transcript", {
          detail: { text: value }
        })
      );
    }
  }

  // =====================================================
  // ROUTE
  // =====================================================

  function showRoute(
    result
  ) {
    const route =
      result?.route;

    if (!route) {
      return;
    }

    $("routeEmpty").hidden =
      true;

    $("routeContent").hidden =
      false;

    $("routeFood")
      .textContent =
      result?.item?.food_name ||
      result?.food_name ||
      result?.requested_food ||
      "Món ăn";

    $("routeTable")
      .textContent =
      route.table ??
      result.table ??
      result.table_number ??
      "-";

    $("routeLine")
      .textContent =
      `Line ${route.line}`;

    $("routeTurn")
      .textContent =
      route.junction_turn_vi ||
      route.junction_turn ||
      "-";

    $("routeStop")
      .textContent =
      route.stop_index ?? "-";
  }

  // =====================================================
  // GEMINI TOOL RESULT
  // =====================================================

  function toolResult(
    name,
    result
  ) {
    log(
      `RESULT ${name} ` +
      JSON.stringify(result)
        .slice(0, 1500)
    );

    showRoute(
      result
    );

    // ===============================================
    // CHECK FOOD
    // ===============================================

    if (
      name ===
      "check_table_food"
    ) {
      if (!result.found) {
        $("assistantText")
          .textContent =
          `Bàn ${result.table_number} ` +
          `không có món ` +
          `${result.requested_food}.`;
      }

      if (
        result.found &&
        !result.deliverable
      ) {
        $("assistantText")
          .textContent =
          result.message ||
          "Món chưa sẵn sàng để giao.";
      }
    }

    // ===============================================
    // PREPARE DELIVERY
    // Gemini chỉ nhận nhiệm vụ. Chưa dispatch database/MQTT.
    // RobotControl sẽ chờ topic/mon từ ESP32 báo current=0 rồi mới thực hiện dispatch.
    // ===============================================

    if (
      name ===
      "prepare_delivery"
    ) {
      if (result?.accepted) {
        const turn =
          result.route
            ?.junction_turn_vi ||
          result.route
            ?.junction_turn ||
          "";

        $("assistantText")
          .textContent =
          `Đã nhận yêu cầu ${result.food_name} tới bàn ${result.table}. ` +
          `Line ${result.route?.line ?? "-"} ${turn}. ` +
          (result.has_food_frontend === true
            ? "Món đã có trên robot."
            : "Hãy mau đặt món lên robot.");

        window.dispatchEvent(
          new CustomEvent(
            "robot:prepare-delivery",
            { detail: result }
          )
        );
      } else if (result?.message) {
        $("assistantText").textContent = result.message;
      }
    }

    if (name === "prepare_task_replacement") {
      if (result?.accepted) {
        window.dispatchEvent(
          new CustomEvent("robot:prepare-task-replacement", { detail: result })
        );
      } else if (result?.message) {
        $("assistantText").textContent = result.message;
      }
    }

    if (name === "start_delivery") {
      if (result?.accepted) {
        window.dispatchEvent(
          new CustomEvent("robot:start-delivery-request", { detail: result })
        );
      } else if (result?.message) {
        $("assistantText").textContent = result.message;
      }
    }

    if (name === "finish_table_support") {
      if (result?.accepted) {
        window.dispatchEvent(
          new CustomEvent("robot:finish-table-support", { detail: result })
        );
      }
    }
  }

  // =====================================================
  // GEMINI EPHEMERAL TOKEN
  // =====================================================

  async function getGeminiToken() {
    try {
      return await api(
        "/robot-ai/gemini-token",
        {
          method: "POST",
          body: "{}"
        }
      );
    } catch (error) {
      if (
        error.status === 401
      ) {
        invalidateSession();

        throw new Error(
          "Phiên đăng nhập đã hết hạn."
        );
      }

      throw error;
    }
  }

  // =====================================================
  // LOCAL WAKE PHRASE: "NHÂN VIÊN PHỤC VỤ"
  // =====================================================
  // Chỉ dùng để mở Gemini Live. Khi Gemini đang nghe, wake recognizer được
  // dừng để không tranh microphone. Nếu trình duyệt không hỗ trợ Web Speech
  // API thì nút "Nhận lệnh" vẫn hoạt động bình thường.

  function normalizeWakeText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isWakePhrase(text) {
    return normalizeWakeText(text)
      .includes("nhan vien phuc vu");
  }

  function getSpeechRecognitionClass() {
    return (
      window.SpeechRecognition ||
      window.webkitSpeechRecognition ||
      null
    );
  }

  function clearWakeRestartTimer() {
    if (!state.wakeRestartTimer) {
      return;
    }

    clearTimeout(state.wakeRestartTimer);
    state.wakeRestartTimer = null;
  }

  function scheduleWakeRestart(delay = 500) {
    clearWakeRestartTimer();

    if (!state.wakeShouldListen) {
      return;
    }

    state.wakeRestartTimer = window.setTimeout(() => {
      state.wakeRestartTimer = null;
      startWakeRecognition();
    }, delay);
  }

  function ensureWakeRecognition() {
    if (state.wakeRecognition) {
      return state.wakeRecognition;
    }

    const SpeechRecognition =
      getSpeechRecognitionClass();

    if (!SpeechRecognition) {
      return null;
    }

    const recognition =
      new SpeechRecognition();

    recognition.lang = "vi-VN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      state.wakeActive = true;
      log('WAKE: đang chờ câu "nhân viên phục vụ"');
    };

    recognition.onresult = (event) => {
      for (
        let i = event.resultIndex;
        i < event.results.length;
        i++
      ) {
        const transcript =
          event.results[i]?.[0]?.transcript || "";

        if (!isWakePhrase(transcript)) {
          continue;
        }

        log(`WAKE detected: ${transcript}`);

        // Dừng wake recognizer trước khi Gemini xin microphone.
        pauseWakeRecognition();

        activateGeminiListening("wake")
          .catch((error) => {
            setMode("error");
            $("assistantText").textContent = error.message;
            log("WAKE START ERROR: " + error.message);
            resumeWakeRecognition();
          });

        break;
      }
    };

    recognition.onerror = (event) => {
      const error = String(event.error || "unknown");

      state.wakeActive = false;

      // Permission bị từ chối thì không restart liên tục.
      if (
        error === "not-allowed" ||
        error === "service-not-allowed"
      ) {
        state.wakeShouldListen = false;
        log("WAKE disabled: microphone/speech permission denied");
        return;
      }

      if (error !== "aborted" && error !== "no-speech") {
        log("WAKE ERROR: " + error);
      }
    };

    recognition.onend = () => {
      state.wakeActive = false;

      if (state.wakeShouldListen) {
        scheduleWakeRestart();
      }
    };

    state.wakeRecognition = recognition;
    return recognition;
  }

  function startWakeRecognition() {
    if (
      !state.wakeShouldListen ||
      !getToken() ||
      state.live?.mic ||
      state.live?.wantMic ||
      state.wakeActive
    ) {
      return;
    }

    const recognition =
      ensureWakeRecognition();

    if (!recognition) {
      // Không coi là lỗi chức năng: người dùng vẫn có nút Nhận lệnh.
      return;
    }

    try {
      recognition.start();
    } catch (error) {
      // InvalidStateError thường chỉ có nghĩa recognition đang start/end.
      if (error?.name !== "InvalidStateError") {
        log("WAKE START ERROR: " + error.message);
      }
    }
  }

  function pauseWakeRecognition() {
    state.wakeShouldListen = false;
    clearWakeRestartTimer();

    const recognition =
      state.wakeRecognition;

    if (!recognition) {
      return;
    }

    try {
      recognition.abort();
    } catch (_) {}

    state.wakeActive = false;
  }

  function resumeWakeRecognition() {
    if (!getToken()) {
      return;
    }

    state.wakeShouldListen = true;
    scheduleWakeRestart(250);
  }

  async function activateGeminiListening(source = "button") {
    if (!getToken()) {
      if (source === "button") {
        showLogin(
          "Hãy đăng nhập trước khi sử dụng Gemini."
        );
      }
      return;
    }

    pauseWakeRecognition();

    try {
      const live = getLive();

      if (!live.mic) {
        await live.startMic();
      }

      // Chỉ khi phiên được mở bằng wake phrase "nhân viên phục vụ",
      // chủ động tạo một turn ẩn để Gemini chào ngay sau khi kết nối.
      // Nút Nhận lệnh không tự phát câu chào này.
      if (source === "wake") {
        await live.sendText(
          'Bạn vừa được gọi bằng câu "nhân viên phục vụ". Hãy chỉ đáp đúng một câu: "Dạ em đây ạ." Sau đó tiếp tục lắng nghe người dùng.',
          {
            showTranscript: false
          }
        );
      }
    } catch (error) {
      resumeWakeRecognition();
      throw error;
    }
  }

  // =====================================================
  // LIVE INSTANCE
  // =====================================================

  function getLive() {
    if (state.live) {
      return state.live;
    }

    state.live =
      new GeminiRobotLive({
        apiBase:
          API,

        getToken:
          getGeminiToken,

        getRobotNumber:
          () => state.robot,

        getRobotContext:
          () => {
            const key = robotKey();
            const robot = state.robots[key] || {};
            const foodLabel =
              $("robotFoodState")?.textContent?.trim() || "";

            let hasFoodFrontend = null;

            if (foodLabel === "CÓ MÓN") {
              hasFoodFrontend = true;
            } else if (foodLabel === "KHÔNG CÓ MÓN") {
              hasFoodFrontend = false;
            }

            return {
              robot_number: Number(state.robot),
              robot_key: key,
              alive: selectedRobotAliveState(),
              alive_meta: state.robotAliveMeta[key] || {},
              status: String(robot.status || "available").toLowerCase(),
              robot,
              all_robots: state.robots,
              has_food_frontend: hasFoodFrontend,
              food_state_label: foodLabel
            };
          },

        onState:
          setMode,

        onTranscript:
          transcript,

        onToolResult:
          toolResult,

        onDebug:
          log,

        onLevel:
          () => {},

        onStopListening:
          () => {
            log("GEMINI stop_listening -> wake mode");
            resumeWakeRecognition();
          },

        onTurnComplete:
          () => {
            const tag = state.pendingRobotSpeechTags.shift() || "";

            window.dispatchEvent(
              new CustomEvent("robot:gemini-turn-complete", {
                detail: { tag }
              })
            );

            if (tag) {
              window.dispatchEvent(
                new CustomEvent("robot:speech-complete", {
                  detail: { tag }
                })
              );

              // Các câu tự động với mic đã tắt tạm pause wake phrase để phát loa
              // sạch hơn. Sau khi audio phát xong thì cho wake phrase hoạt động lại.
              if (!state.live?.mic) {
                resumeWakeRecognition();
              }
            }
          }
      });

    return state.live;
  }

  // =====================================================
  // VALIDATE CURRENT LOGIN
  // =====================================================

  async function validateLogin() {
    if (!getToken()) {
      return false;
    }

    try {
      const user =
        await api(
          "/auth/me"
        );

      localStorage.setItem(
        "restaurant_user",
        JSON.stringify(user)
      );

      return true;

    } catch (error) {
      if (
        error.status === 401
      ) {
        clearToken();

        return false;
      }

      // Nếu lỗi network thì không xóa JWT,
      // vì token có thể vẫn đúng.
      throw error;
    }
  }

  // =====================================================
  // ROBOT-AI STATUS
  // =====================================================

  function robotKey(
    robotNumber = state.robot
  ) {
    return `robot_${Number(robotNumber)}`;
  }

  function robotAliveLabel(alive) {
    return String(alive || "disconnected").toLowerCase() === "alive"
      ? "ALIVE"
      : "DISCONNECT";
  }

  function robotAliveClass(alive) {
    return String(alive || "disconnected").toLowerCase() === "alive"
      ? "good"
      : "bad";
  }

  function robotWorkLabel(status) {
    const value =
      String(status || "disconnected")
        .toLowerCase();

    if (value === "available") {
      return "AVAILABLE";
    }

    if (value === "received_task") {
      return "RECEIVED TASK";
    }

    if (value === "on_task") {
      return "ON TASK";
    }

    if (value === "on_target") {
      return "ON TARGET";
    }

    if (value === "on_home" || value === "come_back") {
      return "ON HOME";
    }

    if (value === "abnormal_behavior") {
      return "ABNORMAL BEHAVIOR";
    }

    return "-";
  }

  function robotWorkClass(status) {
    const value =
      String(status || "disconnected")
        .toLowerCase();

    if (value === "available") {
      return "good";
    }

    if (
      value === "received_task" ||
      value === "on_task" ||
      value === "on_target" ||
      value === "on_home" ||
      value === "come_back"
    ) {
      return "warn";
    }

    if (value === "abnormal_behavior") {
      return "bad";
    }

    return "muted";
  }

  function formatHeartbeat(value) {
    if (!value) {
      return "chưa có heartbeat";
    }

    const time = new Date(value);

    if (Number.isNaN(time.getTime())) {
      return "heartbeat không hợp lệ";
    }

    return (
      "heartbeat " +
      time.toLocaleTimeString(
        "vi-VN",
        {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }
      )
    );
  }

  function selectedRobotAliveState() {
    return String(
      state.robotAlive[robotKey()] || "disconnected"
    ).toLowerCase();
  }

  function renderSelectedRobotAlive() {
    const aliveElement = $("robotAliveState");
    if (!aliveElement) return;

    const alive = selectedRobotAliveState();
    aliveElement.textContent = robotAliveLabel(alive);
    aliveElement.className = `robot-state ${robotAliveClass(alive)}`;

    const meta = state.robotAliveMeta[robotKey()] || {};
    const parts = [];

    if (Number(meta.lastRobotMessageAt) > 0) {
      const ageSeconds = Math.max(
        0,
        Math.floor((Date.now() - Number(meta.lastRobotMessageAt)) / 1000)
      );
      parts.push(`Robot MQTT: ${ageSeconds}s trước`);

      if (meta.lastRobotTopic) {
        parts.push(`topic: ${meta.lastRobotTopic}`);
      }
    } else {
      parts.push("Chưa nhận message từ robot");
    }

    if (meta.awaitingResponse) {
      parts.push("đang chờ phản hồi sau topic/req=1");
    } else {
      parts.push("probe sau 30s im lặng");
    }

    const metaElement = $("robotPresenceMeta");
    if (metaElement) {
      metaElement.textContent = parts.join(" · ");
    }
  }

  function renderSelectedRobotStatus() {
    const robot =
      state.robots[
        robotKey()
      ] || {};

    const status =
      String(
        robot.status ||
        "disconnected"
      ).toLowerCase();

    const titleElement =
      $("robotState");

    const workElement =
      $("robotWorkState");

    titleElement.textContent =
      `Robot ${state.robot}`;

    // Alive được render từ state local do MQTT frontend cập nhật.
    renderSelectedRobotAlive();

    workElement.textContent =
      robotWorkLabel(status);

    workElement.className =
      `robot-state ${robotWorkClass(status)}`;

    // Presence meta được render bởi renderSelectedRobotAlive().


    // KHÔNG cập nhật robotFoodState từ /robot-ai/status.
    // Trạng thái món trên giao diện chỉ lấy trực tiếp từ ESP32 qua topic/mon.
    // Backend/Firebase chỉ lưu trữ has_food và không được ghi đè UI.

    // Thông báo cho robot-control.js biết status mới nhất để
    // bật/tắt nút DEBUG CAMERA.
    window.dispatchEvent(
      new CustomEvent(
        "robot:status-updated",
        {
          detail: {
            robot: state.robot,
            status,
            has_food: robot.has_food === true,
            robotData: robot
          }
        }
      )
    );

    const task =
      robot.tasks;

    const hasTask =
      task &&
      typeof task === "object" &&
      !Array.isArray(task) &&
      Object.keys(task).length > 0;

    $("robotTaskCard")
      .hidden =
      !hasTask;

    if (!hasTask) {
      $("robotTaskFood")
        .textContent = "-";

      $("robotTaskTable")
        .textContent = "-";

      $("robotTaskLine")
        .textContent = "-";

      $("robotTaskTurn")
        .textContent = "-";

      $("robotTaskStop")
        .textContent = "-";

      return;
    }

    $("robotTaskFood")
      .textContent =
      task.food_name ||
      "Món ăn";

    $("robotTaskTable")
      .textContent =
      task.table ?? "-";

    $("robotTaskLine")
      .textContent =
      task.line != null
        ? `Line ${task.line}`
        : "-";

    $("robotTaskTurn")
      .textContent =
      task.junction_turn_vi ||
      task.junction_turn ||
      "-";

    $("robotTaskStop")
      .textContent =
      task.stop_index ?? "-";
  }

  async function refreshStatus(
    { silent = false } = {}
  ) {
    if (state.statusRefreshing) {
      return;
    }

    state.statusRefreshing = true;

    try {
      const data =
        await api(
          "/robot-ai/status"
        );

      $("backendState")
        .textContent =
        "Online";

      $("backendState")
        .className =
        "good";

      // ===============================================
      // GEMINI
      // ===============================================

      if (
        data.gemini_configured
      ) {
        $("geminiState")
          .textContent =
          data.gemini_model;

        $("geminiState")
          .className =
          "good";
      } else {
        $("geminiState")
          .textContent =
          "Chưa cấu hình key";

        $("geminiState")
          .className =
          "bad";
      }

      // ===============================================
      // MQTT
      // ===============================================

      if (
        data.mqtt_connected
      ) {
        $("mqttState")
          .textContent =
          "Connected";

        $("mqttState")
          .className =
          "good";
      } else if (
        data.mqtt_configured
      ) {
        $("mqttState")
          .textContent =
          "Disconnected";

        $("mqttState")
          .className =
          "warn";
      } else {
        $("mqttState")
          .textContent =
          "Chưa cấu hình";

        $("mqttState")
          .className =
          "warn";
      }

      state.robots =
        data.robots || {};

      renderSelectedRobotStatus();

      if (!silent) {
        log(
          "STATUS OK " +
          JSON.stringify(data)
        );
      }

    } catch (error) {
      // ===============================================
      // JWT INVALID
      // ===============================================

      if (
        error.status === 401
      ) {
        /*
         * Backend thực tế vẫn online.
         * Chỉ có JWT bị lỗi.
         */
        $("backendState")
          .textContent =
          "Online";

        $("backendState")
          .className =
          "good";

        invalidateSession(
          "Phiên đăng nhập không hợp lệ hoặc đã hết hạn."
        );

        return;
      }

      // ===============================================
      // NETWORK / BACKEND DOWN
      // ===============================================

      $("backendState")
        .textContent =
        "Offline";

      $("backendState")
        .className =
        "bad";

      if (!silent) {
        log(
          "STATUS ERROR: " +
          error.message
        );
      }
    } finally {
      state.statusRefreshing = false;
    }
  }

  function startStatusPolling() {
    if (state.statusRefreshTimer) {
      return;
    }

    state.statusRefreshTimer =
      window.setInterval(
        () => {
          if (
            getToken() &&
            document.visibilityState !== "hidden"
          ) {
            refreshStatus({
              silent: true
            });
          }
        },
        5000
      );
  }

  // =====================================================
  // LOGIN
  // =====================================================

  async function login(
    username,
    password
  ) {
    const data =
      await api(
        "/auth/login",
        {
          method: "POST",

          body:
            JSON.stringify({
              username:
                username,

              password:
                password
            })
        },

        false
      );

    if (
      !data.access_token
    ) {
      throw new Error(
        "Backend không trả access_token."
      );
    }

    setToken(
      data.access_token
    );

    localStorage.setItem(
      "restaurant_user",
      JSON.stringify(
        data.user || {}
      )
    );

    hideLogin();

    log(
      "LOGIN SUCCESS"
    );

    await refreshStatus();

    resumeWakeRecognition();
  }

  // =====================================================
  // RESET ROBOT
  // =====================================================

  async function resetSelectedRobot() {
    const robotNumber = Number(state.robot || 1);
    const robot = state.robots[robotKey()] || {};
    const task = robot?.tasks;
    const hasTask = Boolean(
      task &&
      typeof task === "object" &&
      !Array.isArray(task) &&
      Object.keys(task).length > 0
    );

    const taskDescription = hasTask
      ? `\nNhiệm vụ hiện tại: ${task.food_name || task.item_name || task.task_type || "task"}` +
        `${task.table != null ? ` → bàn ${task.table}` : ""}.`
      : "\nRobot hiện không có task trong dữ liệu frontend.";

    const confirmed = window.confirm(
      `Bạn có chắc muốn RESET Robot ${robotNumber}?` +
      taskDescription +
      `\n\nSau khi xác nhận, robot sẽ được gửi lệnh STOP, task sẽ bị xóa trong database và Work sẽ trở về AVAILABLE.` +
      `\nNếu đây là task giao món chưa hoàn tất, trạng thái dispatch của món cũng sẽ được rollback để có thể giao lại.`
    );

    // Không gửi STOP, không xóa state local và không update database trước confirm.
    if (!confirmed) return;

    const resetButtons = [$("resetRobotButton"), $("topMenuResetButton")].filter(Boolean);
    resetButtons.forEach((button) => { button.disabled = true; });

    try {
      // Dừng robot trước khi xóa task DB để robot không tiếp tục chạy với task đã mất.
      try {
        window.ROBOT_CONTROL?.stop?.("RESET ROBOT");
      } catch (_) {}

      const result = await api(
        "/robot-ai/reset",
        {
          method: "POST",
          body: JSON.stringify({ robot: robotNumber })
        }
      );

      // Backend đã reset thành công: lúc này mới xóa snapshot task/pending local.
      try {
        window.ROBOT_CONTROL?.resetRuntimeStateAfterServerReset?.();
      } catch (_) {}

      const key = `robot_${robotNumber}`;
      state.robots[key] = {
        ...(state.robots[key] || {}),
        ...(result?.robot_state || {}),
        status: "available",
        tasks: ""
      };

      renderSelectedRobotStatus();
      await refreshStatus({ silent: true });

      const rollbackText = result?.item_rolled_back
        ? " Món đang dispatch đã được trả về trạng thái chờ để có thể giao lại."
        : "";
      alert(`Đã reset Robot ${robotNumber}: xóa task và đưa Work về AVAILABLE.${rollbackText}`);
      log(`RESET ROBOT SUCCESS robot=${robotNumber} rolled_back=${Boolean(result?.item_rolled_back)}`);
    } catch (error) {
      log(`RESET ROBOT ERROR robot=${robotNumber}: ${error.message}`);
      alert(`Reset Robot ${robotNumber} thất bại: ${error.message}`);
      try { await refreshStatus({ silent: true }); } catch (_) {}
    } finally {
      resetButtons.forEach((button) => { button.disabled = false; });
    }
  }

  // =====================================================
  // LOGOUT
  // =====================================================

  async function logout(
    callBackend = true
  ) {
    const token =
      getToken();

    if (
      callBackend &&
      token
    ) {
      try {
        await api(
          "/auth/logout",
          {
            method: "POST",
            body: "{}"
          }
        );
      } catch (_) {
        // Dù backend logout lỗi,
        // browser vẫn xóa local token.
      }
    }

    pauseWakeRecognition();

    if (state.live) {
      state.live.close();
      state.live = null;
    }

    clearToken();

    showLogin();

    setMode(
      "closed"
    );
  }

  // =====================================================
  // LOGIN FORM
  // =====================================================

  $("loginForm")
    .addEventListener(
      "submit",
      async (event) => {
        event.preventDefault();

        const username =
          $("usernameInput")
            .value
            .trim();

        const password =
          $("passwordInput")
            .value;

        $("loginError")
          .textContent =
          "";

        $("loginButton")
          .disabled =
          true;

        $("loginButton")
          .textContent =
          "Đang đăng nhập...";

        try {
          await login(
            username,
            password
          );
        } catch (error) {
          $("loginError")
            .textContent =
            error.message;
        } finally {
          $("loginButton")
            .disabled =
            false;

          $("loginButton")
            .textContent =
            "Đăng nhập";
        }
      }
    );

  // =====================================================
  // LOGOUT BUTTON
  // =====================================================

  $("logoutButton")
    .addEventListener(
      "click",
      () => {
        logout(true);
      }
    );

  // =====================================================
  // RESET BUTTONS (desktop + mobile menu)
  // =====================================================

  $("resetRobotButton")?.addEventListener("click", () => {
    void resetSelectedRobot();
  });

  $("topMenuResetButton")?.addEventListener("click", () => {
    void resetSelectedRobot();
  });

  // =====================================================
  // ROBOT SELECT
  // =====================================================

  $("robotSelect")
    .value =
    String(
      state.robot
    );

  $("robotSelect")
    .addEventListener(
      "change",
      () => {
        state.robot =
          Number(
            $("robotSelect")
              .value
          );

        renderSelectedRobotStatus();

        refreshStatus({
          silent: true
        });

        log(
          `SELECT Robot ${state.robot}`
        );

        window.dispatchEvent(
          new CustomEvent(
            "robot:selected",
            { detail: { robot: state.robot } }
          )
        );
      }
    );

  // =====================================================
  // VOICE BUTTON
  // =====================================================

  $("commandButton")
    .addEventListener(
      "click",
      async () => {
        if (!getToken()) {
          showLogin(
            "Hãy đăng nhập trước khi sử dụng Gemini."
          );

          return;
        }

        try {
          // Mobile browsers may keep AudioContext suspended unless it is resumed
          // from a direct user gesture. This only unlocks playback; Gemini logic
          // and automatic VAD remain unchanged.
          if (window.RobotAudio?.unlock) {
            await window.RobotAudio.unlock();
          }

          const live =
            getLive();

          if (live.mic) {
            // Nhấn lần nữa = kết thúc hẳn phiên và quay về chờ wake phrase.
            live.close();
            setMode("closed");
            resumeWakeRecognition();
          } else {
            await activateGeminiListening("button");
          }

        } catch (error) {
          if (
            error.status === 401
          ) {
            invalidateSession();

            return;
          }

          setMode(
            "error"
          );

          $("assistantText")
            .textContent =
            error.message;

          log(
            "MIC ERROR: " +
            error.message
          );
        }
      }
    );

  // =====================================================
  // DEBUG TEXT
  // =====================================================

  $("sendDebugButton")
    .addEventListener(
      "click",
      async () => {
        if (!getToken()) {
          showLogin(
            "Hãy đăng nhập trước khi test Gemini."
          );

          return;
        }

        const text =
          $("debugText")
            .value
            .trim();

        if (!text) {
          return;
        }

        try {
          await getLive()
            .sendText(
              text
            );

        } catch (error) {
          if (
            error.status === 401
          ) {
            invalidateSession();

            return;
          }

          setMode(
            "error"
          );

          $("assistantText")
            .textContent =
            error.message;

          log(
            "TEXT ERROR: " +
            error.message
          );
        }
      }
    );

  $("debugText")
    .addEventListener(
      "keydown",
      (event) => {
        if (
          event.key ===
          "Enter"
        ) {
          event.preventDefault();

          $("sendDebugButton")
            .click();
        }
      }
    );

  // =====================================================
  // ROBOT AUTOMATIC SPEECH / CONTROL EVENTS
  // =====================================================

  async function speakRobotText(detail = {}) {
    const text = String(detail.text || "").trim();
    const tag = String(detail.tag || "").trim();
    const listen = detail.listen === true;

    if (!text) return;

    try {
      pauseWakeRecognition();

      const live = getLive();

      if (listen) {
        if (!live.mic) {
          await live.startMic();
        }
      } else {
        await live.connect();
      }

      if (tag) {
        state.pendingRobotSpeechTags.push(tag);
      }

      const quotedText = JSON.stringify(text);
      await live.sendText(
        `Hãy chỉ nói đúng nguyên văn câu sau, không thêm hoặc bớt nội dung: ${quotedText}`,
        { showTranscript: false }
      );
    } catch (error) {
      if (tag) {
        const index = state.pendingRobotSpeechTags.indexOf(tag);
        if (index >= 0) state.pendingRobotSpeechTags.splice(index, 1);
      }

      log(`ROBOT SPEECH ERROR tag=${tag || "-"}: ${error.message}`);
      window.dispatchEvent(
        new CustomEvent("robot:speech-failed", {
          detail: { tag, error: error.message }
        })
      );
    }
  }

  window.addEventListener("robot:speak-request", (event) => {
    void speakRobotText(event?.detail || {});
  });

  window.addEventListener("robot:refresh-status", () => {
    void refreshStatus({ silent: true });
  });

  window.addEventListener("robot:stop-gemini-mic", () => {
    try {
      state.live?.stopMic();
    } catch (_) {}
    resumeWakeRecognition();
  });

  // Đóng hẳn Gemini Live khi robot bắt đầu di chuyển. Wake phrase local vẫn
  // được bật lại ngay sau đó, vì vậy ở BẤT KỲ work status nào người dùng vẫn
  // có thể gọi "nhân viên phục vụ" để mở một phiên Live mới.
  window.addEventListener("robot:close-gemini-session", () => {
    try {
      state.live?.close();
    } catch (_) {}

    setMode("closed");
    resumeWakeRecognition();
    log("GEMINI session closed by robot navigation; wake phrase remains active");
  });

  // =====================================================
  // FRONTEND-DRIVEN ROBOT ALIVE
  // =====================================================

  window.addEventListener(
    "robot:alive-local",
    (event) => {
      const detail = event?.detail || {};
      const robotNumber = Number(detail.robot || 0);
      if (!robotNumber) return;

      const key = robotKey(robotNumber);
      state.robotAlive[key] =
        String(detail.alive || "disconnected").toLowerCase() === "alive"
          ? "alive"
          : "disconnected";

      state.robotAliveMeta[key] = {
        lastRobotMessageAt: Number(detail.lastRobotMessageAt || 0),
        lastRobotTopic: String(detail.lastRobotTopic || ""),
        awaitingResponse: Boolean(detail.awaitingResponse),
        probeSentAt: Number(detail.probeSentAt || 0),
        reason: String(detail.reason || "")
      };

      if (robotNumber === Number(state.robot)) {
        renderSelectedRobotAlive();
      }
    }
  );

  // =====================================================
  // ROBOT EYES FOLLOW POINTER
  // =====================================================

  window.addEventListener(
    "pointermove",
    (event) => {
      const head =
        $("robotHead");

      if (!head) {
        return;
      }

      const rect =
        head
          .getBoundingClientRect();

      const centerX =
        rect.left +
        rect.width / 2;

      const centerY =
        rect.top +
        rect.height / 2;

      const dx =
        Math.max(
          -1,
          Math.min(
            1,
            (
              event.clientX -
              centerX
            ) /
            (
              rect.width / 2
            )
          )
        );

      const dy =
        Math.max(
          -1,
          Math.min(
            1,
            (
              event.clientY -
              centerY
            ) /
            (
              rect.height / 2
            )
          )
        );

      document
        .documentElement
        .style
        .setProperty(
          "--look-x",
          `${(dx * 11).toFixed(1)}px`
        );

      document
        .documentElement
        .style
        .setProperty(
          "--look-y",
          `${(dy * 8).toFixed(1)}px`
        );
    },

    {
      passive: true
    }
  );

  document.addEventListener(
    "visibilitychange",
    () => {
      if (
        document.visibilityState === "visible" &&
        getToken()
      ) {
        refreshStatus({
          silent: true
        });
      }
    }
  );

  // =====================================================
  // STARTUP
  // =====================================================

  async function bootstrap() {
    setMode(
      "closed"
    );

    renderSelectedRobotStatus();

    startStatusPolling();

    // Không có token → hiện login.
    if (!getToken()) {
      showLogin();

      return;
    }

    /*
     * QUAN TRỌNG:
     *
     * Không gọi /robot-ai/status ngay bằng JWT cũ.
     * Trước tiên kiểm tra JWT bằng /auth/me.
     */
    try {
      const valid =
        await validateLogin();

      if (!valid) {
        showLogin(
          "Phiên đăng nhập cũ không còn hợp lệ. Hãy đăng nhập lại."
        );

        log(
          "AUTH old JWT invalid"
        );

        return;
      }

      hideLogin();

      await refreshStatus();

      resumeWakeRecognition();

    } catch (error) {
      /*
       * Nếu backend không chạy,
       * vẫn giữ JWT.
       */
      hideLogin();

      $("backendState")
        .textContent =
        "Offline";

      $("backendState")
        .className =
        "bad";

      log(
        "BOOT ERROR: " +
        error.message
      );
    }
  }

  bootstrap();
})();