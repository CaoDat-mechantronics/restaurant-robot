window.APP_CONFIG = {
  API_BASE_URL: "https://restaurant-api-t6pq.onrender.com",
  DEFAULT_ROBOT: 1,
  GEMINI_WS_BASE: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",

  // =====================================================
  // HIVEMQ CLOUD - FRONTEND MQTT OVER WEBSOCKET
  // =====================================================
  // Nên tạo 1 MQTT user riêng cho frontend, chỉ cấp quyền:
  // SUB: topic1/status, topic1/sensors, topic2/status, topic2/sensors
  // PUB: topic1/task, topic1/motor, topic2/task, topic2/motor
  MQTT_WS_URL: "wss://20d0e023b23d4286a0527539aafdfe1e.s1.eu.hivemq.cloud:8884/mqtt",
  MQTT_USERNAME: "dat.cao",
  MQTT_PASSWORD: "Alc476qu14_99",

  // =====================================================
  // NAVIGATION / CAMERA - LINE DETECTION V2
  // =====================================================
  NAVIGATION: {
    // ---------------------------------------------------
    // CAMERA / TẦN SỐ XỬ LÝ
    // ---------------------------------------------------
    // Mobile/tablet vẫn ưu tiên camera trước; desktop dùng camera mặc định.
    CAMERA_FACING_MODE: "user",

    // Ảnh debug vẫn hiển thị stream đầy đủ; riêng thuật toán line resize
    // xuống 480px để giữ realtime trên điện thoại.
    VISION_ANALYSIS_WIDTH: 480,
    VISION_PROCESS_INTERVAL_MS: 40, // ~25 FPS tối đa

    // QR dùng canvas riêng, độ phân giải cao hơn line detection.
    QR_ANALYSIS_WIDTH: 640,
    QR_SCAN_INTERVAL_MS: 220, // ~4.5 lần/giây

    // ---------------------------------------------------
    // ROI - CHỈ PHÂN TÍCH PHẦN ĐƯỜNG
    // ---------------------------------------------------
    VISION_ROI_TOP_RATIO: 0.40,
    VISION_ROI_BOTTOM_RATIO: 0.97,

    // ---------------------------------------------------
    // OTSU HYBRID THRESHOLD
    // ---------------------------------------------------
    // ROI được chia thành nhiều dải ngang. Mỗi dải tự tính Otsu riêng,
    // sau đó cộng offset nhỏ, clamp + EMA theo thời gian để chống nhảy.
    VISION_THRESHOLD_MODE: "otsu_bands",
    VISION_OTSU_BANDS: 3,
    VISION_OTSU_OFFSET: 8,
    VISION_THRESHOLD_MIN: 28,
    VISION_THRESHOLD_MAX: 145,
    VISION_THRESHOLD_EMA_ALPHA: 0.18,

    // ---------------------------------------------------
    // DARK-RUN + SLIDING WINDOW
    // ---------------------------------------------------
    // Quét nhiều lát ngang từ gần robot lên phía trước để theo cả đường cong.
    VISION_SCAN_ROWS: 15,
    VISION_ROW_HALF_HEIGHT: 2,

    // Một đoạn tối chỉ được coi là candidate line khi có độ rộng hợp lý.
    // Các giá trị là tỷ lệ theo chiều rộng ảnh phân tích.
    VISION_RUN_MIN_RATIO: 0.006,
    VISION_RUN_MAX_RATIO: 0.120,
    VISION_RUN_MIN_DENSITY: 0.56,

    // Sliding-window: frame mới ưu tiên tìm quanh line frame trước / điểm trước.
    VISION_SEARCH_MARGIN_PX: 52,
    VISION_MIN_POINTS_PER_SIDE: 5,
    VISION_POINT_OUTLIER_PX: 20,
    VISION_MAX_FIT_RMS_PX: 18,

    // ---------------------------------------------------
    // LANE GEOMETRY / TEMPORAL TRACKING
    // ---------------------------------------------------
    // Khoảng cách giữa hai biên phải nằm trong giới hạn vật lý hợp lý.
    VISION_LANE_WIDTH_MIN_RATIO: 0.16,
    VISION_LANE_WIDTH_MAX_RATIO: 0.88,

    // So với frame trước, lane width không được nhảy quá vô lý.
    VISION_TEMPORAL_WIDTH_MIN_RATIO: 0.55,
    VISION_TEMPORAL_WIDTH_MAX_RATIO: 1.55,

    // EMA coefficient của đường cong trái/phải giữa các frame.
    VISION_CURVE_EMA_ALPHA: 0.30,

    // Tâm điều khiển được lọc riêng để xe không giật trái/phải liên tục.
    VISION_CENTER_EMA_ALPHA: 0.20,
    VISION_MAX_CENTER_JUMP_PX: 26,

    // Điểm gần dùng để đo lệch ngang và điểm nhìn trước dùng để bắt cua sớm.
    // 0 = đầu ROI (xa), 1 = cuối ROI (gần robot).
    VISION_NEAR_Y_RATIO: 0.88,
    VISION_LOOKAHEAD_Y_RATIO: 0.42,

    // Confidence thấp thì navigation giảm tốc hoặc dừng.
    VISION_MIN_CONFIDENCE: 0.38,
    VISION_SLOW_CONFIDENCE: 0.62,
    VISION_GOOD_CONFIDENCE: 0.78,

    // ---------------------------------------------------
    // LINE FOLLOW CONTROLLER
    // ---------------------------------------------------
    BASE_SPEED: 122,
    MAX_SPEED: 190,
    MIN_CURVE_SPEED: 68,

    // CENTER-LOCK PID:
    // lineError(px) = tâm center curve xanh dương - tâm camera.
    // Kp kéo xe về tâm, Ki bù lệch cơ khí 2 động cơ,
    // Kd hãm dao động; heading/look-ahead giúp bắt cua sớm.
    LINE_KP: 0.26,
    LINE_KI: 0.028,
    LINE_KD: 0.032,
    LINE_KH: 1.05,
    LINE_LOOKAHEAD_KP: 0.055,

    // Sai số <= vùng này được coi là đã nằm trên center line.
    CENTER_DEADBAND_PX: 4,

    // Anti-windup và lọc đạo hàm của PID.
    LINE_INTEGRAL_LIMIT: 120,
    LINE_DERIVATIVE_EMA_ALPHA: 0.22,

    // Không cho correction lái vượt quá mức này (đơn vị PWM).
    MAX_STEERING_CORRECTION: 92,

    // Nếu lệch tâm tới tỷ lệ này của bề rộng frame thì giảm về MIN_CURVE_SPEED.
    CENTER_FULL_SLOWDOWN_RATIO: 0.26,

    // Khi heading lớn, tự giảm BASE_SPEED để vào cua ổn định hơn.
    CURVE_FULL_SLOWDOWN_DEG: 28,

    // Không cho PWM nhảy quá nhiều giữa hai lần publish MQTT.
    // Lệnh STOP khẩn cấp vẫn bỏ qua giới hạn này.
    MOTOR_MAX_DELTA_PER_UPDATE: 20,

    // IR2/IR3 override khi chạm biên.
    BORDER_FAST_SPEED: 145,
    BORDER_SLOW_SPEED: 65,

    // ---------------------------------------------------
    // RẼ Ở NGÃ 3 BẰNG GYRO + REACQUIRE LINE
    // ---------------------------------------------------
    TURN_FAST_SPEED: 145,
    TURN_MEDIUM_SPEED: 105,
    TURN_SLOW_SPEED: 72,
    TURN_START_LINE_SEARCH_DEG: 68,
    TURN_TARGET_DEG: 90,
    TURN_MAX_DEG: 112,

    // QR phải thấy ổn định nhiều lần trước khi coi là ngã 3.
    T_JUNCTION_QR_TEXT: "T-junction",
    T_JUNCTION_STABLE_COUNT: 2,

    // Ngưỡng dừng theo diện tích QR trong toàn bộ frame QR (%).
    // Đo thực nghiệm ở DEBUG CAMERA rồi chỉnh giá trị này.
    T_JUNCTION_STOP_AREA_PERCENT: 12,

    // Nếu mất lane quá lâu thì dừng robot.
    LINE_LOST_STOP_MS: 850,

    // Tần số gửi lệnh motor lên HiveMQ.
    MOTOR_INTERVAL_MS: 70
  }
};
