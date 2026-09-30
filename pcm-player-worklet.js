class RobotPcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // A generous ring buffer avoids dropping audio when Gemini sends a burst.
    this.capacity = Math.max(24000, Math.floor(sampleRate * 60));
    this.buffer = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;

    // Small prebuffer absorbs network/main-thread jitter without adding much latency.
    this.startThreshold = Math.max(256, Math.floor(sampleRate * 0.08));
    this.started = false;

    this.lastSample = 0;
    this.fadeRemaining = 0;
    this.fadeTotal = Math.max(32, Math.floor(sampleRate * 0.004));
    this.fadeStart = 0;

    this.port.onmessage = (event) => {
      const data = event.data;

      if (!data) return;

      if (data.type === "flush") {
        this.readIndex = this.writeIndex;
        this.available = 0;
        this.started = false;
        this.fadeStart = this.lastSample;
        this.fadeRemaining = this.fadeTotal;
        return;
      }

      if (data.type !== "push" || !(data.buffer instanceof ArrayBuffer)) {
        return;
      }

      const inputRate = Number(data.inputRate) || 24000;
      this.pushPcm16(data.buffer, inputRate);
    };
  }

  readInt16LE(view, sampleIndex) {
    return view.getInt16(sampleIndex * 2, true) / 32768;
  }

  writeSample(value) {
    if (this.available >= this.capacity) {
      // Keep the newest audio if a pathological burst fills the whole ring.
      this.readIndex = (this.readIndex + 1) % this.capacity;
      this.available--;
    }

    this.buffer[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.available++;
  }

  pushPcm16(arrayBuffer, inputRate) {
    const evenBytes = arrayBuffer.byteLength - (arrayBuffer.byteLength % 2);
    if (evenBytes <= 0) return;

    const view = new DataView(arrayBuffer, 0, evenBytes);
    const inputSamples = evenBytes / 2;

    if (inputRate === sampleRate) {
      for (let i = 0; i < inputSamples; i++) {
        this.writeSample(this.readInt16LE(view, i));
      }
      return;
    }

    // Linear resampling only runs on devices that ignore the requested 24 kHz
    // AudioContext sample rate. This keeps playback pitch/speed correct.
    const outputSamples = Math.max(
      1,
      Math.floor(inputSamples * sampleRate / inputRate)
    );
    const step = inputRate / sampleRate;

    for (let i = 0; i < outputSamples; i++) {
      const sourcePos = i * step;
      const i0 = Math.min(inputSamples - 1, Math.floor(sourcePos));
      const i1 = Math.min(inputSamples - 1, i0 + 1);
      const frac = sourcePos - i0;
      const a = this.readInt16LE(view, i0);
      const b = this.readInt16LE(view, i1);
      this.writeSample(a + (b - a) * frac);
    }
  }

  nextSample() {
    if (!this.started) {
      if (this.available < this.startThreshold) {
        if (this.fadeRemaining > 0) {
          const t = this.fadeRemaining / this.fadeTotal;
          this.fadeRemaining--;
          this.lastSample = this.fadeStart * t;
          return this.lastSample;
        }

        this.lastSample = 0;
        return 0;
      }

      this.started = true;
      this.fadeRemaining = 0;
    }

    if (this.available <= 0) {
      // Gracefully ramp to zero on an underrun/end instead of creating a click.
      this.started = false;
      this.fadeStart = this.lastSample;
      this.fadeRemaining = this.fadeTotal;
      return this.nextSample();
    }

    const value = this.buffer[this.readIndex];
    this.readIndex = (this.readIndex + 1) % this.capacity;
    this.available--;
    this.lastSample = value;
    return value;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const mono = output[0];
    for (let i = 0; i < mono.length; i++) {
      mono[i] = this.nextSample();
    }

    // Mirror mono into any extra output channels.
    for (let channel = 1; channel < output.length; channel++) {
      output[channel].set(mono);
    }

    return true;
  }
}

registerProcessor("robot-pcm-player", RobotPcmPlayerProcessor);
