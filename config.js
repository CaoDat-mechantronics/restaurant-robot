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
    CAMERA_FACING_MODE: "user",

    VISION_ANALYSIS_WIDTH: 480,
    VISION_PROCESS_INTERVAL_MS: 40,

    QR_ANALYSIS_WIDTH: 640,
    QR_SCAN_INTERVAL_MS: 220,

    // ---------------------------------------------------
    // ROI
    // ---------------------------------------------------
    VISION_ROI_TOP_RATIO: 0.40,
    VISION_ROI_BOTTOM_RATIO: 0.97,

    // ---------------------------------------------------
    // OTSU HYBRID THRESHOLD
    // ---------------------------------------------------
    VISION_THRESHOLD_MODE: "otsu_bands",
    VISION_OTSU_BANDS: 3,
    VISION_OTSU_OFFSET: 8,
    VISION_THRESHOLD_MIN: 28,
    VISION_THRESHOLD_MAX: 145,
    VISION_THRESHOLD_EMA_ALPHA: 0.18,

    // ---------------------------------------------------
    // DARK-RUN + SLIDING WINDOW
    // ---------------------------------------------------
    VISION_SCAN_ROWS: 15,
    VISION_ROW_HALF_HEIGHT: 2,

    VISION_RUN_MIN_RATIO: 0.006,
    VISION_RUN_MAX_RATIO: 0.120,
    VISION_RUN_MIN_DENSITY: 0.56,

    VISION_SEARCH_MARGIN_PX: 52,
    VISION_MIN_POINTS_PER_SIDE: 5,
    VISION_POINT_OUTLIER_PX: 20,
    VISION_MAX_FIT_RMS_PX: 18,

    // ---------------------------------------------------
    // LANE GEOMETRY
    // ---------------------------------------------------
    VISION_LANE_WIDTH_MIN_RATIO: 0.16,
    VISION_LANE_WIDTH_MAX_RATIO: 0.88,

    VISION_TEMPORAL_WIDTH_MIN_RATIO: 0.55,
    VISION_TEMPORAL_WIDTH_MAX_RATIO: 1.55,

    VISION_CURVE_EMA_ALPHA: 0.30,

    // ONE-LINE TRACKING
    VISION_LANE_WIDTH_MODEL_ALPHA: 0.16,

    VISION_ONE_LINE_CONFIDENCE_SCALE: 0.82,

    VISION_ONE_LINE_MAX_FRAMES: 45,

    VISION_LOST_PREDICT_FRAMES: 4,
    VISION_LOST_PREDICT_CONFIDENCE: 0.56,

    // Làm mượt center curve
    VISION_CENTER_EMA_ALPHA: 0.20,
    VISION_MAX_CENTER_JUMP_PX: 26,

    // ---------------------------------------------------
    // ĐIỂM ĐIỀU KHIỂN
    // ---------------------------------------------------
    //
    // Near point:
    // điểm xanh gần xe.
    //
    // Look-ahead:
    // điểm HỒNG phía trước.
    //
    // 0 = xa / đầu ROI
    // 1 = gần robot
    //
    VISION_NEAR_Y_RATIO: 0.88,
    VISION_LOOKAHEAD_Y_RATIO: 0.42,

    // ---------------------------------------------------
    // CONFIDENCE
    // ---------------------------------------------------
    VISION_MIN_CONFIDENCE: 0.38,
    VISION_SLOW_CONFIDENCE: 0.62,
    VISION_GOOD_CONFIDENCE: 0.78,

    // ---------------------------------------------------
    // PATH FOLLOW CONTROLLER
    //
    // ƯU TIÊN ĐIỂM HỒNG LOOK-AHEAD
    // ---------------------------------------------------
    BASE_SPEED: 122,

    MAX_SPEED: 190,

    MIN_CURVE_SPEED: 68,

    // ===================================================
    // PATH ANGLE
    // ===================================================
    //
    // pathAngle = góc:
    //
    // center xanh gần xe
    //        ↓
    // điểm hồng phía trước
    //
    //
    // angle < 0:
    // điểm hồng sang trái
    // => cua trái.
    //
    // angle > 0:
    // điểm hồng sang phải
    // => cua phải.
    //
    // Đây là tín hiệu điều khiển CHÍNH.
    // ===================================================

    PATH_ANGLE_KP: 3.0,

    PATH_ANGLE_KD: 0.055,

    // ===================================================
    // POSITION ERROR
    // ===================================================
    //
    // positionError =
    //
    // center xanh gần xe
    // -
    // tâm camera
    //
    // Chỉ dùng để kéo xe về giữa lane.
    //
    // Không cho thành phần này lấn át hướng cua
    // do điểm hồng xác định.
    // ===================================================

    POSITION_KP: 0.10,

    POSITION_KD: 0.004,

    // Feed-forward nhỏ theo curvature
    CURVATURE_KP: 0.18,

    // ---------------------------------------------------
    // DEADBAND
    // ---------------------------------------------------

    PATH_ANGLE_DEADBAND_DEG: 1.2,

    POSITION_DEADBAND_PX: 4,

    // ---------------------------------------------------
    // DERIVATIVE FILTER
    // ---------------------------------------------------

    PATH_ANGLE_DERIVATIVE_EMA_ALPHA: 0.18,

    POSITION_DERIVATIVE_EMA_ALPHA: 0.20,

    // ---------------------------------------------------
    // CURVE DIRECTION LOCK
    // ---------------------------------------------------
    //
    // Nếu đường cong rõ ràng:
    //
    // angle < -5°
    // => correction bắt buộc âm
    // => motor phải > motor trái.
    //
    // angle > +5°
    // => correction bắt buộc dương
    // => motor trái > motor phải.
    //
    CURVE_DIRECTION_LOCK_DEG: 5,

    CURVE_DIRECTION_MIN_CORRECTION: 10,

    // Nếu xe đã lệch center quá lớn thì cho phép
    // position controller override để cứu xe.
    CURVE_DIRECTION_OVERRIDE_OFFCENTER_RATIO: 0.85,

    // ---------------------------------------------------
    // CURVE SPEED
    // ---------------------------------------------------

    // Góc tới điểm hồng >= 24°
    // => giảm xuống MIN_CURVE_SPEED
    PATH_FULL_SLOWDOWN_DEG: 24,

    // ---------------------------------------------------
    // STEERING LIMIT
    // ---------------------------------------------------

    MAX_STEERING_CORRECTION: 92,

    CENTER_FULL_SLOWDOWN_RATIO: 0.26,

    // ---------------------------------------------------
    // ONE LINE
    // ---------------------------------------------------

    ONE_LINE_BASE_SPEED: 76,

    ONE_LINE_STEERING_GAIN: 1.08,

    // ---------------------------------------------------
    // LOST LINE PREDICTION
    // ---------------------------------------------------

    LOST_PREDICT_SPEED: 52,

    LOST_PREDICT_STEERING_GAIN: 0.82,

    // ---------------------------------------------------
    // MOTOR SMOOTHING
    // ---------------------------------------------------

    MOTOR_MAX_DELTA_PER_UPDATE: 20,

    // ---------------------------------------------------
    // IR SENSOR
    // ---------------------------------------------------
    //
    // Theo phần cứng bạn mô tả:
    //
    // true  = còn tín hiệu / nền đường
    // false = băng đen
    //
    IR_ACTIVE_LOW: true,

    BORDER_FAST_SPEED: 145,

    BORDER_SLOW_SPEED: 65,

    // ---------------------------------------------------
    // T-JUNCTION / GYRO TURN
    // ---------------------------------------------------

    TURN_FAST_SPEED: 145,

    TURN_MEDIUM_SPEED: 105,

    TURN_SLOW_SPEED: 72,

    TURN_START_LINE_SEARCH_DEG: 68,

    TURN_TARGET_DEG: 90,

    TURN_MAX_DEG: 112,

    T_JUNCTION_QR_TEXT: "T-junction",

    T_JUNCTION_STABLE_COUNT: 2,

    T_JUNCTION_STOP_AREA_PERCENT: 12,

    // ---------------------------------------------------
    // LOST LINE
    // ---------------------------------------------------

    LINE_LOST_STOP_MS: 650,

    // ---------------------------------------------------
    // MQTT MOTOR
    // ---------------------------------------------------

    MOTOR_INTERVAL_MS: 70
  }
};