const params = new URLSearchParams(location.search);
const showId = params.get('showId') || '';
const timelineId = params.get('timelineId') || '';

let timeline = null;

const els = {
  pageTitle: document.getElementById('pageTitle'),
  timelineMeta: document.getElementById('timelineMeta'),
  timelineForm: document.getElementById('timelineForm'),
  timelineNameInput: document.getElementById('timelineNameInput'),
  csvInput: document.getElementById('csvInput'),
  removeTimeline: document.getElementById('removeTimeline'),
  timelineStatus: document.getElementById('timelineStatus'),
  cueList: document.getElementById('cueList')
};

els.timelineForm.addEventListener('submit', saveTimeline);
els.removeTimeline.addEventListener('click', removeTimeline);

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

  els.cueList.innerHTML = entries.map((entry, i) => `
    <div class="cue-item">
      <div class="cue-number">${i + 1}</div>
      <div class="cue-source" style="background:${escapeAttr(entry.color || '#333')}">${escapeHtml(entry.source || '')}</div>
      <div>
        <div class="cue-title">${escapeHtml(entry.description || entry.rawName || '')}</div>
        <div class="timeline-meta">${escapeHtml(entry.startTimecode)} - ${escapeHtml(entry.endTimecode)} · ${escapeHtml(entry.durationTimecode)} · ${escapeHtml(entry.number || '')}</div>
      </div>
    </div>
  `).join('');
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

function setStatus(message, isError = false) {
  els.timelineStatus.textContent = message;
  els.timelineStatus.style.color = isError ? '#ff9a8c' : '#8ecbff';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
