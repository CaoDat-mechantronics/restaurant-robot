(() => {
  const NAV_STATE = Object.freeze({
    IDLE: "IDLE",
    LINE_FOLLOW: "LINE_FOLLOW",
    T_JUNCTION_DETECTED: "T_JUNCTION_DETECTED",
    TURNING: "TURNING",
    REACQUIRE_LINE: "REACQUIRE_LINE",
    ARRIVED: "ARRIVED",
    ERROR: "ERROR",
    STOPPED: "STOPPED"
  });

  class RobotNavigation {
    constructor({
      config = {},
      mqttBridge,
      vision,
      orientation,
      onState = () => {},
      onMotor = () => {},
      onDebug = () => {}
    }) {
      this.config = config;
      this.mqtt = mqttBridge;
      this.vision = vision;
      this.orientation = orientation;
      this.onState = onState;
      this.onMotor = onMotor;
      this.onDebug = onDebug;

      this.state = NAV_STATE.IDLE;
      this.task = null;

      this.sensors = {
        ir2: true,
        ir3: true,
        ir5: false,
        has_food: false
      };

      this.lastVision = null;
      this.lastLineSeenAt = 0;
      this.lastMotorAt = 0;
      this.lastMotor = { left: 0, right: 0 };
      this.controlTimer = null;

      // PATH-FOLLOW controller:
      // - position error: center xanh gần xe so với tâm camera
      // - path angle: vector từ center xanh gần xe tới điểm hồng look-ahead
      //   Đây là thành phần chính để quyết định hướng cua.
      this.prevLineError = null;
      this.prevControlAt = 0;
      this.filteredLineDerivative = 0;
      this.prevPathAngle = null;
      this.filteredPathAngleDerivative = 0;

      this.turnStartYaw = null;
      this.turnDirection = null;
      this.reacquireStableFrames = 0;

      this.tableQrHits = 0;
      this.lastTableQrAt = 0;
      this.tJunctionHits = 0;
      this.lastTJunctionQrAt = 0;
      this.lastTJunctionHandledAt = 0;
      this.qrStopPending = false;

      // Trạng thái debug giúp biết vì sao motor đang chạy hoặc bằng 0.
      this.motorReason = "WAITING_TASK";
      this.motorPublishOk = null;
    }

    // =====================================================
    // LIFECYCLE
    // =====================================================

    start(task) {
      this.task = { ...task };
      this.turnStartYaw = null;
      this.turnDirection = null;
      this.reacquireStableFrames = 0;
      this.tableQrHits = 0;
      this.lastTableQrAt = 0;
      this.tJunctionHits = 0;
      this.lastTJunctionQrAt = 0;
      this.lastTJunctionHandledAt = 0;
      this.qrStopPending = false;
      this.lastVision = null;
      this.lastLineSeenAt = performance.now();
      this.lastMotor = { left: 0, right: 0 };
      this.resetLineController();
      this.setMotorReason("WAITING_VISION", "Đang chờ camera nhận diện lane");

      this.setState(NAV_STATE.LINE_FOLLOW);

      if (!this.controlTimer) {
        this.controlTimer = window.setInterval(
          () => this.controlLoop(),
          Math.max(30, Number(this.config.MOTOR_INTERVAL_MS) || 70)
        );
      }
    }

    stop(reason = "manual") {
      if (this.controlTimer) {
        clearInterval(this.controlTimer);
        this.controlTimer = null;
      }

      this.setMotorReason("STOPPED", reason);
      this.sendMotor(0, 0, true);
      this.setState(NAV_STATE.STOPPED, reason);
    }

    fail(message) {
      this.setMotorReason("ERROR", message);
      this.sendMotor(0, 0, true);
      this.setState(NAV_STATE.ERROR, message);
      this.onDebug(`NAV ERROR: ${message}`);
    }

    setState(state, detail = "") {
      if (this.state === state && !detail) {
        return;
      }

      this.state = state;

      this.onState({
        state,
        detail,
        task: this.task,
        turnDirection: this.turnDirection
      });

      this.onDebug(`NAV ${state}${detail ? `: ${detail}` : ""}`);
    }

    // =====================================================
    // MOTOR DEBUG REASON
    // =====================================================

    setMotorReason(reason, detail = "") {
      const text = detail ? `${reason} · ${detail}` : reason;
      this.motorReason = text;

      if (typeof document !== "undefined") {
        const mainReason = document.getElementById("motorReasonState");
        const visionReason = document.getElementById("visionMotorReasonState");

        if (mainReason) mainReason.textContent = text;
        if (visionReason) visionReason.textContent = text;
      }
    }

    updateMotorPublishDebug(published) {
      this.motorPublishOk = Boolean(published);
      const text = this.motorPublishOk ? "OK" : "FAIL / chưa kết nối";

      if (typeof document !== "undefined") {
        const mainState = document.getElementById("motorPublishState");
        const visionState = document.getElementById("visionMotorPublishState");

        if (mainState) mainState.textContent = text;
        if (visionState) visionState.textContent = text;
      }
    }

    // =====================================================
    // SENSOR / VISION INPUT
    // =====================================================

    updateSensors(payload = {}) {
      this.sensors = {
        ...this.sensors,
        ir2: Boolean(payload.ir2),
        ir3: Boolean(payload.ir3),
        ir5: Boolean(payload.ir5),
        has_food:
          payload.has_food != null
            ? Boolean(payload.has_food)
            : Boolean(payload.ir5)
      };
    }

    updateVision(frame) {
      this.lastVision = frame;

      // Chỉ reset timeout khi camera THẬT SỰ nhìn thấy ít nhất một vạch.
      // PREDICTED chỉ là hình học giữ lại vài frame nên không được phép
      // kéo dài vô hạn thời gian "line còn sống".
      if (frame?.hasVisualLine && frame?.hasLane) {
        this.lastLineSeenAt = performance.now();
      }
    }

    resetLineController() {
      this.prevLineError = null;
      this.prevPathAngle = null;
      this.prevControlAt = 0;
      this.filteredLineDerivative = 0;
      this.filteredPathAngleDerivative = 0;
    }

    // =====================================================
    // QR NAVIGATION
    // =====================================================
    // 1) QR bàn hiện tại, ví dụ task.table = 3 -> "ban_3"
    //    Khi diện tích QR >= TABLE_QR_STOP_AREA_PERCENT thì STOP và
    //    chuyển sang ARRIVED. ARRIVED không tự resume lại chỉ vì
    //    backend vẫn còn ON TASK.
    //
    // 2) QR "nga_re"
    //    Khi đủ ngưỡng diện tích, dừng tạm rồi dùng junction_turn
    //    của task để quay LEFT/RIGHT 90° bằng gyro.
    // =====================================================

    handleQr(qr) {
      if (this.state !== NAV_STATE.LINE_FOLLOW) {
        return;
      }

      const payload =
        typeof qr === "string"
          ? { text: qr }
          : (qr || {});

      const value = String(payload.text || "")
        .trim()
        .toLowerCase();

      const areaPercent = Number(payload.areaPercent);
      if (!value || !Number.isFinite(areaPercent)) {
        return;
      }

      const now = performance.now();

      // ---------------------------------------------------
      // QR BÀN ĐÍCH: ban_<table>
      // ---------------------------------------------------
      const currentTable = Number(
        this.task?.table ?? this.task?.table_number ?? 0
      );

      const tablePrefix = String(
        this.config.TABLE_QR_PREFIX || "ban_"
      )
        .trim()
        .toLowerCase();

      const expectedTableQr =
        currentTable > 0
          ? `${tablePrefix}${currentTable}`
          : "";

      if (expectedTableQr && value === expectedTableQr) {
        const tableStopPercent = Math.max(
          0,
          Number(this.config.TABLE_QR_STOP_AREA_PERCENT) || 4
        );

        if (areaPercent < tableStopPercent) {
          this.tableQrHits = 0;
          return;
        }

        if (now - this.lastTableQrAt > 1000) {
          this.tableQrHits = 0;
        }

        this.lastTableQrAt = now;
        this.tableQrHits += 1;

        const required = Math.max(
          1,
          Number(this.config.TABLE_QR_STABLE_COUNT) || 1
        );

        if (this.tableQrHits >= required) {
          this.tableQrHits = 0;
          this.arriveAtCurrentTable(areaPercent);
        }

        return;
      }

      // QR khác bàn hiện tại thì không được dừng xe.
      if (value.startsWith(tablePrefix)) {
        this.tableQrHits = 0;
        return;
      }

      // ---------------------------------------------------
      // QR NGÃ RẼ: nga_re
      // ---------------------------------------------------
      const expectedJunction = String(
        this.config.JUNCTION_QR_TEXT ||
        this.config.T_JUNCTION_QR_TEXT ||
        "nga_re"
      )
        .trim()
        .toLowerCase();

      if (value !== expectedJunction) {
        return;
      }

      const triggerPercent = Math.max(
        0,
        Number(
          this.config.JUNCTION_QR_TRIGGER_AREA_PERCENT ??
          this.config.T_JUNCTION_STOP_AREA_PERCENT
        ) || 12
      );

      // Không xử lý lại cùng một ngã rẽ ngay sau khi vừa quay xong.
      if (
        this.lastTJunctionHandledAt > 0 &&
        now - this.lastTJunctionHandledAt < 3500
      ) {
        return;
      }

      if (areaPercent < triggerPercent) {
        this.tJunctionHits = 0;
        this.qrStopPending = false;
        return;
      }

      if (now - this.lastTJunctionQrAt > 1000) {
        this.tJunctionHits = 0;
      }

      this.lastTJunctionQrAt = now;
      this.tJunctionHits += 1;
      this.qrStopPending = true;

      // Dừng ngay khi QR ngã rẽ đã đạt ngưỡng.
      this.setMotorReason(
        "JUNCTION_QR",
        `${value} ${areaPercent.toFixed(2)}%`
      );
      this.sendMotor(0, 0, true);

      const required = Math.max(
        1,
        Number(
          this.config.JUNCTION_QR_STABLE_COUNT ??
          this.config.T_JUNCTION_STABLE_COUNT
        ) || 2
      );

      if (this.tJunctionHits >= required) {
        this.tJunctionHits = 0;
        this.qrStopPending = false;
        this.beginTJunctionTurn();
      }
    }

    arriveAtCurrentTable(areaPercent) {
      const table = Number(
        this.task?.table ?? this.task?.table_number ?? 0
      );

      this.qrStopPending = false;
      this.resetLineController();

      // STOP tức thời, không qua slew-rate.
      this.sendMotor(0, 0, true);

      this.setMotorReason(
        "TABLE_REACHED",
        `ban_${table} · QR=${areaPercent.toFixed(2)}%`
      );

      this.setState(
        NAV_STATE.ARRIVED,
        `Đã tới bàn ${table} · QR ${areaPercent.toFixed(2)}%`
      );
    }

    beginTJunctionTurn() {
      if (!this.task) {
        this.fail("Không có task để xác định hướng rẽ.");
        return;
      }

      let direction =
        String(this.task.junction_turn || "")
          .trim()
          .toUpperCase();

      // Fallback giữ nguyên từ source trước:
      // Line 1 -> LEFT, Line 2 -> RIGHT.
      if (!direction) {
        if (Number(this.task.line) === 1) direction = "LEFT";
        if (Number(this.task.line) === 2) direction = "RIGHT";
      }

      if (!["LEFT", "RIGHT"].includes(direction)) {
        this.fail("Task không có hướng rẽ LEFT/RIGHT hợp lệ.");
        return;
      }

      const yaw = this.orientation.getYaw();
      if (yaw == null) {
        this.fail("Chưa đọc được góc orientation của điện thoại.");
        return;
      }

      this.turnDirection = direction;
      this.turnStartYaw = yaw;
      this.lastTJunctionHandledAt = performance.now();
      this.resetLineController();

      this.setState(
        NAV_STATE.T_JUNCTION_DETECTED,
        `QR nga_re, chuẩn bị rẽ ${direction}`
      );

      this.sendMotor(0, 0, true);

      window.setTimeout(() => {
        if (this.state === NAV_STATE.T_JUNCTION_DETECTED) {
          this.setState(NAV_STATE.TURNING, `Rẽ ${direction} 90°`);
        }
      }, 160);
    }

    // =====================================================
    // CONTROL LOOP
    // =====================================================

    controlLoop() {
      if (!this.task) {
        return;
      }

      switch (this.state) {
        case NAV_STATE.LINE_FOLLOW:
          this.controlLineFollow();
          break;

        case NAV_STATE.TURNING:
          this.controlTurn();
          break;

        case NAV_STATE.REACQUIRE_LINE:
          this.controlReacquireLine();
          break;

        case NAV_STATE.ARRIVED:
        case NAV_STATE.ERROR:
        case NAV_STATE.STOPPED:
        case NAV_STATE.IDLE:
        default:
          break;
      }
    }

    // =====================================================
    // LINE FOLLOW V2
    // lateral + heading + confidence + curve slowdown
    // =====================================================

    controlLineFollow() {
      // ===================================================
      // 0) STOP khi đang xác nhận QR T-junction
      // ===================================================
      if (this.qrStopPending) {
        if (performance.now() - this.lastTJunctionQrAt > 1200) {
          this.qrStopPending = false;
          this.tJunctionHits = 0;
        } else {
          this.resetLineController();
          this.setMotorReason("QR_STOP", "Đang xác nhận QR nga_re");
          this.sendMotor(0, 0, true);
          return;
        }
      }

      // ===================================================
      // 1) IR boundary override
      // ===================================================
      // Theo phần cứng bạn mô tả:
      //   true  = cảm biến còn nhận phản xạ / đang ở nền đường
      //   false = chạm băng đen / mất tín hiệu
      // Có thể đảo bằng IR_ACTIVE_LOW=false nếu firmware dùng quy ước ngược.
      const irActiveLow = this.config.IR_ACTIVE_LOW !== false;
      const leftBorderHit = irActiveLow
        ? (!this.sensors.ir2 && this.sensors.ir3)
        : (this.sensors.ir2 && !this.sensors.ir3);
      const rightBorderHit = irActiveLow
        ? (this.sensors.ir2 && !this.sensors.ir3)
        : (this.sensors.ir3 && !this.sensors.ir2);

      if (leftBorderHit) {
        this.resetLineController();
        this.setMotorReason("IR_LEFT", "Chạm biên trái → ép xe sang phải");
        this.sendMotor(
          Number(this.config.BORDER_FAST_SPEED) || 145,
          Number(this.config.BORDER_SLOW_SPEED) || 65,
          true
        );
        return;
      }

      if (rightBorderHit) {
        this.resetLineController();
        this.setMotorReason("IR_RIGHT", "Chạm biên phải → ép xe sang trái");
        this.sendMotor(
          Number(this.config.BORDER_SLOW_SPEED) || 65,
          Number(this.config.BORDER_FAST_SPEED) || 145,
          true
        );
        return;
      }

      // ===================================================
      // 2) Kiểm tra vision
      // ===================================================
      const frame = this.lastVision;

      if (
        !frame?.hasLane ||
        frame.lineError == null ||
        frame.headingErrorDeg == null ||
        frame.laneCenter == null ||
        frame.lookAheadCenter == null
      ) {
        const lostFor = performance.now() - this.lastLineSeenAt;
        this.resetLineController();

        if (lostFor >= (Number(this.config.LINE_LOST_STOP_MS) || 850)) {
          this.setMotorReason(
            "LOST_LINE",
            `Mất lane ${Math.round(lostFor)} ms → STOP`
          );
          this.sendMotor(0, 0, true);
        } else {
          this.setMotorReason(
            "WAITING_LINE",
            `Chưa có lane hợp lệ · ${Math.round(lostFor)} ms`
          );
        }
        return;
      }

      const confidence = this.clamp(
        Number(frame.laneConfidence) || 0,
        0,
        1
      );

      const minConfidence = this.clamp(
        Number(this.config.VISION_MIN_CONFIDENCE) || 0.38,
        0.05,
        0.95
      );

      const slowConfidence = this.clamp(
        Number(this.config.VISION_SLOW_CONFIDENCE) || 0.62,
        minConfidence,
        0.98
      );

      const trackMode = String(frame.trackMode || "TWO_LINES");
      const oneLineMode =
        trackMode === "LEFT_ONLY" ||
        trackMode === "RIGHT_ONLY";
      const predictedMode = trackMode === "PREDICTED";

      if (confidence < minConfidence) {
        this.resetLineController();
        this.setMotorReason(
          "LOW_CONFIDENCE",
          `${confidence.toFixed(2)} < ${minConfidence.toFixed(2)}`
        );
        return;
      }

      // ===================================================
      // 3) Hình học điều khiển
      // ===================================================
      // positionError:
      //   center xanh gần xe - tâm camera
      //   > 0: xe đang nằm bên trái center -> cần chỉnh phải
      //   < 0: xe đang nằm bên phải center -> cần chỉnh trái
      //
      // pathAngleDeg:
      //   góc của vector từ center xanh gần xe tới điểm HỒNG.
      //   < 0: đường phía trước cong TRÁI
      //   > 0: đường phía trước cong PHẢI
      //
      // Đây là thay đổi chính: pathAngle (điểm hồng) quyết định hướng cua,
      // positionError chỉ đóng vai trò giữ xe gần giữa lane.
      const lineError = Number(frame.lineError) || 0;
      const laneCenter = Number(frame.laneCenter);
      const lookAheadCenter = Number(frame.lookAheadCenter);
      const curveDx = lookAheadCenter - laneCenter;
      const pathAngleDeg = Number(frame.headingErrorDeg) || 0;
      const curvatureDeg = Number(frame.curvatureDeg) || 0;
      const frameWidth = Math.max(1, Number(frame.width) || 1);

      const positionDeadband = Math.max(
        0,
        Number(this.config.POSITION_DEADBAND_PX) || 4
      );
      const angleDeadband = Math.max(
        0,
        Number(this.config.PATH_ANGLE_DEADBAND_DEG) || 1.2
      );

      const positionError =
        Math.abs(lineError) <= positionDeadband ? 0 : lineError;
      const pathAngle =
        Math.abs(pathAngleDeg) <= angleDeadband ? 0 : pathAngleDeg;

      // ===================================================
      // 4) Tốc độ cơ sở: cua gấp -> giảm tốc
      // ===================================================
      const configuredBase = Number(this.config.BASE_SPEED) || 122;
      const minCurveSpeed = Math.min(
        configuredBase,
        Number(this.config.MIN_CURVE_SPEED) || 68
      );
      const maxSpeed = Number(this.config.MAX_SPEED) || 190;

      const fullSlowdownDeg = Math.max(
        8,
        Number(this.config.PATH_FULL_SLOWDOWN_DEG) || 24
      );

      // Dùng góc tới điểm hồng làm tín hiệu cua chính.
      // curvature chỉ bổ sung nếu center curve đổi hướng rất nhanh.
      const curveMeasure = Math.max(
        Math.abs(pathAngle),
        Math.abs(curvatureDeg) * 0.55
      );

      const curveRatio = this.clamp(
        curveMeasure / fullSlowdownDeg,
        0,
        1
      );

      let baseSpeed =
        configuredBase -
        curveRatio * (configuredBase - minCurveSpeed);

      // Lệch tâm quá xa cũng phải giảm tốc.
      const centerFullSlowdownRatio = this.clamp(
        Number(this.config.CENTER_FULL_SLOWDOWN_RATIO) || 0.26,
        0.08,
        0.49
      );

      const offCenterRatio = this.clamp(
        Math.abs(positionError) /
          (frameWidth * centerFullSlowdownRatio),
        0,
        1
      );

      baseSpeed = Math.max(
        minCurveSpeed,
        baseSpeed -
          offCenterRatio * 0.65 * (baseSpeed - minCurveSpeed)
      );

      // Confidence trung bình -> giảm tốc.
      if (confidence < slowConfidence) {
        const confidenceRatio = this.clamp(
          (confidence - minConfidence) /
            Math.max(0.001, slowConfidence - minConfidence),
          0,
          1
        );

        baseSpeed = Math.max(
          minCurveSpeed,
          minCurveSpeed +
            confidenceRatio * (baseSpeed - minCurveSpeed)
        );
      }

      // Chỉ thấy một vạch -> chạy chậm.
      if (oneLineMode) {
        baseSpeed = Math.min(
          baseSpeed,
          Math.max(35, Number(this.config.ONE_LINE_BASE_SPEED) || 76)
        );
      }

      // Mất cả hai vạch, chỉ đang prediction -> bò rất chậm.
      if (predictedMode) {
        baseSpeed = Math.min(
          baseSpeed,
          Math.max(25, Number(this.config.LOST_PREDICT_SPEED) || 52)
        );
      }

      // ===================================================
      // 5) Damping theo tốc độ thay đổi của góc và vị trí
      // ===================================================
      const now = performance.now();
      let dt = this.prevControlAt > 0
        ? (now - this.prevControlAt) / 1000
        : (Number(this.config.MOTOR_INTERVAL_MS) || 70) / 1000;
      dt = this.clamp(dt, 0.02, 0.20);

      let rawPositionDerivative = 0;
      if (this.prevLineError != null) {
        rawPositionDerivative =
          (positionError - this.prevLineError) / dt;
      }

      let rawAngleDerivative = 0;
      if (this.prevPathAngle != null) {
        rawAngleDerivative =
          (pathAngle - this.prevPathAngle) / dt;
      }

      const positionDAlpha = this.clamp(
        Number(this.config.POSITION_DERIVATIVE_EMA_ALPHA) || 0.20,
        0.05,
        1
      );
      const angleDAlpha = this.clamp(
        Number(this.config.PATH_ANGLE_DERIVATIVE_EMA_ALPHA) || 0.18,
        0.05,
        1
      );

      this.filteredLineDerivative +=
        positionDAlpha *
        (rawPositionDerivative - this.filteredLineDerivative);

      this.filteredPathAngleDerivative +=
        angleDAlpha *
        (rawAngleDerivative - this.filteredPathAngleDerivative);

      this.prevLineError = positionError;
      this.prevPathAngle = pathAngle;
      this.prevControlAt = now;

      // ===================================================
      // 6) PATH FOLLOW CONTROLLER
      // ===================================================
      // Thành phần chính: pathAngle từ điểm xanh gần xe -> điểm hồng.
      // Thành phần phụ: positionError giữ robot gần giữa lane.
      const angleKp = Number(this.config.PATH_ANGLE_KP) || 3.0;
      const angleKd = Number(this.config.PATH_ANGLE_KD) || 0.055;
      const positionKp = Number(this.config.POSITION_KP) || 0.10;
      const positionKd = Number(this.config.POSITION_KD) || 0.004;
      const curvatureKp = Number(this.config.CURVATURE_KP) || 0.18;

      const angleTerm = angleKp * pathAngle;
      const angleDTerm = angleKd * this.filteredPathAngleDerivative;
      const positionTerm = positionKp * positionError;
      const positionDTerm = positionKd * this.filteredLineDerivative;
      const curvatureTerm = curvatureKp * curvatureDeg;

      let correction =
        angleTerm +
        angleDTerm +
        positionTerm +
        positionDTerm +
        curvatureTerm;

      // ===================================================
      // 7) CURVE DIRECTION LOCK
      // ===================================================
      // Nếu điểm hồng thể hiện một cua rõ ràng thì không cho positionError
      // gần xe lật ngược hướng cua, trừ khi xe đã lệch tâm cực lớn.
      //
      // pathAngle < 0 -> bắt buộc correction âm -> Right > Left -> cua trái
      // pathAngle > 0 -> bắt buộc correction dương -> Left > Right -> cua phải
      const lockDeg = Math.max(
        0,
        Number(this.config.CURVE_DIRECTION_LOCK_DEG) || 5
      );
      const minCurveCorrection = Math.max(
        0,
        Number(this.config.CURVE_DIRECTION_MIN_CORRECTION) || 10
      );
      const overrideOffCenter = this.clamp(
        Number(this.config.CURVE_DIRECTION_OVERRIDE_OFFCENTER_RATIO) || 0.85,
        0.35,
        1
      );

      if (
        Math.abs(pathAngle) >= lockDeg &&
        offCenterRatio < overrideOffCenter
      ) {
        if (pathAngle < 0 && correction > -minCurveCorrection) {
          correction = -minCurveCorrection;
        }
        else if (pathAngle > 0 && correction < minCurveCorrection) {
          correction = minCurveCorrection;
        }
      }

      if (oneLineMode) {
        correction *= this.clamp(
          Number(this.config.ONE_LINE_STEERING_GAIN) || 1.08,
          0.75,
          1.40
        );
      }

      if (predictedMode) {
        correction *= this.clamp(
          Number(this.config.LOST_PREDICT_STEERING_GAIN) || 0.82,
          0.35,
          1.00
        );
      }

      const maxCorrection = Math.max(
        10,
        Number(this.config.MAX_STEERING_CORRECTION) || 92
      );
      correction = this.clamp(
        correction,
        -maxCorrection,
        maxCorrection
      );

      // ===================================================
      // 8) Differential drive
      // ===================================================
      // correction < 0 -> Left chậm, Right nhanh -> cua trái
      // correction > 0 -> Left nhanh, Right chậm -> cua phải
      const leftTarget = this.clamp(
        baseSpeed + correction,
        -maxSpeed,
        maxSpeed
      );
      const rightTarget = this.clamp(
        baseSpeed - correction,
        -maxSpeed,
        maxSpeed
      );

      const directionText =
        pathAngle < -angleDeadband
          ? "LEFT"
          : pathAngle > angleDeadband
            ? "RIGHT"
            : "STRAIGHT";

      const debugDetail =
        `${directionText} · angle=${pathAngleDeg.toFixed(1)}°` +
        ` · pinkDx=${Math.round(curveDx)}px` +
        ` · pos=${Math.round(lineError)}px` +
        ` · conf=${confidence.toFixed(2)}`;

      if (trackMode === "LEFT_ONLY") {
        this.setMotorReason("ONE_LINE_LEFT", debugDetail);
      }
      else if (trackMode === "RIGHT_ONLY") {
        this.setMotorReason("ONE_LINE_RIGHT", debugDetail);
      }
      else if (predictedMode) {
        this.setMotorReason("PREDICTED", debugDetail);
      }
      else {
        this.setMotorReason("PATH_FOLLOW", debugDetail);
      }

      this.sendMotor(leftTarget, rightTarget);
    }

    // =====================================================
    // GYRO TURN
    // =====================================================

    controlTurn() {
      const yaw = this.orientation.getYaw();

      if (yaw == null || this.turnStartYaw == null) {
        this.fail("Mất dữ liệu orientation trong lúc rẽ.");
        return;
      }

      const relative =
        window.RobotOrientation.deltaDegrees(
          yaw,
          this.turnStartYaw
        );

      const angle = Math.abs(relative);
      const target =
        Number(this.config.TURN_TARGET_DEG) || 90;
      const targetTolerance = Math.max(
        0.5,
        Number(this.config.TURN_TARGET_TOLERANCE_DEG) || 2
      );
      const configuredSearchAt =
        Number(this.config.TURN_START_LINE_SEARCH_DEG) || 88;

      // Không cho reacquire quá sớm. Với target 90° và tolerance 2°
      // thì phải quay ít nhất khoảng 88° mới được nhận line mới.
      const searchAt = Math.max(
        configuredSearchAt,
        target - targetTolerance
      );

      const maxAngle =
        Number(this.config.TURN_MAX_DEG) || 112;

      const frame = this.lastVision;
      const confidence = Number(frame?.laneConfidence) || 0;
      const minConfidence =
        Number(this.config.VISION_MIN_CONFIDENCE) || 0.38;

      // Chỉ chấp nhận line mới khi thực sự thấy cả hai biên, confidence đủ
      // và tâm đã tương đối gần giữa ảnh.
      if (
        angle >= searchAt &&
        frame?.hasBothLines &&
        frame?.hasLane &&
        confidence >= minConfidence &&
        frame.lineError != null &&
        Math.abs(frame.lineError) < frame.width * 0.22
      ) {
        this.sendMotor(0, 0, true);
        this.reacquireStableFrames = 0;

        this.setState(
          NAV_STATE.REACQUIRE_LINE,
          `Đã thấy line mới ở ${angle.toFixed(1)}°`
        );
        return;
      }

      if (angle > maxAngle) {
        this.fail(`Quay quá ${maxAngle}° nhưng chưa bắt lại được line.`);
        return;
      }

      const remaining = Math.max(0, target - angle);
      let speed;

      if (remaining > 35) {
        speed = Number(this.config.TURN_FAST_SPEED) || 145;
      }
      else if (remaining > 15) {
        speed = Number(this.config.TURN_MEDIUM_SPEED) || 105;
      }
      else {
        speed = Number(this.config.TURN_SLOW_SPEED) || 72;
      }

      if (angle >= target) {
        speed = Number(this.config.TURN_SLOW_SPEED) || 72;
      }

      if (this.turnDirection === "LEFT") {
        this.setMotorReason("TURN_LEFT", `yaw=${angle.toFixed(1)}°`);
        this.sendMotor(-speed, speed);
      }
      else {
        this.setMotorReason("TURN_RIGHT", `yaw=${angle.toFixed(1)}°`);
        this.sendMotor(speed, -speed);
      }
    }

    // =====================================================
    // REACQUIRE LINE
    // =====================================================

    controlReacquireLine() {
      const frame = this.lastVision;
      const minConfidence =
        Number(this.config.VISION_MIN_CONFIDENCE) || 0.38;

      if (
        !frame?.hasLane ||
        !frame?.hasBothLines ||
        frame.lineError == null ||
        frame.headingErrorDeg == null ||
        (Number(frame.laneConfidence) || 0) < minConfidence
      ) {
        this.reacquireStableFrames = 0;
        this.setMotorReason("REACQUIRE_WAIT", "Đang chờ bắt lại đủ 2 biên");
        this.sendMotor(0, 0, true);
        return;
      }

      const base = Math.min(
        88,
        Number(this.config.BASE_SPEED) || 122
      );

      const positionKp = Number(this.config.POSITION_KP) || 0.10;
      const angleKp = Number(this.config.PATH_ANGLE_KP) || 3.0;

      // Sau cú rẽ, vẫn ưu tiên hướng tới điểm hồng nhưng giới hạn nhẹ hơn
      // để quá trình bắt lại line không giật mạnh.
      const correction = this.clamp(
        frame.lineError * positionKp +
        frame.headingErrorDeg * angleKp,
        -55,
        55
      );

      this.setMotorReason(
        "REACQUIRE_LINE",
        `err=${Math.round(frame.lineError)} px`
      );

      this.sendMotor(
        this.clamp(base + correction, 38, 110),
        this.clamp(base - correction, 38, 110)
      );

      const centered =
        Math.abs(frame.lineError) < frame.width * 0.10;

      const headingReady =
        Math.abs(frame.headingErrorDeg) < 12;

      if (centered && headingReady) {
        this.reacquireStableFrames += 1;
      }
      else {
        this.reacquireStableFrames = 0;
      }

      if (this.reacquireStableFrames >= 5) {
        this.turnStartYaw = null;
        this.turnDirection = null;
        this.reacquireStableFrames = 0;
        this.resetLineController();
        this.setState(NAV_STATE.LINE_FOLLOW, "Đã ổn định line mới");
      }
    }

    // =====================================================
    // MOTOR OUTPUT + SLEW RATE LIMIT
    // =====================================================

    sendMotor(left, right, force = false) {
      const now = performance.now();
      const interval = Math.max(
        30,
        Number(this.config.MOTOR_INTERVAL_MS) || 70
      );

      if (!force && now - this.lastMotorAt < interval * 0.8) {
        return;
      }

      let nextLeft = Number(left) || 0;
      let nextRight = Number(right) || 0;

      if (!force) {
        const maxDelta = Math.max(
          1,
          Number(this.config.MOTOR_MAX_DELTA_PER_UPDATE) || 20
        );

        const deltaLeft = nextLeft - this.lastMotor.left;
        const deltaRight = nextRight - this.lastMotor.right;
        const largestDelta = Math.max(
          Math.abs(deltaLeft),
          Math.abs(deltaRight)
        );

        // Scale cả vector PWM cùng một tỷ lệ để vẫn giữ chênh lệch
        // trái/phải. Nếu clamp từng bánh riêng, giai đoạn tăng tốc có thể
        // vô tình biến một lệnh cua thành hai bánh bằng nhau.
        if (largestDelta > maxDelta) {
          const scale = maxDelta / largestDelta;
          nextLeft = this.lastMotor.left + deltaLeft * scale;
          nextRight = this.lastMotor.right + deltaRight * scale;
        }
      }

      const maxSpeed = Math.max(
        1,
        Number(this.config.MAX_SPEED) || 190
      );

      nextLeft = this.clamp(nextLeft, -maxSpeed, maxSpeed);
      nextRight = this.clamp(nextRight, -maxSpeed, maxSpeed);

      this.lastMotorAt = now;
      this.lastMotor = {
        left: Math.round(nextLeft),
        right: Math.round(nextRight)
      };

      const published = this.mqtt.publishMotor(
        this.lastMotor.left,
        this.lastMotor.right
      );

      this.updateMotorPublishDebug(published);

      // Cập nhật trực tiếp các ô motor trong DEBUG CAMERA.
      // Làm ở navigation.js để chỉ cần apply 4 file chính,
      // không phụ thuộc robot-control.js có phiên bản mới hay cũ.
      if (typeof document !== "undefined") {
        const leftDebug = document.getElementById("visionMotorLeftState");
        const rightDebug = document.getElementById("visionMotorRightState");
        const leftState = document.getElementById("leftMotorState");
        const rightState = document.getElementById("rightMotorState");

        if (leftDebug) leftDebug.textContent = String(this.lastMotor.left);
        if (rightDebug) rightDebug.textContent = String(this.lastMotor.right);
        if (leftState) leftState.textContent = String(this.lastMotor.left);
        if (rightState) rightState.textContent = String(this.lastMotor.right);
      }

      this.onMotor({
        ...this.lastMotor,
        published: Boolean(published)
      });
    }

    clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }
  }

  window.ROBOT_NAV_STATE = NAV_STATE;
  window.RobotNavigation = RobotNavigation;
})();
