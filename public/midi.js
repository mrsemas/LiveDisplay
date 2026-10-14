const STORAGE_KEY = 'liveDisplayMidiControl.v1';
const TRANSPORT_ACTIONS = new Set(['start', 'unpause', 'pause', 'stop', 'reset']);
const ACTION_LABELS = {
  start: 'Start',
  unpause: 'Unpause',
  pause: 'Pause',
  stop: 'Stop',
  reset: 'Reset',
  set_show: 'Go to show'
};

let midiAccess = null;
let selectedInput = null;
let mappings = loadMappings();
let showsPayload = null;
let playbackState = null;
let learningMappingId = null;
let inFlightActions = new Set();

const els = {
  enableMidi: document.getElementById('enableMidi'),
  refreshMidi: document.getElementById('refreshMidi'),
  inputSelect: document.getElementById('inputSelect'),
  midiStatus: document.getElementById('midiStatus'),
  activeShow: document.getElementById('activeShow'),
  playbackState: document.getElementById('playbackState'),
  midiMessage: document.getElementById('midiMessage'),
  addMapping: document.getElementById('addMapping'),
  resetMappings: document.getElementById('resetMappings'),
  mappingRows: document.getElementById('mappingRows'),
  portDiagnostics: document.getElementById('portDiagnostics'),
  lastInput: document.getElementById('lastInput'),
  lastAction: document.getElementById('lastAction'),
  eventLog: document.getElementById('eventLog')
};

els.enableMidi.addEventListener('click', enableMidi);
els.refreshMidi.addEventListener('click', refreshMidiInputs);
els.inputSelect.addEventListener('change', () => selectMidiInput(els.inputSelect.value));
els.addMapping.addEventListener('click', () => {
  mappings.push(createMapping());
  saveMappings();
  renderMappings();
});
els.resetMappings.addEventListener('click', () => {
  if (!confirm('Reset MIDI note mappings to blank transport defaults?')) return;
  mappings = defaultMappings();
  learningMappingId = null;
  saveMappings();
  renderMappings();
});

await refreshShows();
await refreshPlaybackState();
renderMappings();
initializeMidiUi();
setInterval(refreshPlaybackState, 500);
setInterval(refreshShows, 5000);

function initializeMidiUi() {
  if (!navigator.requestMIDIAccess) {
    setMidiStatus('ERROR', 'Web MIDI is not supported in this browser. Use Chrome or Edge.');
    els.enableMidi.disabled = true;
    els.refreshMidi.disabled = true;
    els.inputSelect.disabled = true;
    return;
  }

  setMidiStatus('OFF', 'Enable MIDI to choose an input device.');
}

async function enableMidi() {
  try {
    if (!navigator.requestMIDIAccess) {
      throw new Error('Web MIDI is not supported in this browser. Use Chrome or Edge.');
    }

    if (!midiAccess) {
      midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.onstatechange = () => {
        refreshMidiInputs();
        renderMidiPorts();
      };
    }

    refreshMidiInputs();
    const storedInputId = getStoredInputId();
    const inputId = storedInputId && midiAccess.inputs.has(storedInputId)
      ? storedInputId
      : firstMidiInputId();

    if (inputId) selectMidiInput(inputId);
    if (!selectedInput) throw new Error('No MIDI input devices found.');

    setMidiStatus('LISTENING', `Listening to ${formatMidiDeviceName(selectedInput)}.`);
  } catch (err) {
    setMidiStatus('ERROR', err.message || 'MIDI could not be enabled.');
  }
}

function refreshMidiInputs() {
  if (!midiAccess) {
    setMidiStatus('OFF', 'Enable MIDI before refreshing devices.');
    renderMidiPorts();
    return;
  }

  const previousInputId = selectedInput?.id || getStoredInputId();
  els.inputSelect.innerHTML = '<option value="">MIDI Input Device: None</option>';

  for (const input of midiAccess.inputs.values()) {
    const option = document.createElement('option');
    option.value = input.id;
    option.textContent = `MIDI Input Device: ${formatMidiDeviceName(input)}`;
    els.inputSelect.appendChild(option);
  }

  els.inputSelect.disabled = midiAccess.inputs.size === 0;
  renderMidiPorts();

  if (previousInputId && midiAccess.inputs.has(previousInputId)) {
    selectMidiInput(previousInputId, { silent: true });
  } else if (selectedInput) {
    detachInput(selectedInput);
    selectedInput = null;
    setMidiStatus('NO DEVICE', 'Selected MIDI input disconnected.');
  } else if (midiAccess.inputs.size === 0) {
    setMidiStatus('NO DEVICE', 'No MIDI input devices found.');
  }
}

function renderMidiPorts() {
  if (!els.portDiagnostics) return;

  if (!midiAccess) {
    els.portDiagnostics.innerHTML = '<div class="muted small-text">Enable MIDI to inspect browser-visible input and output ports.</div>';
    return;
  }

  const inputs = Array.from(midiAccess.inputs.values());
  const outputs = Array.from(midiAccess.outputs.values());
  const iacInputs = inputs.filter(isIacPort);
  const iacOutputs = outputs.filter(isIacPort);
  const macHint = isMacLike()
    ? ' On macOS, IAC must be online in Audio MIDI Setup before the browser starts; Chrome or Edge may need a full restart after enabling it.'
    : '';

  let hint = '';
  if (iacInputs.length) {
    hint = `IAC is available as an input: ${iacInputs.map(formatMidiDeviceName).join(', ')}.`;
  } else if (iacOutputs.length) {
    hint = `IAC is visible only as an output. This page needs IAC as an input to receive notes.${macHint}`;
  } else {
    hint = `IAC is not exposed by Web MIDI in this browser session.${macHint}`;
  }

  els.portDiagnostics.innerHTML = `
    <div class="midi-diagnostic-hint">${escapeHtml(hint)}</div>
    <div class="midi-port-grid">
      ${renderPortGroup('Inputs', inputs)}
      ${renderPortGroup('Outputs', outputs)}
    </div>
  `;
}

function renderPortGroup(label, ports) {
  const rows = ports.length
    ? ports.map(port => `
        <div class="midi-port-row${isIacPort(port) ? ' iac' : ''}">
          <div class="midi-port-name">${escapeHtml(formatMidiDeviceName(port))}</div>
          <div class="midi-port-meta">state ${escapeHtml(port.state || '--')} · connection ${escapeHtml(port.connection || '--')} · id ${escapeHtml(port.id || '--')}</div>
        </div>
      `).join('')
    : '<div class="midi-port-row empty">None</div>';

  return `
    <div class="midi-port-group">
      <div class="eyebrow">${escapeHtml(label)}</div>
      ${rows}
    </div>
  `;
}

function isIacPort(port) {
  return /iac/i.test(`${port?.name || ''} ${port?.manufacturer || ''} ${port?.id || ''}`);
}

function isMacLike() {
  return /mac/i.test(navigator.platform || navigator.userAgent || '');
}

function selectMidiInput(inputId, { silent = false } = {}) {
  if (selectedInput) detachInput(selectedInput);

  selectedInput = inputId ? midiAccess?.inputs.get(inputId) || null : null;
  els.inputSelect.value = selectedInput?.id || '';

  if (!selectedInput) {
    setStoredInputId('');
    setMidiStatus('NO DEVICE', silent ? '' : 'No MIDI input selected.');
    return;
  }

  selectedInput.onmidimessage = handleMidiMessage;
  setStoredInputId(selectedInput.id);
  setMidiStatus('LISTENING', silent ? '' : `Listening to ${formatMidiDeviceName(selectedInput)}.`);
}

function detachInput(input) {
  if (input) input.onmidimessage = null;
}

function handleMidiMessage(event) {
  const parsed = parseMidiMessage(event.data);
  if (!parsed) return;

  els.lastInput.textContent = formatMidiInput(parsed);

  if (parsed.type !== 'note_on') {
    logEvent(`Ignored ${parsed.type.replace('_', ' ')} ${formatMidiInput(parsed)}.`);
    return;
  }

  if (learningMappingId) {
    const mapping = mappings.find(item => item.id === learningMappingId);
    if (mapping) {
      mapping.note = parsed.note;
      mapping.channel = parsed.channel;
      saveMappings();
      logEvent(`Learned ${noteName(parsed.note)} on channel ${parsed.channel}.`);
    }
    learningMappingId = null;
    setMidiStatus('LISTENING', `Listening to ${formatMidiDeviceName(selectedInput)}.`);
    renderMappings();
    return;
  }

  const matched = mappings.filter(mapping => mappingMatches(mapping, parsed));
  if (!matched.length) {
    logEvent(`No mapping for ${noteName(parsed.note)} on channel ${parsed.channel}.`);
    return;
  }

  for (const mapping of matched) {
    void runMapping(mapping, parsed);
  }
}

function parseMidiMessage(data) {
  const status = data[0];
  const command = status & 0xF0;
  const channel = (status & 0x0F) + 1;
  const note = data[1];
  const velocity = data[2] || 0;

  if (command === 0x90) {
    return {
      type: velocity > 0 ? 'note_on' : 'note_off',
      channel,
      note,
      velocity
    };
  }

  if (command === 0x80) {
    return { type: 'note_off', channel, note, velocity };
  }

  return null;
}

function mappingMatches(mapping, input) {
  return Number(mapping.note) === input.note &&
    (!mapping.channel || Number(mapping.channel) === input.channel);
}

async function runMapping(mapping, input) {
  const actionKey = actionFingerprint(mapping);
  if (inFlightActions.has(actionKey)) return;
  inFlightActions.add(actionKey);

  try {
    if (TRANSPORT_ACTIONS.has(mapping.action)) {
      await postJson('/api/control', { action: mapping.action });
      els.lastAction.textContent = ACTION_LABELS[mapping.action];
      logEvent(`${formatMidiInput(input)} -> ${ACTION_LABELS[mapping.action]}.`);
    } else if (mapping.action === 'set_show') {
      if (!mapping.showId) throw new Error('Show mapping has no show selected.');
      await postJson('/api/active-show', { showId: mapping.showId });
      await refreshShows();
      els.lastAction.textContent = `Go to ${showName(mapping.showId)}`;
      logEvent(`${formatMidiInput(input)} -> active show ${showName(mapping.showId)}.`);
    }

    await refreshPlaybackState();
  } catch (err) {
    logEvent(`${formatMidiInput(input)} failed: ${err.message}`, true);
  } finally {
    setTimeout(() => inFlightActions.delete(actionKey), 120);
  }
}

function actionFingerprint(mapping) {
  return `${mapping.action}:${mapping.showId || ''}`;
}

async function refreshShows() {
  try {
    const res = await fetch('/api/shows');
    showsPayload = await res.json();
    updateShowStatus();
    renderShowSelects();
  } catch {
    els.activeShow.textContent = 'OFFLINE';
  }
}

async function refreshPlaybackState() {
  try {
    const res = await fetch('/api/state');
    playbackState = await res.json();
    els.playbackState.textContent = playbackState.status?.toUpperCase() || '--';
  } catch {
    els.playbackState.textContent = 'OFFLINE';
  }
}

function updateShowStatus() {
  const active = showsPayload?.shows?.find(show => show.id === showsPayload.activeShowId);
  els.activeShow.textContent = active?.name || '--';
}

function renderMappings() {
  els.mappingRows.innerHTML = '';

  for (const mapping of mappings) {
    const row = document.createElement('div');
    row.className = `midi-map-row${learningMappingId === mapping.id ? ' learning' : ''}`;
    row.dataset.mappingId = mapping.id;
    row.innerHTML = `
      <label>
        <span class="sr-only">Note</span>
        <input class="midi-note-input" type="number" min="0" max="127" step="1" value="${escapeAttr(mapping.note ?? '')}" placeholder="0-127" />
      </label>
      <label>
        <span class="sr-only">Channel</span>
        <select class="midi-channel-select">
          <option value="">Any</option>
          ${Array.from({ length: 16 }, (_, index) => `<option value="${index + 1}">Ch ${index + 1}</option>`).join('')}
        </select>
      </label>
      <label>
        <span class="sr-only">Action</span>
        <select class="midi-action-select">
          <option value="start">Start</option>
          <option value="unpause">Unpause</option>
          <option value="pause">Pause</option>
          <option value="stop">Stop</option>
          <option value="reset">Reset</option>
          <option value="set_show">Go to show</option>
        </select>
      </label>
      <label>
        <span class="sr-only">Show</span>
        <select class="midi-show-select"></select>
      </label>
      <div class="midi-row-actions">
        <button class="midi-learn" type="button">${learningMappingId === mapping.id ? 'Listening...' : 'Learn'}</button>
        <button class="midi-remove danger" type="button">Remove</button>
      </div>
    `;

    const noteInput = row.querySelector('.midi-note-input');
    const channelSelect = row.querySelector('.midi-channel-select');
    const actionSelect = row.querySelector('.midi-action-select');
    const showSelect = row.querySelector('.midi-show-select');
    const learnButton = row.querySelector('.midi-learn');
    const removeButton = row.querySelector('.midi-remove');

    channelSelect.value = mapping.channel ? String(mapping.channel) : '';
    actionSelect.value = mapping.action || 'start';
    renderShowOptions(showSelect, mapping.showId);
    updateShowSelectState(actionSelect, showSelect);

    noteInput.addEventListener('change', () => {
      const rawNote = noteInput.value.trim();
      const note = Number(rawNote);
      mapping.note = rawNote && Number.isInteger(note) && note >= 0 && note <= 127 ? note : '';
      noteInput.value = mapping.note === '' ? '' : String(mapping.note);
      saveMappings();
    });
    channelSelect.addEventListener('change', () => {
      mapping.channel = channelSelect.value ? Number(channelSelect.value) : '';
      saveMappings();
    });
    actionSelect.addEventListener('change', () => {
      mapping.action = actionSelect.value;
      if (mapping.action !== 'set_show') mapping.showId = '';
      updateShowSelectState(actionSelect, showSelect);
      saveMappings();
    });
    showSelect.addEventListener('change', () => {
      mapping.showId = showSelect.value;
      saveMappings();
    });
    learnButton.addEventListener('click', () => {
      learningMappingId = learningMappingId === mapping.id ? null : mapping.id;
      renderMappings();
      if (learningMappingId) {
        setMidiStatus(selectedInput ? 'LEARNING' : 'NO DEVICE', selectedInput ? 'Press a MIDI note to assign it.' : 'Select a MIDI input before learning.');
      } else {
        setMidiStatus(selectedInput ? 'LISTENING' : 'NO DEVICE', selectedInput ? `Listening to ${formatMidiDeviceName(selectedInput)}.` : 'Select a MIDI input before learning.');
      }
    });
    removeButton.addEventListener('click', () => {
      mappings = mappings.filter(item => item.id !== mapping.id);
      if (learningMappingId === mapping.id) learningMappingId = null;
      saveMappings();
      renderMappings();
    });

    els.mappingRows.appendChild(row);
  }

  if (!mappings.length) {
    els.mappingRows.innerHTML = '<div class="muted small-text midi-empty">No mappings yet.</div>';
  }
}

function renderShowSelects() {
  for (const row of els.mappingRows.querySelectorAll('.midi-map-row')) {
    const mapping = mappings.find(item => item.id === row.dataset.mappingId);
    const showSelect = row.querySelector('.midi-show-select');
    if (mapping && showSelect) renderShowOptions(showSelect, mapping.showId);
  }
}

function renderShowOptions(select, selectedShowId) {
  select.innerHTML = '<option value="">Select show</option>';
  for (const show of showsPayload?.shows || []) {
    const option = document.createElement('option');
    option.value = show.id;
    option.textContent = show.name;
    select.appendChild(option);
  }
  select.value = selectedShowId || '';
}

function updateShowSelectState(actionSelect, showSelect) {
  showSelect.disabled = actionSelect.value !== 'set_show';
}

function createMapping(overrides = {}) {
  return {
    id: `map_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    note: '',
    channel: '',
    action: 'start',
    showId: '',
    ...overrides
  };
}

function defaultMappings() {
  return [
    createMapping({ action: 'start' }),
    createMapping({ action: 'unpause' }),
    createMapping({ action: 'pause' }),
    createMapping({ action: 'stop' }),
    createMapping({ action: 'reset' })
  ];
}

function loadMappings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const loaded = Array.isArray(parsed.mappings) ? parsed.mappings : null;
    if (!loaded?.length) return defaultMappings();
    return loaded.map(item => {
      const mapping = createMapping();
      mapping.id = item.id || mapping.id;
      mapping.note = normalizeNote(item.note);
      mapping.channel = normalizeChannel(item.channel);
      mapping.action = ACTION_LABELS[item.action] ? item.action : 'start';
      mapping.showId = String(item.showId || '');
      return mapping;
    });
  } catch {
    return defaultMappings();
  }
}

function saveMappings() {
  const stored = readStoredConfig();
  stored.mappings = mappings;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function getStoredInputId() {
  return readStoredConfig().inputId || '';
}

function setStoredInputId(inputId) {
  const stored = readStoredConfig();
  stored.inputId = inputId || '';
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function readStoredConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function normalizeNote(value) {
  const note = Number(value);
  return Number.isInteger(note) && note >= 0 && note <= 127 ? note : '';
}

function normalizeChannel(value) {
  const channel = Number(value);
  return Number.isInteger(channel) && channel >= 1 && channel <= 16 ? channel : '';
}

function firstMidiInputId() {
  return midiAccess?.inputs.values().next().value?.id || '';
}

function formatMidiDeviceName(device) {
  return device?.name || [device?.manufacturer, device?.id].filter(Boolean).join(' ') || 'MIDI Input';
}

function formatMidiInput(input) {
  return `${noteName(input.note)} (${input.note}) ch ${input.channel} vel ${input.velocity}`;
}

function noteName(note) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const safe = Number(note);
  if (!Number.isInteger(safe) || safe < 0 || safe > 127) return '--';
  return `${names[safe % 12]}${Math.floor(safe / 12) - 1}`;
}

function showName(showId) {
  return showsPayload?.shows?.find(show => show.id === showId)?.name || showId || 'show';
}

function setMidiStatus(status, message = '') {
  els.midiStatus.textContent = status;
  if (message) els.midiMessage.textContent = message;
}

function logEvent(message, isError = false) {
  const line = document.createElement('div');
  line.className = `midi-event${isError ? ' error' : ''}`;
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  els.eventLog.prepend(line);

  while (els.eventLog.children.length > 40) {
    els.eventLog.lastElementChild?.remove();
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
