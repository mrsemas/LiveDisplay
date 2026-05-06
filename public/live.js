const FPS = 25;
const BASE_TC = '01:00:00:00';
const BASE_FRAMES = timecodeToFrames(BASE_TC);

const zoomPresets = [
  { name: 'Compact', pxPerSecond: 72 },
  { name: 'Normal', pxPerSecond: 118 },
  { name: 'Wide', pxPerSecond: 175 },
  { name: 'Ultra', pxPerSecond: 250 }
];

let zoomIndex = Number(localStorage.getItem('waterfallZoomIndex') ?? 1);
if (!Number.isInteger(zoomIndex) || zoomIndex < 0 || zoomIndex >= zoomPresets.length) zoomIndex = 1;

let showData = {
  show: null,
  abbreviations: {},
  entries: [],
  cameras: [],
  durationMs: 0
};

let selectedCamera = localStorage.getItem('selectedCamera') || '';

let ws;
let wsConnected = false;
let serverStatus = 'stopped';
let targetPositionMs = 0;
let localPositionMs = 0;
let lastFrameAt = performance.now();
let lastRenderAt = 0;
let estimatedOneWayMs = 30;
let lastPingAt = 0;
let lastServerStateAt = 0;
let serverTimecode = BASE_TC;

const els = {
  showName: document.getElementById('showName'),
  statusPill: document.getElementById('statusPill'),
  mainClock: document.getElementById('mainClock'),
  latency: document.getElementById('latency'),
  cameraStrip: document.getElementById('cameraStrip'),
  pinnedRow: document.getElementById('pinnedRow'),
  waterfall: document.getElementById('waterfall'),
  zoomOut: document.getElementById('zoomOut'),
  zoomIn: document.getElementById('zoomIn'),
  zoomLabel: document.getElementById('zoomLabel'),
  timelineName: document.getElementById('timelineName'),
  durationLabel: document.getElementById('durationLabel')
};

els.zoomOut.addEventListener('click', () => setZoom(zoomIndex - 1));
els.zoomIn.addEventListener('click', () => setZoom(zoomIndex + 1));
setZoom(zoomIndex);

connectSocket();
requestShow();
requestAnimationFrame(tick);

function connectSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('open', () => {
    wsConnected = true;
    pingServer();
  });

  ws.addEventListener('close', () => {
    wsConnected = false;
    setTimeout(connectSocket, 800);
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'show') {
      showData = msg;
      if (!showData.cameras.includes(selectedCamera)) {
        selectedCamera = showData.cameras[0] || '';
        localStorage.setItem('selectedCamera', selectedCamera);
      }
      renderStatic();
    }

    if (msg.type === 'state') {
      applyServerState(msg);
    }

    if (msg.type === 'syncPong') {
      const now = performance.now();
      const t0 = Number(msg.clientSentAt);
      if (Number.isFinite(t0)) {
        const rtt = Math.max(0, now - t0);
        estimatedOneWayMs = clamp(rtt / 2, 2, 250);
      }
      applyServerState(msg);
    }
  });
}

async function requestShow() {
  try {
    const res = await fetch('/api/show');
    showData = await res.json();
    if (!showData.cameras.includes(selectedCamera)) {
      selectedCamera = showData.cameras[0] || '';
      localStorage.setItem('selectedCamera', selectedCamera);
    }
    renderStatic();
  } catch {
    // WebSocket retry will pick it up later.
  }
}

function pingServer() {
  if (ws?.readyState === WebSocket.OPEN) {
    lastPingAt = performance.now();
    ws.send(JSON.stringify({ type: 'syncPing', clientSentAt: lastPingAt }));
  }
  setTimeout(pingServer, 1500);
}

function applyServerState(msg) {
  serverStatus = msg.status || 'stopped';
  serverTimecode = msg.currentTimecode || serverTimecode;
  lastServerStateAt = performance.now();

  const incoming = Number(msg.positionMs) || 0;
  targetPositionMs = serverStatus === 'playing'
    ? incoming + estimatedOneWayMs
    : incoming;

  if (Math.abs(targetPositionMs - localPositionMs) > 1200) {
    localPositionMs = targetPositionMs;
  }
}

function tick(now) {
  const dt = Math.max(0, now - lastFrameAt);
  lastFrameAt = now;

  if (serverStatus === 'playing') {
    localPositionMs += dt;
    const correction = targetPositionMs - localPositionMs;
    if (Math.abs(correction) > 500) localPositionMs = targetPositionMs;
    else localPositionMs += correction * 0.06;
  } else {
    localPositionMs += (targetPositionMs - localPositionMs) * 0.18;
  }

  localPositionMs = clamp(localPositionMs, 0, showData.durationMs || Number.MAX_SAFE_INTEGER);

  if (now - lastRenderAt > 33) {
    renderLive();
    lastRenderAt = now;
  }

  requestAnimationFrame(tick);
}

function renderStatic() {
  els.showName.textContent = showData.show?.name || 'No show loaded';
  renderCameraButtons();
  renderTimelineSummary();
  renderLive(true);
}

function renderCameraButtons() {
  els.cameraStrip.innerHTML = '';
  if (!showData.cameras?.length) {
    const empty = document.createElement('div');
    empty.className = 'muted small-text';
    empty.textContent = 'No pinnable cameras found. Expected C1, C2, etc. at the start of Name.';
    els.cameraStrip.appendChild(empty);
    return;
  }

  for (const camera of showData.cameras) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `camera-btn ${camera === selectedCamera ? 'active' : ''}`;
    btn.textContent = getDisplaySource(camera);
    btn.title = camera;
    const color = findColorForSource(camera) || '#333';
    btn.style.background = color;
    btn.addEventListener('click', () => {
      selectedCamera = camera;
      localStorage.setItem('selectedCamera', selectedCamera);
      renderCameraButtons();
      renderLive(true);
    });
    els.cameraStrip.appendChild(btn);
  }
}

function renderTimelineSummary() {
  const show = showData.show;
  if (!show?.timelines?.length) {
    els.timelineName.textContent = '';
    els.durationLabel.textContent = 'Duration: —';
    return;
  }
  els.timelineName.textContent = '';
  els.durationLabel.textContent = `Duration: ${showData.durationTimecode || '—'}`;
}

function renderLive(force = false) {
  updateTopClock();
  renderPinnedRow();
  renderWaterfallRows(force);
  renderTimelineSummary();
}

function updateTopClock() {
  const frames = msToFrames(localPositionMs);
  els.mainClock.textContent = framesToTimecode(BASE_FRAMES + frames);
  els.statusPill.textContent = wsConnected ? serverStatus.toUpperCase() : 'OFFLINE';
  els.statusPill.className = `status-pill ${wsConnected ? serverStatus : 'stopped'}`;
  els.latency.textContent = `sync ${Math.round(estimatedOneWayMs * 2)} ms`;
}

function renderPinnedRow() {
  if (!selectedCamera) {
    els.pinnedRow.innerHTML = emptyPinnedHtml('PIN', 'Pick a camera');
    return;
  }

  const entries = showData.entries || [];
  const cameraEntries = entries.filter(e => e.source === selectedCamera);
  const active = cameraEntries.find(e => e.startMs <= localPositionMs && (e.renderEndMs || e.endMs) > localPositionMs);
  const next = cameraEntries.find(e => e.startMs > localPositionMs);
  const ref = active || next;
  const color = findColorForSource(selectedCamera) || '#333';

  if (!ref) {
    els.pinnedRow.className = 'timeline-row pinned empty-row';
    els.pinnedRow.innerHTML = emptyPinnedHtml(selectedCamera, 'No more shots for this camera');
    setPinnedSourceColor(color);
    return;
  }

  const isLive = Boolean(active);
  const countdown = isLive
    ? formatCountdown((ref.renderEndMs || ref.endMs) - localPositionMs)
    : formatCountdown(ref.startMs - localPositionMs);

  const countClass = isLive
    ? `live ${(ref.renderEndMs || ref.endMs) - localPositionMs < 3500 ? 'warn' : ''}`
    : 'future';

  const bars = cameraEntries
    .filter(entry => (entry.renderEndMs || entry.endMs) > localPositionMs - 80)
    .map(entry => {
      const entryLive = entry.startMs <= localPositionMs && (entry.renderEndMs || entry.endMs) > localPositionMs;
      return cueGeometryHtml(entry, localPositionMs, entry.color || color, entryLive);
    })
    .join('');

  els.pinnedRow.className = `timeline-row pinned ${isLive ? 'current' : 'future'}`;
  els.pinnedRow.innerHTML = `
    <div class="row-index">PIN</div>
    <div class="source-cell" style="background:${escapeAttr(color)}">${escapeHtml(getDisplaySource(selectedCamera))}</div>
    <div class="count-cell ${countClass}">${escapeHtml(countdown)}</div>
    <div class="track-area">
      <div class="playhead"></div>
      ${bars}
      <div class="row-description">${formatDescription(ref, true, isLive)}</div>
    </div>
  `;
}

function renderWaterfallRows(force = false) {
  const entries = showData.entries || [];
  const rowHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 49;
  const maxRows = Math.max(1, Math.floor(els.waterfall.clientHeight / rowHeight));

  let visible = entries.filter(e => (e.renderEndMs || e.endMs) > localPositionMs - 80);
  if (!visible.length && entries.length) visible = [entries.at(-1)];
  visible = visible.slice(0, maxRows + 1);

  const html = visible.map((entry, i) => {
    const isLive = entry.startMs <= localPositionMs && (entry.renderEndMs || entry.endMs) > localPositionMs;
    return rowHtml(entry, i + 1, localPositionMs, false, isLive, entry.source);
  }).join('');

  // Full rerender is fine here because visible rows are small. This keeps the code reliable on iOS Safari.
  els.waterfall.innerHTML = html || '<div class="timeline-row"><div class="row-index">—</div><div class="source-cell empty-source">NO</div><div class="count-cell">--</div><div class="track-area"><div class="playhead"></div><div class="row-description empty-description">Import a CSV from Admin</div></div></div>';
}

function rowHtml(entry, displayIndex, nowMs, pinned, isLive, sourceOverride) {
  const color = entry.color || '#666';
  const desc = formatDescription(entry, pinned, isLive);
  const effectiveEndMs = entry.renderEndMs || entry.endMs;
  const countLabel = isLive
    ? formatCountdown(effectiveEndMs - nowMs)
    : formatDuration(entry.endMs - entry.startMs);

  const countClass = isLive
    ? `live ${effectiveEndMs - nowMs < 3500 ? 'warn' : ''}`
    : 'duration';

  const rowClass = pinned ? `timeline-row pinned ${isLive ? 'current' : 'future'}` : `timeline-row ${isLive ? 'current' : 'future'}`;
  const indexLabel = pinned ? 'PIN' : displayIndex;
  const source = sourceOverride || entry.source || '—';
  const displaySource = getDisplaySource(source);

  return `
    <div class="${rowClass}">
      <div class="row-index">${escapeHtml(indexLabel)}</div>
      <div class="source-cell" style="background:${escapeAttr(color)}">${escapeHtml(displaySource)}</div>
      <div class="count-cell ${countClass}">${escapeHtml(countLabel)}</div>
      <div class="track-area">
        <div class="playhead"></div>
        ${cueGeometryHtml(entry, nowMs, color, isLive)}
        <div class="row-description">${desc}</div>
      </div>
    </div>
  `;
}

function emptyPinnedHtml(source, description) {
  return `
    <div class="row-index">PIN</div>
    <div class="source-cell empty-source">${escapeHtml(source)}</div>
    <div class="count-cell">--</div>
    <div class="track-area">
      <div class="playhead"></div>
      <div class="row-description empty-description">${escapeHtml(description)}</div>
    </div>
  `;
}

function setPinnedSourceColor(color) {
  const source = els.pinnedRow.querySelector('.source-cell');
  if (source) source.style.background = color;
}

function formatDescription(entry, pinned, isLive) {
  if (!entry?.isCamera) return '';
  const status = pinned ? `<span class="timeline-chip">${isLive ? 'ON AIR' : 'STANDBY'}</span>` : '';
  const description = entry.description || '';
  return `${status}${escapeHtml(description)}`;
}

function cueGeometryHtml(entry, nowMs, color, isLive) {
  const parts = [];
  const fadeInEnd = entry.transitionIn ? entry.transitionIn.endMs : entry.startMs;
  const fadeOutStart = entry.transitionOut ? entry.transitionOut.startMs : entry.endMs;
  const holdStart = Math.max(entry.startMs, fadeInEnd);
  const holdEnd = Math.max(holdStart, fadeOutStart);
  const partClass = isLive ? 'shot-bar' : 'shot-bar ghost';

  if (entry.transitionIn) {
    parts.push(shotPartHtml('shot-ramp ramp-in', entry.transitionIn.startMs, entry.transitionIn.endMs, nowMs, color, partClass));
  }

  if (holdEnd > holdStart) {
    const squareClass = [
      entry.transitionIn ? 'square-left' : '',
      entry.transitionOut ? 'square-right' : ''
    ].filter(Boolean).join(' ');
    parts.push(shotPartHtml(squareClass, holdStart, holdEnd, nowMs, color, partClass));
  }

  if (entry.transitionOut) {
    parts.push(shotPartHtml('shot-ramp ramp-out', entry.transitionOut.startMs, entry.transitionOut.endMs, nowMs, color, partClass));
  }

  if (!parts.length) {
    parts.push(shotPartHtml('', entry.startMs, entry.endMs, nowMs, color, partClass));
  }

  return parts.join('');
}

function shotPartHtml(shapeClass, startMs, endMs, nowMs, color, partClass) {
  const left = barLeftPx(startMs, nowMs);
  const width = Math.max(2, (endMs - startMs) / 1000 * currentZoom().pxPerSecond);
  return `<div class="${partClass} ${shapeClass}" style="left:${left}px;width:${width}px;background:${escapeAttr(color)}"></div>`;
}

function barLeftPx(entryStartMs, nowMs) {
  const playheadX = getPlayheadX();
  return playheadX + ((entryStartMs - nowMs) / 1000 * currentZoom().pxPerSecond);
}

function getPlayheadX() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--playhead-x').trim();
  return Number.parseFloat(value) || 180;
}

function findColorForSource(source) {
  return showData.entries?.find(e => e.source === source)?.color;
}

function getDisplaySource(source) {
  const key = String(source || '').trim().toUpperCase();
  return showData.abbreviations?.[key] || source || '—';
}

function currentTimeline(positionMs) {
  const show = showData.show;
  if (!show?.timelines?.length) return null;
  const posFrames = msToFrames(positionMs);
  return show.timelines.find(t => {
    const start = t.offsetFrames;
    const end = t.offsetFrames + t.durationFrames;
    return posFrames >= start && posFrames < end;
  }) || show.timelines.at(-1);
}

function currentZoom() { return zoomPresets[zoomIndex]; }
function setZoom(next) {
  zoomIndex = clamp(next, 0, zoomPresets.length - 1);
  localStorage.setItem('waterfallZoomIndex', String(zoomIndex));
  if (els.zoomLabel) els.zoomLabel.textContent = zoomPresets[zoomIndex].name;
}

function formatDuration(ms) {
  const abs = Math.max(0, Math.round(Math.abs(ms) / 1000));
  const min = Math.floor(abs / 60);
  const sec = abs % 60;
  if (min > 0) return `${min}:${String(sec).padStart(2, '0')}`;
  return `:${String(sec).padStart(2, '0')}`;
}

function formatCountdown(ms) {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.max(0, Math.ceil(Math.abs(ms) / 1000));
  const min = Math.floor(abs / 60);
  const sec = abs % 60;
  if (min > 0) return `${sign}${min}:${String(sec).padStart(2, '0')}`;
  return `${sign}:${String(sec).padStart(2, '0')}`;
}

function timecodeToFrames(tc) {
  const m = String(tc).match(/^(\d{1,2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]), ff = Number(m[4]);
  return (((hh * 60 + mm) * 60 + ss) * FPS) + ff;
}
function framesToTimecode(frames) {
  const safe = Math.max(0, Math.round(frames));
  const totalSeconds = Math.floor(safe / FPS);
  const ff = safe % FPS;
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}
function msToFrames(ms) { return Math.round(ms * FPS / 1000); }
function pad2(n) { return String(Math.floor(n)).padStart(2, '0'); }
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function escapeAttr(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }
