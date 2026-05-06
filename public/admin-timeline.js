const FPS = 25;
const params = new URLSearchParams(location.search);
const showId = params.get('showId') || '';
const timelineId = params.get('timelineId') || '';

let timeline = null;
let transitionSaveTimer = null;

const els = {
  pageTitle: document.getElementById('pageTitle'),
  timelineMeta: document.getElementById('timelineMeta'),
  timelineForm: document.getElementById('timelineForm'),
  timelineNameInput: document.getElementById('timelineNameInput'),
  csvInput: document.getElementById('csvInput'),
  removeTimeline: document.getElementById('removeTimeline'),
  timelineStatus: document.getElementById('timelineStatus'),
  transitionStatus: document.getElementById('transitionStatus'),
  cueList: document.getElementById('cueList')
};

els.timelineForm.addEventListener('submit', saveTimeline);
els.removeTimeline.addEventListener('click', removeTimeline);
els.cueList.addEventListener('change', onTransitionEdit);
els.cueList.addEventListener('input', onTransitionEdit);

await loadTimeline();

async function loadTimeline() {
  if (!showId || !timelineId) {
    setStatus('Missing show or timeline id.', true);
    els.timelineForm.classList.add('hidden');
    return;
  }

  try {
    const res = await fetch(`/api/shows/${encodeURIComponent(showId)}/timelines/${encodeURIComponent(timelineId)}`);
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Timeline not found.');

    timeline = payload.timeline;
    renderTimeline(payload.show, payload.timeline);
  } catch (err) {
    setStatus(err.message, true);
    els.timelineForm.classList.add('hidden');
  }
}

function renderTimeline(show, nextTimeline) {
  els.pageTitle.textContent = nextTimeline.name || 'Edit Timeline';
  els.timelineNameInput.value = nextTimeline.name || '';
  els.timelineMeta.textContent = `${show?.name || 'Show'} · Start ${nextTimeline.startTimecode} · Duration ${nextTimeline.durationTimecode} · ${nextTimeline.entryCount} cues`;
  renderCueList(nextTimeline.entries || []);
}

function renderCueList(entries) {
  if (!entries.length) {
    els.cueList.innerHTML = '<div class="muted small-text">No cues found.</div>';
    return;
  }

  const transitionByTarget = new Map((timeline?.transitions || []).map(transition => [transition.toEntryId, transition]));

  els.cueList.innerHTML = entries.map((entry, i) => {
    const previous = entries[i - 1];
    const transition = transitionByTarget.get(entry.id);
    const durationSeconds = transition ? (transition.durationFrames / FPS).toFixed(2).replace(/\.?0+$/, '') : '1';
    const boundary = previous ? `
      <div class="transition-row" data-from-entry-id="${escapeAttr(previous.id)}" data-to-entry-id="${escapeAttr(entry.id)}">
        <div class="transition-label">${escapeHtml(previous.source || '')} -> ${escapeHtml(entry.source || '')}</div>
        <select class="transition-type">
          <option value="cut"${transition ? '' : ' selected'}>Cut</option>
          <option value="mix"${transition ? ' selected' : ''}>Mix</option>
        </select>
        <label class="transition-duration">
          Duration
          <input class="transition-duration-input" type="number" min="0.04" step="0.04" value="${escapeAttr(durationSeconds)}" />
        </label>
      </div>
    ` : '';

    return `
      ${boundary}
      <div class="cue-item">
        <div class="cue-number">${i + 1}</div>
        <div class="cue-source" style="background:${escapeAttr(entry.color || '#333')}">${escapeHtml(entry.source || '')}</div>
        <div>
          <div class="cue-title">${escapeHtml(entry.description || entry.rawName || '')}</div>
          <div class="timeline-meta">${escapeHtml(entry.startTimecode)} - ${escapeHtml(entry.endTimecode)} · ${escapeHtml(entry.durationTimecode)} · ${escapeHtml(entry.number || '')}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function saveTimeline(event) {
  event.preventDefault();
  const name = els.timelineNameInput.value.trim();
  if (!name) return setStatus('Timeline name is required.', true);

  const fd = new FormData();
  fd.set('timelineName', name);
  if (els.csvInput.files?.[0]) fd.set('csv', els.csvInput.files[0]);

  setStatus('Saving timeline...');
  try {
    const res = await fetch(`/api/shows/${encodeURIComponent(showId)}/timelines/${encodeURIComponent(timelineId)}`, {
      method: 'POST',
      body: fd
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Save failed.');

    timeline = payload.timeline;
    els.csvInput.value = '';
    renderTimeline(payload.show, payload.timeline);
    setStatus('Timeline saved.');
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function removeTimeline() {
  const name = timeline?.name || 'this timeline';
  if (!confirm(`Remove timeline "${name}" from this show?`)) return;

  setStatus(`Removing ${name}...`);
  try {
    const res = await fetch(`/api/shows/${encodeURIComponent(showId)}/timelines/${encodeURIComponent(timelineId)}`, { method: 'DELETE' });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Remove failed.');
    location.href = '/admin';
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function saveTransitions() {
  clearTimeout(transitionSaveTimer);
  const transitions = [];

  for (const row of els.cueList.querySelectorAll('.transition-row')) {
    const type = row.querySelector('.transition-type')?.value || 'cut';
    if (type !== 'mix') continue;

    const durationSeconds = Number(row.querySelector('.transition-duration-input')?.value);
    transitions.push({
      type: 'mix',
      fromEntryId: row.dataset.fromEntryId,
      toEntryId: row.dataset.toEntryId,
      durationFrames: Math.max(1, Math.round((Number.isFinite(durationSeconds) ? durationSeconds : 1) * FPS))
    });
  }

  setTransitionStatus('Saving transitions...');
  try {
    const res = await fetch(`/api/shows/${encodeURIComponent(showId)}/timelines/${encodeURIComponent(timelineId)}/transitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transitions })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Transition save failed.');

    timeline = payload.timeline;
    renderTimeline(payload.show, payload.timeline);
    setTransitionStatus(`Saved ${timeline.transitions.length} mix transitions.`);
  } catch (err) {
    setTransitionStatus(err.message, true);
  }
}

function onTransitionEdit(event) {
  if (!event.target.closest('.transition-row')) return;
  setTransitionStatus('Saving transitions...');
  clearTimeout(transitionSaveTimer);
  transitionSaveTimer = setTimeout(saveTransitions, 350);
}

function setStatus(message, isError = false) {
  els.timelineStatus.textContent = message;
  els.timelineStatus.style.color = isError ? '#ff9a8c' : '#8ecbff';
}

function setTransitionStatus(message, isError = false) {
  els.transitionStatus.textContent = message;
  els.transitionStatus.style.color = isError ? '#ff9a8c' : '#8ecbff';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
