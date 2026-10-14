import { spawn } from 'child_process';
import fs from 'fs';

const DEFAULT_MIDI_CONFIG = {
  enabled: false,
  inputPort: '',
  aseqdumpPath: '',
  reconnectMs: 2000
};

function defaultMidiConfig() {
  return { ...DEFAULT_MIDI_CONFIG };
}

function loadMidiConfig(filePath, env = process.env) {
  let config = defaultMidiConfig();

  if (fs.existsSync(filePath)) {
    try {
      config = normalizeMidiConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {
      config = defaultMidiConfig();
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    }
  } else {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  }

  return applyMidiEnvOverrides(config, env);
}

function applyMidiEnvOverrides(config, env) {
  const next = { ...config };

  if (env.MIDI_ENABLED !== undefined) {
    next.enabled = ['1', 'true', 'yes', 'on'].includes(String(env.MIDI_ENABLED).trim().toLowerCase());
  }

  if (env.MIDI_INPUT_PORT !== undefined) {
    next.inputPort = String(env.MIDI_INPUT_PORT || '').trim();
  }

  if (env.MIDI_ASEQDUMP_PATH !== undefined) {
    next.aseqdumpPath = String(env.MIDI_ASEQDUMP_PATH || '').trim();
  }

  return normalizeMidiConfig(next);
}

function normalizeMidiConfig(input) {
  const reconnectMs = Number(input?.reconnectMs);

  return {
    enabled: Boolean(input?.enabled),
    inputPort: String(input?.inputPort || '').trim(),
    aseqdumpPath: String(input?.aseqdumpPath || '').trim(),
    reconnectMs: Number.isFinite(reconnectMs)
      ? Math.max(250, Math.min(30000, Math.round(reconnectMs)))
      : DEFAULT_MIDI_CONFIG.reconnectMs
  };
}

function startMidiInputLogger({ config, logger = console, onEvent = null } = {}) {
  const midiConfig = normalizeMidiConfig(config || {});
  let child = null;
  let reconnectTimer = null;
  let stopped = false;
  let triedFallback = false;
  const aseqdumpCommand = resolveAseqdumpCommand(midiConfig.aseqdumpPath);

  const runtime = {
    config: midiConfig,
    get running() {
      return Boolean(child && !child.killed);
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (child && !child.killed) child.kill('SIGTERM');
    }
  };

  if (!midiConfig.enabled) {
    logger.log('[MIDI] Input logging disabled.');
    return runtime;
  }

  if (!midiConfig.inputPort) {
    logger.warn('[MIDI] Input logging enabled, but no inputPort is configured.');
    return runtime;
  }

  function start({ fallback = false } = {}) {
    if (stopped) return;

    const command = fallback ? aseqdumpCommand : 'stdbuf';
    const args = fallback
      ? ['-p', midiConfig.inputPort]
      : ['-oL', aseqdumpCommand, '-p', midiConfig.inputPort];

    child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    logger.log(`[MIDI] Listening on ALSA port ${midiConfig.inputPort} via ${fallback ? aseqdumpCommand : `stdbuf/${aseqdumpCommand}`}.`);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const event = parseAseqdumpLine(line);
        if (!event) continue;
        if (onEvent) onEvent(event);
        else logger.log(`[MIDI] ${formatMidiEvent(event)}`);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      for (const line of String(chunk).split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
        logger.warn(`[MIDI] ${line}`);
        if (!fallback && line.includes('No such file or directory') && line.includes('aseqdump')) {
          triedFallback = true;
        }
      }
    });

    child.on('error', err => {
      if (!fallback && err.code === 'ENOENT' && !triedFallback) {
        triedFallback = true;
        logger.warn('[MIDI] stdbuf not found; retrying with aseqdump directly.');
        start({ fallback: true });
        return;
      }
      logger.warn(`[MIDI] Failed to start MIDI input logger: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      child = null;
      if (stopped) return;
      logger.warn(`[MIDI] aseqdump exited${signal ? ` from ${signal}` : ''}${code !== null ? ` with code ${code}` : ''}.`);
      reconnectTimer = setTimeout(() => start({ fallback: triedFallback }), midiConfig.reconnectMs);
    });
  }

  start();
  return runtime;
}

function resolveAseqdumpCommand(configuredPath = '') {
  const configured = String(configuredPath || '').trim();
  if (configured) return configured;

  for (const candidate of ['/usr/bin/aseqdump', '/bin/aseqdump', '/usr/local/bin/aseqdump']) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return 'aseqdump';
}

function parseAseqdumpLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('Source ') || text.startsWith('Waiting for data')) return null;

  const sourceMatch = text.match(/^(\d+:\d+)\s+(.*)$/);
  if (!sourceMatch) return null;

  const [, source, rest] = sourceMatch;
  const noteOn = rest.match(/^Note on\s+(\d+),\s+note\s+(\d+),\s+velocity\s+(\d+)/i);
  if (noteOn) {
    const velocity = Number(noteOn[3]);
    return {
      type: velocity === 0 ? 'note_off' : 'note_on',
      source,
      channel: Number(noteOn[1]) + 1,
      note: Number(noteOn[2]),
      velocity,
      raw: text
    };
  }

  const noteOff = rest.match(/^Note off\s+(\d+),\s+note\s+(\d+),\s+velocity\s+(\d+)/i);
  if (noteOff) {
    return {
      type: 'note_off',
      source,
      channel: Number(noteOff[1]) + 1,
      note: Number(noteOff[2]),
      velocity: Number(noteOff[3]),
      raw: text
    };
  }

  const controlChange = rest.match(/^Control change\s+(\d+),\s+controller\s+(\d+),\s+value\s+(\d+)/i);
  if (controlChange) {
    return {
      type: 'control_change',
      source,
      channel: Number(controlChange[1]) + 1,
      controller: Number(controlChange[2]),
      value: Number(controlChange[3]),
      raw: text
    };
  }

  const programChange = rest.match(/^Program change\s+(\d+),\s+program\s+(\d+)/i);
  if (programChange) {
    return {
      type: 'program_change',
      source,
      channel: Number(programChange[1]) + 1,
      program: Number(programChange[2]),
      raw: text
    };
  }

  return {
    type: 'unknown',
    source,
    raw: text
  };
}

function formatMidiEvent(event) {
  if (!event) return '';

  if (event.type === 'note_on') {
    return `Note On ch=${event.channel} note=${event.note} velocity=${event.velocity} source=${event.source}`;
  }

  if (event.type === 'note_off') {
    return `Note Off ch=${event.channel} note=${event.note} velocity=${event.velocity} source=${event.source}`;
  }

  if (event.type === 'control_change') {
    return `CC ch=${event.channel} controller=${event.controller} value=${event.value} source=${event.source}`;
  }

  if (event.type === 'program_change') {
    return `Program Change ch=${event.channel} program=${event.program} source=${event.source}`;
  }

  return `Unknown source=${event.source} raw="${event.raw}"`;
}

export {
  defaultMidiConfig,
  formatMidiEvent,
  loadMidiConfig,
  normalizeMidiConfig,
  parseAseqdumpLine,
  startMidiInputLogger
};
