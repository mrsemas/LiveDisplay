const DEFAULT_FPS = 25;
const DEFAULT_BASE_TIMECODE = '01:00:00:00';

const timecodeState = {
  fps: DEFAULT_FPS,
  dropFrame: false,
  baseTimecode: DEFAULT_BASE_TIMECODE,

  status: 'stopped',
  playbackRate: 0,

  anchorFrame: 0,
  anchorServerTimeMs: Date.now(),

  segmentId: 0,

  durationFrames: 0,
  showId: null,
  timelineId: null
};

function getServerNowMs() {
  return Date.now();
}

function getCurrentFrame(nowMs = getServerNowMs()) {
  if (timecodeState.status !== 'playing') {
    return timecodeState.anchorFrame;
  }

  const elapsedMs = nowMs - timecodeState.anchorServerTimeMs;
  const elapsedFrames = Math.floor(
    (elapsedMs / 1000) * timecodeState.fps * timecodeState.playbackRate
  );

  const frame = timecodeState.anchorFrame + elapsedFrames;
  return clamp(frame, 0, timecodeState.durationFrames);
}

function play() {
  const now = getServerNowMs();
  const currentFrame = getCurrentFrame(now);

  timecodeState.status = 'playing';
  timecodeState.playbackRate = 1;
  timecodeState.anchorFrame = currentFrame;
  timecodeState.anchorServerTimeMs = now;
  timecodeState.segmentId += 1;

  return getAnchorPayload();
}

function pause() {
  const now = getServerNowMs();
  const currentFrame = getCurrentFrame(now);

  timecodeState.status = 'paused';
  timecodeState.playbackRate = 0;
  timecodeState.anchorFrame = currentFrame;
  timecodeState.anchorServerTimeMs = now;
  timecodeState.segmentId += 1;

  return getAnchorPayload();
}

function stop() {
  const now = getServerNowMs();

  timecodeState.status = 'stopped';
  timecodeState.playbackRate = 0;
  timecodeState.anchorFrame = 0;
  timecodeState.anchorServerTimeMs = now;
  timecodeState.segmentId += 1;

  return getAnchorPayload();
}

function seek(frame) {
  const now = getServerNowMs();

  timecodeState.anchorFrame = clamp(frame, 0, timecodeState.durationFrames);
  timecodeState.anchorServerTimeMs = now;
  timecodeState.playbackRate = timecodeState.status === 'playing' ? 1 : 0;
  timecodeState.segmentId += 1;

  return getAnchorPayload();
}

function reset() {
  return seek(0);
}

function setDurationFrames(durationFrames) {
  const next = Math.max(0, Math.floor(Number(durationFrames) || 0));
  const current = getCurrentFrame();
  const changed = next !== timecodeState.durationFrames;

  timecodeState.durationFrames = next;
  timecodeState.anchorFrame = clamp(current, 0, next);
  timecodeState.anchorServerTimeMs = getServerNowMs();

  if (changed) timecodeState.segmentId += 1;
  return getAnchorPayload();
}

function setTimelineContext({ showId = null, timelineId = null, durationFrames = timecodeState.durationFrames } = {}) {
  const nextDurationFrames = Math.max(0, Math.floor(Number(durationFrames) || 0));
  const changed =
    showId !== timecodeState.showId ||
    timelineId !== timecodeState.timelineId ||
    nextDurationFrames !== timecodeState.durationFrames;

  const current = getCurrentFrame();
  timecodeState.showId = showId;
  timecodeState.timelineId = timelineId;
  timecodeState.durationFrames = nextDurationFrames;
  timecodeState.anchorFrame = clamp(current, 0, nextDurationFrames);
  timecodeState.anchorServerTimeMs = getServerNowMs();

  if (changed) timecodeState.segmentId += 1;
  return getAnchorPayload();
}

function configure({ fps, dropFrame, baseTimecode } = {}) {
  let changed = false;

  if (Number.isFinite(Number(fps)) && Number(fps) > 0 && Number(fps) !== timecodeState.fps) {
    timecodeState.fps = Number(fps);
    changed = true;
  }

  if (typeof dropFrame === 'boolean' && dropFrame !== timecodeState.dropFrame) {
    timecodeState.dropFrame = dropFrame;
    changed = true;
  }

  if (typeof baseTimecode === 'string' && baseTimecode && baseTimecode !== timecodeState.baseTimecode) {
    timecodeState.baseTimecode = baseTimecode;
    changed = true;
  }

  if (changed) {
    timecodeState.anchorFrame = getCurrentFrame();
    timecodeState.anchorServerTimeMs = getServerNowMs();
    timecodeState.segmentId += 1;
  }

  return getAnchorPayload();
}

function getAnchorPayload() {
  const now = getServerNowMs();
  const currentFrame = getCurrentFrame(now);

  return {
    type: 'timecode-anchor',

    segmentId: timecodeState.segmentId,

    status: timecodeState.status,
    fps: timecodeState.fps,
    dropFrame: timecodeState.dropFrame,

    baseTimecode: timecodeState.baseTimecode,

    anchorFrame: timecodeState.anchorFrame,
    anchorTimecode: framesToTimecode(
      timecodeState.anchorFrame,
      timecodeState.fps,
      timecodeState.baseTimecode
    ),

    currentFrame,
    currentTimecode: framesToTimecode(
      currentFrame,
      timecodeState.fps,
      timecodeState.baseTimecode
    ),

    anchorServerTimeMs: timecodeState.anchorServerTimeMs,
    serverNowMs: now,

    playbackRate: timecodeState.playbackRate,

    durationFrames: timecodeState.durationFrames,
    durationTimecode: framesToTimecode(
      timecodeState.durationFrames,
      timecodeState.fps,
      '00:00:00:00'
    ),

    showId: timecodeState.showId,
    timelineId: timecodeState.timelineId
  };
}

function getState() {
  return { ...timecodeState };
}

function timecodeToFrames(tc, fps = DEFAULT_FPS) {
  const [h, m, s, f] = String(tc || '00:00:00:00').split(':').map(Number);
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export {
  DEFAULT_BASE_TIMECODE,
  DEFAULT_FPS,
  configure,
  framesToMs,
  framesToTimecode,
  getAnchorPayload,
  getCurrentFrame,
  getServerNowMs,
  getState,
  msToFrames,
  pause,
  play,
  reset,
  seek,
  setDurationFrames,
  setTimelineContext,
  stop,
  timecodeToFrames
};
