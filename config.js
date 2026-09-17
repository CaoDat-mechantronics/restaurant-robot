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
    CAMERA_FACING_MODE: "environment",

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

    // ONE-LINE TRACKING:
    // laneWidthModel chỉ được học khi nhìn thấy đủ hai vạch thật.
    VISION_LANE_WIDTH_MODEL_ALPHA: 0.16,

    // Confidence của frame chỉ thấy 1 vạch sẽ bị nhân hệ số này.
    VISION_ONE_LINE_CONFIDENCE_SCALE: 0.82,

    // Cho phép chạy tối đa khoảng 45 frame (~1.8 s ở 25 FPS) chỉ với 1 vạch.
    // Quá thời gian này phải bắt lại đủ 2 vạch, nếu không coi là mất line.
    VISION_ONE_LINE_MAX_FRAMES: 45,

    // Nếu mất cả hai vạch, giữ quỹ đạo cũ tối đa vài frame để tránh giật.
    VISION_LOST_PREDICT_FRAMES: 4,
    VISION_LOST_PREDICT_CONFIDENCE: 0.56,

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
    // PATH FOLLOW CONTROLLER - ƯU TIÊN ĐIỂM HỒNG LOOK-AHEAD
    // ---------------------------------------------------
    BASE_SPEED: 122,

    // Thang tốc độ LOGIC mà thuật toán path-follow sử dụng nội bộ.
    // Giữ 190 để vẫn còn đủ độ phân giải khi tính chênh lệch trái/phải.
    MAX_SPEED: 190,

    // PWM THỰC gửi xuống ESP32.
    // 0 luôn là STOP. Mọi lệnh chạy khác 0 sẽ nằm trong 200..255.
    // Đây là tầng output vật lý; thuật toán bám đường vẫn tính trên thang logic 0..190.
    MOTOR_MIN_PWM: 200,
    MOTOR_MAX_PWM: 255,

    // Giá trị logic cực nhỏ được coi là STOP. Bình thường base speed luôn lớn hơn nhiều
    // nên ngưỡng này chủ yếu chống nhiễu/số thực gần 0.
    MOTOR_ZERO_CUTOFF_LOGICAL: 0.5,

    // Gamma > 1 mở rộng chênh lệch PWM giữa bánh nhanh và bánh chậm trong vùng giữa,
    // hữu ích với xe 4 bánh nặng dùng skid-steer.
    MOTOR_PWM_GAMMA: 1.25,

    // Sau khi map từng bánh vào 200..255, tăng thêm chênh lệch trái/phải quanh giá trị
    // trung bình. Không làm đổi hướng cua và vẫn clamp trong 200..255.
    MOTOR_PWM_STEERING_BOOST: 1.35,

    MIN_CURVE_SPEED: 68,

    // pathAngle là góc vector:
    //   center xanh gần xe -> điểm hồng look-ahead
    // pathAngle < 0: đường phía trước cong trái
    // pathAngle > 0: đường phía trước cong phải
    // Đây là tín hiệu lái CHÍNH.
    PATH_ANGLE_KP: 3.0,
    PATH_ANGLE_KD: 0.055,

    // positionError = center xanh gần xe - tâm camera.
    // Chỉ dùng để kéo xe về giữa lane, không được lấn át hướng cua rõ ràng.
    POSITION_KP: 0.10,
    POSITION_KD: 0.004,

    // Feed-forward nhỏ theo độ cong của center curve.
    CURVATURE_KP: 0.18,

    // Deadband chống rung khi gần thẳng / gần tâm.
    PATH_ANGLE_DEADBAND_DEG: 1.2,
    POSITION_DEADBAND_PX: 4,

    // Lọc đạo hàm để motor không giật vì noise camera.
    PATH_ANGLE_DERIVATIVE_EMA_ALPHA: 0.18,
    POSITION_DERIVATIVE_EMA_ALPHA: 0.20,

    // Nếu đường cong rõ ràng, khóa dấu correction theo hướng điểm hồng.
    // Ví dụ pathAngle < -5° => correction phải âm => bánh phải nhanh hơn.
    CURVE_DIRECTION_LOCK_DEG: 5,
    CURVE_DIRECTION_MIN_CORRECTION: 10,

    // Nếu xe lệch tâm cực lớn thì cho phép position controller override
    // curve-direction lock để tránh lao khỏi lane.
    CURVE_DIRECTION_OVERRIDE_OFFCENTER_RATIO: 0.85,

    // Góc tới điểm hồng đạt mức này thì giảm về MIN_CURVE_SPEED.
    PATH_FULL_SLOWDOWN_DEG: 24,

    // Không cho correction lái vượt quá mức này (PWM).
    MAX_STEERING_CORRECTION: 92,

    // Lệch tâm tới tỷ lệ này của bề rộng frame thì giảm tốc mạnh.
    CENTER_FULL_SLOWDOWN_RATIO: 0.26,

    // Khi chỉ còn 1 vạch: center xanh được suy ra từ vạch thật + laneWidthModel.
    ONE_LINE_BASE_SPEED: 76,
    ONE_LINE_STEERING_GAIN: 1.08,

    // Khi mất cả hai vạch nhưng vẫn còn prediction vài frame.
    LOST_PREDICT_SPEED: 52,
    LOST_PREDICT_STEERING_GAIN: 0.82,

    // Không cho PWM nhảy quá nhiều giữa hai lần publish MQTT.
    MOTOR_MAX_DELTA_PER_UPDATE: 20,

    // Cảm biến IR của bạn là active-low:
    // true  = nền đường / có tín hiệu
    // false = băng đen / mất tín hiệu
    IR_ACTIVE_LOW: true,
    BORDER_FAST_SPEED: 145,
    BORDER_SLOW_SPEED: 65,

    // ---------------------------------------------------
    // RẼ Ở NGÃ 3 BẰNG GYRO + REACQUIRE LINE
    // ---------------------------------------------------
    TURN_FAST_SPEED: 145,
    TURN_MEDIUM_SPEED: 105,
    TURN_SLOW_SPEED: 72,
    TURN_START_LINE_SEARCH_DEG: 88,
    TURN_TARGET_DEG: 90,
    TURN_TARGET_TOLERANCE_DEG: 2,
    TURN_MAX_DEG: 112,

    // ---------------------------------------------------
    // QR BÀN ĐÍCH
    // ---------------------------------------------------
    // Ví dụ task.table = 3 -> web chờ QR "ban_3".
    // Khi QR chiếm >= 4% khung QR thì dừng hẳn và chuyển ARRIVED.
    TABLE_QR_PREFIX: "ban_",
    TABLE_QR_STOP_AREA_PERCENT: 4,
    TABLE_QR_STABLE_COUNT: 1,

    // ---------------------------------------------------
    // QR NGÃ RẼ
    // ---------------------------------------------------
    // Giữ ngưỡng 12% từ thuật toán cũ để tránh quay quá sớm.
    // Khi thấy "nga_re" đủ lớn, web dừng tạm rồi dùng junction_turn
    // của task để quay LEFT/RIGHT 90° bằng gyro.
    JUNCTION_QR_TEXT: "nga_re",
    JUNCTION_QR_STABLE_COUNT: 2,
    JUNCTION_QR_TRIGGER_AREA_PERCENT: 12,

    // Alias tương thích source cũ.
    T_JUNCTION_QR_TEXT: "nga_re",
    T_JUNCTION_STABLE_COUNT: 2,
    T_JUNCTION_STOP_AREA_PERCENT: 12,

    // Nếu mất lane quá lâu thì dừng robot.
    LINE_LOST_STOP_MS: 650,

    // Tần số gửi lệnh motor lên HiveMQ.
    MOTOR_INTERVAL_MS: 70
  }
};
