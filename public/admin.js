const FPS = 25;
const BASE_TC = '01:00:00:00';
const BASE_FRAMES = timecodeToFrames(BASE_TC);

let showsPayload = null;
let currentState = null;
let abbreviations = {};
let isScrubbing = false;
let pendingSeekTimer = null;
let lastSeekSentAt = 0;

const els = {
  showSelect: document.getElementById('showSelect'),
  setActiveShow: document.getElementById('setActiveShow'),
  newShowName: document.getElementById('newShowName'),
  createShow: document.getElementById('createShow'),
  showMeta: document.getElementById('showMeta'),
  importForm: document.getElementById('importForm'),
  importMode: document.getElementById('importMode'),
  replaceLabel: document.getElementById('replaceLabel'),
  replaceTimelineSelect: document.getElementById('replaceTimelineSelect'),
  importStatus: document.getElementById('importStatus'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  resetBtn: document.getElementById('resetBtn'),
  adminState: document.getElementById('adminState'),
  adminClock: document.getElementById('adminClock'),
  scrubSlider: document.getElementById('scrubSlider'),
  scrubReadout: document.getElementById('scrubReadout'),
  abbreviationForm: document.getElementById('abbreviationForm'),
  abbreviationRows: document.getElementById('abbreviationRows'),
  addAbbreviation: document.getElementById('addAbbreviation'),
  abbreviationStatus: document.getElementById('abbreviationStatus'),
  timelineList: document.getElementById('timelineList')
};

els.setActiveShow.addEventListener('click', setActiveShow);
els.createShow.addEventListener('click', createShow);
els.importMode.addEventListener('change', updateReplaceVisibility);
els.importForm.addEventListener('submit', importCsv);
els.startBtn.addEventListener('click', () => control('start'));
els.pauseBtn.addEventListener('click', () => control('pause'));
els.stopBtn.addEventListener('click', () => control('stop'));
els.resetBtn.addEventListener('click', () => control('reset'));
els.showSelect.addEventListener('change', renderShowDetailsFromSelect);
els.scrubSlider.addEventListener('pointerdown', () => { isScrubbing = true; });
els.scrubSlider.addEventListener('touchstart', () => { isScrubbing = true; }, { passive: true });
els.scrubSlider.addEventListener('input', onScrubInput);
els.scrubSlider.addEventListener('change', onScrubCommit);
els.scrubSlider.addEventListener('pointerup', onScrubCommit);
els.scrubSlider.addEventListener('touchend', onScrubCommit, { passive: true });
els.addAbbreviation.addEventListener('click', () => addAbbreviationRow('', ''));
els.abbreviationForm.addEventListener('submit', saveAbbreviations);

await refreshAll();
setInterval(refreshState, 400);

async function refreshAll() {
  await refreshShows();
  await refreshActiveShowDetails();
  await refreshAbbreviations();
  await refreshState();
}

async function refreshShows() {
  const res = await fetch('/api/shows');
  showsPayload = await res.json();

  els.showSelect.innerHTML = '';
  for (const show of showsPayload.shows) {
    const option = document.createElement('option');
    option.value = show.id;
    option.textContent = `${show.name} (${show.timelineCount} timelines)`;
    if (show.id === showsPayload.activeShowId) option.selected = true;
    els.showSelect.appendChild(option);
  }
  renderShowDetailsFromSelect();
}


async function refreshAbbreviations() {
  try {
    const res = await fetch('/api/abbreviations');
    const payload = await res.json();
    abbreviations = payload.abbreviations || {};
    renderAbbreviationRows();
    els.abbreviationStatus.textContent = `Saved to ${payload.file || 'data/abbreviations.json'}.`;
    els.abbreviationStatus.style.color = '';
  } catch {
    els.abbreviationStatus.textContent = 'Could not load abbreviations.';
    els.abbreviationStatus.style.color = '#ff9a8c';
  }
}

function renderAbbreviationRows() {
  els.abbreviationRows.innerHTML = '';
  const entries = Object.entries(abbreviations).sort(([a], [b]) => sourceSortKey(a) - sourceSortKey(b) || a.localeCompare(b));

  if (!entries.length) {
    addAbbreviationRow('', '');
    return;
  }

  for (const [source, label] of entries) addAbbreviationRow(source, label);
}

function addAbbreviationRow(source = '', label = '') {
  const row = document.createElement('div');
  row.className = 'abbr-row';
  row.innerHTML = `
    <input class="abbr-source" type="text" placeholder="Original, e.g. BLACK or C1" value="${escapeAttr(source)}" />
    <span class="abbr-arrow">→</span>
    <input class="abbr-label" type="text" maxlength="14" placeholder="Short label, e.g. BLK" value="${escapeAttr(label)}" />
    <button class="abbr-remove" type="button">Remove</button>
  `;
  row.querySelector('.abbr-remove').addEventListener('click', () => row.remove());
  els.abbreviationRows.appendChild(row);
}

async function saveAbbreviations(event) {
  event.preventDefault();
  const next = {};

  for (const row of els.abbreviationRows.querySelectorAll('.abbr-row')) {
    const source = row.querySelector('.abbr-source')?.value.trim().toUpperCase();
    const label = row.querySelector('.abbr-label')?.value.trim();
    if (!source || !label) continue;
    next[source] = label;
  }

  try {
    const payload = await postJson('/api/abbreviations', { abbreviations: next });
    abbreviations = payload.abbreviations || {};
    renderAbbreviationRows();
    els.abbreviationStatus.textContent = `Saved ${Object.keys(abbreviations).length} abbreviations to ${payload.file || 'data/abbreviations.json'}.`;
    els.abbreviationStatus.style.color = '#8ecbff';
  } catch (err) {
    els.abbreviationStatus.textContent = err.message;
    els.abbreviationStatus.style.color = '#ff9a8c';
  }
}

function sourceSortKey(source) {
  const cam = String(source).match(/^C(\d+)$/i);
  if (cam) return Number(cam[1]);
  return 10000;
}

async function refreshActiveShowDetails() {
  const res = await fetch('/api/show');
  const payload = await res.json();
  renderTimelineList(payload.show?.timelines || []);
  renderReplaceSelect(payload.show?.timelines || []);
}

async function refreshState() {
  try {
    const res = await fetch('/api/state');
    currentState = await res.json();
    els.adminState.textContent = currentState.status?.toUpperCase() || '—';
    els.adminClock.textContent = currentState.currentTimecode || '01:00:00:00';
    updateScrubFromState();
  } catch {
    els.adminState.textContent = 'OFFLINE';
  }
}

function updateScrubFromState() {
  const durationMs = Math.max(0, Number(currentState?.durationMs) || 0);
  const positionMs = Math.max(0, Number(currentState?.positionMs) || 0);

  els.scrubSlider.max = String(Math.round(durationMs));
  els.scrubSlider.disabled = durationMs <= 0;

  if (!isScrubbing) {
    els.scrubSlider.value = String(Math.round(Math.min(positionMs, durationMs)));
    updateScrubReadout(positionMs, durationMs);
  }
}

function onScrubInput() {
  isScrubbing = true;
  const positionMs = Number(els.scrubSlider.value) || 0;
  const durationMs = Number(els.scrubSlider.max) || 0;
  updateScrubReadout(positionMs, durationMs);
  throttledSeek(positionMs);
}

function onScrubCommit() {
  const positionMs = Number(els.scrubSlider.value) || 0;
  seek(positionMs, true).finally(() => {
    setTimeout(() => { isScrubbing = false; }, 120);
  });
}

function throttledSeek(positionMs) {
  const now = performance.now();
  const wait = Math.max(0, 85 - (now - lastSeekSentAt));
  clearTimeout(pendingSeekTimer);
  pendingSeekTimer = setTimeout(() => seek(positionMs), wait);
}

async function seek(positionMs, immediate = false) {
  if (immediate) clearTimeout(pendingSeekTimer);
  lastSeekSentAt = performance.now();
  try {
    const payload = await postJson('/api/control', { action: 'seek', positionMs });
    currentState = payload.state || currentState;
    if (currentState) {
      els.adminState.textContent = currentState.status?.toUpperCase() || '—';
      els.adminClock.textContent = currentState.currentTimecode || '01:00:00:00';
      updateScrubReadout(currentState.positionMs, currentState.durationMs);
    }
  } catch (err) {
    setStatus(err.message, true);
  }
}

function updateScrubReadout(positionMs, durationMs) {
  els.scrubReadout.textContent = `${framesToTimecode(BASE_FRAMES + msToFrames(positionMs || 0))} / ${durationMs ? framesToTimecode(msToFrames(durationMs)) : '—'}`;
}

function renderShowDetailsFromSelect() {
  if (!showsPayload) return;
  const selected = showsPayload.shows.find(s => s.id === els.showSelect.value);
  if (!selected) {
    els.showMeta.textContent = 'No show selected.';
    return;
  }
  els.showMeta.textContent = `Timelines: ${selected.timelineCount} · Duration: ${selected.durationTimecode} · Active: ${selected.id === showsPayload.activeShowId ? 'yes' : 'no'}`;
}

function renderTimelineList(timelines) {
  if (!timelines.length) {
    els.timelineList.innerHTML = '<div class="muted small-text">No timelines imported yet.</div>';
    return;
  }
  els.timelineList.innerHTML = timelines.map((t, i) => `
    <div class="timeline-item">
      <div class="timeline-number">${i + 1}</div>
      <div>
        <div class="timeline-title">${escapeHtml(t.name)}</div>
        <div class="timeline-meta">Start ${escapeHtml(t.startTimecode)} · Duration ${escapeHtml(t.durationTimecode)} · ${t.entryCount} entries</div>
      </div>
      <div class="timeline-meta">${escapeHtml(t.id)}</div>
      <div class="timeline-meta">${Math.round((t.durationFrames || 0) / FPS)}s</div>
    </div>
  `).join('');
}

function renderReplaceSelect(timelines) {
  els.replaceTimelineSelect.innerHTML = '';
  for (const t of timelines) {
    const option = document.createElement('option');
    option.value = t.id;
    option.textContent = t.name;
    els.replaceTimelineSelect.appendChild(option);
  }
}

function updateReplaceVisibility() {
  els.replaceLabel.classList.toggle('hidden', els.importMode.value !== 'replace');
}

async function setActiveShow() {
  const showId = els.showSelect.value;
  if (!showId) return;
  await postJson('/api/active-show', { showId });
  await refreshAll();
}

async function createShow() {
  const name = els.newShowName.value.trim();
  if (!name) return setStatus('Enter a show name first.', true);
  await postJson('/api/shows', { name });
  els.newShowName.value = '';
  setStatus(`Created show: ${name}`);
  await refreshAll();
}

async function importCsv(event) {
  event.preventDefault();
  const selectedShowId = els.showSelect.value;
  if (!selectedShowId) return setStatus('Select or create a show first.', true);

  const fd = new FormData(els.importForm);
  fd.set('showId', selectedShowId);

  setStatus('Importing...');
  try {
    const res = await fetch('/api/import', { method: 'POST', body: fd });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Import failed.');
    setStatus('Imported successfully. Playback reset to start.');
    els.importForm.reset();
    updateReplaceVisibility();
    await refreshAll();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function control(action) {
  try {
    const payload = await postJson('/api/control', { action });
    currentState = payload.state || currentState;
    await refreshState();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || 'Request failed.');
  return payload;
}

function setStatus(message, isError = false) {
  els.importStatus.textContent = message;
  els.importStatus.style.color = isError ? '#ff9a8c' : '#8ecbff';
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
function msToFrames(ms) { return Math.round((Number(ms) || 0) * FPS / 1000); }
function pad2(n) { return String(Math.floor(n)).padStart(2, '0'); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function escapeAttr(value) { return escapeHtml(value).replace(/'/g, '&#39;'); }
