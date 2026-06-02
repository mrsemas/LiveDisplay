const DEFAULT_FPS = 25;
const DEFAULT_BASE_TIMECODE = '01:00:00:00';

const { timecodeToFrames } = window.LiveDisplayTimecode;

export class MtcOutput {
  constructor({ getCurrentFrame, getStatus, fps = DEFAULT_FPS, baseTimecode = DEFAULT_BASE_TIMECODE }) {
    if (fps !== 25) {
      throw new Error('Only 25 fps MTC is supported in this version');
    }

    this.getCurrentFrame = getCurrentFrame;
    this.getStatus = getStatus;
    this.fps = fps;
    this.baseTimecode = baseTimecode;

    this.output = null;
    this.enabled = false;
    this.timer = null;

    this.lastQuarterFrameIndex = 0;
    this.lastSentFrame = null;
    this.lastSentTimecode = null;
    this.lastSendTimestamp = null;
    this.lastSegmentId = null;
    this.sentQuarterFrames = 0;
    this.suppressedMessages = 0;
    this.lastError = '';
  }

  setOutput(output) {
    this.output = output || null;
    if (!this.output) this.stop();
  }

  start() {
    if (!this.output) {
      throw new Error('No MIDI output selected');
    }

    this.enabled = true;
    this.lastError = '';
    this.startLoop();
  }

  stop() {
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  startLoop() {
    if (this.timer) clearInterval(this.timer);

    const intervalMs = 1000 / (this.fps * 8);
    this.timer = setInterval(() => {
      this.tick();
    }, intervalMs);
  }

  tick() {
    if (!this.enabled || !this.output) return;

    const status = this.getStatus();
    if (status === 'stopped' || status === 'waiting' || status === 'disconnected') {
      this.resetPosition();
      this.suppressedMessages += 1;
      return;
    }

    if (status !== 'playing') {
      this.suppressedMessages += 1;
      return;
    }

    const currentFrame = Math.max(0, Math.floor(Number(this.getCurrentFrame()) || 0));
    const tc = frameToTcParts(currentFrame, this.fps, this.baseTimecode);
    const messages = buildMtcQuarterFrameMessages({ ...tc, fps: this.fps });
    const message = messages[this.lastQuarterFrameIndex];

    try {
      this.output.send(message);
      this.lastQuarterFrameIndex = (this.lastQuarterFrameIndex + 1) % 8;
      this.lastSentFrame = currentFrame;
      this.lastSentTimecode = formatTcParts(tc);
      this.lastSendTimestamp = performance.now();
      this.sentQuarterFrames += 1;
      this.lastError = '';
    } catch (err) {
      this.lastError = err?.message || 'MIDI send failed';
      this.stop();
    }
  }

  handleSegmentChange(segmentId) {
    const nextSegmentId = Number(segmentId);
    if (!Number.isFinite(nextSegmentId)) return;

    if (nextSegmentId !== this.lastSegmentId) {
      this.lastSegmentId = nextSegmentId;
      this.resetPosition();
    }
  }

  resetPosition() {
    this.lastQuarterFrameIndex = 0;
    this.lastSentFrame = null;
    this.lastSentTimecode = null;
  }
}

export function frameToTcParts(positionFrame, fps, baseTimecode = DEFAULT_BASE_TIMECODE) {
  if (fps !== 25) {
    throw new Error('Only 25 fps MTC is supported in this version');
  }

  const baseFrames = timecodeToFrames(baseTimecode, fps);
  const totalFrames = Math.max(0, baseFrames + Math.max(0, Math.floor(Number(positionFrame) || 0)));

  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;

  return { hours, minutes, seconds, frames };
}

export function buildMtcQuarterFrameMessages({ hours, minutes, seconds, frames, fps }) {
  const rateCode = getMtcRateCode(fps);

  return [
    [0xF1, (0 << 4) | (frames & 0x0F)],
    [0xF1, (1 << 4) | ((frames >> 4) & 0x01)],
    [0xF1, (2 << 4) | (seconds & 0x0F)],
    [0xF1, (3 << 4) | ((seconds >> 4) & 0x03)],
    [0xF1, (4 << 4) | (minutes & 0x0F)],
    [0xF1, (5 << 4) | ((minutes >> 4) & 0x03)],
    [0xF1, (6 << 4) | (hours & 0x0F)],
    [0xF1, (7 << 4) | ((rateCode << 1) | ((hours >> 4) & 0x01))]
  ];
}

export function getMtcRateCode(fps) {
  if (fps !== 25) {
    throw new Error('Only 25 fps MTC is supported in this version');
  }

  return 0b01;
}

function formatTcParts({ hours, minutes, seconds, frames }) {
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
    String(frames).padStart(2, '0')
  ].join(':');
}
