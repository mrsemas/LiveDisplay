const FPS = 25;
const BASE_TC = '01:00:00:00';
const BASE_FRAMES = timecodeToFrames(BASE_TC, FPS);
const DISCONNECT_MUTE_MS = 2000;

let ws = null;
let latestState = null;
let lastReceiveClientNow = 0;
let lastReceiveEpochNow = 0;
let renderedPositionFrames = 0;
let serverConnected = false;
let audioContext = null;
let ltcNode = null;
let ltcRunning = false;
let toneRunning = false;
let selectedOutputLabel = 'Default';

const els = {
  timecodeMain: document.getElementById('timecodeMain'),
  headerStatus: document.getElementById('headerStatus'),
  footerStatus: document.getElementById('footerStatus'),
  statusPill: document.getElementById('statusPill'),
  serverPill: document.getElementById('serverPill'),
  audioPill: document.getElementById('audioPill'),
  fpsValue: document.getElementById('fpsValue'),
  framesValue: document.getElementById('framesValue'),
  driftValue: document.getElementById('driftValue'),
  audioOutputLabel: document.getElementById('audioOutputLabel'),
  levelLabel: document.getElementById('levelLabel'),
  currentCue: document.getElementById('currentCue'),
  nextCue: document.getElementById('nextCue'),
  audioStatus: document.getElementById('audioStatus'),
  connectButton: document.getElementById('connectButton'),
  startAudioButton: document.getElementById('startAudioButton'),
  stopAudioButton: document.getElementById('stopAudioButton'),
  selectOutputButton: document.getElementById('selectOutputButton'),
  testToneButton: document.getElementById('testToneButton'),
  fullscreenButton: document.getElementById('fullscreenButton'),
  outputSelect: document.getElementById('outputSelect'),
  levelSelect: document.getElementById('levelSelect')
};

els.connectButton.addEventListener('click', connectSocket);
els.startAudioButton.addEventListener('click', startAudio);
els.stopAudioButton.addEventListener('click', stopAudio);
els.selectOutputButton.addEventListener('click', refreshAndSelectOutput);
els.testToneButton.addEventListener('click', toggleTestTone);
els.fullscreenButton.addEventListener('click', toggleFullscreen);
els.outputSelect.addEventListener('change', () => selectOutputDevice(els.outputSelect.value));
els.levelSelect.addEventListener('change', updateLevel);
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
updateFullscreenButton();

connectSocket();
requestAnimationFrame(renderLoop);

async function toggleFullscreen() {
  if (!isFullscreenSupported()) return;

  try {
    if (getFullscreenElement()) {
      await exitFullscreen();
    } else {
      await requestFullscreen(document.documentElement);
    }
  } catch {
    updateFullscreenButton();
  }
}

function updateFullscreenButton() {
  const supported = isFullscreenSupported();
  const isFullscreen = Boolean(getFullscreenElement());
  els.fullscreenButton.disabled = !supported;
  els.fullscreenButton.textContent = isFullscreen ? '⛶' : '⛶';
  els.fullscreenButton.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
  els.fullscreenButton.title = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
}

function isFullscreenSupported() {
  return Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled || document.documentElement.webkitRequestFullscreen);
}

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

function requestFullscreen(element) {
  if (element.requestFullscreen) return element.requestFullscreen();
  if (element.webkitRequestFullscreen) return element.webkitRequestFullscreen();
}

function exitFullscreen() {
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
}

function connectSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  els.headerStatus.textContent = 'Connecting';

  ws.addEventListener('open', () => {
    serverConnected = true;
    els.headerStatus.textContent = 'Server connected';
  });

  ws.addEventListener('close', () => {
    serverConnected = false;
    els.headerStatus.textContent = 'Server disconnected';
    setTimeout(connectSocket, 1000);
  });

  ws.addEventListener('error', () => {
    serverConnected = false;
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type !== 'timecode') return;

    latestState = msg;
    lastReceiveClientNow = performance.now();
    lastReceiveEpochNow = Date.now();
    serverConnected = true;
  });
}

function renderLoop(now) {
  const state = latestState;
  const staleMs = lastReceiveClientNow ? now - lastReceiveClientNow : Number.POSITIVE_INFINITY;
  const disconnected = !serverConnected || staleMs > DISCONNECT_MUTE_MS;
  const fps = Number(state?.fps) || FPS;

  let status = state?.status || 'waiting';
  let frames = Number(state?.positionFrames) || 0;

  if (!state) {
    status = 'waiting';
    frames = 0;
  } else if (disconnected) {
    status = 'disconnected';
    frames = renderedPositionFrames;
  } else if (status === 'playing') {
    const elapsedFrames = Math.floor((staleMs / 1000) * fps);
    frames += elapsedFrames;
  }

  renderedPositionFrames = Math.max(0, frames);
  const baseTc = state?.baseTimecode || BASE_TC;
  const timecode = framesToTimecode(renderedPositionFrames, fps, baseTc);
  const driftMs = state?.serverNow ? lastReceiveEpochNow - Number(state.serverNow) : null;

  els.timecodeMain.textContent = timecode;
  els.fpsValue.textContent = String(fps);
  els.framesValue.textContent = String(renderedPositionFrames);
  els.driftValue.textContent = Number.isFinite(driftMs) ? `${driftMs >= 0 ? '+' : ''}${Math.round(driftMs)} ms` : '-- ms';
  els.currentCue.textContent = cueLabel(state?.currentCue);
  els.nextCue.textContent = cueLabel(state?.nextCue);

  updateStatus(status, disconnected);
  syncLtc(status, disconnected, renderedPositionFrames, fps, baseTc);

  requestAnimationFrame(renderLoop);
}

function updateStatus(status, disconnected) {
  const label = disconnected ? 'disconnected' : status;
  document.body.className = label;

  els.statusPill.className = `pill ${label}`;
  els.statusPill.innerHTML = `Status: <strong>${escapeHtml(label.toUpperCase())}</strong>`;

  els.serverPill.className = `pill ${disconnected ? 'disconnected' : 'playing'}`;
  els.serverPill.innerHTML = `Server: <strong>${disconnected ? 'Disconnected' : 'Connected'}</strong>`;

  els.audioPill.className = `pill ${ltcRunning ? 'audio-on' : ''}`;
  els.audioPill.innerHTML = `LTC: <strong>${ltcRunning ? 'ON' : 'OFF'}</strong>`;

  els.footerStatus.textContent = ltcRunning
    ? `LTC output to ${selectedOutputLabel}`
    : 'Monitor only mode';
}

async function startAudio() {
  try {
    if (!audioContext) {
      audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await audioContext.audioWorklet.addModule('/ltc-worklet.js');
      ltcNode = new AudioWorkletNode(audioContext, 'ltc-generator', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      ltcNode.connect(audioContext.destination);
    }

    await audioContext.resume();
    ltcRunning = true;
    toneRunning = false;
    updateLevel();

    els.startAudioButton.disabled = true;
    els.stopAudioButton.disabled = false;
    els.testToneButton.disabled = false;
    els.audioStatus.textContent = '';
  } catch (err) {
    els.audioStatus.textContent = err.message || 'Audio could not be started.';
  }
}

async function stopAudio() {
  try {
    if (ltcNode) {
      ltcNode.port.postMessage({ type: 'mute' });
      ltcNode.disconnect();
    }
    if (audioContext) await audioContext.close();
  } catch {
    // Audio is best-effort; the monitor keeps running.
  }

  audioContext = null;
  ltcNode = null;
  ltcRunning = false;
  toneRunning = false;
  els.startAudioButton.disabled = false;
  els.stopAudioButton.disabled = true;
  els.testToneButton.disabled = true;
  els.testToneButton.textContent = 'Test Tone / LTC Check';
}

async function refreshAndSelectOutput() {
  try {
    const outputs = await listAudioOutputs();
    els.outputSelect.innerHTML = '<option value="">Audio Output Device: Default</option>';

    for (const device of outputs) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = `Audio Output Device: ${device.label || 'Output Device'}`;
      els.outputSelect.appendChild(option);
    }

    await selectOutputDevice(els.outputSelect.value);
    els.audioStatus.textContent = outputs.length ? '' : 'No output devices were exposed by the browser.';
  } catch (err) {
    els.audioStatus.textContent = err.message || 'Could not list audio output devices.';
  }
}

async function listAudioOutputs() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error('Media device enumeration is not supported in this browser.');
  }

  if (navigator.mediaDevices.getUserMedia) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === 'audiooutput');
}

async function selectOutputDevice(deviceId) {
  const option = els.outputSelect.selectedOptions[0];
  selectedOutputLabel = option ? option.textContent.replace(/^Audio Output Device:\s*/, '') : 'Default';
  els.audioOutputLabel.textContent = selectedOutputLabel;

  if (!audioContext) return;

  if (typeof audioContext.setSinkId !== 'function') {
    els.audioStatus.textContent = 'Audio output selection is not supported in this browser. Use Chrome or Edge.';
    return;
  }

  await audioContext.setSinkId(deviceId || '');
  els.audioStatus.textContent = '';
}

function toggleTestTone() {
  if (!ltcNode) return;
  toneRunning = !toneRunning;
  els.testToneButton.textContent = toneRunning ? 'Stop Test Tone' : 'Test Tone / LTC Check';
  ltcNode.port.postMessage({ type: toneRunning ? 'tone' : 'ltc' });
}

function updateLevel() {
  const levelDb = Number(els.levelSelect.value) || -18;
  els.levelLabel.textContent = `${levelDb} dBFS`;
  if (ltcNode) {
    ltcNode.port.postMessage({
      type: 'config',
      fps: FPS,
      sampleRate: audioContext?.sampleRate || 48000,
      levelDb
    });
  }
}

function syncLtc(status, disconnected, positionFrames, fps, baseTc) {
  if (!ltcNode || !ltcRunning || toneRunning) return;

  if (disconnected) {
    ltcNode.port.postMessage({ type: 'sync', status: 'muted', frame: BASE_FRAMES, fps });
    return;
  }

  ltcNode.port.postMessage({
    type: 'sync',
    status: status === 'playing' ? 'playing' : 'hold',
    frame: timecodeToFrames(baseTc, fps) + positionFrames,
    fps
  });
}

function framesToTimecode(positionFrames, fps, baseTc = BASE_TC) {
  const baseFrames = timecodeToFrames(baseTc, fps);
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

function timecodeToFrames(tc, fps = FPS) {
  const parts = String(tc || BASE_TC).split(':').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return 0;
  const [hh, mm, ss, ff] = parts;
  return (((hh * 60 + mm) * 60 + ss) * fps) + ff;
}

function cueLabel(cue) {
  if (!cue) return '--';
  const source = cue.source ? `${cue.source} ` : '';
  return `${source}${cue.name || cue.id || ''}`.trim() || '--';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
