(function () {
  const DEFAULT_FPS = 25;
  const DEFAULT_BASE_TIMECODE = '01:00:00:00';

  class TimecodeClient {
    constructor({ fps = DEFAULT_FPS, baseTimecode = DEFAULT_BASE_TIMECODE } = {}) {
      this.anchor = null;
      this.serverOffsetMs = 0;
      this.rttMs = null;
      this.lastSegmentId = -1;
      this.connected = false;
      this.lastAnchorClientMs = 0;
      this.lastFrozenFrame = 0;
      this.hasServerOffset = false;
    }

    handleAnchor(anchor) {
      if (
        this.anchor &&
        typeof anchor.segmentId === 'number' &&
        anchor.segmentId < this.lastSegmentId
      ) {
        return;
      }

      this.anchor = anchor;
      this.lastSegmentId = Number(anchor.segmentId) || 0;
      this.lastAnchorClientMs = performance.now();
      if (!this.hasServerOffset && Number.isFinite(Number(anchor.serverNowMs))) {
        this.serverOffsetMs = Number(anchor.serverNowMs) - this.lastAnchorClientMs;
        this.hasServerOffset = true;
      }
      this.lastFrozenFrame = this.getCurrentFrame();
    }

    handleClockPong(msg) {
      const clientReceiveMs = performance.now();
      const clientSendMs = Number(msg.clientSendMs);
      if (!Number.isFinite(clientSendMs)) return;

      const rtt = clientReceiveMs - clientSendMs;
      const estimatedServerAtReceive = Number(msg.serverSendMs) + rtt / 2;
      if (!Number.isFinite(estimatedServerAtReceive)) return;

      const offset = estimatedServerAtReceive - clientReceiveMs;

      if (this.rttMs === null || rtt < this.rttMs * 1.5) {
        this.serverOffsetMs = this.hasServerOffset
          ? this.serverOffsetMs * 0.85 + offset * 0.15
          : offset;
        this.rttMs = rtt;
        this.hasServerOffset = true;
      }
    }

    getEstimatedServerNowMs() {
      return performance.now() + this.serverOffsetMs;
    }

    getCurrentFrame({ freezeDisconnected = false } = {}) {
      if (!this.anchor) return 0;
      if (freezeDisconnected && !this.connected) return this.lastFrozenFrame;

      const {
        status,
        anchorFrame,
        anchorServerTimeMs,
        fps,
        playbackRate,
        durationFrames
      } = this.anchor;

      if (status !== 'playing') {
        return anchorFrame;
      }

      const elapsedMs = this.getEstimatedServerNowMs() - anchorServerTimeMs;
      const elapsedFrames = Math.floor((elapsedMs / 1000) * fps * playbackRate);
      const frame = anchorFrame + elapsedFrames;

      return clamp(frame, 0, durationFrames);
    }

    freeze() {
      this.lastFrozenFrame = this.getCurrentFrame();
      this.connected = false;
    }

    getCurrentTimecode(options) {
      if (!this.anchor) return DEFAULT_BASE_TIMECODE;

      return framesToTimecode(
        this.getCurrentFrame(options),
        this.anchor.fps,
        this.anchor.baseTimecode
      );
    }
  }

  function timecodeToFrames(tc, fps = DEFAULT_FPS) {
    const [h, m, s, f] = String(tc || DEFAULT_BASE_TIMECODE).split(':').map(Number);
    if (![h, m, s, f].every(Number.isFinite)) return 0;
    return (((h * 60 + m) * 60 + s) * fps) + f;
  }

  function framesToTimecode(positionFrames, fps = DEFAULT_FPS, baseTimecode = DEFAULT_BASE_TIMECODE) {
    const baseFrames = timecodeToFrames(baseTimecode, fps);
    const total = Math.max(0, baseFrames + Math.max(0, Math.floor(positionFrames)));

    const frames = total % fps;
    const totalSeconds = Math.floor(total / fps);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);

    return [
      String(hours).padStart(2, '0'),
      String(minutes).padStart(2, '0'),
      String(seconds).padStart(2, '0'),
      String(frames).padStart(2, '0')
    ].join(':');
  }

  function msToFrames(ms, fps = DEFAULT_FPS) {
    return Math.floor((ms / 1000) * fps);
  }

  function framesToMs(frames, fps = DEFAULT_FPS) {
    return (frames / fps) * 1000;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  window.LiveDisplayTimecode = {
    TimecodeClient,
    clamp,
    framesToMs,
    framesToTimecode,
    msToFrames,
    timecodeToFrames
  };
})();
