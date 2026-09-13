(() => {
  const NAV_STATE = Object.freeze({
    IDLE: "IDLE",
    LINE_FOLLOW: "LINE_FOLLOW",
    T_JUNCTION_DETECTED: "T_JUNCTION_DETECTED",
    TURNING: "TURNING",
    REACQUIRE_LINE: "REACQUIRE_LINE",
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
        ir2: false,
        ir3: false,
        ir5: false,
        has_food: false
      };

      this.lastVision = null;
      this.lastLineSeenAt = 0;
      this.lastMotorAt = 0;
      this.lastMotor = { left: 0, right: 0 };
      this.controlTimer = null;

      // PID "center-lock":
      // giữ tâm camera trùng với center curve màu xanh dương.
      this.lineIntegral = 0;
      this.prevLineError = null;
      this.prevLineErrorAt = 0;
      this.filteredLineDerivative = 0;

      this.turnStartYaw = null;
      this.turnDirection = null;
      this.reacquireStableFrames = 0;

      this.tJunctionHits = 0;
      this.lastTJunctionQrAt = 0;
      this.lastTJunctionHandledAt = 0;
      this.qrStopPending = false;
    }

    // =====================================================
    // LIFECYCLE
    // =====================================================

    start(task) {
      this.task = { ...task };

      this.turnStartYaw = null;
      this.turnDirection = null;
      this.reacquireStableFrames = 0;

      this.tJunctionHits = 0;
      this.qrStopPending = false;

      this.lastVision = null;
      this.lastLineSeenAt = performance.now();

      this.lastMotor = {
        left: 0,
        right: 0
      };

      this.resetLineController();

      this.setState(NAV_STATE.LINE_FOLLOW);

      if (!this.controlTimer) {
        this.controlTimer = window.setInterval(
          () => this.controlLoop(),
          Math.max(
            30,
            Number(this.config.MOTOR_INTERVAL_MS) || 70
          )
        );
      }
    }

    stop(reason = "manual") {
      if (this.controlTimer) {
        clearInterval(this.controlTimer);
        this.controlTimer = null;
      }

      this.sendMotor(0, 0, true);

      this.setState(
        NAV_STATE.STOPPED,
        reason
      );
    }

    fail(message) {
      this.sendMotor(0, 0, true);

      this.setState(
        NAV_STATE.ERROR,
        message
      );

      this.onDebug(
        `NAV ERROR: ${message}`
      );
    }

    setState(state, detail = "") {
      if (
        this.state === state &&
        !detail
      ) {
        return;
      }

      this.state = state;

      this.onState({
        state,
        detail,
        task: this.task,
        turnDirection: this.turnDirection
      });

      this.onDebug(
        `NAV ${state}${detail ? `: ${detail}` : ""}`
      );
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

      /*
       * Chỉ reset timeout khi camera THẬT SỰ
       * nhìn thấy ít nhất một vạch.
       *
       * PREDICTED chỉ là hình học được giữ lại
       * vài frame nên không được phép làm line
       * "sống" vô hạn.
       */
      if (
        frame?.hasVisualLine &&
        frame?.hasLane
      ) {
        this.lastLineSeenAt =
          performance.now();
      }
    }

    resetLineController() {
      this.lineIntegral = 0;

      this.prevLineError = null;

      this.prevLineErrorAt = 0;

      this.filteredLineDerivative = 0;
    }

    // =====================================================
    // QR T-JUNCTION
    // =====================================================

    handleQr(qr) {
      if (
        this.state !==
        NAV_STATE.LINE_FOLLOW
      ) {
        return;
      }

      const payload =
        typeof qr === "string"
          ? {
              text: qr
            }
          : qr || {};

      const expected =
        String(
          this.config.T_JUNCTION_QR_TEXT ||
            "T-junction"
        )
          .trim()
          .toLowerCase();

      const value =
        String(
          payload.text || ""
        )
          .trim()
          .toLowerCase();

      if (
        value !== expected
      ) {
        return;
      }

      const areaPercent =
        Number(payload.areaPercent);

      const stopPercent =
        Math.max(
          0,
          Number(
            this.config
              .T_JUNCTION_STOP_AREA_PERCENT
          ) || 12
        );

      const now =
        performance.now();

      if (
        now -
          this.lastTJunctionHandledAt <
        3500
      ) {
        return;
      }

      if (
        !Number.isFinite(areaPercent) ||
        areaPercent < stopPercent
      ) {
        this.tJunctionHits = 0;

        this.qrStopPending = false;

        return;
      }

      if (
        now -
          this.lastTJunctionQrAt >
        1000
      ) {
        this.tJunctionHits = 0;
      }

      this.lastTJunctionQrAt =
        now;

      this.tJunctionHits += 1;

      this.qrStopPending =
        true;

      /*
       * STOP phải tức thời.
       * Không dùng motor slew-rate.
       */
      this.sendMotor(
        0,
        0,
        true
      );

      const required =
        Math.max(
          1,
          Number(
            this.config
              .T_JUNCTION_STABLE_COUNT
          ) || 2
        );

      if (
        this.tJunctionHits >=
        required
      ) {
        this.tJunctionHits = 0;

        this.qrStopPending =
          false;

        this.beginTJunctionTurn();
      }
    }

    beginTJunctionTurn() {
      if (!this.task) {
        this.fail(
          "Không có task để xác định hướng rẽ."
        );

        return;
      }

      let direction =
        String(
          this.task.junction_turn ||
            ""
        )
          .trim()
          .toUpperCase();

      /*
       * Fallback route:
       *
       * Line 1 -> LEFT
       * Line 2 -> RIGHT
       */
      if (!direction) {
        if (
          Number(
            this.task.line
          ) === 1
        ) {
          direction = "LEFT";
        }

        if (
          Number(
            this.task.line
          ) === 2
        ) {
          direction = "RIGHT";
        }
      }

      if (
        ![
          "LEFT",
          "RIGHT"
        ].includes(direction)
      ) {
        this.fail(
          "Task không có hướng rẽ LEFT/RIGHT hợp lệ."
        );

        return;
      }

      const yaw =
        this.orientation.getYaw();

      if (
        yaw == null
      ) {
        this.fail(
          "Chưa đọc được góc orientation của điện thoại."
        );

        return;
      }

      this.turnDirection =
        direction;

      this.turnStartYaw =
        yaw;

      this.lastTJunctionHandledAt =
        performance.now();

      this.resetLineController();

      this.setState(
        NAV_STATE.T_JUNCTION_DETECTED,
        `QR T-junction, chuẩn bị rẽ ${direction}`
      );

      this.sendMotor(
        0,
        0,
        true
      );

      window.setTimeout(
        () => {
          if (
            this.state ===
            NAV_STATE.T_JUNCTION_DETECTED
          ) {
            this.setState(
              NAV_STATE.TURNING,
              `Rẽ ${direction}`
            );
          }
        },
        160
      );
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

        case NAV_STATE.ERROR:
        case NAV_STATE.STOPPED:
        case NAV_STATE.IDLE:
        default:
          break;
      }
    }

    // =====================================================
    // LINE FOLLOW
    //
    // center-lock:
    //
    // lateral error
    // + heading
    // + look-ahead
    // + PID
    // + confidence slowdown
    // + curve slowdown
    // + one-line mode
    // =====================================================

    controlLineFollow() {
      // ---------------------------------------------------
      // QR đang chờ xác nhận:
      // giữ xe dừng.
      // ---------------------------------------------------

      if (
        this.qrStopPending
      ) {
        if (
          performance.now() -
            this.lastTJunctionQrAt >
          1200
        ) {
          this.qrStopPending =
            false;

          this.tJunctionHits = 0;
        } else {
          this.resetLineController();

          this.sendMotor(
            0,
            0,
            true
          );

          return;
        }
      }

      // ---------------------------------------------------
      // IR2 = cảm biến biên trái
      //
      // Chạm biên trái:
      // bánh trái nhanh hơn
      // -> ép xe sang phải.
      // ---------------------------------------------------

      if (
        this.sensors.ir2 &&
        !this.sensors.ir3
      ) {
        this.resetLineController();

        this.sendMotor(
          Number(
            this.config
              .BORDER_FAST_SPEED
          ) || 145,

          Number(
            this.config
              .BORDER_SLOW_SPEED
          ) || 65,

          true
        );

        return;
      }

      // ---------------------------------------------------
      // IR3 = cảm biến biên phải
      //
      // Chạm biên phải:
      // bánh phải nhanh hơn
      // -> ép xe sang trái.
      // ---------------------------------------------------

      if (
        this.sensors.ir3 &&
        !this.sensors.ir2
      ) {
        this.resetLineController();

        this.sendMotor(
          Number(
            this.config
              .BORDER_SLOW_SPEED
          ) || 65,

          Number(
            this.config
              .BORDER_FAST_SPEED
          ) || 145,

          true
        );

        return;
      }

      const frame =
        this.lastVision;

      // ---------------------------------------------------
      // Không có lane hợp lệ.
      // ---------------------------------------------------

      if (
        !frame?.hasLane ||
        frame.lineError == null ||
        frame.headingErrorDeg == null
      ) {
        const lostFor =
          performance.now() -
          this.lastLineSeenAt;

        this.resetLineController();

        if (
          lostFor >=
          (
            Number(
              this.config
                .LINE_LOST_STOP_MS
            ) || 850
          )
        ) {
          this.sendMotor(
            0,
            0,
            true
          );
        }

        /*
         * Không publish lệnh mới khi vision
         * chưa đáng tin.
         *
         * ESP32 nên có motor watchdog:
         * nếu mất lệnh MQTT motor quá lâu
         * thì tự dừng.
         */
        return;
      }

      // ---------------------------------------------------
      // CONFIDENCE
      // ---------------------------------------------------

      const confidence =
        this.clamp(
          Number(
            frame.laneConfidence
          ) || 0,

          0,
          1
        );

      const minConfidence =
        this.clamp(
          Number(
            this.config
              .VISION_MIN_CONFIDENCE
          ) || 0.38,

          0.05,
          0.95
        );

      const slowConfidence =
        this.clamp(
          Number(
            this.config
              .VISION_SLOW_CONFIDENCE
          ) || 0.62,

          minConfidence,
          0.98
        );

      // ---------------------------------------------------
      // TRACK MODE
      // ---------------------------------------------------

      const trackMode =
        String(
          frame.trackMode ||
            "TWO_LINES"
        );

      const oneLineMode =
        trackMode ===
          "LEFT_ONLY" ||
        trackMode ===
          "RIGHT_ONLY";

      const predictedMode =
        trackMode ===
        "PREDICTED";

      if (
        confidence <
        minConfidence
      ) {
        this.resetLineController();

        return;
      }

      // ---------------------------------------------------
      // CONFIG MOTOR / PID
      // ---------------------------------------------------

      const configuredBase =
        Number(
          this.config.BASE_SPEED
        ) || 122;

      const minCurveSpeed =
        Math.min(
          configuredBase,

          Number(
            this.config
              .MIN_CURVE_SPEED
          ) || 68
        );

      const maxSpeed =
        Number(
          this.config.MAX_SPEED
        ) || 190;

      const kp =
        Number(
          this.config.LINE_KP
        ) || 0.24;

      const ki =
        Number(
          this.config.LINE_KI
        ) || 0;

      const kd =
        Number(
          this.config.LINE_KD
        ) || 0;

      const kh =
        Number(
          this.config.LINE_KH
        ) || 1.15;

      const lookAheadKp =
        Number(
          this.config
            .LINE_LOOKAHEAD_KP
        ) || 0;

      // ---------------------------------------------------
      // Vision errors
      // ---------------------------------------------------

      const lineError =
        Number(
          frame.lineError
        ) || 0;

      const heading =
        Number(
          frame.headingErrorDeg
        ) || 0;

      const curvature =
        Number(
          frame.curvatureDeg
        ) || 0;

      const frameWidth =
        Math.max(
          1,
          Number(
            frame.width
          ) || 1
        );

      // ===================================================
      // 1. GIẢM TỐC KHI VÀO CUA
      // ===================================================

      const curveMeasure =
        Math.max(
          Math.abs(
            heading
          ),

          Math.abs(
            curvature
          ) * 0.65
        );

      const fullSlowdownDeg =
        Math.max(
          8,

          Number(
            this.config
              .CURVE_FULL_SLOWDOWN_DEG
          ) || 28
        );

      const curveRatio =
        this.clamp(
          curveMeasure /
            fullSlowdownDeg,

          0,
          1
        );

      let baseSpeed =
        configuredBase -
        curveRatio *
          (
            configuredBase -
            minCurveSpeed
          );

      // ===================================================
      // 2. GIẢM TỐC NẾU TÂM CAMERA LỆCH XA CENTER
      // ===================================================

      const centerFullSlowdownRatio =
        this.clamp(
          Number(
            this.config
              .CENTER_FULL_SLOWDOWN_RATIO
          ) || 0.28,

          0.08,
          0.49
        );

      const offCenterRatio =
        this.clamp(
          Math.abs(
            lineError
          ) /
            (
              frameWidth *
              centerFullSlowdownRatio
            ),

          0,
          1
        );

      baseSpeed =
        Math.max(
          minCurveSpeed,

          baseSpeed -
            offCenterRatio *
              (
                baseSpeed -
                minCurveSpeed
              )
        );

      // ===================================================
      // 3. CONFIDENCE TRUNG BÌNH -> GIẢM TỐC
      // ===================================================

      if (
        confidence <
        slowConfidence
      ) {
        const confidenceRatio =
          this.clamp(
            (
              confidence -
              minConfidence
            ) /
              Math.max(
                0.001,
                slowConfidence -
                  minConfidence
              ),

            0,
            1
          );

        baseSpeed =
          Math.max(
            minCurveSpeed,

            minCurveSpeed +
              confidenceRatio *
                (
                  baseSpeed -
                  minCurveSpeed
                )
          );
      }

      // ===================================================
      // 4. ONE LINE MODE
      // ===================================================
      //
      // Chỉ thấy 1 vạch:
      //
      // center xanh =
      // biên thật + laneWidthModel / 2
      //
      // giảm tốc để camera có thời gian
      // bắt lại biên còn thiếu.
      // ===================================================

      if (
        oneLineMode
      ) {
        const oneLineSpeed =
          Math.max(
            35,

            Number(
              this.config
                .ONE_LINE_BASE_SPEED
            ) || 76
          );

        baseSpeed =
          Math.min(
            baseSpeed,
            oneLineSpeed
          );
      }

      // ===================================================
      // 5. PREDICTED MODE
      // ===================================================
      //
      // Không nhìn thấy vạch thật,
      // chỉ giữ hình học cũ vài frame.
      //
      // Chạy rất chậm.
      // ===================================================

      if (
        predictedMode
      ) {
        const predictedSpeed =
          Math.max(
            25,

            Number(
              this.config
                .LOST_PREDICT_SPEED
            ) || 52
          );

        baseSpeed =
          Math.min(
            baseSpeed,
            predictedSpeed
          );
      }

      // ===================================================
      // 6. PID CENTER-LOCK
      // ===================================================
      //
      // lineError =
      //
      // x center xanh dương
      // -
      // x tâm camera
      //
      //
      // lineError > 0
      //
      // center nằm bên phải camera
      //
      // -> bánh trái nhanh hơn
      // -> xe quay phải.
      //
      //
      // lineError < 0
      //
      // center nằm bên trái camera
      //
      // -> bánh phải nhanh hơn
      // -> xe quay trái.
      // ===================================================

      const deadbandPx =
        Math.max(
          0,

          Number(
            this.config
              .CENTER_DEADBAND_PX
          ) || 0
        );

      const effectiveError =
        Math.abs(
          lineError
        ) <= deadbandPx
          ? 0
          : lineError;

      // ---------------------------------------------------
      // Delta time
      // ---------------------------------------------------

      const now =
        performance.now();

      let dt =
        this.prevLineErrorAt >
        0
          ? (
              now -
              this.prevLineErrorAt
            ) / 1000

          : (
              Number(
                this.config
                  .MOTOR_INTERVAL_MS
              ) || 70
            ) / 1000;

      dt =
        this.clamp(
          dt,
          0.02,
          0.20
        );

      // ---------------------------------------------------
      // Integral
      // ---------------------------------------------------

      const integralLimit =
        Math.max(
          0,

          Number(
            this.config
              .LINE_INTEGRAL_LIMIT
          ) || 0
        );

      if (
        effectiveError === 0
      ) {
        /*
         * Khi gần tâm:
         * xả tích phân để tránh overshoot
         * trái/phải liên tục.
         */
        this.lineIntegral *=
          0.78;
      } else {
        this.lineIntegral +=
          effectiveError * dt;

        if (
          integralLimit > 0
        ) {
          this.lineIntegral =
            this.clamp(
              this.lineIntegral,

              -integralLimit,
              integralLimit
            );
        }
      }

      // ---------------------------------------------------
      // Derivative
      // ---------------------------------------------------

      let rawDerivative = 0;

      if (
        this.prevLineError !=
        null
      ) {
        rawDerivative =
          (
            effectiveError -
            this.prevLineError
          ) / dt;
      }

      const derivativeAlpha =
        this.clamp(
          Number(
            this.config
              .LINE_DERIVATIVE_EMA_ALPHA
          ) || 0.25,

          0.05,
          1
        );

      this.filteredLineDerivative +=
        derivativeAlpha *
        (
          rawDerivative -
          this.filteredLineDerivative
        );

      this.prevLineError =
        effectiveError;

      this.prevLineErrorAt =
        now;

      // ---------------------------------------------------
      // Look-ahead
      // ---------------------------------------------------

      const lookAheadError =
        frame.lookAheadCenter != null &&
        frame.frameCenter != null

          ? Number(
              frame.lookAheadCenter
            ) -
            Number(
              frame.frameCenter
            )

          : 0;

      // ---------------------------------------------------
      // PID terms
      // ---------------------------------------------------

      const pTerm =
        kp *
        effectiveError;

      const iTerm =
        ki *
        this.lineIntegral;

      const dTerm =
        kd *
        this.filteredLineDerivative;

      const headingTerm =
        kh *
        heading;

      const lookAheadTerm =
        lookAheadKp *
        lookAheadError;

      let correction =
        pTerm +
        iTerm +
        dTerm +
        headingTerm +
        lookAheadTerm;

      // ---------------------------------------------------
      // One-line steering mạnh hơn một chút
      // ---------------------------------------------------

      if (
        oneLineMode
      ) {
        correction *=
          this.clamp(
            Number(
              this.config
                .ONE_LINE_STEERING_GAIN
            ) || 1.08,

            0.75,
            1.40
          );
      }

      // ---------------------------------------------------
      // Predicted steering yếu hơn
      // ---------------------------------------------------

      if (
        predictedMode
      ) {
        correction *=
          this.clamp(
            Number(
              this.config
                .LOST_PREDICT_STEERING_GAIN
            ) || 0.82,

            0.35,
            1.00
          );
      }

      // ---------------------------------------------------
      // Giới hạn correction
      // ---------------------------------------------------

      const maxCorrection =
        Math.max(
          10,

          Number(
            this.config
              .MAX_STEERING_CORRECTION
          ) || 90
        );

      correction =
        this.clamp(
          correction,

          -maxCorrection,
          maxCorrection
        );

      // ===================================================
      // 7. MOTOR DIFFERENTIAL DRIVE
      // ===================================================
      //
      // Đi thẳng:
      //
      // Left  ~= Right
      //
      //
      // Rẽ phải:
      //
      // Left > Right
      //
      //
      // Rẽ trái:
      //
      // Right > Left
      // ===================================================

      const leftTarget =
        this.clamp(
          baseSpeed +
            correction,

          -maxSpeed,
          maxSpeed
        );

      const rightTarget =
        this.clamp(
          baseSpeed -
            correction,

          -maxSpeed,
          maxSpeed
        );

      this.sendMotor(
        leftTarget,
        rightTarget
      );
    }

    // =====================================================
    // GYRO TURN
    // =====================================================

    controlTurn() {
      const yaw =
        this.orientation.getYaw();

      if (
        yaw == null ||
        this.turnStartYaw == null
      ) {
        this.fail(
          "Mất dữ liệu orientation trong lúc rẽ."
        );

        return;
      }

      const relative =
        window.RobotOrientation
          .deltaDegrees(
            yaw,
            this.turnStartYaw
          );

      const angle =
        Math.abs(
          relative
        );

      const searchAt =
        Number(
          this.config
            .TURN_START_LINE_SEARCH_DEG
        ) || 68;

      const maxAngle =
        Number(
          this.config
            .TURN_MAX_DEG
        ) || 112;

      const target =
        Number(
          this.config
            .TURN_TARGET_DEG
        ) || 90;

      const frame =
        this.lastVision;

      const confidence =
        Number(
          frame?.laneConfidence
        ) || 0;

      const minConfidence =
        Number(
          this.config
            .VISION_MIN_CONFIDENCE
        ) || 0.38;

      /*
       * Chỉ chấp nhận line mới khi:
       *
       * - đã quay đủ một góc tối thiểu
       * - thật sự thấy cả hai biên
       * - confidence đủ
       * - tâm line tương đối gần tâm camera
       */
      if (
        angle >= searchAt &&

        frame?.hasBothLines &&

        frame?.hasLane &&

        confidence >=
          minConfidence &&

        frame.lineError !=
          null &&

        Math.abs(
          frame.lineError
        ) <
          frame.width *
            0.22
      ) {
        this.sendMotor(
          0,
          0,
          true
        );

        this.reacquireStableFrames =
          0;

        this.setState(
          NAV_STATE.REACQUIRE_LINE,
          `Đã thấy line mới ở ${angle.toFixed(1)}°`
        );

        return;
      }

      if (
        angle >
        maxAngle
      ) {
        this.fail(
          `Quay quá ${maxAngle}° nhưng chưa bắt lại được line.`
        );

        return;
      }

      const remaining =
        Math.max(
          0,
          target -
            angle
        );

      let speed;

      if (
        remaining > 35
      ) {
        speed =
          Number(
            this.config
              .TURN_FAST_SPEED
          ) || 145;
      } else if (
        remaining > 15
      ) {
        speed =
          Number(
            this.config
              .TURN_MEDIUM_SPEED
          ) || 105;
      } else {
        speed =
          Number(
            this.config
              .TURN_SLOW_SPEED
          ) || 72;
      }

      if (
        angle >= target
      ) {
        speed =
          Number(
            this.config
              .TURN_SLOW_SPEED
          ) || 72;
      }

      /*
       * Quay tại chỗ:
       *
       * LEFT:
       * motor trái lùi
       * motor phải tiến
       *
       * RIGHT:
       * motor trái tiến
       * motor phải lùi
       */
      if (
        this.turnDirection ===
        "LEFT"
      ) {
        this.sendMotor(
          -speed,
          speed
        );
      } else {
        this.sendMotor(
          speed,
          -speed
        );
      }
    }

    // =====================================================
    // REACQUIRE LINE
    // =====================================================

    controlReacquireLine() {
      const frame =
        this.lastVision;

      const minConfidence =
        Number(
          this.config
            .VISION_MIN_CONFIDENCE
        ) || 0.38;

      /*
       * Sau khi rẽ:
       *
       * yêu cầu thấy đủ hai line thật
       * trước khi chuyển lại LINE_FOLLOW.
       */
      if (
        !frame?.hasLane ||

        !frame?.hasBothLines ||

        frame.lineError ==
          null ||

        frame.headingErrorDeg ==
          null ||

        (
          Number(
            frame.laneConfidence
          ) || 0
        ) <
          minConfidence
      ) {
        this.reacquireStableFrames =
          0;

        this.sendMotor(
          0,
          0,
          true
        );

        return;
      }

      const base =
        Math.min(
          88,

          Number(
            this.config.BASE_SPEED
          ) || 122
        );

      const kp =
        Number(
          this.config.LINE_KP
        ) || 0.24;

      const kh =
        Number(
          this.config.LINE_KH
        ) || 1.15;

      const correction =
        frame.lineError *
          kp +
        frame.headingErrorDeg *
          kh;

      this.sendMotor(
        this.clamp(
          base +
            correction,

          38,
          110
        ),

        this.clamp(
          base -
            correction,

          38,
          110
        )
      );

      const centered =
        Math.abs(
          frame.lineError
        ) <
        frame.width *
          0.10;

      const headingReady =
        Math.abs(
          frame.headingErrorDeg
        ) < 12;

      if (
        centered &&
        headingReady
      ) {
        this.reacquireStableFrames +=
          1;
      } else {
        this.reacquireStableFrames =
          0;
      }

      /*
       * Ổn định đủ 5 frame liên tiếp
       * thì trở về LINE_FOLLOW.
       */
      if (
        this.reacquireStableFrames >=
        5
      ) {
        this.turnStartYaw =
          null;

        this.turnDirection =
          null;

        this.reacquireStableFrames =
          0;

        this.resetLineController();

        this.setState(
          NAV_STATE.LINE_FOLLOW,
          "Đã ổn định line mới"
        );
      }
    }

    // =====================================================
    // MOTOR OUTPUT
    // =====================================================
    //
    // Có:
    //
    // - slew-rate limit
    // - giới hạn MAX_SPEED
    // - publish MQTT
    // - cập nhật DEBUG CAMERA
    //
    // =====================================================

    sendMotor(
      left,
      right,
      force = false
    ) {
      const now =
        performance.now();

      const interval =
        Math.max(
          30,

          Number(
            this.config
              .MOTOR_INTERVAL_MS
          ) || 70
        );

      /*
       * Không gửi quá nhanh nếu không force.
       */
      if (
        !force &&
        now -
          this.lastMotorAt <
          interval *
            0.8
      ) {
        return;
      }

      let nextLeft =
        Number(left) || 0;

      let nextRight =
        Number(right) || 0;

      // ===================================================
      // SLEW-RATE LIMIT
      // ===================================================
      //
      // Không cho PWM nhảy quá mạnh giữa
      // hai lần update.
      // ===================================================

      if (!force) {
        const maxDelta =
          Math.max(
            1,

            Number(
              this.config
                .MOTOR_MAX_DELTA_PER_UPDATE
            ) || 20
          );

        const deltaLeft =
          nextLeft -
          this.lastMotor.left;

        const deltaRight =
          nextRight -
          this.lastMotor.right;

        const largestDelta =
          Math.max(
            Math.abs(
              deltaLeft
            ),

            Math.abs(
              deltaRight
            )
          );

        /*
         * Scale cả vector PWM cùng tỷ lệ.
         *
         * Không clamp riêng từng motor,
         * vì có thể làm mất chênh lệch
         * trái/phải trong lúc xe cua.
         */
        if (
          largestDelta >
          maxDelta
        ) {
          const scale =
            maxDelta /
            largestDelta;

          nextLeft =
            this.lastMotor.left +
            deltaLeft *
              scale;

          nextRight =
            this.lastMotor.right +
            deltaRight *
              scale;
        }
      }

      // ===================================================
      // MAX SPEED
      // ===================================================

      const maxSpeed =
        Math.max(
          1,

          Number(
            this.config.MAX_SPEED
          ) || 190
        );

      nextLeft =
        this.clamp(
          nextLeft,
          -maxSpeed,
          maxSpeed
        );

      nextRight =
        this.clamp(
          nextRight,
          -maxSpeed,
          maxSpeed
        );

      // ===================================================
      // LƯU PWM HIỆN TẠI
      // ===================================================

      this.lastMotorAt =
        now;

      this.lastMotor = {
        left:
          Math.round(
            nextLeft
          ),

        right:
          Math.round(
            nextRight
          )
      };

      // ===================================================
      // GỬI MQTT XUỐNG ESP32
      // ===================================================

      const published =
        this.mqtt.publishMotor(
          this.lastMotor.left,
          this.lastMotor.right
        );

      // ===================================================
      // DEBUG CAMERA
      // ===================================================
      //
      // Cập nhật trực tiếp ở navigation.js.
      //
      // Như vậy không cần sửa robot-control.js.
      //
      // index.html cần có:
      //
      // visionMotorLeftState
      // visionMotorRightState
      //
      // ===================================================

      if (
        typeof document !==
        "undefined"
      ) {
        const leftDebug =
          document.getElementById(
            "visionMotorLeftState"
          );

        const rightDebug =
          document.getElementById(
            "visionMotorRightState"
          );

        /*
         * Giữ tương thích UI cũ nếu
         * index.html cũ có hai ID này.
         */
        const leftState =
          document.getElementById(
            "leftMotorState"
          );

        const rightState =
          document.getElementById(
            "rightMotorState"
          );

        if (leftDebug) {
          leftDebug.textContent =
            String(
              this.lastMotor.left
            );
        }

        if (rightDebug) {
          rightDebug.textContent =
            String(
              this.lastMotor.right
            );
        }

        if (leftState) {
          leftState.textContent =
            String(
              this.lastMotor.left
            );
        }

        if (rightState) {
          rightState.textContent =
            String(
              this.lastMotor.right
            );
        }
      }

      // ===================================================
      // CALLBACK
      // ===================================================

      this.onMotor({
        ...this.lastMotor,

        published:
          Boolean(
            published
          )
      });
    }

    // =====================================================
    // HELPER
    // =====================================================

    clamp(
      value,
      min,
      max
    ) {
      return Math.max(
        min,
        Math.min(
          max,
          value
        )
      );
    }
  }

  // =======================================================
  // EXPORT GLOBAL
  // =======================================================

  window.ROBOT_NAV_STATE =
    NAV_STATE;

  window.RobotNavigation =
    RobotNavigation;
})();