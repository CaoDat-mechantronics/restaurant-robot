class RobotAudio {
  constructor({ onLevel = () => {}, onError = () => {} } = {}) {
    this.onLevel = onLevel;
    this.onError = onError;

    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.zero = null;

    this.outCtx = null;
    this.outNode = null;
    this.outReady = null;

    // Legacy fallback for browsers without AudioWorklet.
    this.outCursor = 0;
    this.outSources = new Set();

    // Prevent stale async mic/play operations from becoming active after stop.
    this.captureEpoch = 0;
    this.playEpoch = 0;
  }

  static createOutputContext() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error("Trình duyệt không hỗ trợ Web Audio.");

    if (RobotAudio.outputContext && RobotAudio.outputContext.state !== "closed") {
      return RobotAudio.outputContext;
    }

    // Keep the browser/device native output sample rate, exactly as the stable
    // version did. Forcing a 24 kHz AudioContext before getUserMedia can change
    // the browser audio session / echo-cancellation path on some systems.
    // The worklet resamples Gemini's 24 kHz PCM to this native rate itself.
    RobotAudio.outputContext = new Context();
    return RobotAudio.outputContext;
  }

  async ensureOutput() {
    if (this.outNode && this.outCtx && this.outCtx.state !== "closed") {
      if (this.outCtx.state === "suspended") await this.outCtx.resume();
      return true;
    }

    if (this.outReady) return this.outReady;

    this.outReady = (async () => {
      const ctx = RobotAudio.createOutputContext();
      this.outCtx = ctx;

      if (ctx.state === "suspended") await ctx.resume();

      if (!ctx.audioWorklet || typeof AudioWorkletNode === "undefined") {
        this.outCursor = ctx.currentTime;
        return false;
      }

      if (!ctx.__robotPcmWorkletModule) {
        ctx.__robotPcmWorkletModule = ctx.audioWorklet
          .addModule("pcm-player-worklet.js?v=20260930-worklet-2")
          .catch((error) => {
            // Allow legacy fallback when AudioWorklet cannot load (for example file://).
            ctx.__robotPcmWorkletModule = null;
            throw error;
          });
      }

      try {
        await ctx.__robotPcmWorkletModule;
      } catch (error) {
        this.onError(error);
        this.outCursor = ctx.currentTime;
        return false;
      }

      this.outNode = new AudioWorkletNode(ctx, "robot-pcm-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      this.outNode.connect(ctx.destination);
      return true;
    })().finally(() => {
      this.outReady = null;
    });

    return this.outReady;
  }

  async start(onChunk) {
    if (this.stream) return;

    const epoch = ++this.captureEpoch;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    if (epoch !== this.captureEpoch) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    this.stream = stream;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.zero = this.ctx.createGain();
    this.zero.gain.value = 0;

    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (const value of input) sum += value * value;
      this.onLevel(Math.sqrt(sum / input.length));
      onChunk(this.resample(input, this.ctx.sampleRate, 16000));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.zero);
    this.zero.connect(this.ctx.destination);
  }

  stop() {
    this.captureEpoch++;

    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.zero?.disconnect();
      this.stream?.getTracks().forEach((track) => track.stop());
      this.ctx?.close();
    } catch (error) {
      this.onError(error);
    }

    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.zero = null;
    this.onLevel(0);
  }

  resample(input, inRate, outRate) {
    const ratio = inRate / outRate;
    const length = Math.max(1, Math.round(input.length / ratio));
    const output = new Int16Array(length);

    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;

      for (let j = start; j < end; j++) {
        sum += input[j];
        count++;
      }

      const sample = Math.max(
        -1,
        Math.min(1, count ? sum / count : input[Math.min(start, input.length - 1)])
      );

      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    return output.buffer;
  }

  toB64(buffer) {
    const bytes = new Uint8Array(buffer);
    let result = "";

    for (let i = 0; i < bytes.length; i += 0x8000) {
      result += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    return btoa(result);
  }

  decodeBase64(base64) {
    const raw = atob(base64);
    const evenLength = raw.length - (raw.length % 2);
    const bytes = new Uint8Array(evenLength);
    for (let i = 0; i < evenLength; i++) bytes[i] = raw.charCodeAt(i);
    return bytes.buffer;
  }

  async play(base64, mimeType = "audio/pcm;rate=24000") {
    const epoch = this.playEpoch;
    const match = /rate=(\d+)/.exec(mimeType || "");
    const rate = match ? Number(match[1]) : 24000;
    const arrayBuffer = this.decodeBase64(base64);
    if (!arrayBuffer.byteLength) return;

    const workletReady = await this.ensureOutput();

    // If an interruption happened while AudioContext/worklet setup was pending,
    // discard this stale chunk.
    if (epoch !== this.playEpoch) return;

    if (workletReady && this.outNode) {
      this.outNode.port.postMessage(
        { type: "push", buffer: arrayBuffer, inputRate: rate },
        [arrayBuffer]
      );
      return;
    }

    // Fallback: old scheduling path for browsers without AudioWorklet.
    const ctx = this.outCtx || RobotAudio.createOutputContext();
    this.outCtx = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    if (epoch !== this.playEpoch) return;

    const view = new DataView(arrayBuffer);
    const sampleCount = Math.floor(arrayBuffer.byteLength / 2);
    const floats = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      floats[i] = view.getInt16(i * 2, true) / 32768;
    }

    const buffer = ctx.createBuffer(1, floats.length, rate);
    buffer.copyToChannel(floats, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const minimumLead = 0.12;
    const startAt = Math.max(ctx.currentTime + minimumLead, this.outCursor);
    source.start(startAt);
    this.outCursor = startAt + buffer.duration;

    this.outSources.add(source);
    source.onended = () => this.outSources.delete(source);
  }

  stopPlayback() {
    this.playEpoch++;

    if (this.outNode) {
      // The worklet performs a short ramp to zero to avoid a click on interruption.
      this.outNode.port.postMessage({ type: "flush" });
    }

    for (const source of this.outSources) {
      try { source.stop(); } catch (_) {}
    }

    this.outSources.clear();
    if (this.outCtx) this.outCursor = this.outCtx.currentTime;
  }
}

window.RobotAudio = RobotAudio;

// Unlock speaker output during a real user gesture. This is important on mobile
// browsers and does not change Gemini's VAD or session behavior.
RobotAudio.unlock = async function () {
  const ctx = RobotAudio.createOutputContext();
  if (ctx.state === "suspended") await ctx.resume();
};
