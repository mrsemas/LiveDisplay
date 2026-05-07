class LtcGeneratorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fps = 25;
    this.level = dbToGain(-18);
    this.mode = 'ltc';
    this.status = 'muted';
    this.targetFrame = 25 * 60 * 60;
    this.currentFrame = this.targetFrame;
    this.sampleInFrame = 0;
    this.phase = 1;
    this.lastBitIndex = -1;
    this.lastHalf = -1;
    this.bits = encodeLtcFrame(this.currentFrame, this.fps);

    this.port.onmessage = (event) => {
      const msg = event.data || {};

      if (msg.type === 'config') {
        this.fps = Math.max(1, Number(msg.fps) || 25);
        this.level = dbToGain(Number(msg.levelDb) || -18);
        this.bits = encodeLtcFrame(this.currentFrame, this.fps);
      }

      if (msg.type === 'sync') {
        this.status = msg.status === 'playing' ? 'playing' : 'muted';
        const nextFrame = Math.max(0, Math.floor(Number(msg.frame) || 0));
        this.targetFrame = nextFrame;

        if (Math.abs(this.targetFrame - this.currentFrame) > 2 || this.status !== 'playing') {
          this.currentFrame = this.targetFrame;
          this.sampleInFrame = 0;
          this.lastBitIndex = -1;
          this.lastHalf = -1;
          this.bits = encodeLtcFrame(this.currentFrame, this.fps);
        }
      }

      if (msg.type === 'tone') this.mode = 'tone';
      if (msg.type === 'ltc') this.mode = 'ltc';
      if (msg.type === 'mute') this.status = 'muted';
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    if (this.mode === 'tone') {
      for (let i = 0; i < out.length; i++) {
        const t = (currentFrame + i) / sampleRate;
        out[i] = Math.sin(2 * Math.PI * 1000 * t) * this.level;
      }
      return true;
    }

    const samplesPerFrame = sampleRate / this.fps;
    const samplesPerBit = samplesPerFrame / 80;

    for (let i = 0; i < out.length; i++) {
      if (this.status !== 'playing') {
        out[i] = 0;
        continue;
      }

      if (this.sampleInFrame >= samplesPerFrame) {
        this.sampleInFrame -= samplesPerFrame;
        const correction = this.targetFrame - this.currentFrame;
        this.currentFrame += correction > 1 ? 2 : 1;
        if (correction < -1) this.currentFrame -= 2;
        this.bits = encodeLtcFrame(this.currentFrame, this.fps);
        this.lastBitIndex = -1;
        this.lastHalf = -1;
      }

      const bitIndex = Math.min(79, Math.floor(this.sampleInFrame / samplesPerBit));
      const bitSample = this.sampleInFrame - (bitIndex * samplesPerBit);
      const half = bitSample >= samplesPerBit / 2 ? 1 : 0;

      if (bitIndex !== this.lastBitIndex) {
        this.phase *= -1;
        this.lastBitIndex = bitIndex;
        this.lastHalf = 0;
      }

      if (this.bits[bitIndex] === 1 && half !== this.lastHalf) {
        this.phase *= -1;
        this.lastHalf = half;
      }

      out[i] = this.phase * this.level;
      this.sampleInFrame++;
    }

    return true;
  }
}

function encodeLtcFrame(frameNumber, fps) {
  const tc = frameNumberToParts(frameNumber, fps);
  const bits = new Array(80).fill(0);

  writeBcd(bits, 0, tc.frames % 10, 4);
  writeBcd(bits, 8, Math.floor(tc.frames / 10), 2);
  writeBcd(bits, 16, tc.seconds % 10, 4);
  writeBcd(bits, 24, Math.floor(tc.seconds / 10), 3);
  writeBcd(bits, 32, tc.minutes % 10, 4);
  writeBcd(bits, 40, Math.floor(tc.minutes / 10), 3);
  writeBcd(bits, 48, tc.hours % 10, 4);
  writeBcd(bits, 56, Math.floor(tc.hours / 10), 2);

  // Binary group flags are left at zero. Sync word is the LTC frame boundary marker.
  const sync = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
  for (let i = 0; i < sync.length; i++) bits[64 + i] = sync[i];

  return bits;
}

function frameNumberToParts(frameNumber, fps) {
  const safe = Math.max(0, Math.floor(frameNumber));
  const frames = safe % fps;
  const totalSeconds = Math.floor(safe / fps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60) % 24;
  return { hours, minutes, seconds, frames };
}

function writeBcd(bits, offset, value, width) {
  for (let i = 0; i < width; i++) {
    bits[offset + i] = (value >> i) & 1;
  }
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

registerProcessor('ltc-generator', LtcGeneratorProcessor);
