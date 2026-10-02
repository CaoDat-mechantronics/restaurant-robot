(() => {
  class RobotVision {
    constructor({
      config = {},
      onFrame = () => {},
      onQr = () => {},
      onDebug = () => {}
    } = {}) {
      this.config = config;
      this.onFrame = onFrame;
      this.onQr = onQr;
      this.onDebug = onDebug;

      this.video = null;
      this.overlay = null;
      this.overlayCtx = null;

      this.qrCanvas = document.createElement("canvas");
      this.qrCtx = this.qrCanvas.getContext("2d", { willReadFrequently: true });

      this.stream = null;
      this.running = false;
      this.raf = 0;
      this.lastQr = null;
      this.lastFrame = null;
      this.lastQrScanAt = 0;
      this.qrBusy = false;
      this.barcodeDetector = null;
      this.displayAspectKey = "";
      this.cameraSwitchBusy = false;

      const configuredFacingMode = String(
        this.config.CAMERA_FACING_MODE || "user"
      ).toLowerCase();

      this.currentFacingMode = configuredFacingMode === "environment"
        ? "environment"
        : "user";

      this.qrAnalysisWidth = Math.max(
        320,
        Number(this.config.QR_ANALYSIS_WIDTH) || 640
      );

      if (
        "BarcodeDetector" in window &&
        typeof window.BarcodeDetector === "function"
      ) {
        try {
          this.barcodeDetector = new window.BarcodeDetector({
            formats: ["qr_code"]
          });
        } catch (_) {
          this.barcodeDetector = null;
        }
      }
    }

    getFacingMode() {
      return this.currentFacingMode;
    }

    getVideoConstraints(
      facingMode = this.currentFacingMode,
      exactFacingMode = false
    ) {
      return {
        facingMode: exactFacingMode
          ? { exact: facingMode }
          : { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      };
    }

    async requestCameraStream(
      facingMode = this.currentFacingMode,
      { exactFacingMode = false } = {}
    ) {
      return navigator.mediaDevices.getUserMedia({
        video: this.getVideoConstraints(facingMode, exactFacingMode),
        audio: false
      });
    }

    async attachCameraStream(stream, facingMode) {
      this.stream = stream;
      this.currentFacingMode = facingMode;

      this.video.srcObject = stream;
      this.video.playsInline = true;
      this.video.muted = true;
      await this.video.play();

      this.displayAspectKey = "";
      this.syncDisplayAspectRatio();
      this.clearOverlay();
      this.lastQr = null;
      this.lastFrame = null;
    }

    async start(videoElement, overlayCanvas) {
      if (this.running) {
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Trình duyệt không hỗ trợ camera getUserMedia.");
      }

      this.video = videoElement;
      this.overlay = overlayCanvas;
      this.overlayCtx = this.overlay?.getContext("2d") || null;

      const stream = await this.requestCameraStream(this.currentFacingMode);
      await this.attachCameraStream(stream, this.currentFacingMode);

      this.running = true;
      this.onDebug(
        `Camera started · ${this.currentFacingMode === "environment" ? "rear" : "front"} · QR only`
      );
      this.loop();
    }

    async switchCamera() {
      if (this.cameraSwitchBusy) {
        return this.currentFacingMode;
      }

      const nextFacingMode = this.currentFacingMode === "user"
        ? "environment"
        : "user";

      if (!this.running || !this.video) {
        this.currentFacingMode = nextFacingMode;
        return this.currentFacingMode;
      }

      this.cameraSwitchBusy = true;
      const previousFacingMode = this.currentFacingMode;

      try {
        if (this.stream) {
          for (const track of this.stream.getTracks()) {
            track.stop();
          }
        }

        this.stream = null;
        this.video.srcObject = null;

        let stream;
        try {
          stream = await this.requestCameraStream(nextFacingMode, {
            exactFacingMode: true
          });
        } catch (exactError) {
          this.onDebug(`Exact facingMode failed: ${exactError.message}`);
          stream = await this.requestCameraStream(nextFacingMode);
        }

        await this.attachCameraStream(stream, nextFacingMode);
        this.onDebug(
          `Camera switched -> ${nextFacingMode === "environment" ? "rear" : "front"}`
        );
        return this.currentFacingMode;
      } catch (error) {
        try {
          const fallbackStream = await this.requestCameraStream(previousFacingMode);
          await this.attachCameraStream(fallbackStream, previousFacingMode);
          this.onDebug("Camera switch failed -> restored previous camera");
        } catch (restoreError) {
          this.onDebug(`Camera restore failed: ${restoreError.message}`);
        }
        throw error;
      } finally {
        this.cameraSwitchBusy = false;
      }
    }

    syncDisplayAspectRatio(width = 0, height = 0) {
      const w = Number(width) || this.video?.videoWidth || 0;
      const h = Number(height) || this.video?.videoHeight || 0;

      if (!w || !h || !this.video) {
        return;
      }

      const key = `${w}x${h}`;
      if (key === this.displayAspectKey) {
        return;
      }

      this.displayAspectKey = key;

      const stage = this.video.closest(".camera-stage") || this.video.parentElement;
      if (stage) {
        stage.style.aspectRatio = `${w} / ${h}`;
      }

      if (this.overlay) {
        const overlayWidth = this.qrAnalysisWidth;
        const overlayHeight = Math.max(
          240,
          Math.round(overlayWidth * h / w)
        );
        this.overlay.width = overlayWidth;
        this.overlay.height = overlayHeight;
      }

      this.onDebug(`Camera frame ${w}x${h}`);
    }

    clearOverlay() {
      if (!this.overlay || !this.overlayCtx) {
        return;
      }
      this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }

    stop() {
      this.running = false;

      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }

      if (this.stream) {
        for (const track of this.stream.getTracks()) {
          track.stop();
        }
      }

      this.stream = null;
      if (this.video) {
        this.video.srcObject = null;
      }

      this.lastQr = null;
      this.lastFrame = null;
      this.clearOverlay();
    }

    loop() {
      if (!this.running) {
        return;
      }

      this.processFrame();
      this.raf = requestAnimationFrame(() => this.loop());
    }

    processFrame() {
      if (!this.video || this.video.readyState < 2) {
        return;
      }

      const sourceWidth = this.video.videoWidth || 1280;
      const sourceHeight = this.video.videoHeight || 720;
      this.syncDisplayAspectRatio(sourceWidth, sourceHeight);

      // Không còn detect/vẽ line. Camera chỉ dùng để quét QR.
      this.clearOverlay();

      const now = performance.now();
      const qrInterval = Math.max(
        120,
        Number(this.config.QR_SCAN_INTERVAL_MS) || 220
      );

      if (now - this.lastQrScanAt >= qrInterval && !this.qrBusy) {
        this.lastQrScanAt = now;
        this.scanQr();
      }
    }

    polygonArea(points) {
      if (!Array.isArray(points) || points.length < 3) {
        return 0;
      }

      let sum = 0;
      for (let i = 0; i < points.length; i++) {
        const current = points[i];
        const next = points[(i + 1) % points.length];
        sum += current.x * next.y - next.x * current.y;
      }
      return Math.abs(sum) / 2;
    }

    normalizeBarcodeCorners(result) {
      const raw = Array.isArray(result?.cornerPoints)
        ? result.cornerPoints
        : [];

      if (raw.length >= 4) {
        return raw.slice(0, 4).map((point) => ({
          x: Number(point.x) || 0,
          y: Number(point.y) || 0
        }));
      }

      const box = result?.boundingBox;
      if (box) {
        const x = Number(box.x) || 0;
        const y = Number(box.y) || 0;
        const w = Number(box.width) || 0;
        const h = Number(box.height) || 0;

        return [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h }
        ];
      }

      return [];
    }

    normalizeJsQrCorners(result) {
      const loc = result?.location;
      if (!loc) {
        return [];
      }

      const raw = [
        loc.topLeftCorner,
        loc.topRightCorner,
        loc.bottomRightCorner,
        loc.bottomLeftCorner
      ];

      if (raw.some((point) => !point)) {
        return [];
      }

      return raw.map((point) => ({
        x: Number(point.x) || 0,
        y: Number(point.y) || 0
      }));
    }

    buildQrPayload(text, corners) {
      const frameWidth = this.qrCanvas.width || 1;
      const frameHeight = this.qrCanvas.height || 1;
      const frameArea = frameWidth * frameHeight;
      const areaPx = this.polygonArea(corners);
      const areaRatio = frameArea > 0 ? areaPx / frameArea : 0;
      const areaPercent = areaRatio * 100;

      let centerX = null;
      let centerY = null;

      if (corners.length) {
        centerX = corners.reduce((sum, point) => sum + point.x, 0) / corners.length;
        centerY = corners.reduce((sum, point) => sum + point.y, 0) / corners.length;
      }

      return {
        text,
        corners,
        areaPx,
        areaRatio,
        areaPercent,
        centerX,
        centerY,
        frameWidth,
        frameHeight,
        timestamp: performance.now()
      };
    }

    async scanQr() {
      if (!this.video || this.video.readyState < 2) {
        return;
      }

      this.qrBusy = true;

      try {
        const sourceWidth = this.video.videoWidth || 1280;
        const sourceHeight = this.video.videoHeight || 720;
        const width = this.qrAnalysisWidth;
        const height = Math.max(
          240,
          Math.round(width * sourceHeight / sourceWidth)
        );

        if (this.qrCanvas.width !== width || this.qrCanvas.height !== height) {
          this.qrCanvas.width = width;
          this.qrCanvas.height = height;
        }

        this.qrCtx.drawImage(this.video, 0, 0, width, height);

        let text = "";
        let corners = [];

        if (this.barcodeDetector) {
          const results = await this.barcodeDetector.detect(this.qrCanvas);
          if (results?.length) {
            const result = results[0];
            text = String(result.rawValue || "").trim();
            corners = this.normalizeBarcodeCorners(result);
          }
        } else if (typeof window.jsQR === "function") {
          const image = this.qrCtx.getImageData(
            0,
            0,
            this.qrCanvas.width,
            this.qrCanvas.height
          );

          const result = window.jsQR(
            image.data,
            image.width,
            image.height,
            { inversionAttempts: "attemptBoth" }
          );

          if (result?.data) {
            text = String(result.data).trim();
            corners = this.normalizeJsQrCorners(result);
          }
        }

        if (text) {
          const payload = this.buildQrPayload(text, corners);
          this.lastQr = payload;
          this.onQr(payload);
        }
      } catch (error) {
        this.onDebug(`QR scan error: ${error.message}`);
      } finally {
        this.qrBusy = false;
      }
    }

    getLastFrame() {
      return this.lastFrame;
    }

    getLastQr() {
      return this.lastQr;
    }
  }

  window.ROBOT_VISION_BUILD = "2026-10-02-qr-only-v1";
  console.info("[RobotVision] loaded", window.ROBOT_VISION_BUILD);
  window.RobotVision = RobotVision;
})();
