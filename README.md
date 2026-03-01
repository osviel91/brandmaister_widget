# BrandMeister Talkgroup Activity Widget

A lightweight macOS-friendly widget page that shows recent contact activity for one BrandMeister talkgroup.

## What it does

- Pulls recent traffic from a configurable BrandMeister endpoint.
- Filters events by a selected talkgroup (TG).
- Shows callsign, DMR ID, timestamp, and duration.
- Shows operator name (when present in BM payload) and TG region label.
- Highlights current transmission in an `On Air Now` panel.
- Moves advanced connection settings into a `Config` popup.
- Shows live throughput (`events/min`) in header.
- Supports compact layout and optional debug panel toggle.
- Uses reconnect backoff for realtime sources.
- Keeps a local history log (browser storage) and supports `Clear log`.
- Supports two source types:
  - `REST`: polling JSON endpoint.
  - `WebSocket`: raw websocket live feed endpoint.
  - `Socket.IO`: socket.io live feed endpoint.

## Files

- `index.html` - widget UI
- `style.css` - widget styling
- `widget.js` - data fetch, normalization, filtering, rendering
- `server.js` - local proxy + static file server
- `Dockerfile` - container image
- `compose.deploy.yml` - deploy stack with auto-update (Watchtower)
- `.github/workflows/docker-publish.yml` - GHCR publish on push to `main`

## Run locally (recommended)

Run the included proxy server (solves most CORS/auth issues):

```bash
node server.js
```

Then open: `http://127.0.0.1:8787`

Optional env vars:

```bash
BM_API_KEY=your_token BM_UPSTREAM='https://api.brandmeister.network/v2/talkgroup' node server.js
```

## WidgetKit API endpoints

Server now exposes:

- `GET /widget/contacts?tg=214&limit=8`
- `POST /widget/ingest` with body `{ \"events\": [...] }`

`/widget/contacts` response format:

```json
{
  "tg": 214,
  "updatedAt": 1772372102,
  "contacts": [
    {
      "time": 1772372102,
      "callsign": "EA4CQH",
      "name": "Gregorio",
      "dmrId": "2143971",
      "tg": 214,
      "region": "Spain",
      "durationSec": 1
    }
  ]
}
```

History persistence:

- Path: `BM_HISTORY_PATH` (default `./widget-history.json`)
- Limit: `BM_HISTORY_LIMIT` (default `5000`)

Optional bootstrap source if no history exists:

- `BM_WIDGET_UPSTREAM` endpoint template (supports `{tg}`, `{talkgroup}`, `{limit}`)

## GitHub -> Container Auto Deploy (ZimaOS)

This repo includes a full GHCR publish + auto-update flow.

### 1) Push to GitHub

Create repo and push this project to `main`.
The workflow publishes:

- `ghcr.io/<owner>/<repo>:latest`
- `ghcr.io/<owner>/<repo>:sha-...`

### 2) Make GHCR image accessible

If your package is private, log in on ZimaOS with a GitHub token that has `read:packages`.
If public, no login is needed on ZimaOS.

### 3) Deploy on ZimaOS

Copy `compose.deploy.yml` to your board and replace:

- `REPLACE_OWNER`
- `REPLACE_REPO`

Run:

```bash
docker compose -f compose.deploy.yml up -d
```

Open:

- `http://<zima-ip>:8787`

### 4) Auto update behavior

`watchtower` checks every 120 seconds and updates the widget container when `:latest` changes, then removes old image layers (`--cleanup`).

### 5) Optional GHCR auth on ZimaOS

```bash
echo "<GH_TOKEN>" | docker login ghcr.io -u "<GH_USERNAME>" --password-stdin
```

## Configuration

Use the controls in the widget:

- **Talkgroup**: TG number to monitor (example: `214`).
- **Data source**: `REST`, `WebSocket`, or `Socket.IO`.
- **Endpoint URL**: BrandMeister endpoint template.
- **Auth mode**: choose how to send API Manager credentials.
- **API key / token**: value generated in BrandMeister API Manager.
- **Poll (sec)**: only used for REST mode.
- **Clear log**: clears stored contact history in this browser.

Endpoint URL also supports placeholders:

- `{tg}` or `{talkgroup}` -> selected talkgroup
- `{limit}` -> max rows

Example:

- `https://api.brandmeister.network/v2/lastheard?limit={limit}`

Config and contact history are persisted in browser `localStorage`.

## Why it may fail without proxy

Direct browser calls to BrandMeister may fail with CORS or auth header restrictions.
The included `server.js` proxies requests from your local machine to BM and returns JSON to the widget.

## BrandMeister endpoint + auth notes

BrandMeister has changed/publicly limited some endpoints over time, and some are region/proxy-specific.

The API manager page you shared is:

- [https://help.brandmeister.network/hotspots/api-manager/](https://help.brandmeister.network/hotspots/api-manager/)

That page explains how to generate API keys for account/hotspot APIs. In this widget, you can test any endpoint by setting:

- `Auth mode = Bearer token` (sends `Authorization: Bearer <token>`)
- `Auth mode = X-API-Key` (sends `X-API-Key: <token>`)
- `Auth mode = apiKey` (sends `apiKey: <token>`)

Try one of these patterns first:

- Socket.IO candidate: `https://api.brandmeister.network` (widget tests `/infoService/`, `/tetralh/`, `/socket.io/`, `/lh/`)
- WebSocket candidate: `wss://api.brandmeister.network/infoService/` (if raw WS mode is needed)
- REST candidate: custom endpoint from your API docs (the old `v2/lastheard` route may return 404)

For raw `WebSocket` source, the widget auto-adds `subscribe=<talkgroup>` query if missing.

If your endpoint payload uses different field names, edit normalization in:

- `normalizeEvent()` in `widget.js`
- `extractEvents()` in `widget.js`

These two functions are intentionally flexible to map alternate payload structures.

The widget now also shows a debug box with:

- first event raw keys
- normalized preview
- raw sample JSON

Use that to confirm mapping quickly.

## Validate API doc endpoint quickly

If docs are restricted in browser, test with curl in your machine:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" "https://api.brandmeister.network/docs/"
```

or:

```bash
curl -H "X-API-Key: YOUR_TOKEN" "https://api.brandmeister.network/docs/"
```

## Make it a desktop widget on macOS

You can embed this in tools like Übersicht/SwiftBar webview wrappers, or just pin it in a browser app window.
