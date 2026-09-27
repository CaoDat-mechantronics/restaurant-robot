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
        geometryTurnRatio: 0,
        feedbackTurnRatio: 0,
        effectiveTrackLane: 0,
        skidMultiplier: 0,
        severity: 0,
        baseSpeed: 0,
        deltaLogical: 0,
        targetCurvature: 0,
        turnRatio: 0,
        adaptiveLookaheadU: 0
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
      this.filteredTurnRatio = 0;
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
      // 0) STOP while confirming QR junction
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
      // 1) CAMERA ONLY in LINE_FOLLOW
      // ===================================================
      // IR2/IR3 are intentionally ignored in this web-only tuning build.
      // This keeps the experiment deterministic: only camera geometry controls motors.

      const frame = this.lastVision;
      const frameTimestamp = Number(frame?.timestamp);
      const frameAgeMs = Number.isFinite(frameTimestamp)
        ? Math.max(0, performance.now() - frameTimestamp)
        : Infinity;
      const maxFrameAgeMs = Math.max(70, Number(this.config.VISION_MAX_FRAME_AGE_MS) || 120);

      if (frame && frameAgeMs > maxFrameAgeMs) {
        this.resetLineController();
        this.setMotorReason("STALE_VISION", `Frame cũ ${Math.round(frameAgeMs)} ms → STOP`);
        this.sendMotor(0, 0, true);
        return;
      }

      const targetCurvature = Number(frame?.targetCurvature);
      const bevLateralLane = Number(frame?.bevLateralLane);
      const bevHeadingDeg = Number(frame?.bevHeadingDeg);

      if (
        !frame?.hasLane ||
        !Number.isFinite(targetCurvature) ||
        !Number.isFinite(bevLateralLane) ||
        !Number.isFinite(bevHeadingDeg)
      ) {
        const lostFor = performance.now() - this.lastLineSeenAt;

        if (lostFor >= (Number(this.config.LINE_LOST_STOP_MS) || 650)) {
          this.resetLineController();
          this.setMotorReason("LOST_LINE", `Mất lane ${Math.round(lostFor)} ms → STOP`);
          this.sendMotor(0, 0, true);
        } else {
          this.setMotorReason("WAITING_LINE", `Chưa có BEV lane hợp lệ · ${Math.round(lostFor)} ms`);
        }
        return;
      }

      const confidence = this.clamp(Number(frame.laneConfidence) || 0, 0, 1);
      const minConfidence = this.clamp(Number(this.config.VISION_MIN_CONFIDENCE) || 0.38, 0.05, 0.95);
      const slowConfidence = this.clamp(Number(this.config.VISION_SLOW_CONFIDENCE) || 0.62, minConfidence, 0.98);

      if (confidence < minConfidence) {
        this.setMotorReason("LOW_CONFIDENCE", `${confidence.toFixed(2)} < ${minConfidence.toFixed(2)}`);
        return;
      }

      const trackMode = String(frame.trackMode || "TWO_LINES");
      const oneLineMode = trackMode === "LEFT_ONLY" || trackMode === "RIGHT_ONLY";
      const predictedMode = trackMode === "PREDICTED";

      // ===================================================
      // 2) NORMALIZED CAMERA GEOMETRY
      // ===================================================
      const curvatureFull = Math.max(0.20, Number(this.config.CURVATURE_TARGET_FULL) || 1.80);
      const lateralFull = Math.max(0.08, Number(this.config.CURVATURE_LATERAL_FULL) || 0.34);
      const headingFull = Math.max(5, Number(this.config.CURVATURE_HEADING_FULL_DEG) || 18);
      const headingDFull = Math.max(20, Number(this.config.CURVATURE_HEADING_D_FULL_DEG_S) || 120);

      const curvatureNorm = this.clamp(targetCurvature / curvatureFull, -1, 1);
      const lateralNorm = this.clamp(bevLateralLane / lateralFull, -1, 1);
      const headingNorm = this.clamp(bevHeadingDeg / headingFull, -1, 1);

      // Heading derivative is damping only; no gyro involved.
      const now = performance.now();
      let dt = this.prevControlAt > 0
        ? (now - this.prevControlAt) / 1000
        : (Number(this.config.MOTOR_INTERVAL_MS) || 60) / 1000;
      dt = this.clamp(dt, 0.025, 0.20);

      let rawHeadingDerivative = 0;
      if (this.prevPathAngle != null) {
        rawHeadingDerivative = (bevHeadingDeg - this.prevPathAngle) / dt;
      }

      const alphaD = this.clamp(
        Number(this.config.PATH_ANGLE_DERIVATIVE_EMA_ALPHA) || 0.16,
        0.05, 1
      );
      this.filteredPathAngleDerivative +=
        alphaD * (rawHeadingDerivative - this.filteredPathAngleDerivative);

      const headingDNorm = this.clamp(
        this.filteredPathAngleDerivative / headingDFull,
        -1, 1
      );

      this.prevPathAngle = bevHeadingDeg;
      this.prevControlAt = now;

      // ===================================================
      // 3) CURVATURE KINEMATICS + SMALL CAMERA FEEDBACK
      // ===================================================
      // targetCurvature is now approximately 1 / lane-width.
      //
      // Ideal differential drive:
      //   turnRatio = kappa * trackWidth / 2
      //
      // This robot has four skid-steer wheels, so lateral tire scrub makes
      // the effective track wider. We compensate continuously by severity,
      // instead of hard-coding a pair such as 63/101 or 70/185.
      const trackWidthLane = this.clamp(
        Number(this.config.ROBOT_TRACK_WIDTH_LANE_RATIO) || 0.50,
        0.15,
        1.20
      );

      const skidBaseGain = this.clamp(
        Number(this.config.CURVATURE_SKID_BASE_GAIN) || 1.15,
        0.60,
        3.00
      );

      const skidCurveGain = this.clamp(
        Number(this.config.CURVATURE_SKID_CURVE_GAIN) || 1.15,
        0,
        3.00
      );

      const skidExponent = Math.max(
        0.35,
        Number(this.config.CURVATURE_SKID_EXPONENT) || 0.85
      );

      const curveSeverityForSkid = this.clamp(
        Math.abs(curvatureNorm),
        0,
        1
      );

      const skidMultiplier =
        skidBaseGain +
        skidCurveGain *
        Math.pow(
          curveSeverityForSkid,
          skidExponent
        );

      const geometryTurnRatio =
        targetCurvature *
        trackWidthLane *
        0.5 *
        skidMultiplier;

      // Feedback only corrects lane-centering / heading error.
      // It is deliberately bounded so it cannot dominate path curvature.
      const feedbackRaw =
        (Number(this.config.CURVATURE_WEIGHT_LATERAL) || 0.36) * lateralNorm +
        (Number(this.config.CURVATURE_WEIGHT_HEADING) || 0.82) * headingNorm +
        (Number(this.config.CURVATURE_WEIGHT_HEADING_D) || 0.07) * headingDNorm;

      const softScale = Math.max(
        0.25,
        Number(this.config.CURVATURE_SOFT_SCALE) || 1.05
      );

      const feedbackMax = this.clamp(
        Number(this.config.CURVATURE_FEEDBACK_MAX_RATIO) || 0.20,
        0.04,
        0.45
      );

      const feedbackTurnRatio =
        Math.tanh(
          feedbackRaw / softScale
        ) *
        feedbackMax;

      const rawSteering =
        geometryTurnRatio +
        feedbackTurnRatio;

      // Debug-compatible steering command.
      const steeringCommand =
        this.clamp(
          rawSteering /
          Math.max(
            0.05,
            Number(this.config.CURVATURE_MAX_TURN_RATIO) || 0.92
          ),
          -1,
          1
        );

      const severity = this.clamp(
        Math.max(
          Math.abs(curvatureNorm),
          Math.abs(headingNorm) * 0.85,
          Math.abs(lateralNorm) * 0.70,
          Number(frame.bevSeverity) || 0
        ),
        0, 1
      );

      // ===================================================
      // 4) DYNAMIC BASE SPEED
      // ===================================================
      // Slow the whole robot BEFORE asking for a larger left/right difference.
      const straightBase = Number(this.config.BASE_SPEED) || 96;
      const minCurveSpeed = Math.min(straightBase, Number(this.config.MIN_CURVE_SPEED) || 42);
      const maxSpeed = Math.max(straightBase, Number(this.config.MAX_SPEED) || 155);

      const slowdownGain = this.clamp(Number(this.config.CURVATURE_SPEED_SLOWDOWN_GAIN) || 0.72, 0, 0.95);
      const slowdownExponent = Math.max(0.35, Number(this.config.CURVATURE_SPEED_SLOWDOWN_EXPONENT) || 0.82);
      const curveSlow = slowdownGain * Math.pow(severity, slowdownExponent);

      let baseSpeed = straightBase - curveSlow * (straightBase - minCurveSpeed);

      const offcenterGain = this.clamp(Number(this.config.CURVATURE_OFFCENTER_SLOWDOWN_GAIN) || 0.28, 0, 0.8);
      baseSpeed -= offcenterGain * Math.abs(lateralNorm) * (baseSpeed - minCurveSpeed);

      if (confidence < slowConfidence) {
        const confidenceRatio = this.clamp(
          (confidence - minConfidence) / Math.max(0.001, slowConfidence - minConfidence),
          0, 1
        );
        baseSpeed = minCurveSpeed + confidenceRatio * (baseSpeed - minCurveSpeed);
      }

      if (oneLineMode) {
        baseSpeed = Math.min(baseSpeed, Math.max(35, Number(this.config.ONE_LINE_BASE_SPEED) || 50));
      }
      if (predictedMode) {
        baseSpeed = Math.min(baseSpeed, Math.max(22, Number(this.config.LOST_PREDICT_SPEED) || 34));
      }

      baseSpeed = this.clamp(baseSpeed, minCurveSpeed, maxSpeed);

      // ===================================================
      // 5) DIFFERENTIAL-DRIVE ALLOCATION FROM CURVATURE
      // ===================================================
      // Positive = turn RIGHT -> left faster, right slower.
      // Negative = turn LEFT  -> left slower, right faster.
      const maxTurnRatio = this.clamp(
        Number(this.config.CURVATURE_MAX_TURN_RATIO) || 0.82,
        0.20,
        0.95
      );

      let targetTurnRatio =
        this.clamp(
          geometryTurnRatio + feedbackTurnRatio,
          -maxTurnRatio,
          maxTurnRatio
        );

      // If the path curvature is clear, feedback is not allowed to flip
      // the turn direction unless the robot is extremely off-center.
      const clearCurve =
        Math.abs(curvatureNorm) >=
        this.clamp(
          Number(this.config.CURVATURE_DIRECTION_LOCK_NORM) || 0.13,
          0.03,
          0.80
        );

      if (
        clearCurve &&
        Math.abs(lateralNorm) <
          this.clamp(
            Number(this.config.CURVATURE_DIRECTION_OVERRIDE_LATERAL_NORM) || 0.88,
            0.45,
            1.0
          ) &&
        Math.sign(targetTurnRatio) !== Math.sign(targetCurvature)
      ) {
        targetTurnRatio =
          Math.sign(targetCurvature) *
          Math.max(
            0.06,
            Math.abs(geometryTurnRatio) * 0.75
          );
      }

      if (oneLineMode) {
        targetTurnRatio *= this.clamp(
          Number(this.config.ONE_LINE_STEERING_GAIN) || 1.08,
          0.75,
          1.25
        );
      }

      if (predictedMode) {
        // Keep direction but reduce authority while using a predicted frame.
        targetTurnRatio *= this.clamp(
          Number(this.config.LOST_PREDICT_STEERING_GAIN) || 0.82,
          0.35,
          0.95
        );
      }

      // Smooth the final steering request itself, so a noisy frame cannot
      // instantly swap motor sides.
      const turnAlpha = this.clamp(
        Number(this.config.CURVATURE_TURN_RATIO_EMA_ALPHA) || 0.44,
        0.08,
        1
      );

      const turnMaxDelta = this.clamp(
        Number(this.config.CURVATURE_TURN_RATIO_MAX_DELTA) || 0.11,
        0.02,
        0.40
      );

      const emaTarget =
        this.filteredTurnRatio +
        turnAlpha *
          (targetTurnRatio - this.filteredTurnRatio);

      const turnDelta = this.clamp(
        emaTarget - this.filteredTurnRatio,
        -turnMaxDelta,
        turnMaxDelta
      );

      this.filteredTurnRatio =
        this.clamp(
          this.filteredTurnRatio + turnDelta,
          -maxTurnRatio,
          maxTurnRatio
        );

      const turnRatio =
        this.filteredTurnRatio;

      let leftTarget =
        baseSpeed * (1 + turnRatio);

      let rightTarget =
        baseSpeed * (1 - turnRatio);

      // Preserve left/right ratio when the outside wheel would exceed max.
      const peak = Math.max(leftTarget, rightTarget);
      if (peak > maxSpeed) {
        const scale = maxSpeed / peak;
        leftTarget *= scale;
        rightTarget *= scale;
      }

      const minForwardLogical = Math.max(
        0,
        Number.isFinite(Number(this.config.LINE_FOLLOW_MIN_LOGICAL_SPEED))
          ? Number(this.config.LINE_FOLLOW_MIN_LOGICAL_SPEED)
          : 1
      );

      leftTarget = this.clamp(leftTarget, minForwardLogical, maxSpeed);
      rightTarget = this.clamp(rightTarget, minForwardLogical, maxSpeed);

      this.blueCurveSeverity = this.clamp(Number(frame.blueCurveSeverity) || severity, 0, 1);
      this.blueCurveDirection =
        targetCurvature < -0.025
          ? "LEFT"
          : targetCurvature > 0.025
            ? "RIGHT"
            : String(frame.blueCurveDirection || "STRAIGHT");

      this.geometryControl = {
        lateralNorm,
        headingNorm,
        curvatureNorm,
        headingDNorm,
        rawSteering,
        steeringCommand,
        geometryTurnRatio,
        feedbackTurnRatio,
        effectiveTrackLane:
          trackWidthLane * skidMultiplier,
        skidMultiplier,
        severity,
        baseSpeed,
        deltaLogical: (leftTarget - rightTarget) / 2,
        targetCurvature,
        turnRatio,
        adaptiveLookaheadU: Number(frame.adaptiveLookaheadU) || 0
      };
      this.updateGeometryControllerDebug();

      const direction =
        targetCurvature < -0.025
          ? "LEFT"
          : targetCurvature > 0.025
            ? "RIGHT"
            : "STRAIGHT";

      const detail =
        `${direction} · κ=${targetCurvature.toFixed(2)}` +
        ` · look=${(Number(frame.adaptiveLookaheadU) || 0).toFixed(2)}` +
        ` · lat=${bevLateralLane.toFixed(2)}` +
        ` · head=${bevHeadingDeg.toFixed(1)}°` +
        ` · conf=${confidence.toFixed(2)}`;

      if (oneLineMode) {
        this.setMotorReason(trackMode === "LEFT_ONLY" ? "ONE_LINE_LEFT" : "ONE_LINE_RIGHT", detail);
      } else if (predictedMode) {
        this.setMotorReason("PREDICTED", detail);
      } else {
        this.setMotorReason("BEV_CURVATURE", detail);
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
        deltaLogical: 0,
        targetCurvature: 0,
        turnRatio: 0,
        adaptiveLookaheadU: 0
      };
      this.updateGeometryControllerDebug();
    }

    updateGeometryControllerDebug() {
      if (typeof document === "undefined") {
        return;
      }

      const state = this.geometryControl || {};
      const lateralLane = Number(this.lastVision?.bevLateralLane);
      const headingDeg = Number(this.lastVision?.bevHeadingDeg);
      const targetCurvature = Number(this.lastVision?.targetCurvature);

      const lateralText = Number.isFinite(lateralLane)
        ? `${lateralLane >= 0 ? "+" : ""}${lateralLane.toFixed(3)} lane`
        : "-";
      const headingText = Number.isFinite(headingDeg)
        ? `${headingDeg >= 0 ? "+" : ""}${headingDeg.toFixed(1)}°`
        : "-";
      const curvatureText = Number.isFinite(targetCurvature)
        ? `${targetCurvature >= 0 ? "+" : ""}${targetCurvature.toFixed(3)} κ`
        : "-";

      const steeringText =
        `${Number(state.steeringCommand || 0).toFixed(2)}` +
        ` · sev ${Math.round((state.severity || 0) * 100)}%`;

      const baseText =
        `${Number(state.baseSpeed || 0).toFixed(1)} logic`;
      const deltaText =
        `${Number(state.deltaLogical || 0) >= 0 ? "+" : ""}` +
        `${Number(state.deltaLogical || 0).toFixed(1)} logic`;
      const curvatureTargetText =
        `${Number(state.targetCurvature || 0) >= 0 ? "+" : ""}` +
        `${Number(state.targetCurvature || 0).toFixed(3)} κ`;
      const turnRatioText =
        `${Number(state.turnRatio || 0) >= 0 ? "+" : ""}` +
        `${Number(state.turnRatio || 0).toFixed(3)}`;
      const lookaheadText =
        `${Number(state.adaptiveLookaheadU || 0).toFixed(2)} u`;

      const radiusText =
        Number.isFinite(targetCurvature) &&
        Math.abs(targetCurvature) > 0.01
          ? `${(1 / Math.abs(targetCurvature)).toFixed(2)} lane`
          : "∞";

      const kinematicText =
        `geo ${Number(state.geometryTurnRatio || 0).toFixed(3)}` +
        ` · fb ${Number(state.feedbackTurnRatio || 0).toFixed(3)}` +
        ` · skid ${Number(state.skidMultiplier || 0).toFixed(2)}x`;

      const gateText =
        `${this.lastVision?.laneGateState || "-"}` +
        ` · ${this.lastVision?.laneGateReason || "-"}`;

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
      set("targetCurvatureState", curvatureTargetText);
      set("turnRatioState", turnRatioText);
      set("adaptiveLookaheadState", lookaheadText);
      set("curveRadiusState", radiusText);
      set("kinematicTurnState", kinematicText);
      set("laneGateState", gateText);

      set("visionGeometrySteeringState", steeringText);
      set("visionGeometryBaseState", baseText);
      set("visionGeometryDeltaState", deltaText);
      set("visionTargetCurvatureState", curvatureTargetText);
      set("visionTurnRatioState", turnRatioText);
      set("visionAdaptiveLookaheadState", lookaheadText);
      set("visionCurveRadiusState", radiusText);
      set("visionKinematicTurnState", kinematicText);
      set("visionLaneGateState", gateText);
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

  window.ROBOT_NAV_BUILD = "2026-09-27-web-bev-curvature-v3-calibrated-15cm-26cm";
  console.info("[RobotNavigation] loaded", window.ROBOT_NAV_BUILD);

  window.ROBOT_NAV_STATE = NAV_STATE;
  window.RobotNavigation = RobotNavigation;
})();
