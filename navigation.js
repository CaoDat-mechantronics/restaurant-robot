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

      this.turnStartYaw = null;
      this.turnDirection = null;
      this.reacquireStableFrames = 0;
      this.tJunctionHits = 0;
      this.lastTJunctionQrAt = 0;
      this.lastTJunctionHandledAt = 0;
    }

    start(task) {
      this.task = { ...task };
      this.turnStartYaw = null;
      this.turnDirection = null;
      this.reacquireStableFrames = 0;
      this.tJunctionHits = 0;
      this.lastLineSeenAt = performance.now();

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

      this.sendMotor(0, 0, true);
      this.setState(NAV_STATE.STOPPED, reason);
    }

    fail(message) {
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
      if (frame?.hasBothLines) {
        this.lastLineSeenAt = performance.now();
      }
    }

    handleQr(text) {
      if (this.state !== NAV_STATE.LINE_FOLLOW) {
        return;
      }

      const expected =
        String(this.config.T_JUNCTION_QR_TEXT || "T-junction")
          .trim()
          .toLowerCase();

      const value = String(text || "").trim().toLowerCase();
      if (value !== expected) {
        return;
      }

      const now = performance.now();

      // Không xử lý lại cùng QR ngay sau khi vừa rẽ xong.
      if (now - this.lastTJunctionHandledAt < 3500) {
        return;
      }

      if (now - this.lastTJunctionQrAt > 1000) {
        this.tJunctionHits = 0;
      }

      this.lastTJunctionQrAt = now;
      this.tJunctionHits += 1;

      const required =
        Math.max(1, Number(this.config.T_JUNCTION_STABLE_COUNT) || 2);

      if (this.tJunctionHits >= required) {
        this.tJunctionHits = 0;
        this.beginTJunctionTurn();
      }
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

      // Fallback theo route hiện tại của backend:
      // Line 1 -> LEFT, Line 2 -> RIGHT.
      if (!direction) {
        if (Number(this.task.line) === 1) direction = "LEFT";
        if (Number(this.task.line) === 2) direction = "RIGHT";
      }

      if (!['LEFT', 'RIGHT'].includes(direction)) {
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

      this.setState(
        NAV_STATE.T_JUNCTION_DETECTED,
        `QR T-junction, chuẩn bị rẽ ${direction}`
      );
      this.sendMotor(0, 0, true);

      window.setTimeout(() => {
        if (this.state === NAV_STATE.T_JUNCTION_DETECTED) {
          this.setState(NAV_STATE.TURNING, `Rẽ ${direction}`);
        }
      }, 160);
    }

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

    controlLineFollow() {
      // IR2 = biên trái. Chạm biên trái -> ép xe sang phải.
      if (this.sensors.ir2 && !this.sensors.ir3) {
        this.sendMotor(
          Number(this.config.BORDER_FAST_SPEED) || 145,
          Number(this.config.BORDER_SLOW_SPEED) || 65
        );
        return;
      }

      // IR3 = biên phải. Chạm biên phải -> ép xe sang trái.
      if (this.sensors.ir3 && !this.sensors.ir2) {
        this.sendMotor(
          Number(this.config.BORDER_SLOW_SPEED) || 65,
          Number(this.config.BORDER_FAST_SPEED) || 145
        );
        return;
      }

      if (!this.lastVision?.hasBothLines || this.lastVision.lineError == null) {
        const lostFor = performance.now() - this.lastLineSeenAt;
        if (lostFor >= (Number(this.config.LINE_LOST_STOP_MS) || 900)) {
          this.sendMotor(0, 0, true);
        }
        return;
      }

      const base = Number(this.config.BASE_SPEED) || 125;
      const kp = Number(this.config.LINE_KP) || 0.30;
      const max = Number(this.config.MAX_SPEED) || 190;
      const correction = this.lastVision.lineError * kp;

      const left = this.clamp(base + correction, -max, max);
      const right = this.clamp(base - correction, -max, max);
      this.sendMotor(left, right);
    }

    controlTurn() {
      const yaw = this.orientation.getYaw();
      if (yaw == null || this.turnStartYaw == null) {
        this.fail("Mất dữ liệu orientation trong lúc rẽ.");
        return;
      }

      const relative =
        window.RobotOrientation.deltaDegrees(yaw, this.turnStartYaw);
      const angle = Math.abs(relative);

      const searchAt =
        Number(this.config.TURN_START_LINE_SEARCH_DEG) || 68;
      const maxAngle =
        Number(this.config.TURN_MAX_DEG) || 112;
      const target =
        Number(this.config.TURN_TARGET_DEG) || 90;

      if (
        angle >= searchAt &&
        this.lastVision?.hasBothLines &&
        this.lastVision.lineError != null &&
        Math.abs(this.lastVision.lineError) < this.lastVision.width * 0.22
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

      // Nếu đã vượt góc mục tiêu nhưng chưa thấy line, chỉ quay chậm để tìm.
      if (angle >= target) {
        speed = Number(this.config.TURN_SLOW_SPEED) || 72;
      }

      if (this.turnDirection === "LEFT") {
        this.sendMotor(-speed, speed);
      }
      else {
        this.sendMotor(speed, -speed);
      }
    }

    controlReacquireLine() {
      if (!this.lastVision?.hasBothLines || this.lastVision.lineError == null) {
        this.reacquireStableFrames = 0;
        this.sendMotor(0, 0, true);
        return;
      }

      const base = Math.min(88, Number(this.config.BASE_SPEED) || 125);
      const kp = Number(this.config.LINE_KP) || 0.30;
      const correction = this.lastVision.lineError * kp;

      this.sendMotor(
        this.clamp(base + correction, 40, 110),
        this.clamp(base - correction, 40, 110)
      );

      if (Math.abs(this.lastVision.lineError) < this.lastVision.width * 0.12) {
        this.reacquireStableFrames += 1;
      }
      else {
        this.reacquireStableFrames = 0;
      }

      if (this.reacquireStableFrames >= 5) {
        this.turnStartYaw = null;
        this.turnDirection = null;
        this.reacquireStableFrames = 0;
        this.setState(NAV_STATE.LINE_FOLLOW, "Đã ổn định line mới");
      }
    }

    sendMotor(left, right, force = false) {
      const now = performance.now();
      const interval = Math.max(30, Number(this.config.MOTOR_INTERVAL_MS) || 70);

      if (!force && now - this.lastMotorAt < interval * 0.8) {
        return;
      }

      this.lastMotorAt = now;
      this.lastMotor = {
        left: Math.round(left),
        right: Math.round(right)
      };

      this.mqtt.publishMotor(left, right);
      this.onMotor({ ...this.lastMotor });
    }

    clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }
  }

  window.ROBOT_NAV_STATE = NAV_STATE;
  window.RobotNavigation = RobotNavigation;
})();
