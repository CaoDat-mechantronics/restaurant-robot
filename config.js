window.ROBOT_SOURCE_BUILD = "2026-09-27-web-bev-curvature-v3-calibrated-15cm-26cm";
window.ROBOT_CONFIG_BUILD = "2026-09-27-web-bev-curvature-v3-calibrated-15cm-26cm";
window.ROBOT_SOURCE_BUILD_LABEL = "2026-09-27 · BEV Curvature V3 · Lane Lock · Track15/Lane26";

window.APP_CONFIG = {
  API_BASE_URL: "https://restaurant-api-t6pq.onrender.com",
  DEFAULT_ROBOT: 1,
  GEMINI_WS_BASE: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",

  // =====================================================
  // HIVEMQ CLOUD - FRONTEND MQTT OVER WEBSOCKET
  // =====================================================
  // Nên tạo 1 MQTT user riêng cho frontend, chỉ cấp quyền:
  // SUB: topic1/status, topic1/sensors, topic2/status, topic2/sensors, topic/mon, topic/req, topic/res
  // PUB: topic/req (và các topic điều khiển hiện có)
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
    VISION_SEARCH_MARGIN_PX: 46,
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
    VISION_LOST_PREDICT_FRAMES: 1,
    VISION_LOST_PREDICT_CONFIDENCE: 0.56,

    // Tâm điều khiển được lọc riêng để xe không giật trái/phải liên tục.
    VISION_CENTER_EMA_ALPHA: 0.42,
    VISION_MAX_CENTER_JUMP_PX: 26,

    // ===================================================
    // LANE LOCK / FALSE-POSITIVE REJECTION
    // ===================================================
    // Sau khi bắt đúng lane, detector khóa theo hình học + lịch sử.
    // Vật thể tối mới xuất hiện ngoài corridor sẽ không được đổi lane ngay.
    VISION_LANE_LOCK_ENABLE: true,
    VISION_LANE_ACQUIRE_CONFIRM_FRAMES: 3,
    VISION_LANE_REJECT_UNLOCK_FRAMES: 5,

    // Khi đã lock, search window hẹp hơn.
    VISION_LOCKED_SEARCH_MARGIN_PX: 32,

    // Hai line thật phải xuất hiện ở đủ số lát quét.
    VISION_PAIR_MIN_COVERAGE: 0.34,

    // Độ lệch trung bình so với lane frame trước, tính theo lane-width.
    VISION_PAIR_MAX_TEMPORAL_INNOVATION_LANES: 0.22,

    // Khi bắt lane mới, tâm lane phải tương đối gần tâm camera.
    VISION_ACQUIRE_CENTER_MAX_OFFSET_LANES: 0.42,

    // Bề rộng lane theo phối cảnh: gần camera không được co nhỏ bất thường.
    VISION_PERSPECTIVE_MIN_NEAR_FAR_WIDTH_RATIO: 0.82,

    // Fit quá xấu thì loại thẳng, không chỉ giảm confidence.
    VISION_PAIR_MAX_FIT_RMS_PX: 17,

    // Điểm gần dùng để đo lệch ngang và điểm nhìn trước dùng để bắt cua sớm.
    // 0 = đầu ROI (xa), 1 = cuối ROI (gần robot).
    VISION_NEAR_Y_RATIO: 0.88,
    VISION_LOOKAHEAD_Y_RATIO: 0.42,

    // Tiếp tuyến cục bộ của đường xanh: sample một đoạn ngắn trên centerCurve.
    // Chỉ dùng để tính heading error; đường vàng trên UI KHÔNG nằm trên curve.
    VISION_LOCAL_HEADING_T_DELTA: 0.08,

    // Heading điều khiển ưu tiên tiếp tuyến cục bộ, nhưng giữ một phần look-ahead xa.
    VISION_LOCAL_HEADING_CONTROL_WEIGHT: 0.80,

    // Đường vàng là HƯỚNG CAMERA MỤC TIÊU: tiếp tuyến của centerCurve
    // tại adaptive look-ahead. Trục camera hiện tại được vẽ xám, thẳng đứng.
    VISION_CAMERA_HEADING_LENGTH_RATIO: 0.075,

    // ===================================================
    // VIRTUAL BIRD'S-EYE / LANE-NORMALIZED GEOMETRY
    // ===================================================
    // Không cần calibration homography cứng ở bước đầu. Thay vào đó mỗi điểm
    // centerCurve được chuẩn hoá theo lane width tại chính hàng ảnh đó.
    // Nhờ vậy hình học xa/gần ít bị phối cảnh làm sai hơn.
    VISION_BEV_ENABLE: true,
    VISION_BEV_FAR_T_RATIO: 0.18,
    VISION_BEV_SAMPLES: 11,

    // Quy đổi lane-width sang một hệ tọa độ forward/lateral tương đối.
    // Đây là hệ số scale hình học, KHÔNG phải PWM.
    VISION_BEV_X_SCALE: 0.55,

    // ===================================================
    // GROUND-GEOMETRY SCALE
    // ===================================================
    // Dùng bề rộng lane theo phối cảnh để ước lượng trục tiến trên mặt đất.
    // Đơn vị hình học là "lane width".
    //
    // near distance = khoảng cách từ camera tới hàng near, chia cho bề rộng lane.
    // Đây là tham số calibration hình học, KHÔNG phải PWM.
    VISION_GROUND_NEAR_DISTANCE_LANES: 0.60,

    // Nếu span suy ra quá ngắn thì không tin curvature metric.
    VISION_GROUND_MIN_FORWARD_SPAN_LANES: 0.45,

    // Adaptive look-ahead: đường thẳng nhìn xa, cua gắt nhìn gần.
    // u=0 ở gần robot, u=1 ở xa.
    VISION_BEV_LOOKAHEAD_NEAR_U: 0.26,
    VISION_BEV_LOOKAHEAD_FAR_U: 0.70,
    VISION_BEV_CURVATURE_FULL: 1.20,
    VISION_BEV_HEADING_FULL_DEG: 18,
    VISION_BEV_LOOKAHEAD_EMA_ALPHA: 0.38,

    // V2: KHÔNG trộn pure-pursuit target-X vào hướng cua.
    // target-X phụ thuộc vị trí robot trong lane và có thể đảo dấu cua.
    // Hướng cua phải đến từ hình dạng/tangent của polynomial centerCurve.
    VISION_BEV_PATH_GEOMETRY_WEIGHT: 0.62,
    VISION_BEV_PREVIEW_HEADING_WEIGHT: 0.38,

    // Curvature tăng nhanh khi vào cua nhưng giảm chậm hơn một chút để tránh
    // 1 frame nhận sai làm robot đột ngột đi thẳng giữa cua.
    VISION_BEV_CURVATURE_RISE_ALPHA: 0.52,
    VISION_BEV_CURVATURE_FALL_ALPHA: 0.24,

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
    MOTOR_MIN_RUN_PWM: 52,
    MOTOR_CRUISE_PWM: 102,
    MOTOR_START_BOOST_PWM: 116,
    MOTOR_START_BOOST_MS: 0,
    MOTOR_MAX_PWM: 230,


    // Giá trị logic cực nhỏ được coi là STOP.
    MOTOR_ZERO_CUTOFF_LOGICAL: 0.5,

    MIN_CURVE_SPEED: 42,

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
    MOTOR_MAX_DELTA_PER_UPDATE: 14,

    // Khi bám line bình thường không đảo chiều bánh trong cua. Hộp số 1/120
    // đủ mô-men để cua bằng cách giảm bánh trong thay vì reverse.
    LINE_FOLLOW_MIN_LOGICAL_SPEED: 1,

    // Chỉ là ngưỡng mô-men vật lý cho LINE_FOLLOW.
    // KHÔNG thay đổi PID / baseSpeed / correction của precision-v2.
    // Nếu một bánh đang tiến nhưng PWM sau mapping thấp hơn mức này,
    // nâng bánh đó lên floor và nâng bánh còn lại cùng lượng để giữ chênh steering.
    LINE_FOLLOW_TORQUE_FLOOR_PWM: 0,

    // ===================================================
    // LANE GEOMETRY SOFT CONTROLLER
    // ===================================================
    // LINE_FOLLOW chỉ dùng camera:
    //   1) lateral error  = center xanh gần robot - tâm camera
    //   2) heading error  = tiếp tuyến cục bộ của đường xanh - hướng camera
    //   3) curvature      = thay đổi heading dọc đường xanh
    //
    // Không hard-code cặp PWM theo severity.
    // Các sai số được chuẩn hoá -> weighted sum -> tanh() để tăng steering
    // liên tục nhưng không nhảy vô hạn.
    LANE_GEOMETRY_CONTROL_ENABLE: true,

    // Mức sai số được coi là "đầy thang" khi chuẩn hoá.
    LANE_LATERAL_FULL_RATIO: 0.18,
    LANE_HEADING_FULL_DEG: 20,
    LANE_CURVATURE_FULL_DEG: 10,
    LANE_HEADING_D_FULL_DEG_S: 140,

    // Trọng số. Heading là thành phần chính; lateral giữ robot ở giữa lane;
    // curvature là feed-forward để bắt cua sớm; D giảm overshoot.
    LANE_WEIGHT_LATERAL: 0.80,
    LANE_WEIGHT_HEADING: 1.35,
    LANE_WEIGHT_CURVATURE: 0.72,
    LANE_WEIGHT_HEADING_D: 0.14,

    // Soft saturation. Nhỏ hơn -> steering mạnh sớm hơn; lớn hơn -> mềm hơn.
    LANE_STEERING_SOFT_SCALE: 1.00,

    // Steering authority thay đổi liên tục theo độ gắt.
    // Đây là delta LOGIC, không phải cặp PWM cố định.
    LANE_STEERING_MIN_DELTA_LOGICAL: 10,
    LANE_STEERING_MAX_DELTA_LOGICAL: 110,
    LANE_STEERING_DELTA_EXPONENT: 0.88,

    // Blue severity cũng tham gia giảm tốc nền ở cua.
    LANE_CURVE_SPEED_SEVERITY_WEIGHT: 1.00,

    // Khi curve rõ ràng, bảo vệ dấu steering để lateral error không lật hướng
    // trừ khi robot đã lệch tâm cực lớn.
    LANE_DIRECTION_LOCK_SEVERITY: 0.28,
    LANE_DIRECTION_LOCK_MIN_DELTA_LOGICAL: 8,
    LANE_DIRECTION_OVERRIDE_LATERAL: 0.88,

    // ===================================================
    // CURVATURE DIFFERENTIAL DRIVE - CAMERA ONLY
    // ===================================================
    // targetCurvature được sinh bởi virtual BEV + adaptive look-ahead.
    // Controller không hard-code cặp PWM và không dùng gyro khi LINE_FOLLOW.
    CURVATURE_CONTROL_ENABLE: true,
    CURVATURE_TARGET_FULL: 1.80,
    CURVATURE_LATERAL_FULL: 0.34,
    CURVATURE_HEADING_FULL_DEG: 18,
    CURVATURE_HEADING_D_FULL_DEG_S: 120,

    CURVATURE_WEIGHT_TARGET: 1.55,
    CURVATURE_WEIGHT_LATERAL: 0.36,
    CURVATURE_WEIGHT_HEADING: 0.82,
    CURVATURE_WEIGHT_HEADING_D: 0.07,
    CURVATURE_SOFT_SCALE: 1.05,

    // Khi đường xanh có curvature rõ ràng, lateral error KHÔNG được phép
    // đảo hướng cua. Chỉ cho phép đảo nếu robot lệch lane cực lớn.
    CURVATURE_DIRECTION_LOCK_NORM: 0.13,
    CURVATURE_DIRECTION_OVERRIDE_LATERAL_NORM: 0.88,
    CURVATURE_DIRECTION_MIN_COMMAND: 0.10,

    // Lọc turn-ratio để motor không đổi trái/phải theo từng frame.
    CURVATURE_TURN_RATIO_EMA_ALPHA: 0.44,
    CURVATURE_TURN_RATIO_MAX_DELTA: 0.11,

    // turnRatio=0 -> hai bên bằng nhau; |turnRatio| tăng liên tục theo sai số.
    // Không phải gap PWM cố định.
    CURVATURE_MAX_TURN_RATIO: 0.92,

    // ===================================================
    // CURVATURE -> SKID-STEER KINEMATICS
    // ===================================================
    // Quan trọng: để tính bán kính quay đúng theo kích thước xe,
    // hãy đặt:
    //   ROBOT_TRACK_WIDTH_LANE_RATIO =
    //     khoảng cách tâm bánh trái-phải / khoảng cách hai line.
    //
    // Ví dụ track=24cm, lane=45cm => 0.533.
    // Measured robot/lane geometry:
    //   wheel-center track = 15 cm
    //   black-line center distance = (23 + 29) / 2 = 26 cm
    //   15 / 26 = 0.576923...
    ROBOT_TRACK_WIDTH_LANE_RATIO: 0.577,

    // Xe 4 bánh skid-steer cần chênh tốc độ lớn hơn differential-drive lý tưởng
    // do ma sát trượt ngang. Đây là hệ số vật lý liên tục theo curvature,
    // không phải cặp PWM hard-code.
    CURVATURE_SKID_BASE_GAIN: 1.15,
    CURVATURE_SKID_CURVE_GAIN: 1.15,
    CURVATURE_SKID_EXPONENT: 0.85,

    // Feedback vị trí/heading chỉ tinh chỉnh quanh curvature hình học.
    CURVATURE_FEEDBACK_MAX_RATIO: 0.20,

    // Cua càng gắt thì tốc độ trung bình càng giảm trước khi tăng chênh hai bên.
    CURVATURE_SPEED_SLOWDOWN_GAIN: 0.72,
    CURVATURE_SPEED_SLOWDOWN_EXPONENT: 0.82,
    CURVATURE_OFFCENTER_SLOWDOWN_GAIN: 0.28,

    // Không dùng IR2/IR3 để điều khiển trong bản test web-only này.
    USE_IR_BOUNDARY_OVERRIDE: false,

    // Gyro KHÔNG điều khiển LINE_FOLLOW.
    // Gyro vẫn được giữ nguyên cho TURNING QR ~90°.
    ADAPTIVE_YAW_FEEDBACK_ENABLE: false,

    // Không sử dụng frame camera quá cũ để tiếp tục lái.
    VISION_MAX_FRAME_AGE_MS: 120,

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
    // NGƯỠNG QR DÙNG ĐỂ RA QUYẾT ĐỊNH ĐIỀU KHIỂN
    // ---------------------------------------------------
    // Chỉ QR có diện tích >= giá trị này (% diện tích frame camera)
    // mới được phép kích hoạt hành động tại nga_re hoặc ban_<số bàn>.
    // Có thể chỉnh duy nhất biến này khi cần tăng/giảm độ gần của QR.
    QR_ACTION_MIN_AREA_PERCENT: 2.1,

    // ---------------------------------------------------
    // QR BÀN ĐÍCH
    // ---------------------------------------------------
    // Legacy cho navigation cũ; luồng BẮT ĐẦU mới dùng QR_ACTION_MIN_AREA_PERCENT ở trên.
    TABLE_QR_PREFIX: "ban_",
    TABLE_QR_STOP_AREA_PERCENT: 4,
    TABLE_QR_STABLE_COUNT: 1,

    // ---------------------------------------------------
    // QR NGÃ RẼ
    // ---------------------------------------------------
    // Legacy cho navigation cũ; luồng BẮT ĐẦU mới dùng QR_ACTION_MIN_AREA_PERCENT ở trên.
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
    MOTOR_INTERVAL_MS: 60
  }
};
