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

      this.qrCanvas = document.createElement("canvas");
      this.qrCtx = this.qrCanvas.getContext("2d", { willReadFrequently: true });

      this.stream = null;
      this.running = false;
      this.raf = 0;
      this.lastFrame = null;
      this.lastQr = null;

      this.lastVisionProcessAt = 0;
      this.lastQrScanAt = 0;
      this.qrBusy = false;
      this.barcodeDetector = null;
      this.displayAspectKey = "";

      this.analysisWidth = Math.max(
        320,
        Number(this.config.VISION_ANALYSIS_WIDTH) || 480
      );

      this.qrAnalysisWidth = Math.max(
        this.analysisWidth,
        Number(this.config.QR_ANALYSIS_WIDTH) || 640
      );

      this.filteredThresholds = [];
      this.prevLeftCurve = null;
      this.prevRightCurve = null;
      this.prevControlCenter = null;
      this.prevLookAheadCenter = null;
      this.prevLaneWidthNear = null;
      this.lostFrames = 0;

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

    // =====================================================
    // CAMERA
    // =====================================================

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

      this.syncDisplayAspectRatio();
      this.resetTracking();

      this.running = true;
      this.onDebug("Camera started · Line Detection V2");
      this.loop();
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

      const stage =
        this.video.closest(".camera-stage") ||
        this.video.parentElement;

      if (stage) {
        stage.style.aspectRatio = `${w} / ${h}`;
      }

      this.onDebug(`Camera frame ${w}x${h}`);
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

      this.resetTracking();
    }

    resetTracking() {
      this.filteredThresholds = [];
      this.prevLeftCurve = null;
      this.prevRightCurve = null;
      this.prevControlCenter = null;
      this.prevLookAheadCenter = null;
      this.prevLaneWidthNear = null;
      this.lostFrames = 0;
      this.lastFrame = null;
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

      const now = performance.now();
      const sourceWidth = this.video.videoWidth || 1280;
      const sourceHeight = this.video.videoHeight || 720;

      this.syncDisplayAspectRatio(sourceWidth, sourceHeight);

      const qrInterval = Math.max(
        120,
        Number(this.config.QR_SCAN_INTERVAL_MS) || 220
      );

      if (now - this.lastQrScanAt >= qrInterval && !this.qrBusy) {
        this.lastQrScanAt = now;
        this.scanQr();
      }

      const processInterval = Math.max(
        20,
        Number(this.config.VISION_PROCESS_INTERVAL_MS) || 40
      );

      if (now - this.lastVisionProcessAt < processInterval) {
        return;
      }

      this.lastVisionProcessAt = now;

      const width = this.analysisWidth;
      const height = Math.max(
        180,
        Math.round(width * sourceHeight / sourceWidth)
      );

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
    }

    // =====================================================
    // OTSU + BINARY MASK
    // =====================================================

    otsuThreshold(histogram, total) {
      if (!total) {
        return 80;
      }

      let totalWeighted = 0;
      for (let i = 0; i < 256; i++) {
        totalWeighted += i * histogram[i];
      }

      let backgroundWeight = 0;
      let backgroundWeighted = 0;
      let bestVariance = -1;
      let bestThreshold = 80;

      for (let threshold = 0; threshold < 256; threshold++) {
        backgroundWeight += histogram[threshold];

        if (backgroundWeight === 0) {
          continue;
        }

        const foregroundWeight = total - backgroundWeight;
        if (foregroundWeight <= 0) {
          break;
        }

        backgroundWeighted += threshold * histogram[threshold];

        const meanBackground =
          backgroundWeighted / backgroundWeight;

        const meanForeground =
          (totalWeighted - backgroundWeighted) / foregroundWeight;

        const diff = meanBackground - meanForeground;
        const betweenVariance =
          backgroundWeight * foregroundWeight * diff * diff;

        if (betweenVariance > bestVariance) {
          bestVariance = betweenVariance;
          bestThreshold = threshold;
        }
      }

      return bestThreshold;
    }

    makeBinaryMask(data, width, roiHeight) {
      const pixelCount = width * roiHeight;
      const gray = new Uint8Array(pixelCount);

      const bandCount = Math.max(
        1,
        Math.min(6, Number(this.config.VISION_OTSU_BANDS) || 3)
      );

      const histograms = Array.from(
        { length: bandCount },
        () => new Uint32Array(256)
      );

      const bandTotals = new Uint32Array(bandCount);

      for (let y = 0; y < roiHeight; y++) {
        const band = Math.min(
          bandCount - 1,
          Math.floor(y * bandCount / roiHeight)
        );

        for (let x = 0; x < width; x++) {
          const src = (y * width + x) * 4;
          const value = Math.max(
            0,
            Math.min(
              255,
              Math.round(
                data[src] * 0.299 +
                data[src + 1] * 0.587 +
                data[src + 2] * 0.114
              )
            )
          );

          const idx = y * width + x;
          gray[idx] = value;
          histograms[band][value] += 1;
          bandTotals[band] += 1;
        }
      }

      const rawThresholds = [];
      const thresholds = [];
      const offset = Number(this.config.VISION_OTSU_OFFSET) || 0;
      const minThreshold = Number(this.config.VISION_THRESHOLD_MIN) || 28;
      const maxThreshold = Number(this.config.VISION_THRESHOLD_MAX) || 145;
      const thresholdAlpha = this.clamp(
        Number(this.config.VISION_THRESHOLD_EMA_ALPHA) || 0.18,
        0.01,
        1
      );

      if (this.filteredThresholds.length !== bandCount) {
        this.filteredThresholds = new Array(bandCount).fill(null);
      }

      for (let band = 0; band < bandCount; band++) {
        const raw = this.otsuThreshold(
          histograms[band],
          bandTotals[band]
        );

        rawThresholds.push(raw);

        const target = this.clamp(
          raw + offset,
          minThreshold,
          maxThreshold
        );

        const previous = this.filteredThresholds[band];
        const filtered = previous == null
          ? target
          : previous + thresholdAlpha * (target - previous);

        this.filteredThresholds[band] = filtered;
        thresholds.push(filtered);
      }

      const mask = new Uint8Array(pixelCount);
      let darkPixels = 0;

      for (let y = 0; y < roiHeight; y++) {
        const band = Math.min(
          bandCount - 1,
          Math.floor(y * bandCount / roiHeight)
        );

        const threshold = thresholds[band];
        const row = y * width;

        for (let x = 0; x < width; x++) {
          const idx = row + x;
          const dark = gray[idx] <= threshold ? 1 : 0;
          mask[idx] = dark;
          darkPixels += dark;
        }
      }

      return {
        gray,
        mask,
        rawThresholds,
        thresholds,
        darkRatio: pixelCount > 0 ? darkPixels / pixelCount : 0
      };
    }

    // =====================================================
    // DARK RUNS / SLIDING WINDOW
    // =====================================================

    extractRuns(mask, width, roiHeight, y) {
      const halfHeight = Math.max(
        0,
        Math.round(Number(this.config.VISION_ROW_HALF_HEIGHT) || 2)
      );

      const stripTop = Math.max(0, y - halfHeight);
      const stripBottom = Math.min(roiHeight - 1, y + halfHeight);
      const stripRows = stripBottom - stripTop + 1;

      const minDensity = this.clamp(
        Number(this.config.VISION_RUN_MIN_DENSITY) || 0.56,
        0.2,
        1
      );

      const minWidth = Math.max(
        2,
        Math.round(
          width * (Number(this.config.VISION_RUN_MIN_RATIO) || 0.006)
        )
      );

      const maxWidth = Math.max(
        minWidth + 1,
        Math.round(
          width * (Number(this.config.VISION_RUN_MAX_RATIO) || 0.12)
        )
      );

      const profile = new Float32Array(width);

      for (let yy = stripTop; yy <= stripBottom; yy++) {
        const row = yy * width;
        for (let x = 0; x < width; x++) {
          profile[x] += mask[row + x];
        }
      }

      for (let x = 0; x < width; x++) {
        profile[x] /= stripRows;
      }

      // Smooth ngang 3 pixel để nối các lỗ nhỏ trên băng dính.
      const smooth = new Float32Array(width);
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;

        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width) {
            sum += profile[xx];
            count++;
          }
        }

        smooth[x] = count ? sum / count : 0;
      }

      const rawRuns = [];
      let start = -1;

      for (let x = 0; x <= width; x++) {
        const active = x < width && smooth[x] >= minDensity;

        if (active && start < 0) {
          start = x;
        }

        if ((!active || x === width) && start >= 0) {
          const end = x - 1;
          rawRuns.push({ start, end });
          start = -1;
        }
      }

      // Ghép hai run cách nhau <= 2px để chống đứt băng dính do phản sáng.
      const merged = [];
      for (const run of rawRuns) {
        const previous = merged[merged.length - 1];

        if (previous && run.start - previous.end <= 3) {
          previous.end = run.end;
        } else {
          merged.push({ ...run });
        }
      }

      const candidates = [];

      for (const run of merged) {
        const runWidth = run.end - run.start + 1;

        if (runWidth < minWidth || runWidth > maxWidth) {
          continue;
        }

        let weightedX = 0;
        let weight = 0;
        let densitySum = 0;

        for (let x = run.start; x <= run.end; x++) {
          const value = Math.max(0.001, smooth[x]);
          weightedX += x * value;
          weight += value;
          densitySum += smooth[x];
        }

        candidates.push({
          x: weight > 0 ? weightedX / weight : (run.start + run.end) / 2,
          width: runWidth,
          strength: this.clamp(densitySum / runWidth, 0, 1),
          start: run.start,
          end: run.end
        });
      }

      return candidates;
    }

    predictX(points, previousCurve, t) {
      let predicted = null;

      if (points.length >= 2) {
        const p1 = points[points.length - 1];
        const p0 = points[points.length - 2];
        const dt = p1.t - p0.t;

        if (Math.abs(dt) > 0.0001) {
          const slope = (p1.x - p0.x) / dt;
          predicted = p1.x + slope * (t - p1.t);
        } else {
          predicted = p1.x;
        }
      }
      else if (points.length === 1) {
        predicted = points[0].x;
      }

      if (previousCurve) {
        const previousX = this.evalCurve(previousCurve, t);

        if (Number.isFinite(predicted)) {
          predicted = predicted * 0.72 + previousX * 0.28;
        } else {
          predicted = previousX;
        }
      }

      return Number.isFinite(predicted) ? predicted : null;
    }

    choosePair({
      candidates,
      expectedLeft,
      expectedRight,
      expectedWidth,
      margin,
      frameWidth
    }) {
      const minWidth =
        frameWidth * (Number(this.config.VISION_LANE_WIDTH_MIN_RATIO) || 0.16);

      const maxWidth =
        frameWidth * (Number(this.config.VISION_LANE_WIDTH_MAX_RATIO) || 0.88);

      const temporalMin =
        Number(this.config.VISION_TEMPORAL_WIDTH_MIN_RATIO) || 0.55;

      const temporalMax =
        Number(this.config.VISION_TEMPORAL_WIDTH_MAX_RATIO) || 1.55;

      let best = null;
      let bestScore = -Infinity;

      for (const left of candidates) {
        for (const right of candidates) {
          if (right.x <= left.x) {
            continue;
          }

          const laneWidth = right.x - left.x;
          if (laneWidth < minWidth || laneWidth > maxWidth) {
            continue;
          }

          if (
            Number.isFinite(expectedWidth) &&
            expectedWidth > 1
          ) {
            const ratio = laneWidth / expectedWidth;
            if (ratio < temporalMin || ratio > temporalMax) {
              continue;
            }
          }

          if (
            Number.isFinite(expectedLeft) &&
            Math.abs(left.x - expectedLeft) > margin
          ) {
            continue;
          }

          if (
            Number.isFinite(expectedRight) &&
            Math.abs(right.x - expectedRight) > margin
          ) {
            continue;
          }

          const pairCenter = (left.x + right.x) / 2;
          let score = (left.strength + right.strength) * 2.4;

          if (Number.isFinite(expectedLeft)) {
            score -= Math.abs(left.x - expectedLeft) / Math.max(1, margin);
          }
          else {
            score -= Math.abs(pairCenter - frameWidth / 2) / frameWidth * 0.8;
          }

          if (Number.isFinite(expectedRight)) {
            score -= Math.abs(right.x - expectedRight) / Math.max(1, margin);
          }

          if (Number.isFinite(expectedWidth) && expectedWidth > 1) {
            score -= Math.abs(laneWidth - expectedWidth) / expectedWidth * 1.4;
          }

          if (score > bestScore) {
            bestScore = score;
            best = {
              left,
              right,
              width: laneWidth,
              score
            };
          }
        }
      }

      return best;
    }

    chooseSingle(candidates, expected, margin, side, frameWidth) {
      let pool = candidates;

      if (Number.isFinite(expected)) {
        pool = candidates.filter(
          (candidate) => Math.abs(candidate.x - expected) <= margin
        );
      }
      else if (side === "left") {
        pool = candidates.filter((candidate) => candidate.x < frameWidth * 0.55);
      }
      else if (side === "right") {
        pool = candidates.filter((candidate) => candidate.x > frameWidth * 0.45);
      }

      let best = null;
      let bestScore = -Infinity;

      for (const candidate of pool) {
        let score = candidate.strength * 2.2;

        if (Number.isFinite(expected)) {
          score -= Math.abs(candidate.x - expected) / Math.max(1, margin);
        }
        else {
          const target = side === "left"
            ? frameWidth * 0.28
            : frameWidth * 0.72;

          score -= Math.abs(candidate.x - target) / frameWidth;
        }

        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      return best;
    }

    // =====================================================
    // CURVE FITTING
    // x(t) = a*t^2 + b*t + c, t: 0=xa, 1=gần robot
    // =====================================================

    solve3x3(matrix, vector) {
      const a = matrix.map((row, index) => [
        ...row.map(Number),
        Number(vector[index])
      ]);

      for (let col = 0; col < 3; col++) {
        let pivot = col;

        for (let row = col + 1; row < 3; row++) {
          if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
            pivot = row;
          }
        }

        if (Math.abs(a[pivot][col]) < 1e-9) {
          return null;
        }

        if (pivot !== col) {
          [a[pivot], a[col]] = [a[col], a[pivot]];
        }

        const divisor = a[col][col];
        for (let j = col; j < 4; j++) {
          a[col][j] /= divisor;
        }

        for (let row = 0; row < 3; row++) {
          if (row === col) {
            continue;
          }

          const factor = a[row][col];
          for (let j = col; j < 4; j++) {
            a[row][j] -= factor * a[col][j];
          }
        }
      }

      return [a[0][3], a[1][3], a[2][3]];
    }

    fitCurve(points) {
      if (!Array.isArray(points) || points.length < 2) {
        return null;
      }

      if (points.length === 2) {
        const p0 = points[0];
        const p1 = points[1];
        const dt = p1.t - p0.t;

        if (Math.abs(dt) < 1e-6) {
          return {
            a: 0,
            b: 0,
            c: (p0.x + p1.x) / 2,
            rms: 0
          };
        }

        const b = (p1.x - p0.x) / dt;
        const c = p0.x - b * p0.t;

        return { a: 0, b, c, rms: 0 };
      }

      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      let s4 = 0;
      let bx0 = 0;
      let bx1 = 0;
      let bx2 = 0;

      for (const point of points) {
        const t = point.t;
        const t2 = t * t;
        const x = point.x;

        s0 += 1;
        s1 += t;
        s2 += t2;
        s3 += t2 * t;
        s4 += t2 * t2;
        bx0 += x;
        bx1 += t * x;
        bx2 += t2 * x;
      }

      const solved = this.solve3x3(
        [
          [s4, s3, s2],
          [s3, s2, s1],
          [s2, s1, s0]
        ],
        [bx2, bx1, bx0]
      );

      if (!solved) {
        return null;
      }

      const [a, b, c] = solved;
      const curve = { a, b, c, rms: 0 };

      let squaredError = 0;
      for (const point of points) {
        const error = point.x - this.evalCurve(curve, point.t);
        squaredError += error * error;
      }

      curve.rms = Math.sqrt(squaredError / points.length);
      return curve;
    }

    fitCurveRobust(points) {
      const minPoints = Math.max(
        3,
        Number(this.config.VISION_MIN_POINTS_PER_SIDE) || 5
      );

      if (!Array.isArray(points) || points.length < minPoints) {
        return null;
      }

      let curve = this.fitCurve(points);
      if (!curve) {
        return null;
      }

      const outlierPx = Math.max(
        4,
        Number(this.config.VISION_POINT_OUTLIER_PX) || 20
      );

      const filtered = points.filter((point) => {
        const residual = Math.abs(
          point.x - this.evalCurve(curve, point.t)
        );
        return residual <= outlierPx;
      });

      if (filtered.length >= minPoints && filtered.length < points.length) {
        const refit = this.fitCurve(filtered);
        if (refit) {
          curve = refit;
        }
      }

      return {
        curve,
        points: filtered.length >= minPoints ? filtered : points
      };
    }

    evalCurve(curve, t) {
      if (!curve) {
        return NaN;
      }

      return curve.a * t * t + curve.b * t + curve.c;
    }

    curveDerivative(curve, t) {
      if (!curve) {
        return 0;
      }

      return 2 * curve.a * t + curve.b;
    }

    smoothCurve(raw, previous, alpha) {
      if (!raw) {
        return previous ? { ...previous } : null;
      }

      if (!previous) {
        return { ...raw };
      }

      const a = this.clamp(alpha, 0.01, 1);

      return {
        a: previous.a + a * (raw.a - previous.a),
        b: previous.b + a * (raw.b - previous.b),
        c: previous.c + a * (raw.c - previous.c),
        rms: raw.rms
      };
    }

    addCurves(curveA, curveB, scaleB = 1) {
      if (!curveA || !curveB) {
        return null;
      }

      return {
        a: curveA.a + curveB.a * scaleB,
        b: curveA.b + curveB.b * scaleB,
        c: curveA.c + curveB.c * scaleB,
        rms: Math.max(curveA.rms || 0, curveB.rms || 0)
      };
    }

    subtractCurves(curveA, curveB) {
      if (!curveA || !curveB) {
        return null;
      }

      return {
        a: curveA.a - curveB.a,
        b: curveA.b - curveB.b,
        c: curveA.c - curveB.c,
        rms: Math.max(curveA.rms || 0, curveB.rms || 0)
      };
    }

    averageCurves(left, right) {
      if (!left || !right) {
        return null;
      }

      return {
        a: (left.a + right.a) / 2,
        b: (left.b + right.b) / 2,
        c: (left.c + right.c) / 2,
        rms: Math.max(left.rms || 0, right.rms || 0)
      };
    }

    // =====================================================
    // LANE DETECTION V2
    // =====================================================

    detectLane(width, height) {
      const roiTopRatio = this.clamp(
        Number(this.config.VISION_ROI_TOP_RATIO) || 0.40,
        0.15,
        0.85
      );

      const roiBottomRatio = this.clamp(
        Number(this.config.VISION_ROI_BOTTOM_RATIO) || 0.97,
        roiTopRatio + 0.05,
        1
      );

      const roiTop = Math.round(height * roiTopRatio);
      const roiBottom = Math.round(height * roiBottomRatio);
      const roiHeight = Math.max(8, roiBottom - roiTop);

      const image = this.ctx.getImageData(
        0,
        roiTop,
        width,
        roiHeight
      );

      const binary = this.makeBinaryMask(
        image.data,
        width,
        roiHeight
      );

      const scanRows = Math.max(
        8,
        Math.min(24, Number(this.config.VISION_SCAN_ROWS) || 15)
      );

      const baseMargin = Math.max(
        16,
        Number(this.config.VISION_SEARCH_MARGIN_PX) || 52
      );

      const leftPoints = [];
      const rightPoints = [];
      let pairedRows = 0;
      let lastPairWidth = null;

      for (let index = 0; index < scanRows; index++) {
        // Quét từ dưới lên: t gần 1 -> gần robot; t gần 0 -> xa.
        const t = 0.96 - index * (0.88 / Math.max(1, scanRows - 1));
        const localY = Math.round(t * (roiHeight - 1));
        const globalY = roiTop + localY;

        const candidates = this.extractRuns(
          binary.mask,
          width,
          roiHeight,
          localY
        );

        if (!candidates.length) {
          continue;
        }

        const expectedLeft = this.predictX(
          leftPoints,
          this.prevLeftCurve,
          t
        );

        const expectedRight = this.predictX(
          rightPoints,
          this.prevRightCurve,
          t
        );

        let expectedWidth = null;

        if (this.prevLeftCurve && this.prevRightCurve) {
          expectedWidth =
            this.evalCurve(this.prevRightCurve, t) -
            this.evalCurve(this.prevLeftCurve, t);
        }
        else if (Number.isFinite(lastPairWidth)) {
          expectedWidth = lastPairWidth;
        }

        const margin = baseMargin * (1 + (1 - t) * 0.35);

        const pair = this.choosePair({
          candidates,
          expectedLeft,
          expectedRight,
          expectedWidth,
          margin,
          frameWidth: width
        });

        if (pair) {
          leftPoints.push({
            x: pair.left.x,
            y: globalY,
            t,
            strength: pair.left.strength
          });

          rightPoints.push({
            x: pair.right.x,
            y: globalY,
            t,
            strength: pair.right.strength
          });

          lastPairWidth = pair.width;
          pairedRows += 1;
          continue;
        }

        const left = this.chooseSingle(
          candidates,
          expectedLeft,
          margin,
          "left",
          width
        );

        const right = this.chooseSingle(
          candidates,
          expectedRight,
          margin,
          "right",
          width
        );

        if (left) {
          leftPoints.push({
            x: left.x,
            y: globalY,
            t,
            strength: left.strength
          });
        }

        if (right) {
          rightPoints.push({
            x: right.x,
            y: globalY,
            t,
            strength: right.strength
          });
        }
      }

      const leftFit = this.fitCurveRobust(leftPoints);
      const rightFit = this.fitCurveRobust(rightPoints);

      let rawLeftCurve = leftFit?.curve || null;
      let rawRightCurve = rightFit?.curve || null;

      const minPoints = Math.max(
        3,
        Number(this.config.VISION_MIN_POINTS_PER_SIDE) || 5
      );

      const leftFound =
        Boolean(rawLeftCurve) &&
        (leftFit?.points?.length || 0) >= minPoints;

      const rightFound =
        Boolean(rawRightCurve) &&
        (rightFit?.points?.length || 0) >= minPoints;

      const hasBothLines = leftFound && rightFound;

      let leftInferred = false;
      let rightInferred = false;

      // Nếu mất tạm một bên, dùng width model frame trước để giữ robot ổn định
      // trong vài frame. Confidence sẽ bị giảm nên navigation tự giảm tốc.
      if (
        leftFound &&
        !rightFound &&
        this.prevLeftCurve &&
        this.prevRightCurve
      ) {
        const previousWidthCurve = this.subtractCurves(
          this.prevRightCurve,
          this.prevLeftCurve
        );

        rawRightCurve = this.addCurves(
          rawLeftCurve,
          previousWidthCurve,
          1
        );

        rightInferred = Boolean(rawRightCurve);
      }

      if (
        rightFound &&
        !leftFound &&
        this.prevLeftCurve &&
        this.prevRightCurve
      ) {
        const previousWidthCurve = this.subtractCurves(
          this.prevRightCurve,
          this.prevLeftCurve
        );

        rawLeftCurve = this.addCurves(
          rawRightCurve,
          previousWidthCurve,
          -1
        );

        leftInferred = Boolean(rawLeftCurve);
      }

      const rawUsable = Boolean(rawLeftCurve && rawRightCurve);
      const nearT = this.clamp(
        Number(this.config.VISION_NEAR_Y_RATIO) || 0.88,
        0.55,
        0.98
      );

      const lookAheadT = this.clamp(
        Number(this.config.VISION_LOOKAHEAD_Y_RATIO) || 0.42,
        0.08,
        nearT - 0.08
      );

      const maxFitRms = Math.max(
        4,
        Number(this.config.VISION_MAX_FIT_RMS_PX) || 18
      );

      const sideConfidence = (fit, found) => {
        if (!fit?.curve || !fit?.points?.length || !found) {
          return 0;
        }

        const coverage = this.clamp(
          fit.points.length / scanRows,
          0,
          1
        );

        const fitScore = this.clamp(
          1 - (fit.curve.rms || 0) / maxFitRms,
          0,
          1
        );

        const strength = this.clamp(
          fit.points.reduce((sum, p) => sum + (p.strength || 0), 0) /
          fit.points.length,
          0,
          1
        );

        return this.clamp(
          coverage * 0.52 +
          fitScore * 0.30 +
          strength * 0.18,
          0,
          1
        );
      };

      const leftConfidence = sideConfidence(leftFit, leftFound);
      const rightConfidence = sideConfidence(rightFit, rightFound);
      const pairCoverage = this.clamp(pairedRows / scanRows, 0, 1);

      let rawNearCenter = null;
      let rawLookAheadCenter = null;
      let rawLaneWidthNear = null;

      if (rawUsable) {
        rawNearCenter = (
          this.evalCurve(rawLeftCurve, nearT) +
          this.evalCurve(rawRightCurve, nearT)
        ) / 2;

        rawLookAheadCenter = (
          this.evalCurve(rawLeftCurve, lookAheadT) +
          this.evalCurve(rawRightCurve, lookAheadT)
        ) / 2;

        rawLaneWidthNear =
          this.evalCurve(rawRightCurve, nearT) -
          this.evalCurve(rawLeftCurve, nearT);
      }

      const laneMin =
        width * (Number(this.config.VISION_LANE_WIDTH_MIN_RATIO) || 0.16);

      const laneMax =
        width * (Number(this.config.VISION_LANE_WIDTH_MAX_RATIO) || 0.88);

      const widthValid =
        Number.isFinite(rawLaneWidthNear) &&
        rawLaneWidthNear >= laneMin &&
        rawLaneWidthNear <= laneMax;

      let widthConfidence = widthValid ? 1 : 0;

      if (
        widthValid &&
        Number.isFinite(this.prevLaneWidthNear) &&
        this.prevLaneWidthNear > 1
      ) {
        const ratio = rawLaneWidthNear / this.prevLaneWidthNear;
        const logDistance = Math.abs(Math.log(Math.max(0.01, ratio)));
        widthConfidence *= Math.exp(-logDistance * 1.8);
      }

      const maxJump = Math.max(
        8,
        (Number(this.config.VISION_MAX_CENTER_JUMP_PX) || 26) *
        (width / 480)
      );

      let temporalConfidence = 1;

      if (
        Number.isFinite(rawNearCenter) &&
        Number.isFinite(this.prevControlCenter)
      ) {
        const jump = Math.abs(rawNearCenter - this.prevControlCenter);
        temporalConfidence = jump <= maxJump
          ? 1
          : this.clamp(maxJump / jump, 0.15, 1);
      }

      let laneConfidence = rawUsable
        ? this.clamp(
            ((leftConfidence + rightConfidence) / 2) * 0.40 +
            pairCoverage * 0.24 +
            widthConfidence * 0.21 +
            temporalConfidence * 0.15,
            0,
            1
          )
        : 0;

      if (leftInferred || rightInferred) {
        laneConfidence *= 0.62;
      }

      const curveAlphaBase = this.clamp(
        Number(this.config.VISION_CURVE_EMA_ALPHA) || 0.30,
        0.03,
        1
      );

      const curveAlpha = this.clamp(
        curveAlphaBase * (0.45 + laneConfidence * 0.75),
        0.06,
        0.55
      );

      const leftCurve = rawLeftCurve
        ? this.smoothCurve(rawLeftCurve, this.prevLeftCurve, curveAlpha)
        : null;

      const rightCurve = rawRightCurve
        ? this.smoothCurve(rawRightCurve, this.prevRightCurve, curveAlpha)
        : null;

      const curvesUsable = Boolean(leftCurve && rightCurve);
      const centerCurve = curvesUsable
        ? this.averageCurves(leftCurve, rightCurve)
        : null;

      let geometricNearCenter = null;
      let geometricLookAheadCenter = null;
      let laneWidthNear = null;

      if (curvesUsable) {
        geometricNearCenter = this.evalCurve(centerCurve, nearT);
        geometricLookAheadCenter = this.evalCurve(centerCurve, lookAheadT);
        laneWidthNear =
          this.evalCurve(rightCurve, nearT) -
          this.evalCurve(leftCurve, nearT);
      }

      const centerAlpha = this.clamp(
        Number(this.config.VISION_CENTER_EMA_ALPHA) || 0.20,
        0.02,
        1
      );

      let laneCenter = geometricNearCenter;
      let lookAheadCenter = geometricLookAheadCenter;

      if (Number.isFinite(geometricNearCenter)) {
        let bounded = geometricNearCenter;

        if (Number.isFinite(this.prevControlCenter)) {
          bounded = this.prevControlCenter + this.clamp(
            geometricNearCenter - this.prevControlCenter,
            -maxJump,
            maxJump
          );

          laneCenter =
            this.prevControlCenter +
            centerAlpha * (bounded - this.prevControlCenter);
        }

        this.prevControlCenter = laneCenter;
      }

      if (Number.isFinite(geometricLookAheadCenter)) {
        if (Number.isFinite(this.prevLookAheadCenter)) {
          lookAheadCenter =
            this.prevLookAheadCenter +
            centerAlpha * 1.25 *
            (geometricLookAheadCenter - this.prevLookAheadCenter);
        }

        this.prevLookAheadCenter = lookAheadCenter;
      }

      const frameCenter = width / 2;
      const rawLineError = Number.isFinite(rawNearCenter)
        ? rawNearCenter - frameCenter
        : null;

      const lineError = Number.isFinite(laneCenter)
        ? laneCenter - frameCenter
        : null;

      const nearY = roiTop + nearT * roiHeight;
      const lookAheadY = roiTop + lookAheadT * roiHeight;
      const verticalDistance = Math.max(1, nearY - lookAheadY);

      const headingErrorDeg =
        Number.isFinite(laneCenter) && Number.isFinite(lookAheadCenter)
          ? Math.atan2(
              lookAheadCenter - laneCenter,
              verticalDistance
            ) * 180 / Math.PI
          : null;

      let curvatureDeg = null;

      if (centerCurve) {
        const farT = Math.max(0.08, lookAheadT - 0.20);
        const derivativeNear = this.curveDerivative(centerCurve, nearT);
        const derivativeFar = this.curveDerivative(centerCurve, farT);

        const headingNear = Math.atan2(
          -derivativeNear,
          roiHeight
        ) * 180 / Math.PI;

        const headingFar = Math.atan2(
          -derivativeFar,
          roiHeight
        ) * 180 / Math.PI;

        curvatureDeg = headingFar - headingNear;
      }

      const minConfidence = this.clamp(
        Number(this.config.VISION_MIN_CONFIDENCE) || 0.38,
        0.05,
        0.95
      );

      const hasLane =
        curvesUsable &&
        widthValid &&
        laneConfidence >= minConfidence &&
        Number.isFinite(lineError) &&
        Number.isFinite(headingErrorDeg);

      if (hasLane) {
        this.lostFrames = 0;
        this.prevLeftCurve = { ...leftCurve };
        this.prevRightCurve = { ...rightCurve };
        this.prevLaneWidthNear = laneWidthNear;
      }
      else {
        this.lostFrames += 1;

        // Sau một khoảng mất line, bỏ model cũ để detector được phép khởi tạo lại.
        if (this.lostFrames > 12) {
          this.prevLeftCurve = null;
          this.prevRightCurve = null;
          this.prevLaneWidthNear = null;
          this.prevControlCenter = null;
          this.prevLookAheadCenter = null;
        }
      }

      const leftNearX = leftCurve
        ? this.evalCurve(leftCurve, nearT)
        : null;

      const rightNearX = rightCurve
        ? this.evalCurve(rightCurve, nearT)
        : null;

      const thresholdMean = binary.thresholds.length
        ? binary.thresholds.reduce((sum, value) => sum + value, 0) /
          binary.thresholds.length
        : 0;

      return {
        width,
        height,
        roiTop,
        roiBottom,
        roiHeight,

        leftFound,
        rightFound,
        hasBothLines,
        hasLane,
        leftInferred,
        rightInferred,

        leftX: Number.isFinite(leftNearX) ? leftNearX : null,
        rightX: Number.isFinite(rightNearX) ? rightNearX : null,
        leftPoints: leftFit?.points || [],
        rightPoints: rightFit?.points || [],
        leftCurve,
        rightCurve,
        centerCurve,

        leftConfidence,
        rightConfidence,
        laneConfidence,
        pairCoverage,

        rawLaneCenter: rawNearCenter,
        laneCenter,
        lookAheadCenter,
        frameCenter,
        rawLineError,
        lineError,
        headingErrorDeg,
        curvatureDeg,
        laneWidth: Number.isFinite(laneWidthNear) ? laneWidthNear : null,

        nearT,
        lookAheadT,
        nearY,
        lookAheadY,

        rawThresholds: binary.rawThresholds,
        thresholds: binary.thresholds,
        thresholdMean,
        darkRatio: binary.darkRatio,

        timestamp: performance.now()
      };
    }

    // =====================================================
    // DEBUG OVERLAY
    // =====================================================

    curveCanvasPoint(curve, t, lane) {
      return {
        x: this.evalCurve(curve, t),
        y: lane.roiTop + t * lane.roiHeight
      };
    }

    drawCurve(ctx, curve, lane, color, dashed = false, lineWidth = 3) {
      if (!curve) {
        return;
      }

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dashed ? [7, 5] : []);
      ctx.beginPath();

      let started = false;

      for (let step = 0; step <= 30; step++) {
        const t = 0.04 + (0.94 * step / 30);
        const point = this.curveCanvasPoint(curve, t, lane);

        if (!Number.isFinite(point.x)) {
          continue;
        }

        if (!started) {
          ctx.moveTo(point.x, point.y);
          started = true;
        } else {
          ctx.lineTo(point.x, point.y);
        }
      }

      ctx.stroke();
      ctx.restore();
    }

    drawOverlay(lane, width, height) {
      if (!this.overlayCtx) {
        return;
      }

      const ctx = this.overlayCtx;
      ctx.clearRect(0, 0, width, height);

      ctx.font = "12px system-ui, sans-serif";
      ctx.textBaseline = "top";

      // ROI.
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,.48)";
      ctx.strokeRect(
        0,
        lane.roiTop,
        width,
        lane.roiBottom - lane.roiTop
      );

      // Các điểm dark-run đã được sliding-window chọn.
      const drawPoints = (points, color) => {
        ctx.fillStyle = color;
        for (const point of points || []) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      };

      drawPoints(lane.leftPoints, "rgba(50,213,131,.75)");
      drawPoints(lane.rightPoints, "rgba(50,213,131,.75)");

      // Tô hành lang theo hai curve.
      if (lane.leftCurve && lane.rightCurve) {
        const left = [];
        const right = [];

        for (let step = 0; step <= 24; step++) {
          const t = 0.06 + (0.90 * step / 24);
          left.push(this.curveCanvasPoint(lane.leftCurve, t, lane));
          right.push(this.curveCanvasPoint(lane.rightCurve, t, lane));
        }

        ctx.fillStyle = "rgba(83,177,253,.09)";
        ctx.beginPath();
        ctx.moveTo(left[0].x, left[0].y);

        for (let i = 1; i < left.length; i++) {
          ctx.lineTo(left[i].x, left[i].y);
        }

        for (let i = right.length - 1; i >= 0; i--) {
          ctx.lineTo(right[i].x, right[i].y);
        }

        ctx.closePath();
        ctx.fill();
      }

      this.drawCurve(
        ctx,
        lane.leftCurve,
        lane,
        lane.leftInferred ? "#fdb022" : "#32d583",
        lane.leftInferred,
        3
      );

      this.drawCurve(
        ctx,
        lane.rightCurve,
        lane,
        lane.rightInferred ? "#fdb022" : "#32d583",
        lane.rightInferred,
        3
      );

      this.drawCurve(
        ctx,
        lane.centerCurve,
        lane,
        "#53b1fd",
        false,
        3
      );

      // Tâm camera.
      ctx.strokeStyle = "#fdb022";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lane.frameCenter, lane.roiTop);
      ctx.lineTo(lane.frameCenter, lane.roiBottom);
      ctx.stroke();

      // Điểm near + lookahead dùng thật cho controller.
      if (Number.isFinite(lane.laneCenter)) {
        ctx.fillStyle = "#53b1fd";
        ctx.beginPath();
        ctx.arc(lane.laneCenter, lane.nearY, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (Number.isFinite(lane.lookAheadCenter)) {
        ctx.fillStyle = "#ee46bc";
        ctx.beginPath();
        ctx.arc(
          lane.lookAheadCenter,
          lane.lookAheadY,
          6,
          0,
          Math.PI * 2
        );
        ctx.fill();

        if (Number.isFinite(lane.laneCenter)) {
          ctx.strokeStyle = "#ee46bc";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(lane.laneCenter, lane.nearY);
          ctx.lineTo(lane.lookAheadCenter, lane.lookAheadY);
          ctx.stroke();
        }
      }

      // QR gần nhất.
      const qr = this.lastQr;
      const qrCorners = qr?.overlayCorners || qr?.corners || [];

      if (
        qrCorners.length === 4 &&
        performance.now() - qr.timestamp < 900
      ) {
        ctx.strokeStyle = "#f97066";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(qrCorners[0].x, qrCorners[0].y);

        for (let i = 1; i < qrCorners.length; i++) {
          ctx.lineTo(qrCorners[i].x, qrCorners[i].y);
        }

        ctx.closePath();
        ctx.stroke();
      }

      // Debug trực tiếp trên ảnh.
      const thresholds = lane.thresholds
        .map((value) => Math.round(value))
        .join("/");

      const lines = [
        `Otsu T: ${thresholds || "-"} · dark ${(lane.darkRatio * 100).toFixed(1)}%`,
        `Conf: ${(lane.laneConfidence * 100).toFixed(0)}% · width ${lane.laneWidth != null ? lane.laneWidth.toFixed(0) : "-"}px`,
        `Err: ${lane.lineError != null ? lane.lineError.toFixed(1) : "-"}px · head ${lane.headingErrorDeg != null ? lane.headingErrorDeg.toFixed(1) : "-"}°`,
        `Curve: ${lane.curvatureDeg != null ? lane.curvatureDeg.toFixed(1) : "-"}°`
      ];

      const boxWidth = Math.min(width - 12, 260);
      const boxHeight = 10 + lines.length * 16;

      ctx.fillStyle = "rgba(2,6,23,.76)";
      ctx.fillRect(6, 6, boxWidth, boxHeight);
      ctx.fillStyle = "#ffffff";

      lines.forEach((text, index) => {
        ctx.fillText(text, 12, 11 + index * 16);
      });

      if (
        qr?.text &&
        performance.now() - qr.timestamp < 900
      ) {
        ctx.fillStyle = "rgba(2,6,23,.82)";
        ctx.fillRect(6, boxHeight + 12, Math.min(width - 12, 250), 22);
        ctx.fillStyle = "#f97066";
        ctx.fillText(
          `QR ${qr.text}: ${qr.areaPercent.toFixed(2)}%`,
          12,
          boxHeight + 16
        );
      }
    }

    // =====================================================
    // QR
    // =====================================================

    polygonArea(points) {
      if (!Array.isArray(points) || points.length < 3) {
        return 0;
      }

      let sum = 0;

      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        sum += Number(a.x) * Number(b.y) - Number(b.x) * Number(a.y);
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
        centerX = corners.reduce((sum, point) => sum + point.x, 0) /
          corners.length;
        centerY = corners.reduce((sum, point) => sum + point.y, 0) /
          corners.length;
      }

      const overlayScaleX =
        (this.canvas.width || 1) / frameWidth;

      const overlayScaleY =
        (this.canvas.height || 1) / frameHeight;

      const overlayCorners = corners.map((point) => ({
        x: point.x * overlayScaleX,
        y: point.y * overlayScaleY
      }));

      return {
        text,
        corners,
        overlayCorners,
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

        if (
          this.qrCanvas.width !== width ||
          this.qrCanvas.height !== height
        ) {
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
        }
        else if (typeof window.jsQR === "function") {
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

    clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }
  }

  window.RobotVision = RobotVision;
})();
