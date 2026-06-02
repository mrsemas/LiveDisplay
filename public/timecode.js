import { MtcOutput } from './mtc-output.js';

const FPS = 25;
const BASE_TC = '01:00:00:00';
const { TimecodeClient, framesToTimecode, timecodeToFrames } = window.LiveDisplayTimecode;
const BASE_FRAMES = timecodeToFrames(BASE_TC, FPS);
const DISCONNECT_MUTE_MS = 2000;

let ws = null;
let timecodeClient = new TimecodeClient({ fps: FPS, baseTimecode: BASE_TC });
let latestCueState = null;
let lastReceiveClientNow = 0;
let renderedPositionFrames = 0;
let serverConnected = false;
let clockPingTimer = null;
let audioContext = null;
let ltcNode = null;
let ltcRunning = false;
let toneRunning = false;
let selectedOutputLabel = 'Default';
let midiAccess = null;
let selectedMidiOutput = null;
let midiDevices = [];
let midiStatus = 'OFF';
let midiRequested = false;

const mtcOutput = new MtcOutput({
  fps: FPS,
  baseTimecode: BASE_TC,
  getCurrentFrame: () => timecodeClient.getCurrentFrame({ freezeDisconnected: isTimecodeDisconnected() }),
  getStatus: () => getMidiPlaybackStatus()
});

const els = {
  timecodeMain: document.getElementById('timecodeMain'),
  headerStatus: document.getElementById('headerStatus'),
  footerStatus: document.getElementById('footerStatus'),
  statusPill: document.getElementById('statusPill'),
  serverPill: document.getElementById('serverPill'),
  audioPill: document.getElementById('audioPill'),
  fpsValue: document.getElementById('fpsValue'),
  segmentValue: document.getElementById('segmentValue'),
  framesValue: document.getElementById('framesValue'),
  rttValue: document.getElementById('rttValue'),
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
  levelSelect: document.getElementById('levelSelect'),
  enableMidiButton: document.getElementById('enableMidiButton'),
  disableMidiButton: document.getElementById('disableMidiButton'),
  refreshMidiButton: document.getElementById('refreshMidiButton'),
  midiOutputSelect: document.getElementById('midiOutputSelect'),
  midiFpsValue: document.getElementById('midiFpsValue'),
  midiStatusValue: document.getElementById('midiStatusValue'),
  midiLastSentValue: document.getElementById('midiLastSentValue'),
  midiDeviceValue: document.getElementById('midiDeviceValue'),
  midiRateValue: document.getElementById('midiRateValue'),
  midiTimestampValue: document.getElementById('midiTimestampValue'),
  midiSegmentValue: document.getElementById('midiSegmentValue'),
  midiFrameValue: document.getElementById('midiFrameValue'),
  midiRttValue: document.getElementById('midiRttValue'),
  midiSuppressedValue: document.getElementById('midiSuppressedValue'),
  midiError: document.getElementById('midiError')
};

els.connectButton.addEventListener('click', connectSocket);
els.startAudioButton.addEventListener('click', startAudio);
els.stopAudioButton.addEventListener('click', stopAudio);
els.selectOutputButton.addEventListener('click', refreshAndSelectOutput);
els.testToneButton.addEventListener('click', toggleTestTone);
els.fullscreenButton.addEventListener('click', toggleFullscreen);
els.outputSelect.addEventListener('change', () => selectOutputDevice(els.outputSelect.value));
els.levelSelect.addEventListener('change', updateLevel);
els.enableMidiButton.addEventListener('click', enableMidi);
els.disableMidiButton.addEventListener('click', disableMidi);
els.refreshMidiButton.addEventListener('click', refreshMidiOutputs);
els.midiOutputSelect.addEventListener('change', () => selectMidiOutput(els.midiOutputSelect.value));
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
updateFullscreenButton();
initializeMidiUi();

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
    timecodeClient.connected = true;
    els.headerStatus.textContent = 'Server connected';
    sendClockPing();
    clearInterval(clockPingTimer);
    clockPingTimer = setInterval(sendClockPing, 2000);
  });

  ws.addEventListener('close', () => {
    serverConnected = false;
    timecodeClient.freeze();
    clearInterval(clockPingTimer);
    els.headerStatus.textContent = 'Server disconnected';
    setTimeout(connectSocket, 1000);
  });

  ws.addEventListener('error', () => {
    serverConnected = false;
    timecodeClient.freeze();
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'clock-pong') {
      timecodeClient.handleClockPong(msg);
      return;
    }

    if (msg.type === 'timecode-anchor') {
      timecodeClient.handleAnchor(msg);
      mtcOutput.baseTimecode = msg.baseTimecode || BASE_TC;
      mtcOutput.handleSegmentChange(msg.segmentId);
      lastReceiveClientNow = performance.now();
      serverConnected = true;
      timecodeClient.connected = true;
      return;
    }

    if (msg.type === 'timecode') {
      latestCueState = msg;
      lastReceiveClientNow = performance.now();
      serverConnected = true;
    }
  });
}

function sendClockPing() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'clock-ping',
      clientSendMs: performance.now()
    }));
  }
}

function renderLoop(now) {
  const anchor = timecodeClient.anchor;
  const staleMs = lastReceiveClientNow ? now - lastReceiveClientNow : Number.POSITIVE_INFINITY;
  const disconnected = !serverConnected || staleMs > DISCONNECT_MUTE_MS;
  if (disconnected && timecodeClient.connected) timecodeClient.freeze();

  const fps = Number(anchor?.fps) || FPS;
  let status = anchor?.status || 'waiting';
  let frames = timecodeClient.getCurrentFrame({ freezeDisconnected: disconnected });

  if (!anchor) {
    status = 'waiting';
    frames = 0;
  } else if (disconnected) {
    status = 'disconnected';
    frames = timecodeClient.lastFrozenFrame;
  }

  renderedPositionFrames = Math.max(0, frames);
  const baseTc = anchor?.baseTimecode || BASE_TC;
  const timecode = framesToTimecode(renderedPositionFrames, fps, baseTc);
  const serverCurrentFrame = Number(anchor?.currentFrame);
  const driftFrames = Number.isFinite(serverCurrentFrame) ? renderedPositionFrames - serverCurrentFrame : null;

  els.timecodeMain.textContent = timecode;
  els.fpsValue.textContent = String(fps);
  els.segmentValue.textContent = String(anchor?.segmentId ?? 0);
  els.framesValue.textContent = String(renderedPositionFrames);
  els.rttValue.textContent = Number.isFinite(timecodeClient.rttMs) ? `${Math.round(timecodeClient.rttMs)} ms` : '-- ms';
  els.driftValue.textContent = Number.isFinite(driftFrames)
    ? `${driftFrames >= 0 ? '+' : ''}${driftFrames} fr / ${Math.round(timecodeClient.serverOffsetMs)} ms`
    : '--';
  els.currentCue.textContent = cueLabel(latestCueState?.currentCue);
  els.nextCue.textContent = cueLabel(latestCueState?.nextCue);

  updateStatus(status, disconnected);
  syncLtc(anchor, status, disconnected, renderedPositionFrames, fps, baseTc);
  updateMidiStatus(status, disconnected);

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

function syncLtc(anchor, status, disconnected, positionFrames, fps, baseTc) {
  if (!ltcNode || !ltcRunning || toneRunning) return;

  if (disconnected) {
    ltcNode.port.postMessage({ type: 'sync', status: 'muted', targetFrame: BASE_FRAMES, fps });
    return;
  }

  ltcNode.port.postMessage({
    type: 'sync',
    segmentId: anchor?.segmentId ?? 0,
    status: status === 'playing' ? 'playing' : 'hold',
    fps,
    targetFrame: timecodeToFrames(baseTc, fps) + positionFrames,
    targetServerTimeMs: anchor?.serverNowMs || 0,
    serverOffsetMs: timecodeClient.serverOffsetMs,
    playbackRate: anchor?.playbackRate ?? 0
  });
}

async function enableMidi() {
  try {
    clearMidiError();
    midiRequested = true;

    if (!navigator.requestMIDIAccess) {
      throw new Error('Web MIDI is not supported in this browser. Use Chrome or Edge.');
    }

    if (!midiAccess) {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.onstatechange = () => {
        refreshMidiOutputs();
      };
    }

    refreshMidiOutputs();

    if (!selectedMidiOutput && midiDevices.length === 1) {
      selectMidiOutput(midiDevices[0].id);
    }

    if (!selectedMidiOutput) {
      midiStatus = 'NO DEVICE';
      throw new Error('No MIDI output selected.');
    }

    mtcOutput.setOutput(selectedMidiOutput);
    mtcOutput.start();
    midiStatus = 'RUNNING';
    els.enableMidiButton.disabled = true;
    els.disableMidiButton.disabled = false;
  } catch (err) {
    const message = err.message || 'MIDI could not be enabled.';
    midiStatus = message === 'No MIDI output selected.' ? 'NO DEVICE' : 'ERROR';
    showMidiError(err.message || 'MIDI could not be enabled.');
  }

  updateMidiStatus();
}

function disableMidi() {
  mtcOutput.stop();
  mtcOutput.lastError = '';
  midiRequested = false;
  midiStatus = 'OFF';
  els.enableMidiButton.disabled = false;
  els.disableMidiButton.disabled = true;
  clearMidiError();
  updateMidiStatus();
}

function getMidiOutputs() {
  if (!midiAccess) return [];

  return Array.from(midiAccess.outputs.values()).map(output => ({
    id: output.id,
    name: output.name,
    manufacturer: output.manufacturer,
    state: output.state,
    connection: output.connection,
    output
  }));
}

function refreshMidiOutputs() {
  if (!navigator.requestMIDIAccess) {
    midiStatus = 'ERROR';
    showMidiError('Web MIDI is not supported in this browser. Use Chrome or Edge.');
    updateMidiStatus();
    return;
  }

  if (!midiAccess) {
    showMidiError('Enable MIDI before refreshing devices.');
    updateMidiStatus();
    return;
  }

  clearMidiError();
  midiDevices = getMidiOutputs();

  const previousSelection = els.midiOutputSelect.value || selectedMidiOutput?.id || '';
  els.midiOutputSelect.innerHTML = '<option value="">MIDI Output Device: None</option>';

  for (const device of midiDevices) {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = `MIDI Output Device: ${formatMidiDeviceName(device)}`;
    els.midiOutputSelect.appendChild(option);
  }

  els.midiOutputSelect.disabled = !midiAccess || midiDevices.length === 0;

  if (previousSelection && midiAccess?.outputs.has(previousSelection)) {
    els.midiOutputSelect.value = previousSelection;
    selectMidiOutput(previousSelection, { silent: true });
  } else if (selectedMidiOutput) {
    selectedMidiOutput = null;
    mtcOutput.setOutput(null);
    midiStatus = mtcOutput.enabled ? 'NO DEVICE' : 'OFF';
    showMidiError('Selected MIDI output disconnected.');
  } else if (midiAccess && midiDevices.length === 0) {
    midiStatus = mtcOutput.enabled ? 'NO DEVICE' : midiStatus;
    showMidiError('No MIDI output devices found.');
  }

  updateMidiStatus();
}

function selectMidiOutput(outputId, { silent = false } = {}) {
  try {
    if (!midiAccess) {
      throw new Error('MIDI access not enabled.');
    }

    selectedMidiOutput = outputId ? midiAccess.outputs.get(outputId) : null;
    if (outputId && !selectedMidiOutput) {
      throw new Error('Selected MIDI output not found.');
    }

    mtcOutput.setOutput(selectedMidiOutput);
    if (selectedMidiOutput && mtcOutput.enabled) {
      mtcOutput.start();
      midiStatus = 'RUNNING';
    } else if (!selectedMidiOutput && mtcOutput.enabled) {
      midiStatus = 'NO DEVICE';
    }

    if (!silent) clearMidiError();
  } catch (err) {
    midiStatus = 'ERROR';
    if (!silent) showMidiError(err.message || 'Could not select MIDI output.');
  }

  updateMidiStatus();
}

function updateMidiStatus(renderStatus, disconnected) {
  const playbackStatus = renderStatus || getMidiPlaybackStatus();
  const deviceConnected = selectedMidiOutput && selectedMidiOutput.state !== 'disconnected';

  if (mtcOutput.lastError) {
    midiStatus = 'ERROR';
    showMidiError(mtcOutput.lastError);
  } else if (midiStatus === 'ERROR' && !mtcOutput.enabled) {
    midiStatus = 'ERROR';
  } else if (midiRequested && !deviceConnected) {
    midiStatus = 'NO DEVICE';
  } else if (!mtcOutput.enabled) {
    midiStatus = 'OFF';
  } else if (disconnected || playbackStatus === 'disconnected') {
    midiStatus = 'PAUSED';
  } else if (playbackStatus === 'playing') {
    midiStatus = 'RUNNING';
  } else {
    midiStatus = 'PAUSED';
  }

  els.midiStatusValue.textContent = midiStatus;
  els.midiLastSentValue.textContent = mtcOutput.lastSentTimecode || '--';
  els.midiDeviceValue.textContent = selectedMidiOutput?.name || selectedMidiOutput?.manufacturer || 'None';
  els.midiRateValue.textContent = `${FPS * 8}/s`;
  els.midiTimestampValue.textContent = Number.isFinite(mtcOutput.lastSendTimestamp)
    ? `${Math.round(mtcOutput.lastSendTimestamp)} ms`
    : '--';
  els.midiSegmentValue.textContent = String(timecodeClient.anchor?.segmentId ?? 0);
  els.midiFrameValue.textContent = String(renderedPositionFrames);
  els.midiRttValue.textContent = Number.isFinite(timecodeClient.rttMs) ? `${Math.round(timecodeClient.rttMs)} ms` : '-- ms';
  els.midiSuppressedValue.textContent = String(mtcOutput.suppressedMessages);
  els.midiFpsValue.textContent = '25 fps fixed';
}

function initializeMidiUi() {
  if (!navigator.requestMIDIAccess) {
    els.enableMidiButton.disabled = true;
    els.refreshMidiButton.disabled = true;
    els.midiOutputSelect.disabled = true;
    midiStatus = 'ERROR';
    showMidiError('Web MIDI is not supported in this browser. Use Chrome or Edge.');
    updateMidiStatus();
  }
}

function getMidiPlaybackStatus() {
  if (!timecodeClient.anchor) return 'waiting';
  if (isTimecodeDisconnected()) return 'disconnected';
  return timecodeClient.anchor.status || 'stopped';
}

function isTimecodeDisconnected() {
  const staleMs = lastReceiveClientNow ? performance.now() - lastReceiveClientNow : Number.POSITIVE_INFINITY;
  return !serverConnected || staleMs > DISCONNECT_MUTE_MS;
}

function formatMidiDeviceName(device) {
  return device.name || [device.manufacturer, device.id].filter(Boolean).join(' ') || 'MIDI Output';
}

function showMidiError(message) {
  els.midiError.textContent = message;
}

function clearMidiError() {
  els.midiError.textContent = '';
}

function cueLabel(cue) {
  if (!cue) return '--';
  const source = cue.source ? `${cue.source} ` : '';
  return `${source}${cue.name || cue.id || ''}`.trim() || '--';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
