import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ABBREVIATIONS_FILE = path.join(DATA_DIR, 'abbreviations.json');

const FPS = 25;
const BASE_TIMECODE = '01:00:00:00';
const BASE_FRAMES = timecodeToFrames(BASE_TIMECODE, FPS);
const DEFAULT_ABBREVIATIONS = { BLACK: 'BLK', WHITE: 'WHT' };

fs.mkdirSync(DATA_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

let store = loadStore();
let abbreviations = loadAbbreviations();
let playback = {
  status: 'stopped', // stopped | playing | paused
  positionMs: 0,
  startedAtMs: 0
};

function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function loadStore() {
  if (fs.existsSync(STATE_FILE)) {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return ensureStoreShape(parsed);
  }

  const showId = newId('show');
  const initial = {
    fps: FPS,
    baseTimecode: BASE_TIMECODE,
    activeShowId: showId,
    shows: [
      {
        id: showId,
        name: 'Default Show',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timelines: []
      }
    ]
  };
  saveStore(initial);
  return initial;
}

function ensureStoreShape(input) {
  const showId = input.activeShowId || input.shows?.[0]?.id || newId('show');
  const shows = Array.isArray(input.shows) && input.shows.length
    ? input.shows
    : [{ id: showId, name: 'Default Show', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), timelines: [] }];

  for (const show of shows) {
    show.timelines ||= [];
    show.createdAt ||= new Date().toISOString();
    show.updatedAt ||= new Date().toISOString();
    for (const timeline of show.timelines) {
      normalizeTimelineCameraSources(timeline);
      timeline.transitions = normalizeTransitions(timeline.transitions || []);
    }
  }

  const output = {
    fps: FPS,
    baseTimecode: BASE_TIMECODE,
    activeShowId: showId,
    shows
  };
  recomputeAllTimelineOffsets(output);
  return output;
}

function saveStore(nextStore = store) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextStore, null, 2));
}

function loadAbbreviations() {
  if (!fs.existsSync(ABBREVIATIONS_FILE)) {
    saveAbbreviations(DEFAULT_ABBREVIATIONS);
    return { ...DEFAULT_ABBREVIATIONS };
  }

  try {
    const raw = fs.readFileSync(ABBREVIATIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeAbbreviations(parsed);
  } catch {
    saveAbbreviations(DEFAULT_ABBREVIATIONS);
    return { ...DEFAULT_ABBREVIATIONS };
  }
}

function saveAbbreviations(next = abbreviations) {
  const normalized = normalizeAbbreviations(next);
  fs.writeFileSync(ABBREVIATIONS_FILE, JSON.stringify(normalized, null, 2));
}

function normalizeAbbreviations(input) {
  const source = input && typeof input === 'object' ? input : {};
  const normalized = {};

  for (const [key, value] of Object.entries(source)) {
    const original = String(key || '').trim().toUpperCase();
    const label = String(value || '').trim();
    if (!original || !label) continue;
    normalized[original] = label.slice(0, 14);
  }

  return normalized;
}

function getActiveShow() {
  return store.shows.find(s => s.id === store.activeShowId) || store.shows[0] || null;
}

function getShow(showId) {
  return store.shows.find(s => s.id === showId) || null;
}

function getTimeline(show, timelineId) {
  return show?.timelines?.find(t => t.id === timelineId) || null;
}

function timelinePayload(timeline) {
  return {
    id: timeline.id,
    name: timeline.name,
    importedAt: timeline.importedAt,
    sourceFirstTimecode: timeline.sourceFirstTimecode,
    offsetFrames: timeline.offsetFrames || 0,
    durationFrames: timeline.durationFrames || 0,
    startTimecode: framesToTimecode(BASE_FRAMES + (timeline.offsetFrames || 0), FPS),
    durationTimecode: framesToTimecode(timeline.durationFrames || 0, FPS),
    entryCount: timeline.entries?.length || 0,
    transitions: normalizeTransitions(timeline.transitions || []),
    entries: timeline.entries || []
  };
}

function afterShowTimelineChange(show) {
  if (store.activeShowId !== show.id) return;
  setPlaybackPosition(currentPositionMs());
  broadcastShow();
  broadcastState();
}

function getShowDurationFrames(show) {
  if (!show || !show.timelines?.length) return 0;
  const last = show.timelines.at(-1);
  return (last.offsetFrames || 0) + (last.durationFrames || 0);
}

function getShowDurationMs(show) {
  return framesToMs(getShowDurationFrames(show), FPS);
}

function currentPositionMs() {
  const activeShow = getActiveShow();
  const durationMs = getShowDurationMs(activeShow);

  if (playback.status === 'playing') {
    const elapsed = Date.now() - playback.startedAtMs;
    const pos = playback.positionMs + elapsed;
    if (durationMs > 0 && pos >= durationMs) {
      playback.status = 'stopped';
      playback.positionMs = durationMs;
      playback.startedAtMs = 0;
      return durationMs;
    }
    return Math.max(0, durationMs ? Math.min(pos, durationMs) : pos);
  }

  return Math.max(0, durationMs ? Math.min(playback.positionMs, durationMs) : playback.positionMs);
}

function setPlaybackPosition(ms) {
  const durationMs = getShowDurationMs(getActiveShow());
  const clamped = Math.max(0, durationMs ? Math.min(ms, durationMs) : ms);
  playback.positionMs = clamped;
  if (playback.status === 'playing') playback.startedAtMs = Date.now();
}

function flattenShow(show) {
  if (!show) return [];
  const rows = [];

  for (const timeline of show.timelines || []) {
    const transitionByIncoming = new Map();
    const transitionByOutgoing = new Map();
    for (const transition of normalizeTransitions(timeline.transitions || [])) {
      transitionByIncoming.set(transition.toEntryId, transition);
      transitionByOutgoing.set(transition.fromEntryId, transition);
    }

    for (const entry of timeline.entries || []) {
      const showStartFrames = (timeline.offsetFrames || 0) + entry.relativeStartFrames;
      const showEndFrames = (timeline.offsetFrames || 0) + entry.relativeEndFrames;
      const transitionIn = transitionByIncoming.get(entry.id) || null;
      const transitionOut = transitionByOutgoing.get(entry.id) || null;
      const startMs = framesToMs(showStartFrames, FPS);
      const endMs = framesToMs(showEndFrames, FPS);
      rows.push({
        ...entry,
        timelineId: timeline.id,
        timelineName: timeline.name,
        timelineOffsetFrames: timeline.offsetFrames || 0,
        showStartFrames,
        showEndFrames,
        startMs,
        endMs,
        renderEndMs: endMs + (transitionOut ? framesToMs(transitionOut.durationFrames, FPS) : 0),
        transitionIn: transitionIn ? transitionPayloadForEntry(transitionIn, timeline.offsetFrames || 0, timeline.entries || []) : null,
        transitionOut: transitionOut ? transitionPayloadForEntry(transitionOut, timeline.offsetFrames || 0, timeline.entries || []) : null,
        showStartTimecode: framesToTimecode(BASE_FRAMES + showStartFrames, FPS),
        showEndTimecode: framesToTimecode(BASE_FRAMES + showEndFrames, FPS)
      });
    }
  }

  return rows.sort((a, b) => a.showStartFrames - b.showStartFrames || a.rowOrder - b.rowOrder);
}

function showPayload(show = getActiveShow()) {
  const flattened = flattenShow(show);
  const cameras = [...new Set(flattened.filter(r => r.isCamera).map(r => r.source))]
    .sort((a, b) => cameraSortKey(a) - cameraSortKey(b));

  return {
    fps: FPS,
    baseTimecode: BASE_TIMECODE,
    activeShowId: show?.id || null,
    show: show ? {
      id: show.id,
      name: show.name,
      createdAt: show.createdAt,
      updatedAt: show.updatedAt,
      timelines: show.timelines.map(t => ({
        id: t.id,
        name: t.name,
        offsetFrames: t.offsetFrames || 0,
        durationFrames: t.durationFrames || 0,
        startTimecode: framesToTimecode(BASE_FRAMES + (t.offsetFrames || 0), FPS),
        durationTimecode: framesToTimecode(t.durationFrames || 0, FPS),
        entryCount: t.entries?.length || 0,
        transitionCount: normalizeTransitions(t.transitions || []).length
      }))
    } : null,
    durationFrames: getShowDurationFrames(show),
    durationMs: getShowDurationMs(show),
    durationTimecode: framesToTimecode(getShowDurationFrames(show), FPS),
    abbreviations,
    cameras,
    entries: flattened
  };
}

function playbackPayload() {
  const activeShow = getActiveShow();
  const positionMs = currentPositionMs();
  const positionFrames = msToFrames(positionMs, FPS);
  const durationMs = getShowDurationMs(activeShow);

  return {
    type: 'state',
    status: playback.status,
    positionMs,
    positionFrames,
    serverSentAt: Date.now(),
    durationMs,
    durationFrames: getShowDurationFrames(activeShow),
    currentTimecode: framesToTimecode(BASE_FRAMES + positionFrames, FPS)
  };
}

function broadcast(payload) {
  const json = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(json);
  }
}

function broadcastShow() {
  broadcast({ type: 'show', ...showPayload() });
}

function broadcastState() {
  broadcast(playbackPayload());
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/admin/timeline', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin-timeline.html'));
});

app.get('/api/shows', (_req, res) => {
  res.json({
    fps: FPS,
    baseTimecode: BASE_TIMECODE,
    activeShowId: store.activeShowId,
    shows: store.shows.map(show => ({
      id: show.id,
      name: show.name,
      createdAt: show.createdAt,
      updatedAt: show.updatedAt,
      timelineCount: show.timelines?.length || 0,
      durationMs: getShowDurationMs(show),
      durationTimecode: framesToTimecode(getShowDurationFrames(show), FPS)
    }))
  });
});

app.post('/api/shows', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Show name is required.' });

  const show = {
    id: newId('show'),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timelines: []
  };
  store.shows.push(show);
  store.activeShowId = show.id;
  saveStore();
  setPlaybackPosition(0);
  playback.status = 'stopped';
  broadcastShow();
  broadcastState();
  res.json({ ok: true, show });
});

app.post('/api/active-show', (req, res) => {
  const showId = String(req.body?.showId || '');
  const show = getShow(showId);
  if (!show) return res.status(404).json({ error: 'Show not found.' });

  store.activeShowId = show.id;
  saveStore();
  playback.status = 'stopped';
  playback.positionMs = 0;
  playback.startedAtMs = 0;
  broadcastShow();
  broadcastState();
  res.json({ ok: true, activeShowId: show.id });
});

app.get('/api/show', (_req, res) => {
  res.json(showPayload());
});

app.get('/api/shows/:showId/timelines/:timelineId', (req, res) => {
  const show = getShow(String(req.params.showId || ''));
  if (!show) return res.status(404).json({ error: 'Show not found.' });

  const timeline = getTimeline(show, String(req.params.timelineId || ''));
  if (!timeline) return res.status(404).json({ error: 'Timeline not found.' });

  res.json({ ok: true, show: showPayload(show).show, timeline: timelinePayload(timeline) });
});

app.get('/api/state', (_req, res) => {
  res.json(playbackPayload());
});

app.get('/api/abbreviations', (_req, res) => {
  res.json({
    abbreviations,
    file: 'data/abbreviations.json'
  });
});

app.post('/api/abbreviations', (req, res) => {
  abbreviations = normalizeAbbreviations(req.body?.abbreviations || {});
  saveAbbreviations(abbreviations);
  broadcastShow();
  res.json({ ok: true, abbreviations, file: 'data/abbreviations.json' });
});

app.post('/api/import', upload.single('csv'), (req, res) => {
  const showId = String(req.body?.showId || store.activeShowId || '');
  const show = getShow(showId);
  if (!show) return res.status(404).json({ error: 'Show not found.' });

  const timelineName = String(req.body?.timelineName || '').trim();
  if (!timelineName) return res.status(400).json({ error: 'Timeline/song name is required.' });
  if (!req.file?.buffer) return res.status(400).json({ error: 'CSV file is required.' });

  const mode = String(req.body?.mode || 'append');
  const replaceTimelineId = String(req.body?.replaceTimelineId || '');

  try {
    const parsedTimeline = parseCsvTimeline(req.file.buffer.toString('utf8'), timelineName);

    if (mode === 'replace') {
      const idx = show.timelines.findIndex(t => t.id === replaceTimelineId);
      if (idx < 0) return res.status(404).json({ error: 'Timeline to replace was not found.' });
      parsedTimeline.id = replaceTimelineId;
      show.timelines[idx] = parsedTimeline;
    } else {
      show.timelines.push(parsedTimeline);
    }

    show.updatedAt = new Date().toISOString();
    recomputeTimelineOffsets(show);
    saveStore();
    store.activeShowId = show.id;
    playback.status = 'stopped';
    playback.positionMs = 0;
    playback.startedAtMs = 0;
    broadcastShow();
    broadcastState();

    res.json({ ok: true, show: showPayload(show).show });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'CSV import failed.' });
  }
});

app.post('/api/shows/:showId/timelines/:timelineId', upload.single('csv'), (req, res) => {
  const show = getShow(String(req.params.showId || ''));
  if (!show) return res.status(404).json({ error: 'Show not found.' });

  const timelineId = String(req.params.timelineId || '');
  const idx = show.timelines.findIndex(t => t.id === timelineId);
  if (idx < 0) return res.status(404).json({ error: 'Timeline not found.' });

  const timelineName = String(req.body?.timelineName || '').trim();
  if (!timelineName) return res.status(400).json({ error: 'Timeline/song name is required.' });

  try {
    if (req.file?.buffer) {
      const parsedTimeline = parseCsvTimeline(req.file.buffer.toString('utf8'), timelineName);
      parsedTimeline.id = timelineId;
      show.timelines[idx] = parsedTimeline;
    } else {
      show.timelines[idx].name = timelineName;
    }

    show.updatedAt = new Date().toISOString();
    recomputeTimelineOffsets(show);
    saveStore();
    afterShowTimelineChange(show);

    res.json({ ok: true, show: showPayload(show).show, timeline: timelinePayload(show.timelines[idx]) });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Timeline update failed.' });
  }
});

app.post('/api/shows/:showId/timelines/:timelineId/transitions', (req, res) => {
  const show = getShow(String(req.params.showId || ''));
  if (!show) return res.status(404).json({ error: 'Show not found.' });

  const timeline = getTimeline(show, String(req.params.timelineId || ''));
  if (!timeline) return res.status(404).json({ error: 'Timeline not found.' });

  try {
    timeline.transitions = normalizeTransitions(req.body?.transitions || [], timeline.entries || []);
    show.updatedAt = new Date().toISOString();
    saveStore();
    afterShowTimelineChange(show);
    res.json({ ok: true, show: showPayload(show).show, timeline: timelinePayload(timeline) });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Transition update failed.' });
  }
});

app.delete('/api/shows/:showId/timelines/:timelineId', (req, res) => {
  const show = getShow(String(req.params.showId || ''));
  if (!show) return res.status(404).json({ error: 'Show not found.' });

  const timelineId = String(req.params.timelineId || '');
  const idx = show.timelines.findIndex(t => t.id === timelineId);
  if (idx < 0) return res.status(404).json({ error: 'Timeline not found.' });

  const [removed] = show.timelines.splice(idx, 1);
  show.updatedAt = new Date().toISOString();
  recomputeTimelineOffsets(show);
  saveStore();
  afterShowTimelineChange(show);

  res.json({ ok: true, removedTimelineId: removed.id, show: showPayload(show).show });
});

app.post('/api/control', (req, res) => {
  const action = String(req.body?.action || '');
  const activeShow = getActiveShow();
  const durationMs = getShowDurationMs(activeShow);

  if (action === 'start') {
    const current = currentPositionMs();
    playback.positionMs = durationMs && current >= durationMs ? 0 : current;
    playback.startedAtMs = Date.now();
    playback.status = 'playing';
  } else if (action === 'pause') {
    playback.positionMs = currentPositionMs();
    playback.startedAtMs = 0;
    playback.status = 'paused';
  } else if (action === 'stop') {
    playback.positionMs = 0;
    playback.startedAtMs = 0;
    playback.status = 'stopped';
  } else if (action === 'reset') {
    setPlaybackPosition(0);
  } else if (action === 'seek') {
    const positionMs = Number(req.body?.positionMs);
    if (!Number.isFinite(positionMs)) return res.status(400).json({ error: 'positionMs must be a number.' });
    setPlaybackPosition(positionMs);
  } else {
    return res.status(400).json({ error: 'Unknown control action.' });
  }

  const state = playbackPayload();
  broadcast(state);
  res.json({ ok: true, state });
});

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'show', ...showPayload() }));
  socket.send(JSON.stringify(playbackPayload()));

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'syncPing') {
        socket.send(JSON.stringify({
          ...playbackPayload(),
          type: 'syncPong',
          clientSentAt: msg.clientSentAt,
          serverSentAt: Date.now()
        }));
      }
    } catch {
      // Ignore malformed client messages.
    }
  });
});

setInterval(broadcastState, 100);

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Live waterfall server running on http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});

function parseCsvTimeline(csvText, timelineName) {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true
  });

  if (!records.length) throw new Error('CSV has no rows.');

  const required = ['Index', 'Number', 'Name', 'Start', 'End', 'Duration', 'Color'];
  for (const col of required) {
    if (!(col in records[0])) throw new Error(`Missing CSV column: ${col}`);
  }

  const firstStartFrames = timecodeToFrames(records[0].Start, FPS);
  let previousStart = -Infinity;

  const entries = records.map((row, i) => {
    const startAbs = timecodeToFrames(row.Start, FPS);
    const endAbs = timecodeToFrames(row.End, FPS);
    if (endAbs < startAbs) throw new Error(`Row ${i + 2}: End is before Start.`);
    if (startAbs < previousStart) throw new Error(`Row ${i + 2}: Start time goes backwards.`);
    previousStart = startAbs;

    const relativeStartFrames = startAbs - firstStartFrames;
    const relativeEndFrames = endAbs - firstStartFrames;
    const durationFrames = Math.max(0, relativeEndFrames - relativeStartFrames);
    const name = String(row.Name || '').trim();
    const parsed = parseSourceAndDescription(name);

    return {
      id: newId('shot'),
      rowOrder: i,
      index: String(row.Index || '').trim(),
      number: String(row.Number || '').trim(),
      rawName: name,
      source: parsed.source,
      camera: parsed.isCamera ? parsed.source : null,
      isCamera: parsed.isCamera,
      description: parsed.description,
      startTimecode: row.Start,
      endTimecode: row.End,
      durationTimecode: row.Duration,
      color: normalizeColor(row.Color, parsed.isCamera),
      relativeStartFrames,
      relativeEndFrames,
      durationFrames
    };
  });

  const lastEnd = Math.max(...entries.map(e => e.relativeEndFrames));

  return {
    id: newId('timeline'),
    name: timelineName,
    importedAt: new Date().toISOString(),
    sourceFirstTimecode: records[0].Start,
    durationFrames: lastEnd,
    offsetFrames: 0,
    transitions: [],
    entries
  };
}

function normalizeTransitions(input, entries = []) {
  if (!Array.isArray(input)) return [];
  const entryIds = new Set(entries.map(entry => entry.id));
  const normalized = [];
  const seen = new Set();

  for (const transition of input) {
    const type = String(transition?.type || '').trim().toLowerCase();
    if (type !== 'mix') continue;

    const fromEntryId = String(transition?.fromEntryId || '').trim();
    const toEntryId = String(transition?.toEntryId || '').trim();
    if (!fromEntryId || !toEntryId || fromEntryId === toEntryId) continue;
    if (entryIds.size && (!entryIds.has(fromEntryId) || !entryIds.has(toEntryId))) continue;

    const durationFrames = Math.max(1, Math.round(Number(transition?.durationFrames) || FPS));
    const id = String(transition?.id || '').trim() || newId('transition');
    const key = `${fromEntryId}->${toEntryId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      id,
      type: 'mix',
      fromEntryId,
      toEntryId,
      durationFrames
    });
  }

  return normalized;
}

function transitionPayloadForEntry(transition, timelineOffsetFrames, entries) {
  const incoming = entries.find(entry => entry.id === transition.toEntryId);
  const showStartFrames = timelineOffsetFrames + (incoming?.relativeStartFrames || 0);
  return {
    id: transition.id,
    type: transition.type,
    fromEntryId: transition.fromEntryId,
    toEntryId: transition.toEntryId,
    durationFrames: transition.durationFrames,
    durationMs: framesToMs(transition.durationFrames, FPS),
    showStartFrames,
    showEndFrames: showStartFrames + transition.durationFrames,
    startMs: framesToMs(showStartFrames, FPS),
    endMs: framesToMs(showStartFrames + transition.durationFrames, FPS)
  };
}

function parseSourceAndDescription(name) {
  const normalized = name.replace(/\s+/g, ' ').trim();
  const cameraMatch = normalized.match(/^(C\d+)\s*(?:[—–-]\s*)?(.*)$/i);
  if (cameraMatch) {
    return {
      source: cameraNumber(cameraMatch[1]),
      description: cameraMatch[2]?.trim() || '',
      isCamera: true
    };
  }

  // Non-camera entries are kept as sources but are not pinnable.
  // Split only when an actual separator exists. This prevents BLACK becoming B + LACK.
  const separatorMatch = normalized.match(/^(.+?)\s+[—–-]\s+(.+)$/);
  return {
    source: ((separatorMatch?.[1] || normalized || 'SOURCE').trim()).toUpperCase(),
    description: (separatorMatch?.[2] || '').trim(),
    isCamera: false
  };
}

function normalizeTimelineCameraSources(timeline) {
  for (const entry of timeline.entries || []) {
    if (!entry?.isCamera) continue;
    const source = cameraNumber(entry.source || entry.camera || entry.rawName);
    if (!source) continue;
    entry.source = source;
    entry.camera = source;
  }
}

function cameraNumber(input) {
  const match = String(input || '').trim().match(/^C?(\d+)\b/i);
  return match ? String(Number(match[1])) : '';
}

function normalizeColor(input, isCamera) {
  const fallback = isCamera ? '#3a7dfe' : '#777777';
  const color = String(input || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

function recomputeAllTimelineOffsets(nextStore) {
  for (const show of nextStore.shows || []) recomputeTimelineOffsets(show);
}

function recomputeTimelineOffsets(show) {
  let offset = 0;
  for (const timeline of show.timelines || []) {
    timeline.offsetFrames = offset;
    timeline.durationFrames = Math.max(0, ...(timeline.entries || []).map(e => e.relativeEndFrames || 0));
    offset += timeline.durationFrames;
  }
}

function timecodeToFrames(tc, fps = FPS) {
  const match = String(tc || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid timecode: ${tc}`);
  const [, hh, mm, ss, ff] = match.map(Number);
  if (mm > 59 || ss > 59 || ff >= fps) throw new Error(`Invalid timecode value for ${fps} fps: ${tc}`);
  return (((hh * 60 + mm) * 60 + ss) * fps) + ff;
}

function framesToTimecode(frames, fps = FPS) {
  const safe = Math.max(0, Math.round(frames));
  const totalSeconds = Math.floor(safe / fps);
  const ff = safe % fps;
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

function framesToMs(frames, fps = FPS) {
  return frames * 1000 / fps;
}

function msToFrames(ms, fps = FPS) {
  return Math.round(ms * fps / 1000);
}

function pad2(n) {
  return String(Math.floor(n)).padStart(2, '0');
}

function cameraSortKey(camera) {
  const n = Number(cameraNumber(camera));
  return Number.isFinite(n) ? n : 9999;
}
