window.APP_CONFIG = {
  API_BASE_URL: "https://restaurant-api-t6pq.onrender.com",
  DEFAULT_ROBOT: 1,
  GEMINI_WS_BASE: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",

  // =====================================================
  // HIVEMQ CLOUD - FRONTEND MQTT OVER WEBSOCKET
  // =====================================================
  // Ví dụ:
  // MQTT_WS_URL: "wss://xxxxxxxx.s1.eu.hivemq.cloud:8884/mqtt"
  //
  // Nên tạo 1 MQTT user riêng cho frontend, chỉ cấp quyền:
  // SUB: topic1/status, topic1/sensors, topic2/status, topic2/sensors
  // PUB: topic1/task, topic1/motor, topic2/task, topic2/motor
  MQTT_WS_URL: "wss://20d0e023b23d4286a0527539aafdfe1e.s1.eu.hivemq.cloud:8884/mqtt",
  MQTT_USERNAME: "dat.cao",
  MQTT_PASSWORD: "Alc476qu14_99",

  // =====================================================
  // NAVIGATION / CAMERA
  // =====================================================
  NAVIGATION: {
    // Camera trước của điện thoại
    CAMERA_FACING_MODE: "user",

    // Nhận diện 2 vạch băng dính đen
    VISION_DARK_THRESHOLD: 80,
    VISION_MIN_LINE_SCORE: 0.08,

    // Điều khiển bám line
    BASE_SPEED: 125,
    MAX_SPEED: 190,
    LINE_KP: 0.30,

    // IR2/IR3 override khi chạm biên
    BORDER_FAST_SPEED: 145,
    BORDER_SLOW_SPEED: 65,

    // Rẽ ở ngã 3
    TURN_FAST_SPEED: 145,
    TURN_MEDIUM_SPEED: 105,
    TURN_SLOW_SPEED: 72,
    TURN_START_LINE_SEARCH_DEG: 68,
    TURN_TARGET_DEG: 90,
    TURN_MAX_DEG: 112,

    // QR phải thấy ổn định nhiều lần trước khi coi là ngã 3
    T_JUNCTION_QR_TEXT: "T-junction",
    T_JUNCTION_STABLE_COUNT: 2,

    // Ngưỡng dừng theo diện tích QR trong toàn bộ khung hình (%).
    // Ví dụ 12 nghĩa là QR chiếm >= 12% diện tích frame thì robot dừng.
    // Hãy đo thực nghiệm bằng ô "QR diện tích" trong DEBUG CAMERA rồi chỉnh giá trị này.
    T_JUNCTION_STOP_AREA_PERCENT: 12,

    // Nếu mất line quá lâu thì dừng robot
    LINE_LOST_STOP_MS: 900,

    // Tần số gửi lệnh motor lên HiveMQ
    MOTOR_INTERVAL_MS: 70
  }
};
