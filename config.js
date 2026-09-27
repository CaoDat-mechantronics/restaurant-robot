window.ROBOT_SOURCE_BUILD = "2026-09-27-gear120-adaptive-curve-yaw-v2-local-heading";
window.ROBOT_CONFIG_BUILD = "2026-09-27-gear120-adaptive-curve-yaw-v2-local-heading";
window.ROBOT_SOURCE_BUILD_LABEL = "2026-09-27 · Precision V2 · Adaptive Curve + Short Yellow Guide · 4-Motor";

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

    // Short yellow local-heading guide.
    // 0.08 = chỉ nhìn trước khoảng 8% chiều cao ROI từ điểm near.
    // Hai đầu đoạn vàng đều lấy trực tiếp từ centerCurve xanh.
    VISION_LOCAL_HEADING_T_DELTA: 0.08,

    // Steering tức thời ưu tiên tiếp tuyến cục bộ ngắn để ôm đường xanh.
    // 0.75 local + 0.25 long look-ahead.
    VISION_LOCAL_HEADING_CONTROL_WEIGHT: 0.75,

    // Confidence thấp thì navigation giảm tốc hoặc dừng.
    VISION_MIN_CONFIDENCE: 0.38,
    VISION_SLOW_CONFIDENCE: 0.62,
    VISION_GOOD_CONFIDENCE: 0.78,

    // ---------------------------------------------------
    // PATH FOLLOW CONTROLLER - ƯU TIÊN ĐIỂM HỒNG LOOK-AHEAD
    // ---------------------------------------------------
    BASE_SPEED: 96,

    // Thang tốc độ LOGIC nội bộ. Với hộp số 1/120 không cần đẩy quá cao;
    // vẫn giữ đủ khoảng điều khiển để tạo chênh lệch trái/phải mượt.
    MAX_SPEED: 155,

    // ===================================================
    // MOTOR OUTPUT VẬT LÝ - KICK START + CRUISE
    // ===================================================
    //
    // Hộp số 1/120 đã tăng mô-men, vì vậy không còn ép PWM nền cao.
    // PWM vật lý được map theo từng bánh: bánh trong cua có thể giảm thật,
    // bánh ngoài tăng vừa phải. Nhờ vậy curve slowdown của controller có tác dụng.
    //
    // MOTOR_MIN_RUN_PWM: PWM nhỏ nhất dùng khi bánh cần quay.
    // MOTOR_CRUISE_PWM : PWM chạy thẳng mặc định.
    // START_BOOST đang tắt (0 ms); chỉ bật lại nếu thực tế vẫn khó đề-pa.
    MOTOR_MIN_RUN_PWM: 50,
    MOTOR_CRUISE_PWM: 98,
    MOTOR_START_BOOST_PWM: 112,
    MOTOR_START_BOOST_MS: 0,
    MOTOR_MAX_PWM: 240,


    // Giá trị logic cực nhỏ được coi là STOP.
    MOTOR_ZERO_CUTOFF_LOGICAL: 0.5,

    MIN_CURVE_SPEED: 44,

    // pathAngle là góc vector:
    //   center xanh gần xe -> điểm hồng look-ahead
    // pathAngle < 0: đường phía trước cong trái
    // pathAngle > 0: đường phía trước cong phải
    // Đây là tín hiệu lái CHÍNH.
    PATH_ANGLE_KP: 2.15,
    PATH_ANGLE_KD: 0.030,

    // positionError = center xanh gần xe - tâm camera.
    // Chỉ dùng để kéo xe về giữa lane, không được lấn át hướng cua rõ ràng.
    POSITION_KP: 0.075,
    POSITION_KD: 0.0025,

    // Feed-forward nhỏ theo độ cong của center curve.
    CURVATURE_KP: 0.09,

    // Deadband chống rung khi gần thẳng / gần tâm.
    PATH_ANGLE_DEADBAND_DEG: 1.2,
    POSITION_DEADBAND_PX: 4,

    // Lọc đạo hàm để motor không giật vì noise camera.
    PATH_ANGLE_DERIVATIVE_EMA_ALPHA: 0.16,
    POSITION_DERIVATIVE_EMA_ALPHA: 0.18,

    // Nếu đường cong rõ ràng, khóa dấu correction theo hướng điểm hồng.
    // Ví dụ pathAngle < -5° => correction phải âm => bánh phải nhanh hơn.
    CURVE_DIRECTION_LOCK_DEG: 5,
    CURVE_DIRECTION_MIN_CORRECTION: 7,

    // Nếu xe lệch tâm cực lớn thì cho phép position controller override
    // curve-direction lock để tránh lao khỏi lane.
    CURVE_DIRECTION_OVERRIDE_OFFCENTER_RATIO: 0.85,

    // Góc tới điểm hồng đạt mức này thì giảm về MIN_CURVE_SPEED.
    PATH_FULL_SLOWDOWN_DEG: 15,

    // Không cho correction lái vượt quá mức này (PWM).
    MAX_STEERING_CORRECTION: 58,

    // Lệch tâm tới tỷ lệ này của bề rộng frame thì giảm tốc mạnh.
    CENTER_FULL_SLOWDOWN_RATIO: 0.20,

    // Khi chỉ còn 1 vạch: center xanh được suy ra từ vạch thật + laneWidthModel.
    ONE_LINE_BASE_SPEED: 50,
    ONE_LINE_STEERING_GAIN: 1.08,

    // Khi mất cả hai vạch nhưng vẫn còn prediction vài frame.
    LOST_PREDICT_SPEED: 34,
    LOST_PREDICT_STEERING_GAIN: 0.82,

    // Không cho PWM nhảy quá nhiều giữa hai lần publish MQTT.
    MOTOR_MAX_DELTA_PER_UPDATE: 7,

    // Khi bám line bình thường không đảo chiều bánh trong cua. Hộp số 1/120
    // đủ mô-men để cua bằng cách giảm bánh trong thay vì reverse.
    LINE_FOLLOW_MIN_LOGICAL_SPEED: 6,

    // Chỉ là ngưỡng mô-men vật lý cho LINE_FOLLOW.
    // KHÔNG thay đổi PID / baseSpeed / correction của precision-v2.
    // Nếu một bánh đang tiến nhưng PWM sau mapping thấp hơn mức này,
    // nâng bánh đó lên floor và nâng bánh còn lại cùng lượng để giữ chênh steering.
    LINE_FOLLOW_TORQUE_FLOOR_PWM: 70,

    // ===================================================
    // BLUE-CURVE FEED-FORWARD
    // ===================================================
    // Đường center màu xanh dương là quỹ đạo điều khiển duy nhất.
    // Severity được tính trực tiếp từ hình học centerCurve xanh:
    // heading gần->lookahead, độ uốn của curve và độ lệch lookahead.
    // Cua càng gắt -> yêu cầu chênh PWM trái/phải tối thiểu càng lớn.
    BLUE_CURVE_FEEDFORWARD_ENABLE: false,

    // Khi severity dưới mức này, không ép thêm PWM gap.
    BLUE_CURVE_GAP_ACTIVATE_SEVERITY: 0.12,

    // Cua vừa/gắt sẽ nội suy gap từ MIN tới MAX.
    // Với torque floor 70, cua rất gắt thường sẽ tiến tới khoảng 70/140.
    BLUE_CURVE_GAP_MIN_PWM: 24,
    BLUE_CURVE_GAP_MAX_PWM: 115,
    BLUE_CURVE_GAP_EXPONENT: 0.90,

    // Làm mượt gap để không giật khi severity thay đổi giữa các frame.
    BLUE_CURVE_GAP_EMA_ALPHA: 0.52,
    BLUE_CURVE_GAP_MAX_DELTA_PWM: 14,

    // Strong-turn profile:
    // Ngoài việc ép PWM gap, trực tiếp kéo bánh trong xuống và bánh ngoài lên
    // theo độ cong của chính đường xanh.
    // severity = 100%:
    //   LEFT  -> khoảng 70 / 185
    //   RIGHT -> khoảng 185 / 70
    BLUE_CURVE_DIRECT_SPEED_ENABLE: false,
    BLUE_CURVE_DIRECT_ACTIVATE_SEVERITY: 0.15,
    BLUE_CURVE_DIRECT_EXPONENT: 0.90,
    BLUE_CURVE_INNER_PWM_AT_FULL_CURVE: 70,
    BLUE_CURVE_OUTER_PWM_AT_FULL_CURVE: 185,

    // Chuẩn hoá severity từ chính đường xanh.
    BLUE_CURVE_HEADING_FULL_DEG: 13,
    BLUE_CURVE_BEND_FULL_DEG: 8,
    BLUE_CURVE_LATERAL_FULL_RATIO: 0.11,

    // ===================================================
    // ADAPTIVE CURVATURE CONTROLLER
    // ===================================================
    // Không gán cứng severity=100% thành một cặp PWM cụ thể.
    // Đường xanh tạo turn ratio liên tục. Gyro đo robot quay thực tế
    // và tự tăng/giảm steering khi robot understeer/oversteer.
    ADAPTIVE_CURVE_ENABLE: true,

    // Dưới mức này coi gần như thẳng và giữ output Precision V2.
    ADAPTIVE_CURVE_ACTIVATE_SEVERITY: 0.06,

    // Hình học đường xanh -> turn ratio.
    // ratio=0: hai bên bằng nhau.
    // ratio=1: bánh trong có thể tiến gần 0 trong mô hình động học.
    // >1 cho phép cua rất gắt nhưng LINE_FOLLOW vẫn không reverse.
    ADAPTIVE_CURVE_MAX_TURN_RATIO: 1.45,
    ADAPTIVE_CURVE_EXPONENT: 1.05,

    // PWM nhỏ nhất mà adaptive controller được phép yêu cầu cho bánh trong.
    // Đây là GIỚI HẠN PHẦN CỨNG, không phải tốc độ cua hard-code.
    // Nếu motor của bạn vẫn quay ổn ở PWM thấp hơn, có thể giảm tiếp.
    ADAPTIVE_CURVE_MIN_INNER_PWM: 45,

    // Giới hạn output vật lý. Bánh ngoài có thể tự tăng tới mức này
    // khi đường cong yêu cầu hoặc gyro báo robot quay chưa đủ.
    ADAPTIVE_CURVE_MAX_OUTER_PWM: 240,

    // Giới hạn tốc độ thay đổi của turn ratio giữa hai vòng điều khiển
    // để tránh giật mạnh khi camera noise.
    ADAPTIVE_CURVE_RATIO_MAX_DELTA: 0.10,

    // ---------------- Gyro closed-loop ----------------
    ADAPTIVE_YAW_FEEDBACK_ENABLE: true,

    // Curve severity -> yaw-rate mục tiêu. Đây không phải PWM cố định:
    // PWM được tự điều chỉnh cho tới khi yaw-rate thực tế tiến gần mục tiêu.
    ADAPTIVE_YAW_RATE_MAX_DEG_S: 95,
    ADAPTIVE_YAW_RATE_EXPONENT: 1.00,

    // Low-pass cho yaw-rate đo từ DeviceOrientation.
    ADAPTIVE_YAW_RATE_EMA_ALPHA: 0.26,

    // Feedback gain: understeer -> tăng ratio; oversteer -> giảm ratio.
    ADAPTIVE_YAW_KP: 0.0070,
    ADAPTIVE_YAW_KI: 0.0008,
    ADAPTIVE_YAW_INTEGRAL_LIMIT: 45,

    // Không sử dụng frame camera quá cũ để tiếp tục lái.
    VISION_MAX_FRAME_AGE_MS: 160,

    // Cảm biến IR của bạn là active-low:
    // true  = nền đường / có tín hiệu
    // false = băng đen / mất tín hiệu
    IR_ACTIVE_LOW: true,
    BORDER_FAST_SPEED: 88,
    BORDER_SLOW_SPEED: 30,

    // ---------------------------------------------------
    // RẼ Ở NGÃ 3 BẰNG GYRO + REACQUIRE LINE
    // ---------------------------------------------------
    TURN_FAST_SPEED: 88,
    TURN_MEDIUM_SPEED: 68,
    TURN_SLOW_SPEED: 48,
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
    MOTOR_INTERVAL_MS: 40
  }
};
