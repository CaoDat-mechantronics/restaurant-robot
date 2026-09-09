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

    logs: []
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
        "CHƯA KẾT NỐI",
        "Nhấn Nhận lệnh để bắt đầu."
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
    // DISPATCH
    // ===============================================

    if (
      name ===
      "dispatch_delivery"
    ) {
      const turn =
        result.route
          ?.junction_turn_vi ||
        result.route
          ?.junction_turn ||
        "";

      $("assistantText")
        .textContent =
        `Đã gửi ${result.food_name} ` +
        `tới bàn ${result.table}. ` +
        `Line ${result.route?.line ?? "-"} ` +
        `${turn}.`;
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

        onState:
          setMode,

        onTranscript:
          transcript,

        onToolResult:
          toolResult,

        onDebug:
          log,

        onLevel:
          () => {}
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

  async function refreshStatus() {
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

      log(
        "STATUS OK " +
        JSON.stringify(data)
      );

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

      log(
        "STATUS ERROR: " +
        error.message
      );
    }
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

        $("robotState")
          .textContent =
          `Robot ${state.robot}`;

        log(
          `SELECT Robot ${state.robot}`
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
          const live =
            getLive();

          if (live.mic) {
            live.stopMic();
          } else {
            await live.startMic();
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

  // =====================================================
  // STARTUP
  // =====================================================

  async function bootstrap() {
    setMode(
      "closed"
    );

    $("robotState")
      .textContent =
      `Robot ${state.robot}`;

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