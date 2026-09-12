(() => {
  class RobotOrientation {
    constructor({ onUpdate = () => {}, onDebug = () => {} } = {}) {
      this.onUpdate = onUpdate;
      this.onDebug = onDebug;
      this.yaw = null;
      this.started = false;
      this.boundHandler = this.handleOrientation.bind(this);
    }

    static normalize360(value) {
      let angle = Number(value) || 0;
      angle %= 360;
      if (angle < 0) angle += 360;
      return angle;
    }

    static deltaDegrees(current, start) {
      let delta = RobotOrientation.normalize360(current) - RobotOrientation.normalize360(start);
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      return delta;
    }

    async requestPermission() {
      if (typeof DeviceOrientationEvent === "undefined") {
        throw new Error("Trình duyệt không hỗ trợ DeviceOrientationEvent.");
      }

      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result !== "granted") {
          throw new Error("Bạn chưa cấp quyền Motion & Orientation.");
        }
      }

      return true;
    }

    start() {
      if (this.started) {
        return;
      }

      window.addEventListener("deviceorientation", this.boundHandler, true);
      this.started = true;
      this.onDebug("Orientation listener started");
    }

    stop() {
      if (!this.started) {
        return;
      }

      window.removeEventListener("deviceorientation", this.boundHandler, true);
      this.started = false;
    }

    handleOrientation(event) {
      let yaw = null;

      // Safari/iOS có thể cung cấp hướng compass trực tiếp.
      if (Number.isFinite(Number(event.webkitCompassHeading))) {
        yaw = Number(event.webkitCompassHeading);
      }
      else if (Number.isFinite(Number(event.alpha))) {
        yaw = Number(event.alpha);
      }

      if (yaw == null) {
        return;
      }

      this.yaw = RobotOrientation.normalize360(yaw);
      this.onUpdate({ yaw: this.yaw, event });
    }

    getYaw() {
      return this.yaw;
    }

    relativeFrom(startYaw) {
      if (this.yaw == null || startYaw == null) {
        return null;
      }

      return RobotOrientation.deltaDegrees(this.yaw, startYaw);
    }
  }

  window.RobotOrientation = RobotOrientation;
})();
