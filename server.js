const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const HISTORY_PATH = process.env.BM_HISTORY_PATH || path.join(ROOT, 'widget-history.json');
const HISTORY_LIMIT = Number(process.env.BM_HISTORY_LIMIT || 5000);
const WIDGET_UPSTREAM =
  process.env.BM_WIDGET_UPSTREAM ||
  process.env.BM_UPSTREAM ||
  'https://api.brandmeister.network/v2/lastheard?limit={limit}';
const TG_REGION_UPSTREAM = process.env.BM_TG_REGION_UPSTREAM || 'https://api.brandmeister.network/v2/talkgroup';
const TOKEN_SEED = process.env.BM_TOKEN_SEED || '';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const DEFAULT_UPSTREAM =
  process.env.BM_UPSTREAM || 'https://api.brandmeister.network/v2/lastheard?limit={limit}';
let history = [];
let tgRegionMap = {};
let tgRegionLoadedAt = 0;

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, Authorization, X-API-Key, apiKey, X-Widget-Token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function base64urlToBuffer(value) {
  if (typeof value !== 'string' || !value.length) return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
}

function readWidgetToken(req) {
  const fromHeader = String(req.headers['x-widget-token'] || '').trim();
  if (fromHeader) return fromHeader;
  const auth = String(req.headers.authorization || '').trim();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function verifyWidgetToken(token) {
  if (!TOKEN_SEED) return true;
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return false;

  const expectedSig = crypto.createHmac('sha256', TOKEN_SEED).update(payloadB64).digest();
  const tokenSig = base64urlToBuffer(sigB64);
  if (!tokenSig || tokenSig.length !== expectedSig.length) return false;
  if (!crypto.timingSafeEqual(tokenSig, expectedSig)) return false;

  const payloadBuffer = base64urlToBuffer(payloadB64);
  if (!payloadBuffer) return false;

  let payload = null;
  try {
    payload = JSON.parse(payloadBuffer.toString('utf8'));
  } catch {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload && typeof payload === 'object') {
    if (payload.nbf != null && Number(payload.nbf) > now) return false;
    if (payload.exp != null && Number(payload.exp) < now) return false;
  }
  return true;
}

function ensureAuthorized(req, res) {
  if (!TOKEN_SEED) return true;
  const token = readWidgetToken(req);
  if (verifyWidgetToken(token)) return true;
  console.warn(`Unauthorized request: ${req.method} ${req.url}`);
  send(
    res,
    401,
    JSON.stringify({ error: 'Unauthorized. Missing or invalid widget token.' }),
    'application/json; charset=utf-8'
  );
  return false;
}

function buildUpstreamUrl(template, talkgroup, limit) {
  return template
    .replaceAll('{tg}', String(talkgroup))
    .replaceAll('{talkgroup}', String(talkgroup))
    .replaceAll('{limit}', String(limit));
}

function buildAuthHeaders(authMode, apiKey) {
  const headers = { Accept: 'application/json' };
  if (!apiKey || authMode === 'none') return headers;

  if (authMode === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  if (authMode === 'x-api-key') headers['X-API-Key'] = apiKey;
  if (authMode === 'api-key') headers.apiKey = apiKey;
  return headers;
}

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value > 1_000_000_000_000 ? value : value * 1000;
  const n = Number(value);
  if (!Number.isNaN(n)) return n > 1_000_000_000_000 ? n : n * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function decodeJsonMaybe(value, depth = 3) {
  let current = value;
  for (let i = 0; i < depth; i += 1) {
    if (typeof current !== 'string') return current;
    const trimmed = current.trim();
    if (!trimmed) return current;
    try {
      current = JSON.parse(trimmed);
      continue;
    } catch {
      if (trimmed.startsWith('{\\\"') && trimmed.endsWith('}')) {
        try {
          current = JSON.parse(`"${trimmed.replace(/"/g, '\\"')}"`);
          continue;
        } catch {
          return current;
        }
      }
      return current;
    }
  }
  return current;
}

function pick(obj, keys, fallback = null) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

function safeParseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeIncomingEvent(raw) {
  let event = raw;
  if (raw?.payload && typeof raw.payload === 'object') event = raw.payload;
  if (raw?.payload && typeof raw.payload === 'string') {
    const decoded = decodeJsonMaybe(raw.payload, 4);
    event = typeof decoded === 'object' && decoded != null ? decoded : raw;
  }
  if (typeof event === 'string') {
    const decodedEvent = decodeJsonMaybe(event, 4);
    event = typeof decodedEvent === 'object' && decodedEvent != null ? decodedEvent : raw;
  }

  const tgText = pick(event, [
    'DestinationName',
    'destinationName',
    'DestinationPointName',
    'destinationPointName',
    'DestinationCall',
    'destinationCall',
  ]);
  let tgFromText = null;
  if (typeof tgText === 'string') {
    const m = tgText.match(/\((\d{1,8})\)/);
    if (m) tgFromText = Number(m[1]);
    if (!Number.isFinite(tgFromText)) {
      const m2 = tgText.match(/\bTG\s*(\d{1,8})\b/i);
      if (m2) tgFromText = Number(m2[1]);
    }
  }

  const tg = toNumberOrNull(
    pick(event, [
      'tgid',
      'talkgroup',
      'destination',
      'destinationid',
      'DestinationID',
      'DestinationPointID',
      'dst',
      'to',
      'talkGroup',
      'talk_group',
      'Number',
      'number',
    ])
  );

  const timeMs = toEpochMs(
    pick(event, ['timestamp', 'time', 'Time', 'Start', 'start', 'seen', 'last_seen', 'date'])
  );
  const destinationText =
    pick(event, [
      'DestinationName',
      'destinationName',
      'DestinationPointName',
      'destinationPointName',
      'DestinationCall',
      'destinationCall',
    ]) || '';
  const dmrId = String(
    pick(event, ['dmrid', 'id', 'src', 'source', 'SourceID', 'sourceid', 'subscriber', 'radio_id'], '')
  );
  const callsign = String(
    pick(event, ['callsign', 'call', 'SourceCall', 'sourceCall', 'source_callsign'], 'Unknown')
  );
  const name = String(pick(event, ['SourceName', 'sourceName', 'name', 'operatorName'], ''));
  const durationSec = Number(
    pick(event, ['duration', 'Duration', 'duration_sec', 'slot_time', 'Length', 'length'], 0)
  ) || 0;
  const region = String(tgRegionMap[String(tg)] || '');
  const dedupeKey = `${pick(event, ['SessionID', 'sessionId'], '')}:${pick(
    event,
    ['Updated', 'updated', 'time', 'timestamp'],
    ''
  )}:${dmrId}:${Number.isFinite(tg) ? tg : ''}`;

  return {
    time: timeMs ? Math.floor(timeMs / 1000) : 0,
    callsign,
    name,
    dmrId,
    tg: Number.isFinite(tg) ? tg : Number.isFinite(tgFromText) ? tgFromText : null,
    region,
    durationSec,
    destinationText: String(destinationText || ''),
    dedupeKey,
  };
}

function matchesTalkgroup(entry, tg) {
  if (!tg) return true;
  if (entry.tg === tg) return true;
  const text = String(entry.destinationText || '');
  if (!text) return false;
  if (text.includes(`(${tg})`)) return true;
  if (text.match(new RegExp(`\\bTG\\s*${tg}\\b`, 'i'))) return true;
  if (text.trim() === String(tg)) return true;
  return false;
}

function loadHistoryFromDisk() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Try to recover from partially corrupted files (e.g. conflict markers).
    try {
      const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
      const start = raw.indexOf('[');
      const end = raw.lastIndexOf(']');
      if (start >= 0 && end > start) {
        const maybeArray = raw.slice(start, end + 1);
        const parsed = JSON.parse(maybeArray);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return [];
  }
}

function saveHistoryToDisk() {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
  } catch {
    // Ignore write failures.
  }
}

function mergeContacts(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const normalized = entries.map(normalizeIncomingEvent).filter((e) => e.time > 0 && e.callsign);
  if (!normalized.length) return;
  const seen = new Set(history.map((e) => e.dedupeKey));
  for (const item of normalized) {
    if (item.dedupeKey && seen.has(item.dedupeKey)) continue;
    if (item.dedupeKey) seen.add(item.dedupeKey);
    history.push(item);
  }
  history.sort((a, b) => (b.time || 0) - (a.time || 0));
  if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
  saveHistoryToDisk();
}

async function ensureTgRegionMap() {
  if (Date.now() - tgRegionLoadedAt < 6 * 60 * 60 * 1000 && Object.keys(tgRegionMap).length) return;
  try {
    const response = await fetch(TG_REGION_UPSTREAM, { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      tgRegionMap = payload;
      tgRegionLoadedAt = Date.now();
    }
  } catch {
    // Non-fatal.
  }
}

async function fetchWidgetUpstream(tg, limit) {
  // BM lastheard is global and often needs a larger window before TG filtering.
  const upstreamLimit = Math.max(limit * 40, 250);
  const upstreamUrl = buildUpstreamUrl(WIDGET_UPSTREAM, tg, upstreamLimit);
  const response = await fetch(upstreamUrl, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  const payload = await response.json();
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.results)
          ? payload.results
          : Array.isArray(payload?.lastheard)
            ? payload.lastheard
            : [];
  return list;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function handleProxy(req, res, reqUrl) {
  const talkgroup = Number(reqUrl.searchParams.get('talkgroup') || 214);
  const limit = Number(reqUrl.searchParams.get('limit') || 20);
  const endpointTemplate = req.headers['x-upstream-url'] || DEFAULT_UPSTREAM;
  const authMode = req.headers['x-auth-mode'] || 'none';
  const apiKey = req.headers['x-api-key'] || process.env.BM_API_KEY || '';

  const upstreamUrl = buildUpstreamUrl(endpointTemplate, talkgroup, limit);
  const headers = buildAuthHeaders(authMode, apiKey);

  try {
    const upstreamResponse = await fetch(upstreamUrl, { headers });
    const text = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      send(
        res,
        upstreamResponse.status,
        JSON.stringify({
          error: `Upstream HTTP ${upstreamResponse.status}`,
          upstreamUrl,
          upstreamBody: text.slice(0, 500),
        }),
        'application/json; charset=utf-8'
      );
      return;
    }

    send(res, 200, text, 'application/json; charset=utf-8');
  } catch (error) {
    send(
      res,
      502,
      JSON.stringify({ error: error.message, upstreamUrl }),
      'application/json; charset=utf-8'
    );
  }
}

async function handleWidgetContacts(req, res, reqUrl) {
  const tg = Number(reqUrl.searchParams.get('tg') || reqUrl.searchParams.get('talkgroup') || 214);
  const limit = Number(reqUrl.searchParams.get('limit') || 8);
  await ensureTgRegionMap();

  if (!history.length) {
    try {
      const upstreamRows = await fetchWidgetUpstream(tg, limit);
      mergeContacts(upstreamRows);
    } catch {
      // ignore
    }
  }

  let filtered = history.filter((e) => matchesTalkgroup(e, tg)).slice(0, limit);
  // If TG-specific list is empty/stale, top up from upstream and filter again.
  if (filtered.length < limit) {
    try {
      const upstreamRows = await fetchWidgetUpstream(tg, limit);
      mergeContacts(upstreamRows);
      filtered = history.filter((e) => matchesTalkgroup(e, tg)).slice(0, limit);
    } catch {
      // ignore
    }
  }
  send(
    res,
    200,
    JSON.stringify({
      tg,
      updatedAt: Math.floor(Date.now() / 1000),
      contacts: filtered.map((e) => ({
        time: e.time,
        callsign: e.callsign,
        name: e.name,
        dmrId: e.dmrId,
        tg: e.tg,
        region: e.region || tgRegionMap[String(e.tg)] || '',
        durationSec: e.durationSec || 0,
      })),
    }),
    'application/json; charset=utf-8'
  );
}

async function handleWidgetIngest(req, res) {
  const payload = await parseBody(req);
  const events = Array.isArray(payload?.events) ? payload.events : [];
  await ensureTgRegionMap();
  mergeContacts(events);
  send(
    res,
    200,
    JSON.stringify({ ok: true, inserted: events.length, total: history.length }),
    'application/json; charset=utf-8'
  );
}

function handleStatic(req, res, reqUrl) {
  let reqPath = reqUrl.pathname === '/' ? '/index.html' : reqUrl.pathname;
  reqPath = path.normalize(reqPath).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(ROOT, reqPath);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    send(res, 200, data, contentType);
  });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/lastheard') {
    if (!ensureAuthorized(req, res)) return;
    handleProxy(req, res, reqUrl);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/widget/contacts') {
    if (!ensureAuthorized(req, res)) return;
    handleWidgetContacts(req, res, reqUrl);
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/widget/ingest') {
    if (!ensureAuthorized(req, res)) return;
    handleWidgetIngest(req, res);
    return;
  }

  if (req.method === 'GET') {
    handleStatic(req, res, reqUrl);
    return;
  }

  send(res, 405, 'Method Not Allowed');
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});

history = loadHistoryFromDisk();
if (history.length) saveHistoryToDisk();
ensureTgRegionMap();

server.listen(PORT, HOST, () => {
  console.log(`BM widget running on http://${HOST}:${PORT}`);
});
