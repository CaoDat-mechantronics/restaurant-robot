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
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });

      this.stream = null;
      this.running = false;
      this.raf = 0;
      this.lastFrame = null;
      this.lastQrScanAt = 0;
      this.qrBusy = false;
      this.barcodeDetector = null;

      this.analysisWidth = 320;
      this.darkThreshold =
        Number(this.config.VISION_DARK_THRESHOLD) || 80;
      this.minLineScore =
        Number(this.config.VISION_MIN_LINE_SCORE) || 0.08;

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

      // Camera selection:
      // - Điện thoại / tablet: ưu tiên camera trước.
      // - Máy tính / laptop: để browser dùng camera mặc định.
      const isMobileDevice = (() => {
        const ua = navigator.userAgent || "";

        return (
          /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
          (
            navigator.maxTouchPoints > 1 &&
            /Macintosh/i.test(ua)
          )
        );
      })();

      let videoConstraints;

      if (isMobileDevice) {
        videoConstraints = {
          facingMode: { ideal: "user" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        };

        this.onDebug("Mobile -> front camera");
      } else {
        videoConstraints = {
          width: { ideal: 1280 },
          height: { ideal: 720 }
        };

        this.onDebug("Desktop -> default camera");
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });

      this.video.srcObject = this.stream;
      this.video.playsInline = true;
      this.video.muted = true;
      await this.video.play();

      this.running = true;
      this.onDebug("Camera started");
      this.loop();
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
      const width = this.analysisWidth;
      const height = Math.max(180, Math.round(width * sourceHeight / sourceWidth));

      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;

        if (this.overlay) {
          this.overlay.width = width;
          this.overlay.height = height;
        }
      }

      this.ctx.drawImage(this.video, 0, 0, width, height);

      const lane = this.detectLane(width, height);
      this.lastFrame = lane;
      this.drawOverlay(lane, width, height);
      this.onFrame(lane);

      const now = performance.now();
      if (now - this.lastQrScanAt >= 250 && !this.qrBusy) {
        this.lastQrScanAt = now;
        this.scanQr();
      }
    }

    detectLane(width, height) {
      const roiTop = Math.round(height * 0.55);
      const roiBottom = Math.round(height * 0.96);
      const roiHeight = Math.max(1, roiBottom - roiTop);
      const image = this.ctx.getImageData(0, roiTop, width, roiHeight);
      const data = image.data;

      const columnScores = new Float32Array(width);

      for (let y = 0; y < roiHeight; y++) {
        const row = y * width * 4;

        for (let x = 0; x < width; x++) {
          const i = row + x * 4;
          const gray =
            data[i] * 0.299 +
            data[i + 1] * 0.587 +
            data[i + 2] * 0.114;

          if (gray < this.darkThreshold) {
            columnScores[x] += 1;
          }
        }
      }

      const smoothScore = (x) => {
        let sum = 0;
        let count = 0;
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width) {
            sum += columnScores[xx];
            count++;
          }
        }
        return count ? sum / count : 0;
      };

      const center = width / 2;
      const centerGap = Math.round(width * 0.08);
      const edgeMargin = Math.round(width * 0.04);

      let leftX = null;
      let leftScore = -1;
      for (let x = edgeMargin; x < center - centerGap; x++) {
        const score = smoothScore(x);
        if (score > leftScore) {
          leftScore = score;
          leftX = x;
        }
      }

      let rightX = null;
      let rightScore = -1;
      for (let x = Math.round(center + centerGap); x < width - edgeMargin; x++) {
        const score = smoothScore(x);
        if (score > rightScore) {
          rightScore = score;
          rightX = x;
        }
      }

      const leftConfidence = Math.max(0, leftScore / roiHeight);
      const rightConfidence = Math.max(0, rightScore / roiHeight);

      const leftFound =
        leftX != null && leftConfidence >= this.minLineScore;
      const rightFound =
        rightX != null && rightConfidence >= this.minLineScore;
      const hasBothLines = leftFound && rightFound;

      const laneCenter = hasBothLines
        ? (leftX + rightX) / 2
        : null;

      const lineError = laneCenter == null
        ? null
        : laneCenter - center;

      return {
        width,
        height,
        roiTop,
        roiBottom,
        leftFound,
        rightFound,
        hasBothLines,
        leftX: leftFound ? leftX : null,
        rightX: rightFound ? rightX : null,
        leftConfidence,
        rightConfidence,
        laneCenter,
        frameCenter: center,
        lineError,
        timestamp: performance.now()
      };
    }

    drawOverlay(lane, width, height) {
      if (!this.overlayCtx) {
        return;
      }

      const ctx = this.overlayCtx;
      ctx.clearRect(0, 0, width, height);

      // ROI mà thuật toán thực sự dùng để tìm hai vạch đen.
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.strokeRect(0, lane.roiTop, width, lane.roiBottom - lane.roiTop);

      // Tô nhẹ phần hành lang mà frontend tính được giữa hai line.
      if (lane.hasBothLines) {
        ctx.fillStyle = "rgba(83,177,253,.10)";
        ctx.fillRect(
          lane.leftX,
          lane.roiTop,
          Math.max(1, lane.rightX - lane.leftX),
          lane.roiBottom - lane.roiTop
        );
      }

      if (lane.leftFound) {
        ctx.strokeStyle = "#32d583";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(lane.leftX, lane.roiTop);
        ctx.lineTo(lane.leftX, lane.roiBottom);
        ctx.stroke();
      }

      if (lane.rightFound) {
        ctx.strokeStyle = "#32d583";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(lane.rightX, lane.roiTop);
        ctx.lineTo(lane.rightX, lane.roiBottom);
        ctx.stroke();
      }

      // Tâm ảnh / hướng thẳng của điện thoại.
      ctx.strokeStyle = "#fdb022";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lane.frameCenter, lane.roiTop);
      ctx.lineTo(lane.frameCenter, lane.roiBottom);
      ctx.stroke();

      // Tâm hành lang do hai line tạo ra.
      if (lane.laneCenter != null) {
        ctx.strokeStyle = "#53b1fd";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(lane.laneCenter, lane.roiTop);
        ctx.lineTo(lane.laneCenter, lane.roiBottom);
        ctx.stroke();

        ctx.fillStyle = "#53b1fd";
        ctx.beginPath();
        ctx.arc(lane.laneCenter, lane.roiBottom - 8, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Thông số trực tiếp trên ảnh debug.
      ctx.font = "12px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(2,6,23,.72)";
      ctx.fillRect(6, 6, 178, 54);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(
        `L: ${lane.leftFound ? lane.leftX.toFixed(0) : "-"}  R: ${lane.rightFound ? lane.rightX.toFixed(0) : "-"}`,
        12,
        12
      );
      ctx.fillText(
        `Center: ${lane.laneCenter != null ? lane.laneCenter.toFixed(1) : "-"}`,
        12,
        28
      );
      ctx.fillText(
        `Error: ${lane.lineError != null ? lane.lineError.toFixed(1) + " px" : "-"}`,
        12,
        44
      );
    }

    async scanQr() {
      this.qrBusy = true;

      try {
        let text = "";

        if (this.barcodeDetector) {
          const results = await this.barcodeDetector.detect(this.canvas);
          if (results?.length) {
            text = String(results[0].rawValue || "").trim();
          }
        }
        else if (typeof window.jsQR === "function") {
          const image = this.ctx.getImageData(
            0,
            0,
            this.canvas.width,
            this.canvas.height
          );

          const result = window.jsQR(
            image.data,
            image.width,
            image.height,
            { inversionAttempts: "attemptBoth" }
          );

          if (result?.data) {
            text = String(result.data).trim();
          }
        }

        if (text) {
          this.onQr({
            text,
            timestamp: performance.now()
          });
        }
      }
      catch (error) {
        this.onDebug(`QR scan error: ${error.message}`);
      }
      finally {
        this.qrBusy = false;
      }
    }

    getLastFrame() {
      return this.lastFrame;
    }
  }

  window.RobotVision = RobotVision;
})();
