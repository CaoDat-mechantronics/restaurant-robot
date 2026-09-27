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

      // lastLogicalMotor: tốc độ nội bộ của thuật toán (-MAX_SPEED..MAX_SPEED).
      // lastMotor: PWM thật đã map và gửi xuống ESP32 (-255..255).
      this.lastLogicalMotor = { left: 0, right: 0 };
      this.lastMotor = { left: 0, right: 0 };
      this.controlTimer = null;

      // Sau mỗi lần motor về 0/0, lần chạy tiếp theo sẽ có một pha
      // kick-start ngắn để thắng ma sát tĩnh của xe 4 bánh nặng.
      this.motorNeedsStartBoost = true;
      this.motorStartBoostUntil = 0;

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

      // Blue-curve feed-forward: chỉ bổ sung độ mạnh steering theo độ cong
      // của centerCurve xanh, không thay PID Precision V2.
      this.blueCurveDirection = "STRAIGHT";
      this.blueCurveSeverity = 0;
      this.blueCurveTargetGap = 0;
      this.filteredBlueCurveGap = 0;

      // Debug/state cho lane-geometry soft controller.
      this.geometryControl = {
        lateralNorm: 0,
        headingNorm: 0,
        curvatureNorm: 0,
        headingDNorm: 0,
        rawSteering: 0,
        steeringCommand: 0,
        severity: 0,
        baseSpeed: 0,
        deltaLogical: 0
      };
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
      this.lastLogicalMotor = { left: 0, right: 0 };
      this.lastMotor = { left: 0, right: 0 };
      this.motorNeedsStartBoost = true;
      this.motorStartBoostUntil = 0;
      this.resetLineController();
      this.resetGeometryControllerDebug();
      this.setMotorReason("WAITING_VISION", "Đang chờ camera nhận diện lane");

      this.setState(NAV_STATE.LINE_FOLLOW);

      if (!this.controlTimer) {
        this.controlTimer = window.setInterval(
          () => this.controlLoop(),
          Math.max(30, Number(this.config.MOTOR_INTERVAL_MS) || 40)
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
      this.blueCurveDirection = "STRAIGHT";
      this.blueCurveSeverity = 0;
      this.blueCurveTargetGap = 0;
      this.filteredBlueCurveGap = 0;
      this.updateBlueCurveDebugUi();
      this.resetGeometryControllerDebug();
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
          Number(this.config.BORDER_FAST_SPEED) || 88,
          Number(this.config.BORDER_SLOW_SPEED) || 30,
          true
        );
        return;
      }

      if (rightBorderHit) {
        this.resetLineController();
        this.setMotorReason("IR_RIGHT", "Chạm biên phải → ép xe sang trái");
        this.sendMotor(
          Number(this.config.BORDER_SLOW_SPEED) || 30,
          Number(this.config.BORDER_FAST_SPEED) || 88,
          true
        );
        return;
      }

      // ===================================================
      // 2) Kiểm tra vision
      // ===================================================
      const frame = this.lastVision;

      // Không lái bằng một kết quả vision đã quá cũ.
      const frameTimestamp = Number(frame?.timestamp);
      const frameAgeMs = Number.isFinite(frameTimestamp)
        ? Math.max(0, performance.now() - frameTimestamp)
        : Infinity;
      const maxFrameAgeMs = Math.max(80, Number(this.config.VISION_MAX_FRAME_AGE_MS) || 160);

      if (frame && frameAgeMs > maxFrameAgeMs) {
        this.resetLineController();
        this.setMotorReason(
          "STALE_VISION",
          `Frame cũ ${Math.round(frameAgeMs)} ms → STOP`
        );
        this.sendMotor(0, 0, true);
        return;
      }

      if (
        !frame?.hasLane ||
        frame.lineError == null ||
        (frame.controlHeadingErrorDeg == null && frame.headingErrorDeg == null) ||
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

      // Steering tức thời bám đoạn vàng cục bộ rất ngắn,
      // vẫn được blend nhẹ với look-ahead dài trong vision.js.
      const pathAngleDeg =
        Number.isFinite(Number(frame.controlHeadingErrorDeg))
          ? Number(frame.controlHeadingErrorDeg)
          : Number(frame.headingErrorDeg) || 0;

      const curvatureDeg = Number(frame.curvatureDeg) || 0;
      const frameWidth = Math.max(1, Number(frame.width) || 1);

      // Severity/direction lấy trực tiếp từ centerCurve xanh của vision.
      this.blueCurveSeverity = this.clamp(
        Number(frame.blueCurveSeverity) || 0,
        0,
        1
      );
      this.blueCurveDirection = String(frame.blueCurveDirection || "STRAIGHT");


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
      const configuredBase = Number(this.config.BASE_SPEED) || 96;
      const minCurveSpeed = Math.min(
        configuredBase,
        Number(this.config.MIN_CURVE_SPEED) || 44
      );
      const maxSpeed = Number(this.config.MAX_SPEED) || 155;

      const fullSlowdownDeg = Math.max(
        8,
        Number(this.config.PATH_FULL_SLOWDOWN_DEG) || 15
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

      const severityWeight = this.clamp(
        Number(this.config.LANE_CURVE_SPEED_SEVERITY_WEIGHT) || 1.0,
        0,
        1.5
      );

      const speedCurveSeverity = this.clamp(
        Math.max(
          curveRatio,
          this.blueCurveSeverity * severityWeight
        ),
        0,
        1
      );

      let baseSpeed =
        configuredBase -
        speedCurveSeverity * (configuredBase - minCurveSpeed);

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
          Math.max(35, Number(this.config.ONE_LINE_BASE_SPEED) || 50)
        );
      }

      // Mất cả hai vạch, chỉ đang prediction -> bò rất chậm.
      if (predictedMode) {
        baseSpeed = Math.min(
          baseSpeed,
          Math.max(25, Number(this.config.LOST_PREDICT_SPEED) || 34)
        );
      }

      // ===================================================
      // 5) Damping theo tốc độ thay đổi của góc và vị trí
      // ===================================================
      const now = performance.now();
      let dt = this.prevControlAt > 0
        ? (now - this.prevControlAt) / 1000
        : (Number(this.config.MOTOR_INTERVAL_MS) || 40) / 1000;
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
      // 6) LANE GEOMETRY SOFT CONTROLLER
      // ===================================================
      // Không dùng cặp PWM hard-code.
      // Camera tạo 3 tín hiệu hình học:
      //   lateral  : center xanh gần xe lệch khỏi tâm camera bao nhiêu
      //   heading  : tiếp tuyến cục bộ của đường xanh khác hướng camera bao nhiêu
      //   curvature: đường xanh tiếp tục uốn bao nhiêu ở phía trước
      //
      // Tất cả được chuẩn hoá rồi qua tanh() để steering tăng mượt:
      // sai số nhỏ -> correction nhỏ
      // sai số lớn -> correction lớn
      // nhưng không nhảy vô hạn.
      const lateralFullRatio = this.clamp(
        Number(this.config.LANE_LATERAL_FULL_RATIO) || 0.18,
        0.05,
        0.45
      );
      const headingFullDeg = Math.max(
        3,
        Number(this.config.LANE_HEADING_FULL_DEG) || 20
      );
      const curvatureFullDeg = Math.max(
        2,
        Number(this.config.LANE_CURVATURE_FULL_DEG) || 10
      );
      const headingDFullDegS = Math.max(
        20,
        Number(this.config.LANE_HEADING_D_FULL_DEG_S) || 140
      );

      const lateralNorm = this.clamp(
        positionError /
          Math.max(1, frameWidth * lateralFullRatio),
        -1,
        1
      );
      const headingNorm = this.clamp(
        pathAngle / headingFullDeg,
        -1,
        1
      );
      const curvatureNorm = this.clamp(
        curvatureDeg / curvatureFullDeg,
        -1,
        1
      );
      const headingDNorm = this.clamp(
        this.filteredPathAngleDerivative / headingDFullDegS,
        -1,
        1
      );

      const wLateral =
        Number(this.config.LANE_WEIGHT_LATERAL) || 0.80;
      const wHeading =
        Number(this.config.LANE_WEIGHT_HEADING) || 1.35;
      const wCurvature =
        Number(this.config.LANE_WEIGHT_CURVATURE) || 0.72;
      const wHeadingD =
        Number(this.config.LANE_WEIGHT_HEADING_D) || 0.14;

      let rawSteering =
        wLateral * lateralNorm +
        wHeading * headingNorm +
        wCurvature * curvatureNorm +
        wHeadingD * headingDNorm;

      const softScale = Math.max(
        0.20,
        Number(this.config.LANE_STEERING_SOFT_SCALE) || 1.00
      );

      let steeringCommand = Math.tanh(
        rawSteering / softScale
      );

      // Severity quyết định "quyền" tạo chênh tốc.
      // Không quyết định một cặp PWM cụ thể.
      const steeringSeverity = this.clamp(
        Math.max(
          this.blueCurveSeverity,
          Math.abs(headingNorm),
          Math.abs(curvatureNorm),
          Math.abs(lateralNorm) * 0.70
        ),
        0,
        1
      );

      const minDeltaLogical = Math.max(
        0,
        Number(this.config.LANE_STEERING_MIN_DELTA_LOGICAL) || 10
      );
      const maxDeltaLogical = Math.max(
        minDeltaLogical + 1,
        Number(this.config.LANE_STEERING_MAX_DELTA_LOGICAL) || 110
      );
      const deltaExponent = Math.max(
        0.35,
        Number(this.config.LANE_STEERING_DELTA_EXPONENT) || 0.88
      );

      let steeringAuthority =
        minDeltaLogical +
        (maxDeltaLogical - minDeltaLogical) *
        Math.pow(steeringSeverity, deltaExponent);

      if (oneLineMode) {
        steeringAuthority *= this.clamp(
          Number(this.config.ONE_LINE_STEERING_GAIN) || 1.08,
          0.75,
          1.35
        );
      }

      if (predictedMode) {
        steeringAuthority *= this.clamp(
          Number(this.config.LOST_PREDICT_STEERING_GAIN) || 0.82,
          0.30,
          1
        );
      }

      let correction =
        steeringCommand * steeringAuthority;

      // ===================================================
      // 7) DIRECTION LOCK NHẸ THEO BLUE CURVE
      // ===================================================
      // Chỉ bảo vệ dấu khi blue curve rất rõ.
      // Nếu robot lệch tâm cực lớn, lateral controller vẫn được override.
      const lockSeverity = this.clamp(
        Number(this.config.LANE_DIRECTION_LOCK_SEVERITY) || 0.28,
        0,
        1
      );
      const lockMinDelta = Math.max(
        0,
        Number(this.config.LANE_DIRECTION_LOCK_MIN_DELTA_LOGICAL) || 8
      );
      const overrideLateral = this.clamp(
        Number(this.config.LANE_DIRECTION_OVERRIDE_LATERAL) || 0.88,
        0.3,
        1
      );

      if (
        this.blueCurveSeverity >= lockSeverity &&
        Math.abs(lateralNorm) < overrideLateral
      ) {
        if (
          this.blueCurveDirection === "LEFT" &&
          correction > -lockMinDelta
        ) {
          correction = -lockMinDelta;
        }
        else if (
          this.blueCurveDirection === "RIGHT" &&
          correction < lockMinDelta
        ) {
          correction = lockMinDelta;
        }
      }

      // ===================================================
      // 8) DIFFERENTIAL DRIVE
      // ===================================================
      // correction < 0 -> Left giảm, Right tăng -> cua trái
      // correction > 0 -> Left tăng, Right giảm -> cua phải
      //
      // Không speed-aware clamp theo baseSpeed nữa:
      // ở cua gắt bánh trong được phép giảm rất thấp,
      // đồng thời bánh ngoài vẫn có thể tăng cao.
      // Chỉ cấm reverse trong LINE_FOLLOW.
      const configuredMinForward = Number(
        this.config.LINE_FOLLOW_MIN_LOGICAL_SPEED
      );
      const minForwardLogical = Math.max(
        0,
        Number.isFinite(configuredMinForward)
          ? configuredMinForward
          : 1
      );

      const leftTarget = this.clamp(
        baseSpeed + correction,
        minForwardLogical,
        maxSpeed
      );
      const rightTarget = this.clamp(
        baseSpeed - correction,
        minForwardLogical,
        maxSpeed
      );

      this.geometryControl = {
        lateralNorm,
        headingNorm,
        curvatureNorm,
        headingDNorm,
        rawSteering,
        steeringCommand,
        severity: steeringSeverity,
        baseSpeed,
        deltaLogical: correction
      };
      this.updateGeometryControllerDebug();

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
        speed = Number(this.config.TURN_FAST_SPEED) || 88;
      }
      else if (remaining > 15) {
        speed = Number(this.config.TURN_MEDIUM_SPEED) || 68;
      }
      else {
        speed = Number(this.config.TURN_SLOW_SPEED) || 48;
      }

      if (angle >= target) {
        speed = Number(this.config.TURN_SLOW_SPEED) || 48;
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
        Number(this.config.BASE_SPEED) || 96
      );

      const positionKp = Number(this.config.POSITION_KP) || 0.075;
      const angleKp = Number(this.config.PATH_ANGLE_KP) || 2.15;

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
    // MOTOR OUTPUT
    // =====================================================
    //
    // Hai tầng tách biệt:
    //
    // 1) Thuật toán path-follow vẫn tính tốc độ LOGIC trên thang
    //    -MAX_SPEED..MAX_SPEED để giữ độ phân giải lái.
    //
    // 2) Tầng vật lý chuyển sang PWM theo cơ chế:
    //
    //    STOP        : 0 / 0
    //    chạy thẳng : quanh MOTOR_CRUISE_PWM
    //    vào cua     : bánh trong giảm thật, bánh ngoài tăng vừa phải
    //    kick-start  : mặc định tắt với hộp số 1/120
    //
    // Nhờ vậy tốc độ vật lý phản ánh đúng curve slowdown của controller.
    // =====================================================

    sendMotor(left, right, force = false) {
      const now = performance.now();
      const interval = Math.max(
        30,
        Number(this.config.MOTOR_INTERVAL_MS) || 40
      );

      if (!force && now - this.lastMotorAt < interval * 0.8) {
        return;
      }

      let nextLeft = Number(left) || 0;
      let nextRight = Number(right) || 0;

      const zeroCutoff = Math.max(
        0,
        Number(this.config.MOTOR_ZERO_CUTOFF_LOGICAL) || 0.5
      );

      const requestedStop =
        Math.abs(nextLeft) <= zeroCutoff &&
        Math.abs(nextRight) <= zeroCutoff;

      // ---------------------------------------------------
      // STOP phải luôn tức thời và chính xác 0 / 0.
      // Đồng thời đánh dấu để lần chạy kế tiếp có kick-start.
      // ---------------------------------------------------
      if (requestedStop) {
        this.motorNeedsStartBoost = true;
        this.motorStartBoostUntil = 0;
        this.lastLogicalMotor = { left: 0, right: 0 };
        this.lastMotorAt = now;
        this.lastMotor = { left: 0, right: 0 };

        const published = this.mqtt.publishMotor(0, 0);
        this.updateMotorPublishDebug(published);
        this.updateMotorDebugUi(0, 0);

        this.onMotor({
          left: 0,
          right: 0,
          published: Boolean(published),
          boost: false
        });

        return;
      }

      // ---------------------------------------------------
      // Slew-rate chạy trên thang LOGIC để hạn chế thay đổi PWM đột ngột.
      // Nếu sau này bật kick-start trở lại thì controller vẫn tiếp tục
      // tiến dần tới target trong suốt pha boost.
      // ---------------------------------------------------
      if (!force) {
        const maxDelta = Math.max(
          1,
          Number(this.config.MOTOR_MAX_DELTA_PER_UPDATE) || 7
        );

        const deltaLeft = nextLeft - this.lastLogicalMotor.left;
        const deltaRight = nextRight - this.lastLogicalMotor.right;
        const largestDelta = Math.max(
          Math.abs(deltaLeft),
          Math.abs(deltaRight)
        );

        if (largestDelta > maxDelta) {
          const scale = maxDelta / largestDelta;
          nextLeft = this.lastLogicalMotor.left + deltaLeft * scale;
          nextRight = this.lastLogicalMotor.right + deltaRight * scale;
        }
      }

      const maxSpeed = Math.max(
        1,
        Number(this.config.MAX_SPEED) || 155
      );

      nextLeft = this.clamp(nextLeft, -maxSpeed, maxSpeed);
      nextRight = this.clamp(nextRight, -maxSpeed, maxSpeed);

      this.lastLogicalMotor = {
        left: nextLeft,
        right: nextRight
      };

      // ---------------------------------------------------
      // Bắt đầu kick-start chỉ khi chuyển từ STOP -> RUN.
      // ---------------------------------------------------
      if (this.motorNeedsStartBoost) {
        const configuredBoostMs = Number(this.config.MOTOR_START_BOOST_MS);
        const boostMs = Math.max(
          0,
          Number.isFinite(configuredBoostMs) ? configuredBoostMs : 0
        );

        this.motorStartBoostUntil = now + boostMs;
        this.motorNeedsStartBoost = false;
      }

      const boostActive = now < this.motorStartBoostUntil;

      let mapped = this.mapMotorPairToPwm(
        nextLeft,
        nextRight,
        boostActive
      );

      // LINE_FOLLOW đã tính steering từ lane geometry ở thang LOGIC.
      // Tại đây chỉ map sang PWM vật lý; không có profile/gap/yaw controller
      // bổ sung để tránh điều khiển chồng nhau.
      mapped = {
        left: Math.round(mapped.left),
        right: Math.round(mapped.right)
      };

      this.lastMotorAt = now;
      this.lastMotor = {
        left: Math.round(mapped.left),
        right: Math.round(mapped.right)
      };

      const published = this.mqtt.publishMotor(
        this.lastMotor.left,
        this.lastMotor.right
      );

      this.updateMotorPublishDebug(published);
      this.updateMotorDebugUi(
        this.lastMotor.left,
        this.lastMotor.right
      );

      if (boostActive) {
        const remain = Math.max(
          0,
          Math.ceil(this.motorStartBoostUntil - now)
        );

        this.setMotorReason(
          "KICK_START",
          `PWM>=${Number(this.config.MOTOR_START_BOOST_PWM) || 112} · còn ${remain} ms`
        );
      }

      this.onMotor({
        ...this.lastMotor,
        published: Boolean(published),
        boost: boostActive
      });
    }

    // =====================================================
    // MAP LOGICAL MOTOR -> PWM VẬT LÝ (GEAR 1/120)
    // =====================================================
    //
    // Khác bản cũ: không ép cả hai bánh luôn >= MOTOR_CRUISE_PWM.
    // Mỗi bánh được map độc lập theo magnitude logic:
    //
    //   logical nhỏ          -> MOTOR_MIN_RUN_PWM
    //   logical = BASE_SPEED -> MOTOR_CRUISE_PWM
    //   logical = MAX_SPEED  -> MOTOR_MAX_PWM
    //
    // Vì vậy khi cua, bánh trong thực sự giảm tốc và curve slowdown thực sự
    // làm cả xe chậm lại. Đây phù hợp hơn khi hộp số 1/120 đã đủ mô-men.
    // =====================================================

    mapMotorPairToPwm(left, right, boostActive = false) {
      const zeroCutoff = Math.max(
        0,
        Number(this.config.MOTOR_ZERO_CUTOFF_LOGICAL) || 0.5
      );

      const leftValue = Math.abs(left) <= zeroCutoff ? 0 : Number(left) || 0;
      const rightValue = Math.abs(right) <= zeroCutoff ? 0 : Number(right) || 0;

      if (leftValue === 0 && rightValue === 0) {
        return { left: 0, right: 0 };
      }

      const minRunPwm = this.clamp(
        Number(this.config.MOTOR_MIN_RUN_PWM) || 62,
        1,
        254
      );

      const cruisePwm = this.clamp(
        Number(this.config.MOTOR_CRUISE_PWM) || 98,
        minRunPwm,
        254
      );

      const maxPwm = this.clamp(
        Number(this.config.MOTOR_MAX_PWM) || 185,
        cruisePwm,
        255
      );

      const boostPwm = this.clamp(
        Number(this.config.MOTOR_START_BOOST_PWM) || cruisePwm,
        cruisePwm,
        maxPwm
      );

      let leftPwm = this.mapSingleMotorPhysical(
        leftValue,
        minRunPwm,
        cruisePwm,
        maxPwm
      );
      let rightPwm = this.mapSingleMotorPhysical(
        rightValue,
        minRunPwm,
        cruisePwm,
        maxPwm
      );

      // ---------------------------------------------------
      // Không ép torque floor riêng trong LINE_FOLLOW.
      // MOTOR_MIN_RUN_PWM là giới hạn vật lý duy nhất cho bánh đang quay.
      // Vì vậy bánh trong có thể linh hoạt xuống dưới 70 nếu hình học yêu cầu.
      // ---------------------------------------------------

      // Boost chỉ nâng mức tối thiểu của bánh đang quay; không phá chênh lệch
      // trái/phải. Với cấu hình gear 1/120 mặc định boostMs=0 nên nhánh này tắt.
      if (boostActive) {
        if (leftPwm !== 0) {
          leftPwm = Math.sign(leftPwm) * Math.max(Math.abs(leftPwm), boostPwm);
        }
        if (rightPwm !== 0) {
          rightPwm = Math.sign(rightPwm) * Math.max(Math.abs(rightPwm), boostPwm);
        }
      }

      return { left: leftPwm, right: rightPwm };
    }

    mapSingleMotorPhysical(value, minRunPwm, cruisePwm, maxPwm) {
      const numeric = Number(value) || 0;
      if (numeric === 0) return 0;

      const sign = numeric < 0 ? -1 : 1;
      const magnitude = Math.abs(numeric);

      const logicalBase = Math.max(
        1,
        Number(this.config.BASE_SPEED) || 96
      );
      const logicalMax = Math.max(
        logicalBase + 1,
        Number(this.config.MAX_SPEED) || 155
      );

      let pwm;

      if (magnitude <= logicalBase) {
        // 0..BASE_SPEED -> MIN_RUN..CRUISE
        const ratio = this.clamp(magnitude / logicalBase, 0, 1);
        pwm = minRunPwm + ratio * (cruisePwm - minRunPwm);
      }
      else {
        // BASE_SPEED..MAX_SPEED -> CRUISE..MAX
        const ratio = this.clamp(
          (magnitude - logicalBase) / (logicalMax - logicalBase),
          0,
          1
        );
        pwm = cruisePwm + ratio * (maxPwm - cruisePwm);
      }

      return sign * Math.round(this.clamp(pwm, minRunPwm, maxPwm));
    }


    // =====================================================
    // ADAPTIVE CURVATURE + GYRO FEEDBACK
    // =====================================================

    resetGeometryControllerDebug() {
      this.geometryControl = {
        lateralNorm: 0,
        headingNorm: 0,
        curvatureNorm: 0,
        headingDNorm: 0,
        rawSteering: 0,
        steeringCommand: 0,
        severity: 0,
        baseSpeed: 0,
        deltaLogical: 0
      };
      this.updateGeometryControllerDebug();
    }

    updateGeometryControllerDebug() {
      if (typeof document === "undefined") {
        return;
      }

      const state = this.geometryControl || {};
      const lateralPx = Number(this.lastVision?.lineError);
      const headingDeg =
        Number.isFinite(Number(this.lastVision?.controlHeadingErrorDeg))
          ? Number(this.lastVision.controlHeadingErrorDeg)
          : Number(this.lastVision?.headingErrorDeg);
      const curvatureDeg = Number(this.lastVision?.curvatureDeg);

      const lateralText = Number.isFinite(lateralPx)
        ? `${lateralPx >= 0 ? "+" : ""}${lateralPx.toFixed(1)} px`
        : "-";
      const headingText = Number.isFinite(headingDeg)
        ? `${headingDeg >= 0 ? "+" : ""}${headingDeg.toFixed(1)}°`
        : "-";
      const curvatureText = Number.isFinite(curvatureDeg)
        ? `${curvatureDeg >= 0 ? "+" : ""}${curvatureDeg.toFixed(1)}°`
        : "-";

      const steeringText =
        `${Number(state.steeringCommand || 0).toFixed(2)}` +
        ` · sev ${Math.round((state.severity || 0) * 100)}%`;

      const baseText =
        `${Number(state.baseSpeed || 0).toFixed(1)} logic`;
      const deltaText =
        `${Number(state.deltaLogical || 0) >= 0 ? "+" : ""}` +
        `${Number(state.deltaLogical || 0).toFixed(1)} logic`;

      const set = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      };

      set("geometryLateralState", lateralText);
      set("geometryHeadingState", headingText);
      set("geometryCurvatureState", curvatureText);
      set("geometrySteeringState", steeringText);
      set("geometryBaseState", baseText);
      set("geometryDeltaState", deltaText);

      set("visionGeometrySteeringState", steeringText);
      set("visionGeometryBaseState", baseText);
      set("visionGeometryDeltaState", deltaText);
    }

    updateBlueCurveDebugUi() {
      if (typeof document === "undefined") return;

      const severityText =
        `${this.blueCurveDirection} · ${Math.round((this.blueCurveSeverity || 0) * 100)}%`;
      const gapText = `${Math.round(this.blueCurveTargetGap || 0)} PWM`;

      const severityEl = document.getElementById("visionBlueCurveState");
      const gapEl = document.getElementById("visionCurveGapState");
      const mainSeverityEl = document.getElementById("blueCurveState");
      const mainGapEl = document.getElementById("curveGapState");

      if (severityEl) severityEl.textContent = severityText;
      if (gapEl) gapEl.textContent = gapText;
      if (mainSeverityEl) mainSeverityEl.textContent = severityText;
      if (mainGapEl) mainGapEl.textContent = gapText;
    }

    updateMotorDebugUi(left, right) {
      if (typeof document === "undefined") {
        return;
      }

      const leftDebug = document.getElementById("visionMotorLeftState");
      const rightDebug = document.getElementById("visionMotorRightState");
      const leftState = document.getElementById("leftMotorState");
      const rightState = document.getElementById("rightMotorState");

      if (leftDebug) leftDebug.textContent = String(left);
      if (rightDebug) rightDebug.textContent = String(right);
      if (leftState) leftState.textContent = String(left);
      if (rightState) rightState.textContent = String(right);
    }

    clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }
  }

  window.ROBOT_NAV_BUILD = "2026-09-27-gear120-lane-geometry-v1";
  console.info("[RobotNavigation] loaded", window.ROBOT_NAV_BUILD);

  window.ROBOT_NAV_STATE = NAV_STATE;
  window.RobotNavigation = RobotNavigation;
})();
