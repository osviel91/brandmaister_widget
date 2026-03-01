const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;

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

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
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

  if (req.method === 'GET' && reqUrl.pathname === '/api/lastheard') {
    handleProxy(req, res, reqUrl);
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

server.listen(PORT, HOST, () => {
  console.log(`BM widget running on http://${HOST}:${PORT}`);
});
