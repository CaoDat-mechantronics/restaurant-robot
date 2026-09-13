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

      this.lastMotor = {
        left: 0,
        right: 0
      };

      this.controlTimer = null;

      // ===================================================
      // PATH FOLLOW CONTROLLER
      // ===================================================
      //
      // prevLineError:
      // sai lệch vị trí center xanh gần xe.
      //
      // prevPathAngle:
      // góc từ center xanh gần xe tới điểm hồng.
      //
      // Path angle là thành phần điều khiển chính.
      //
      this.prevLineError = null;

      this.prevControlAt = 0;

      this.filteredLineDerivative = 0;

      this.prevPathAngle = null;

      this.filteredPathAngleDerivative = 0;

      // ===================================================
      // TURN STATE
      // ===================================================

      this.turnStartYaw = null;

      this.turnDirection = null;

      this.reacquireStableFrames = 0;

      // ===================================================
      // QR STATE
      // ===================================================

      this.tJunctionHits = 0;

      this.lastTJunctionQrAt = 0;

      this.lastTJunctionHandledAt = 0;

      this.qrStopPending = false;

      // ===================================================
      // MOTOR DEBUG
      // ===================================================

      this.motorReason = "WAITING_TASK";

      this.motorPublishOk = null;
    }

    // =====================================================
    // START
    // =====================================================

    start(task) {
      this.task = {
        ...task
      };

      this.turnStartYaw = null;

      this.turnDirection = null;

      this.reacquireStableFrames = 0;

      this.tJunctionHits = 0;

      this.qrStopPending = false;

      this.lastVision = null;

      this.lastLineSeenAt =
        performance.now();

      this.lastMotor = {
        left: 0,
        right: 0
      };

      this.resetLineController();

      this.setMotorReason(
        "WAITING_VISION",
        "Đang chờ camera nhận diện lane"
      );

      this.setState(
        NAV_STATE.LINE_FOLLOW
      );

      if (!this.controlTimer) {
        this.controlTimer =
          window.setInterval(
            () => this.controlLoop(),

            Math.max(
              30,
              Number(
                this.config.MOTOR_INTERVAL_MS
              ) || 70
            )
          );
      }
    }

    // =====================================================
    // STOP
    // =====================================================

    stop(reason = "manual") {
      if (this.controlTimer) {
        clearInterval(
          this.controlTimer
        );

        this.controlTimer = null;
      }

      this.setMotorReason(
        "STOPPED",
        reason
      );

      this.sendMotor(
        0,
        0,
        true
      );

      this.setState(
        NAV_STATE.STOPPED,
        reason
      );
    }

    // =====================================================
    // FAIL
    // =====================================================

    fail(message) {
      this.setMotorReason(
        "ERROR",
        message
      );

      this.sendMotor(
        0,
        0,
        true
      );

      this.setState(
        NAV_STATE.ERROR,
        message
      );

      this.onDebug(
        `NAV ERROR: ${message}`
      );
    }

    // =====================================================
    // NAV STATE
    // =====================================================

    setState(
      state,
      detail = ""
    ) {
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
        turnDirection:
          this.turnDirection
      });

      this.onDebug(
        `NAV ${state}${
          detail
            ? `: ${detail}`
            : ""
        }`
      );
    }

    // =====================================================
    // MOTOR DEBUG REASON
    // =====================================================

    setMotorReason(
      reason,
      detail = ""
    ) {
      const text =
        detail
          ? `${reason} · ${detail}`
          : reason;

      this.motorReason = text;

      if (
        typeof document !==
        "undefined"
      ) {
        const mainReason =
          document.getElementById(
            "motorReasonState"
          );

        const visionReason =
          document.getElementById(
            "visionMotorReasonState"
          );

        if (mainReason) {
          mainReason.textContent =
            text;
        }

        if (visionReason) {
          visionReason.textContent =
            text;
        }
      }
    }

    updateMotorPublishDebug(
      published
    ) {
      this.motorPublishOk =
        Boolean(published);

      const text =
        this.motorPublishOk
          ? "OK"
          : "FAIL / chưa kết nối";

      if (
        typeof document !==
        "undefined"
      ) {
        const mainState =
          document.getElementById(
            "motorPublishState"
          );

        const visionState =
          document.getElementById(
            "visionMotorPublishState"
          );

        if (mainState) {
          mainState.textContent =
            text;
        }

        if (visionState) {
          visionState.textContent =
            text;
        }
      }
    }

    // =====================================================
    // SENSOR INPUT
    // =====================================================

    updateSensors(
      payload = {}
    ) {
      this.sensors = {
        ...this.sensors,

        ir2:
          Boolean(
            payload.ir2
          ),

        ir3:
          Boolean(
            payload.ir3
          ),

        ir5:
          Boolean(
            payload.ir5
          ),

        has_food:
          payload.has_food != null
            ? Boolean(
                payload.has_food
              )
            : Boolean(
                payload.ir5
              )
      };
    }

    // =====================================================
    // VISION INPUT
    // =====================================================

    updateVision(frame) {
      this.lastVision = frame;

      // Chỉ reset timeout nếu
      // camera thực sự thấy ít nhất 1 line.
      //
      // PREDICTED không được kéo dài
      // thời gian line sống vô hạn.
      if (
        frame?.hasVisualLine &&
        frame?.hasLane
      ) {
        this.lastLineSeenAt =
          performance.now();
      }
    }

    // =====================================================
    // RESET CONTROLLER
    // =====================================================

    resetLineController() {
      this.prevLineError = null;

      this.prevPathAngle = null;

      this.prevControlAt = 0;

      this.filteredLineDerivative = 0;

      this.filteredPathAngleDerivative = 0;
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
          : (
              qr || {}
            );

      const expected =
        String(
          this.config
            .T_JUNCTION_QR_TEXT ||
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
        Number(
          payload.areaPercent
        );

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
        !Number.isFinite(
          areaPercent
        ) ||
        areaPercent <
        stopPercent
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

      this.qrStopPending = true;

      // STOP ngay lập tức.
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

        this.qrStopPending = false;

        this.beginTJunctionTurn();
      }
    }

    // =====================================================
    // BEGIN T-JUNCTION TURN
    // =====================================================

    beginTJunctionTurn() {
      if (!this.task) {
        this.fail(
          "Không có task để xác định hướng rẽ."
        );

        return;
      }

      let direction =
        String(
          this.task
            .junction_turn ||
          ""
        )
          .trim()
          .toUpperCase();

      // Fallback:
      //
      // Line 1 -> LEFT
      // Line 2 -> RIGHT
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
        ].includes(
          direction
        )
      ) {
        this.fail(
          "Task không có hướng rẽ LEFT/RIGHT hợp lệ."
        );

        return;
      }

      const yaw =
        this.orientation
          .getYaw();

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
        NAV_STATE
          .T_JUNCTION_DETECTED,

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
            NAV_STATE
              .T_JUNCTION_DETECTED
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

      switch (
        this.state
      ) {
        case NAV_STATE
          .LINE_FOLLOW:

          this.controlLineFollow();

          break;

        case NAV_STATE
          .TURNING:

          this.controlTurn();

          break;

        case NAV_STATE
          .REACQUIRE_LINE:

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
    // POINT HỒNG = HƯỚNG CUA CHÍNH
    // =====================================================

    controlLineFollow() {
      // ===================================================
      // QR STOP
      // ===================================================

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
        }
        else {
          this.resetLineController();

          this.setMotorReason(
            "QR_STOP",
            "Đang xác nhận T-junction"
          );

          this.sendMotor(
            0,
            0,
            true
          );

          return;
        }
      }

      // ===================================================
      // IR SENSOR
      // ===================================================
      //
      // true:
      // nền đường
      //
      // false:
      // băng đen
      //
      const irActiveLow =
        this.config
          .IR_ACTIVE_LOW !==
        false;

      const leftBorderHit =
        irActiveLow
          ? (
              !this.sensors.ir2 &&
              this.sensors.ir3
            )
          : (
              this.sensors.ir2 &&
              !this.sensors.ir3
            );

      const rightBorderHit =
        irActiveLow
          ? (
              this.sensors.ir2 &&
              !this.sensors.ir3
            )
          : (
              this.sensors.ir3 &&
              !this.sensors.ir2
            );

      // ---------------------------------------------------
      // Chạm vạch trái
      // -> bánh trái nhanh
      // -> ép xe sang phải
      // ---------------------------------------------------

      if (
        leftBorderHit
      ) {
        this.resetLineController();

        this.setMotorReason(
          "IR_LEFT",
          "Chạm biên trái → ép xe sang phải"
        );

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
      // Chạm vạch phải
      // -> bánh phải nhanh
      // -> ép xe sang trái
      // ---------------------------------------------------

      if (
        rightBorderHit
      ) {
        this.resetLineController();

        this.setMotorReason(
          "IR_RIGHT",
          "Chạm biên phải → ép xe sang trái"
        );

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

      // ===================================================
      // VISION FRAME
      // ===================================================

      const frame =
        this.lastVision;

      if (
        !frame?.hasLane ||

        frame.lineError ==
          null ||

        frame.headingErrorDeg ==
          null ||

        frame.laneCenter ==
          null ||

        frame.lookAheadCenter ==
          null
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
          this.setMotorReason(
            "LOST_LINE",

            `Mất lane ${Math.round(
              lostFor
            )} ms → STOP`
          );

          this.sendMotor(
            0,
            0,
            true
          );
        }
        else {
          this.setMotorReason(
            "WAITING_LINE",

            `Chưa có lane hợp lệ · ${Math.round(
              lostFor
            )} ms`
          );
        }

        return;
      }

      // ===================================================
      // CONFIDENCE
      // ===================================================

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

        this.setMotorReason(
          "LOW_CONFIDENCE",

          `${confidence.toFixed(
            2
          )} < ${minConfidence.toFixed(
            2
          )}`
        );

        return;
      }

      // ===================================================
      // HÌNH HỌC
      // ===================================================
      //
      // laneCenter:
      // điểm xanh gần xe.
      //
      // lookAheadCenter:
      // điểm HỒNG phía trước.
      //
      // curveDx:
      //
      // pinkX - nearCenterX
      //
      //
      // curveDx < 0:
      // điểm hồng nằm trái
      // => cua trái.
      //
      // curveDx > 0:
      // điểm hồng nằm phải
      // => cua phải.
      //
      // headingErrorDeg do vision tính:
      //
      // atan2(
      //   pinkX - nearX,
      //   khoảng cách dọc
      // )
      //
      // nên chính là pathAngle.
      // ===================================================

      const lineError =
        Number(
          frame.lineError
        ) || 0;

      const laneCenter =
        Number(
          frame.laneCenter
        );

      const lookAheadCenter =
        Number(
          frame.lookAheadCenter
        );

      const curveDx =
        lookAheadCenter -
        laneCenter;

      const pathAngleDeg =
        Number(
          frame.headingErrorDeg
        ) || 0;

      const curvatureDeg =
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
      // DEADBAND
      // ===================================================

      const positionDeadband =
        Math.max(
          0,

          Number(
            this.config
              .POSITION_DEADBAND_PX
          ) || 4
        );

      const angleDeadband =
        Math.max(
          0,

          Number(
            this.config
              .PATH_ANGLE_DEADBAND_DEG
          ) || 1.2
        );

      const positionError =
        Math.abs(
          lineError
        ) <=
        positionDeadband

          ? 0

          : lineError;

      const pathAngle =
        Math.abs(
          pathAngleDeg
        ) <=
        angleDeadband

          ? 0

          : pathAngleDeg;

      // ===================================================
      // BASE SPEED
      // ===================================================

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

      // ===================================================
      // GIẢM TỐC THEO GÓC ĐIỂM HỒNG
      // ===================================================

      const fullSlowdownDeg =
        Math.max(
          8,

          Number(
            this.config
              .PATH_FULL_SLOWDOWN_DEG
          ) || 24
        );

      const curveMeasure =
        Math.max(
          Math.abs(
            pathAngle
          ),

          Math.abs(
            curvatureDeg
          ) * 0.55
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
      // GIẢM TỐC NẾU XE LỆCH TÂM
      // ===================================================

      const centerFullSlowdownRatio =
        this.clamp(
          Number(
            this.config
              .CENTER_FULL_SLOWDOWN_RATIO
          ) || 0.26,

          0.08,

          0.49
        );

      const offCenterRatio =
        this.clamp(
          Math.abs(
            positionError
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
          0.65 *
          (
            baseSpeed -
            minCurveSpeed
          )
        );

      // ===================================================
      // CONFIDENCE SPEED
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
      // ONE-LINE SPEED
      // ===================================================

      if (
        oneLineMode
      ) {
        baseSpeed =
          Math.min(
            baseSpeed,

            Math.max(
              35,

              Number(
                this.config
                  .ONE_LINE_BASE_SPEED
              ) || 76
            )
          );
      }

      // ===================================================
      // PREDICTED SPEED
      // ===================================================

      if (
        predictedMode
      ) {
        baseSpeed =
          Math.min(
            baseSpeed,

            Math.max(
              25,

              Number(
                this.config
                  .LOST_PREDICT_SPEED
              ) || 52
            )
          );
      }

      // ===================================================
      // DELTA TIME
      // ===================================================

      const now =
        performance.now();

      let dt =
        this.prevControlAt >
        0
          ? (
              now -
              this.prevControlAt
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

      // ===================================================
      // POSITION DERIVATIVE
      // ===================================================

      let rawPositionDerivative =
        0;

      if (
        this.prevLineError !=
        null
      ) {
        rawPositionDerivative =
          (
            positionError -
            this.prevLineError
          ) /
          dt;
      }

      // ===================================================
      // ANGLE DERIVATIVE
      // ===================================================

      let rawAngleDerivative =
        0;

      if (
        this.prevPathAngle !=
        null
      ) {
        rawAngleDerivative =
          (
            pathAngle -
            this.prevPathAngle
          ) /
          dt;
      }

      // ===================================================
      // DERIVATIVE FILTER
      // ===================================================

      const positionDAlpha =
        this.clamp(
          Number(
            this.config
              .POSITION_DERIVATIVE_EMA_ALPHA
          ) || 0.20,

          0.05,

          1
        );

      const angleDAlpha =
        this.clamp(
          Number(
            this.config
              .PATH_ANGLE_DERIVATIVE_EMA_ALPHA
          ) || 0.18,

          0.05,

          1
        );

      this.filteredLineDerivative +=
        positionDAlpha *
        (
          rawPositionDerivative -
          this.filteredLineDerivative
        );

      this.filteredPathAngleDerivative +=
        angleDAlpha *
        (
          rawAngleDerivative -
          this.filteredPathAngleDerivative
        );

      this.prevLineError =
        positionError;

      this.prevPathAngle =
        pathAngle;

      this.prevControlAt =
        now;

      // ===================================================
      // CONTROLLER GAINS
      // ===================================================

      const angleKp =
        Number(
          this.config
            .PATH_ANGLE_KP
        ) || 3.0;

      const angleKd =
        Number(
          this.config
            .PATH_ANGLE_KD
        ) || 0.055;

      const positionKp =
        Number(
          this.config
            .POSITION_KP
        ) || 0.10;

      const positionKd =
        Number(
          this.config
            .POSITION_KD
        ) || 0.004;

      const curvatureKp =
        Number(
          this.config
            .CURVATURE_KP
        ) || 0.18;

      // ===================================================
      // CONTROL TERMS
      // ===================================================

      const angleTerm =
        angleKp *
        pathAngle;

      const angleDTerm =
        angleKd *
        this.filteredPathAngleDerivative;

      const positionTerm =
        positionKp *
        positionError;

      const positionDTerm =
        positionKd *
        this.filteredLineDerivative;

      const curvatureTerm =
        curvatureKp *
        curvatureDeg;

      // ===================================================
      // STEERING CORRECTION
      // ===================================================

      let correction =
        angleTerm +
        angleDTerm +
        positionTerm +
        positionDTerm +
        curvatureTerm;

      // ===================================================
      // CURVE DIRECTION LOCK
      // ===================================================
      //
      // Nếu điểm hồng cho thấy cua rõ:
      //
      // pathAngle < 0:
      //
      // correction bắt buộc âm
      // => Left < Right
      // => cua trái.
      //
      //
      // pathAngle > 0:
      //
      // correction bắt buộc dương
      // => Left > Right
      // => cua phải.
      //
      //
      // Nếu xe đã lệch tâm quá lớn,
      // position controller được phép override.
      // ===================================================

      const lockDeg =
        Math.max(
          0,

          Number(
            this.config
              .CURVE_DIRECTION_LOCK_DEG
          ) || 5
        );

      const minCurveCorrection =
        Math.max(
          0,

          Number(
            this.config
              .CURVE_DIRECTION_MIN_CORRECTION
          ) || 10
        );

      const overrideOffCenter =
        this.clamp(
          Number(
            this.config
              .CURVE_DIRECTION_OVERRIDE_OFFCENTER_RATIO
          ) || 0.85,

          0.35,

          1
        );

      if (
        Math.abs(
          pathAngle
        ) >=
          lockDeg &&

        offCenterRatio <
          overrideOffCenter
      ) {
        // -----------------------------------------------
        // CUA TRÁI
        // -----------------------------------------------

        if (
          pathAngle <
            0 &&

          correction >
            -minCurveCorrection
        ) {
          correction =
            -minCurveCorrection;
        }

        // -----------------------------------------------
        // CUA PHẢI
        // -----------------------------------------------

        else if (
          pathAngle >
            0 &&

          correction <
            minCurveCorrection
        ) {
          correction =
            minCurveCorrection;
        }
      }

      // ===================================================
      // ONE LINE GAIN
      // ===================================================

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

      // ===================================================
      // PREDICTED GAIN
      // ===================================================

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

      // ===================================================
      // MAX CORRECTION
      // ===================================================

      const maxCorrection =
        Math.max(
          10,

          Number(
            this.config
              .MAX_STEERING_CORRECTION
          ) || 92
        );

      correction =
        this.clamp(
          correction,

          -maxCorrection,

          maxCorrection
        );

      // ===================================================
      // DIFFERENTIAL DRIVE
      // ===================================================
      //
      // correction < 0:
      //
      // Left chậm
      // Right nhanh
      // => cua trái.
      //
      //
      // correction > 0:
      //
      // Left nhanh
      // Right chậm
      // => cua phải.
      //
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

      // ===================================================
      // DEBUG DIRECTION
      // ===================================================

      const directionText =
        pathAngle <
          -angleDeadband

          ? "LEFT"

          : pathAngle >
            angleDeadband

            ? "RIGHT"

            : "STRAIGHT";

      const debugDetail =
        `${directionText}` +

        ` · angle=${pathAngleDeg.toFixed(
          1
        )}°` +

        ` · pinkDx=${Math.round(
          curveDx
        )}px` +

        ` · pos=${Math.round(
          lineError
        )}px` +

        ` · conf=${confidence.toFixed(
          2
        )}`;

      // ===================================================
      // DEBUG MODE
      // ===================================================

      if (
        trackMode ===
        "LEFT_ONLY"
      ) {
        this.setMotorReason(
          "ONE_LINE_LEFT",
          debugDetail
        );
      }

      else if (
        trackMode ===
        "RIGHT_ONLY"
      ) {
        this.setMotorReason(
          "ONE_LINE_RIGHT",
          debugDetail
        );
      }

      else if (
        predictedMode
      ) {
        this.setMotorReason(
          "PREDICTED",
          debugDetail
        );
      }

      else {
        this.setMotorReason(
          "PATH_FOLLOW",
          debugDetail
        );
      }

      // ===================================================
      // SEND MOTOR
      // ===================================================

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
        this.orientation
          .getYaw();

      if (
        yaw == null ||
        this.turnStartYaw ==
          null
      ) {
        this.fail(
          "Mất dữ liệu orientation trong lúc rẽ."
        );

        return;
      }

      const relative =
        window
          .RobotOrientation
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
          frame
            ?.laneConfidence
        ) || 0;

      const minConfidence =
        Number(
          this.config
            .VISION_MIN_CONFIDENCE
        ) || 0.38;

      // ===================================================
      // REACQUIRE CHECK
      // ===================================================

      if (
        angle >=
          searchAt &&

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
          NAV_STATE
            .REACQUIRE_LINE,

          `Đã thấy line mới ở ${angle.toFixed(
            1
          )}°`
        );

        return;
      }

      // ===================================================
      // TURN TIMEOUT
      // ===================================================

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
        remaining >
        35
      ) {
        speed =
          Number(
            this.config
              .TURN_FAST_SPEED
          ) || 145;
      }

      else if (
        remaining >
        15
      ) {
        speed =
          Number(
            this.config
              .TURN_MEDIUM_SPEED
          ) || 105;
      }

      else {
        speed =
          Number(
            this.config
              .TURN_SLOW_SPEED
          ) || 72;
      }

      if (
        angle >=
        target
      ) {
        speed =
          Number(
            this.config
              .TURN_SLOW_SPEED
          ) || 72;
      }

      // ===================================================
      // TURN LEFT
      // ===================================================

      if (
        this.turnDirection ===
        "LEFT"
      ) {
        this.setMotorReason(
          "TURN_LEFT",

          `yaw=${angle.toFixed(
            1
          )}°`
        );

        this.sendMotor(
          -speed,
          speed
        );
      }

      // ===================================================
      // TURN RIGHT
      // ===================================================

      else {
        this.setMotorReason(
          "TURN_RIGHT",

          `yaw=${angle.toFixed(
            1
          )}°`
        );

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

        this.setMotorReason(
          "REACQUIRE_WAIT",
          "Đang chờ bắt lại đủ 2 biên"
        );

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
            this.config
              .BASE_SPEED
          ) || 122
        );

      const positionKp =
        Number(
          this.config
            .POSITION_KP
        ) || 0.10;

      const angleKp =
        Number(
          this.config
            .PATH_ANGLE_KP
        ) || 3.0;

      // Sau cú rẽ vẫn ưu tiên điểm hồng,
      // nhưng correction được giới hạn nhỏ hơn.
      const correction =
        this.clamp(
          frame.lineError *
          positionKp +

          frame.headingErrorDeg *
          angleKp,

          -55,

          55
        );

      this.setMotorReason(
        "REACQUIRE_LINE",

        `err=${Math.round(
          frame.lineError
        )} px` +

        ` · angle=${Number(
          frame.headingErrorDeg
        ).toFixed(
          1
        )}°`
      );

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
        ) <
        12;

      if (
        centered &&
        headingReady
      ) {
        this.reacquireStableFrames +=
          1;
      }

      else {
        this.reacquireStableFrames =
          0;
      }

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
          NAV_STATE
            .LINE_FOLLOW,

          "Đã ổn định line mới"
        );
      }
    }

    // =====================================================
    // MOTOR OUTPUT
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
        Number(
          left
        ) || 0;

      let nextRight =
        Number(
          right
        ) || 0;

      // ===================================================
      // MOTOR SLEW RATE
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
      // MOTOR LIMIT
      // ===================================================

      const maxSpeed =
        Math.max(
          1,

          Number(
            this.config
              .MAX_SPEED
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
      // SAVE MOTOR
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
      // MQTT
      // ===================================================

      const published =
        this.mqtt
          .publishMotor(
            this.lastMotor
              .left,

            this.lastMotor
              .right
          );

      this.updateMotorPublishDebug(
        published
      );

      // ===================================================
      // UPDATE DEBUG UI
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

        const leftState =
          document.getElementById(
            "leftMotorState"
          );

        const rightState =
          document.getElementById(
            "rightMotorState"
          );

        if (
          leftDebug
        ) {
          leftDebug.textContent =
            String(
              this.lastMotor.left
            );
        }

        if (
          rightDebug
        ) {
          rightDebug.textContent =
            String(
              this.lastMotor.right
            );
        }

        if (
          leftState
        ) {
          leftState.textContent =
            String(
              this.lastMotor.left
            );
        }

        if (
          rightState
        ) {
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
    // CLAMP
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
  // EXPORT
  // =======================================================

  window.ROBOT_NAV_STATE =
    NAV_STATE;

  window.RobotNavigation =
    RobotNavigation;
})();