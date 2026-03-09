const STORAGE_KEY = "bm-widget-config-v1";
const HISTORY_STORAGE_KEY = "bm-widget-history-v1";
const HISTORY_LIMIT = 5000;

const els = {
  title: document.getElementById("title"),
  status: document.getElementById("status"),
  eventsPerMin: document.getElementById("eventsPerMin"),
  updatedAt: document.getElementById("updatedAt"),
  onAirCallsign: document.getElementById("onAirCallsign"),
  onAirName: document.getElementById("onAirName"),
  onAirTg: document.getElementById("onAirTg"),
  onAirRegion: document.getElementById("onAirRegion"),
  onAirDmr: document.getElementById("onAirDmr"),
  onAirLast: document.getElementById("onAirLast"),
  onAirState: document.getElementById("onAirState"),
  onAirTime: document.getElementById("onAirTime"),
  talkgroupInput: document.getElementById("talkgroupInput"),
  maxRowsInput: document.getElementById("maxRowsInput"),
  filterModeInput: document.getElementById("filterModeInput"),
  debugToggleInput: document.getElementById("debugToggleInput"),
  pollSecInput: document.getElementById("pollSecInput"),
  sourceTypeInput: document.getElementById("sourceTypeInput"),
  endpointInput: document.getElementById("endpointInput"),
  authModeInput: document.getElementById("authModeInput"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  widgetTokenInput: document.getElementById("widgetTokenInput"),
  applyBtn: document.getElementById("applyBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  configBtn: document.getElementById("configBtn"),
  configDialog: document.getElementById("configDialog"),
  closeConfigBtn: document.getElementById("closeConfigBtn"),
  rows: document.getElementById("rows"),
  debugBox: document.getElementById("debugBox"),
};

let pollTimer = null;
let socket = null;
let ws = null;
let wsRetryTimer = null;
let wsReconnectAttempts = 0;
const recentEventTimes = [];
let historyEvents = [];
let tgRegionMap = {};

const defaults = {
  talkgroup: 214,
  maxRows: 8,
  pollSec: 20,
  sourceType: "socket",
  endpoint: "https://api.brandmeister.network",
  filterMode: "talkgroup",
  showDebug: false,
  authMode: "none",
  apiKey: "",
  widgetToken: "",
};

function normalizeEndpointTemplate(endpoint) {
  let value = String(endpoint || "").trim();
  if (!value) return defaults.endpoint;

  // Migrate old invalid pattern: /v2/lastheard/{tg} or /v2/lastheard/214
  value = value.replace(
    /\/v2\/lastheard\/(\{(?:tg|talkgroup)\}|\d+)(?=\?|$)/,
    "/v2/lastheard"
  );

  // If endpoint is lastheard without limit query, add it.
  if (/\/v2\/lastheard(?:\?.*)?$/.test(value) && !/[?&]limit=/.test(value)) {
    value += value.includes("?") ? "&limit={limit}" : "?limit={limit}";
  }

  return value;
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaults };
    const merged = { ...defaults, ...JSON.parse(raw) };
    merged.endpoint = normalizeEndpointTemplate(merged.endpoint);
    if (
      (merged.sourceType === "socket" || merged.sourceType === "websocket") &&
      (/hose\.brandmeister\.network/i.test(merged.endpoint) || /\/v2\/lastheard/i.test(merged.endpoint))
    ) {
      merged.endpoint = "https://api.brandmeister.network";
    }
    return merged;
  } catch {
    return { ...defaults };
  }
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveHistory(events) {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(events.slice(0, HISTORY_LIMIT)));
}

function mergeHistory(rawEvents) {
  if (!Array.isArray(rawEvents) || !rawEvents.length) return;
  const normalized = rawEvents.map(normalizeEvent);
  const byKey = new Set(historyEvents.map((e) => e.dedupeKey));
  for (const ev of normalized) {
    if (!ev.dedupeKey || byKey.has(ev.dedupeKey)) continue;
    byKey.add(ev.dedupeKey);
    historyEvents.push(ev);
  }
  historyEvents.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
  if (historyEvents.length > HISTORY_LIMIT) {
    historyEvents = historyEvents.slice(0, HISTORY_LIMIT);
  }
  saveHistory(historyEvents);
}

function getServiceAuthHeaders(config) {
  const token = String(config?.widgetToken || "").trim();
  if (!token) return {};
  return {
    "X-Widget-Token": token,
  };
}

async function loadTalkgroupRegions(config) {
  try {
    const proxyUrl = new URL("/api/lastheard", window.location.origin);
    proxyUrl.searchParams.set("talkgroup", String(config.talkgroup || 214));
    proxyUrl.searchParams.set("limit", "1");
    const response = await fetch(proxyUrl.toString(), {
      headers: {
        "X-Upstream-Url": "https://api.brandmeister.network/v2/talkgroup",
        "X-Auth-Mode": config.authMode || "none",
        "X-Api-Key": config.apiKey || "",
        ...getServiceAuthHeaders(config),
      },
    });
    if (!response.ok) return;
    const payload = await response.json();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      tgRegionMap = payload;
    }
  } catch {
    // Non-critical metadata endpoint.
  }
}

async function pushEventsToServer(events, config) {
  if (!Array.isArray(events) || !events.length) return;
  try {
    const response = await fetch('/widget/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getServiceAuthHeaders(config),
      },
      body: JSON.stringify({ events }),
    });
    if (!response.ok) {
      let details = '';
      try {
        details = await response.text();
      } catch {
        // ignore
      }
      const msg = details?.slice?.(0, 120) || `HTTP ${response.status}`;
      setStatus(`Ingest failed: ${msg}`, 'warn');
    }
  } catch {
    setStatus('Ingest failed: network error', 'warn');
  }
}

function setStatus(text, tone = "idle") {
  els.status.textContent = text;
  els.status.className = `status status--${tone}`;
}

function updateEventsRate() {
  const now = Date.now();
  while (recentEventTimes.length && now - recentEventTimes[0] > 60_000) {
    recentEventTimes.shift();
  }
  els.eventsPerMin.textContent = `${recentEventTimes.length} ev/min`;
}

function noteEvents(count = 1) {
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    recentEventTimes.push(now);
  }
  updateEventsRate();
}

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (value > 1_000_000_000_000) return value;
    return value * 1000;
  }
  const asNum = Number(value);
  if (!Number.isNaN(asNum)) {
    return asNum > 1_000_000_000_000 ? asNum : asNum * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function pick(obj, keys, fallback = null) {
  for (const key of keys) {
    if (obj?.[key] != null && obj[key] !== "") return obj[key];
  }
  return fallback;
}

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function decodeJsonMaybe(value, depth = 3) {
  let current = value;
  for (let i = 0; i < depth; i += 1) {
    if (typeof current !== "string") return current;
    const trimmed = current.trim();
    if (!trimmed) return current;
    try {
      current = JSON.parse(trimmed);
      continue;
    } catch {
      // Some feeds send an extra-escaped JSON object string.
      if (trimmed.startsWith("{\\\"") && trimmed.endsWith("}")) {
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

function normalizeEvent(raw) {
  let event = raw;
  if (raw?.payload && typeof raw.payload === "object") event = raw.payload;
  if (raw?.payload && typeof raw.payload === "string") {
    const decoded = decodeJsonMaybe(raw.payload, 4);
    event = typeof decoded === "object" && decoded != null ? decoded : raw;
  }
  if (typeof event === "string") {
    const decodedEvent = decodeJsonMaybe(event, 4);
    event = typeof decodedEvent === "object" && decodedEvent != null ? decodedEvent : raw;
  }

  const tgText = pick(event, [
    "DestinationName",
    "destinationName",
    "DestinationPointName",
    "destinationPointName",
    "DestinationCall",
    "destinationCall",
  ]);
  let tgFromText = null;
  if (typeof tgText === "string") {
    const m = tgText.match(/\((\d{1,8})\)/);
    if (m) tgFromText = Number(m[1]);
  }

  const tg = toNumberOrNull(
    pick(event, [
      "tgid",
      "talkgroup",
      "destination",
      "destinationid",
      "DestinationID",
      "DestinationPointID",
      "dst",
      "to",
      "talkGroup",
      "talk_group",
      "Number",
      "number",
    ])
  );

  const dmrId = pick(event, [
    "dmrid",
    "id",
    "src",
    "source",
    "SourceID",
    "sourceid",
    "subscriber",
    "radio_id",
  ]);
  const callsign = pick(event, [
    "callsign",
    "call",
    "Callsign",
    "SourceCall",
    "sourcecall",
    "source_callsign",
    "srcCall",
    "sourceCall",
    "name",
    "alias",
  ]);
  const operatorName = pick(event, [
    "SourceName",
    "sourceName",
    "name",
    "operatorName",
    "fname",
    "first_name",
  ]);

  const timestampMs = toEpochMs(
    pick(event, [
      "timestamp",
      "time",
      "Time",
      "seen",
      "last_seen",
      "date",
      "created_at",
      "Start",
      "start",
    ])
  );

  const durationSec = Number(
    pick(event, ["duration", "Duration", "duration_sec", "slot_time", "Length", "length"], 0)
  ) || 0;

  const destinationText =
    pick(event, [
      "DestinationName",
      "destinationName",
      "DestinationPointName",
      "destinationPointName",
      "DestinationCall",
      "destinationCall",
    ]) || "";

  const sessionId = pick(event, ["SessionID", "sessionId", "session_id"]);
  const updated = pick(event, ["Updated", "updated", "timestamp", "time"]);

  return {
    timestampMs,
    callsign: callsign || "Unknown",
    operatorName: operatorName || "",
    dmrId: dmrId != null ? String(dmrId) : "-",
    tg: Number.isFinite(tg) ? tg : Number.isFinite(tgFromText) ? tgFromText : null,
    durationSec,
    destinationText: String(destinationText || ""),
    dedupeKey: `${sessionId ?? ""}:${updated ?? ""}:${dmrId ?? ""}:${tg ?? ""}`,
  };
}

function matchesTalkgroup(ev, talkgroup) {
  if (ev.tg === talkgroup) return true;
  if (!ev.destinationText) return false;
  if (ev.destinationText.includes(`(${talkgroup})`)) return true;
  if (ev.destinationText.trim() === String(talkgroup)) return true;
  return false;
}

function getRegionForTg(tg) {
  if (tg == null) return "";
  const value = tgRegionMap?.[String(tg)];
  return typeof value === "string" ? value : "";
}

function setOnAir(ev) {
  if (!ev) {
    els.onAirCallsign.textContent = "-";
    els.onAirName.textContent = "No active contact";
    els.onAirTg.textContent = "TG -";
    els.onAirRegion.textContent = "Region -";
    els.onAirDmr.textContent = "DMR -";
    els.onAirLast.textContent = "Last --";
    els.onAirState.textContent = "State IDLE";
    els.onAirState.className = "";
    els.onAirTime.textContent = "--:--:--";
    return;
  }
  const now = Date.now();
  const ageMs = Number.isFinite(ev.timestampMs) ? now - ev.timestampMs : Number.NaN;
  const ageSec = Number.isFinite(ageMs) && ageMs >= 0 ? Math.floor(ageMs / 1000) : null;
  const isTxNow = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 6000;
  els.onAirCallsign.textContent = isTxNow ? ev.callsign || "-" : "Waiting...";
  els.onAirName.textContent = isTxNow ? ev.operatorName || "-" : "-";
  els.onAirTg.textContent = `TG ${ev.tg ?? "-"}`;
  els.onAirRegion.textContent = isTxNow ? `Region ${getRegionForTg(ev.tg) || "-"}` : "Region -";
  els.onAirDmr.textContent = isTxNow ? `DMR ${ev.dmrId || "-"}` : "DMR -";
  els.onAirLast.textContent = `Last ${ageSec == null ? "--" : `${ageSec}s ago`}`;
  els.onAirState.textContent = `State ${isTxNow ? "TX NOW" : "IDLE"}`;
  els.onAirState.className = isTxNow ? "txNow" : "";
  els.onAirTime.textContent = isTxNow ? formatTimestamp(ev.timestampMs) : "--:--:--";
}

function extractEvents(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.lastheard)) return payload.lastheard;
  return [];
}

function disconnectRealtime() {
  if (socket) {
    socket.close();
    socket = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }
}

function buildSocketCandidates(endpointUrl) {
  const candidates = new Set([endpointUrl]);
  try {
    const parsed = new URL(endpointUrl);
    const withRoot = new URL(parsed.toString());
    withRoot.pathname = "/";
    candidates.add(withRoot.toString());

    const withLh = new URL(parsed.toString());
    withLh.pathname = `${withLh.pathname.replace(/\/$/, "")}/lh`;
    candidates.add(withLh.toString());
  } catch {
    // If URL parsing fails, keep only original endpoint.
  }
  return [...candidates];
}

function buildSocketPathCandidates(endpointUrl) {
  const candidates = new Set(["/infoService/", "/tetralh/", "/socket.io/", "/lh/"]);
  try {
    const parsed = new URL(endpointUrl);
    if (parsed.pathname && parsed.pathname !== "/") {
      candidates.add(parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`);
    }
  } catch {
    // Keep defaults.
  }
  return [...candidates];
}

function parseInboundPayload(msg) {
  if (typeof msg !== "string") return msg;
  try {
    return JSON.parse(msg);
  } catch {
    return null;
  }
}

function getAuthHeaders(config) {
  const headers = { Accept: "application/json" };
  if (!config.apiKey || config.authMode === "none") return headers;

  if (config.authMode === "bearer") headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.authMode === "x-api-key") headers["X-API-Key"] = config.apiKey;
  if (config.authMode === "api-key") headers.apiKey = config.apiKey;
  return headers;
}

function getSocketOptions(config) {
  const options = {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1200,
    reconnectionDelayMax: 12000,
    randomizationFactor: 0.4,
    timeout: 8000,
    query: {
      subscribe: String(config.talkgroup),
      tg: String(config.talkgroup),
      tgid: String(config.talkgroup),
      talkgroup: String(config.talkgroup),
    },
  };

  if (!config.apiKey || config.authMode === "none") return options;

  if (config.authMode === "bearer") {
    options.auth = { token: config.apiKey };
    return options;
  }
  if (config.authMode === "x-api-key") {
    options.extraHeaders = { "X-API-Key": config.apiKey };
    return options;
  }
  if (config.authMode === "api-key") {
    options.extraHeaders = { apiKey: config.apiKey };
  }
  return options;
}

function formatTimestamp(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function formatDuration(seconds) {
  if (!seconds || seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${sec}s`;
}

function buildEndpoint(config) {
  let resolved = normalizeEndpointTemplate(config.endpoint)
    .replaceAll("{tg}", String(config.talkgroup))
    .replaceAll("{talkgroup}", String(config.talkgroup))
    .replaceAll("{limit}", String(config.maxRows));

  // Normalize protocol by transport type.
  if (config.sourceType === "socket") {
    if (resolved.startsWith("wss://")) resolved = `https://${resolved.slice("wss://".length)}`;
    if (resolved.startsWith("ws://")) resolved = `http://${resolved.slice("ws://".length)}`;
  }
  if (config.sourceType === "websocket") {
    if (resolved.startsWith("https://")) resolved = `wss://${resolved.slice("https://".length)}`;
    if (resolved.startsWith("http://")) resolved = `ws://${resolved.slice("http://".length)}`;
  }

  if (config.sourceType === "websocket") {
    const hasSubscribe = /[?&]subscribe=/.test(resolved);
    if (!hasSubscribe) {
      return `${resolved}${resolved.includes("?") ? "&" : "?"}subscribe=${encodeURIComponent(
        String(config.talkgroup)
      )}`;
    }
  }

  return resolved;
}

function setDebugInfo(events) {
  if (!els.debugToggleInput.checked) {
    els.debugBox.hidden = true;
    return;
  }
  if (!events?.length) {
    els.debugBox.hidden = true;
    return;
  }
  const sample = events[0];
  const decodedPayload =
    typeof sample?.payload === "string" ? decodeJsonMaybe(sample.payload, 4) : sample?.payload;
  const normalized = normalizeEvent(sample);
  const keys = Object.keys(sample);
  const decodedKeys =
    decodedPayload && typeof decodedPayload === "object" ? Object.keys(decodedPayload) : [];
  els.debugBox.hidden = false;
  els.debugBox.textContent = [
    "Debug sample (first event):",
    `keys: ${keys.join(", ")}`,
    `decoded payload keys: ${decodedKeys.join(", ") || "(none)"}`,
    `normalized: ${JSON.stringify(normalized, null, 2)}`,
    `raw: ${JSON.stringify(sample, null, 2)}`,
  ].join("\n");
}

function renderRows(events, talkgroup, maxRows, filterMode = "talkgroup") {
  if (!events.length) {
    els.rows.innerHTML = `<tr><td colspan="7" class="empty">No recent traffic found for TG ${talkgroup}.</td></tr>`;
    setOnAir(null);
    return;
  }

  const normalized = events
    .map((ev) => (ev?.dedupeKey ? ev : normalizeEvent(ev)))
    .sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));

  const unique = [];
  const seen = new Set();
  for (const ev of normalized) {
    const k = ev.dedupeKey;
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    unique.push(ev);
  }

  const filtered =
    filterMode === "all"
      ? unique.slice(0, maxRows)
      : unique.filter((e) => matchesTalkgroup(e, talkgroup)).slice(0, maxRows);

  if (!filtered.length) {
    els.rows.innerHTML =
      filterMode === "all"
        ? `<tr><td colspan="7" class="empty">Connected but no decodable events yet.</td></tr>`
        : `<tr><td colspan="7" class="empty">No matching rows for TG ${talkgroup} in current payload.</td></tr>`;
    setOnAir(null);
    return;
  }

  setOnAir(filtered[0]);

  els.rows.innerHTML = filtered
    .map(
      (ev) => `
        <tr>
          <td>${formatTimestamp(ev.timestampMs)}</td>
          <td>${ev.callsign}</td>
          <td>${ev.operatorName || "-"}</td>
          <td>${ev.dmrId}</td>
          <td>${ev.tg ?? "-"}</td>
          <td>${getRegionForTg(ev.tg) || "-"}</td>
          <td>${formatDuration(ev.durationSec)}</td>
        </tr>
      `
    )
    .join("");
}

async function fetchRest(config) {
  const proxyUrl = new URL("/api/lastheard", window.location.origin);
  proxyUrl.searchParams.set("talkgroup", String(config.talkgroup));
  proxyUrl.searchParams.set("limit", String(config.maxRows));

  const proxyHeaders = {
    "X-Upstream-Url": config.endpoint,
    "X-Auth-Mode": config.authMode,
    "X-Api-Key": config.apiKey,
    ...getServiceAuthHeaders(config),
  };

  const proxyResponse = await fetch(proxyUrl.toString(), { headers: proxyHeaders });
  if (proxyResponse.ok) {
    const payload = await proxyResponse.json();
    return extractEvents(payload);
  }

  const proxyErr = await proxyResponse.text();
  // If we are not on the bundled proxy server, try direct request as fallback.
  if (!window.location.origin.includes("127.0.0.1:8787")) {
    const directResponse = await fetch(buildEndpoint(config), { headers: getAuthHeaders(config) });
    if (!directResponse.ok) {
      throw new Error(
        `Direct HTTP ${directResponse.status}. Open widget from http://127.0.0.1:8787 after running: node server.js`
      );
    }
    const payload = await directResponse.json();
    return extractEvents(payload);
  }

  if (proxyResponse.status === 404 && /lastheard/i.test(proxyErr)) {
    throw new Error(
      "REST lastheard route not available on this API. Switch Data source to Socket.IO and use https://api.brandmeister.network"
    );
  }
  throw new Error(`Proxy HTTP ${proxyResponse.status}: ${proxyErr.slice(0, 240)}`);
}

function connectSocket(config) {
  return new Promise((resolve, reject) => {
    if (typeof window.io !== "function") {
      reject(new Error("socket.io script is not available"));
      return;
    }

    const buffer = [];
    const baseCandidates = buildSocketCandidates(buildEndpoint(config));
    const pathCandidates = buildSocketPathCandidates(buildEndpoint(config));
    let resolved = false;
    let candidateIndex = 0;
    let waitTimer = null;
    const totalCandidates = baseCandidates.length * pathCandidates.length;

    const finish = (events) => {
      if (resolved) return;
      resolved = true;
      if (waitTimer) clearTimeout(waitTimer);
      resolve(events);
    };

    // Several BM feeds use "lastheard" or generic message names.
    const ingest = (msg) => {
      const parsed = parseInboundPayload(msg);
      if (parsed == null) return;
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      buffer.push(...batch);
      if (buffer.length > 250) buffer.shift();
      mergeHistory(batch);
      pushEventsToServer(batch, config);
      renderRows(
        historyEvents,
        Number(config.talkgroup),
        Number(config.maxRows),
        String(config.filterMode || "talkgroup")
      );
      setDebugInfo(batch);
      els.updatedAt.textContent = new Date().toLocaleTimeString();
      if (historyEvents.length) finish(historyEvents.slice());
    };

    const connectCandidate = () => {
      if (candidateIndex >= totalCandidates) {
        setStatus("Connected, waiting for live traffic...", "warn");
        finish([]);
        return;
      }

      const baseIndex = Math.floor(candidateIndex / pathCandidates.length);
      const pathIndex = candidateIndex % pathCandidates.length;
      const candidateUrl = baseCandidates[baseIndex];
      const candidatePath = pathCandidates[pathIndex];
      candidateIndex += 1;
      if (socket) socket.close();

      setStatus(`Socket connecting (${candidateIndex}/${totalCandidates})`, "warn");
      socket = window.io(candidateUrl, { ...getSocketOptions(config), path: candidatePath });

      socket.on("connect", () => {
        wsReconnectAttempts = 0;
        setStatus(`Socket connected on ${candidatePath}`, "ok");
        const tg = Number(config.talkgroup);
        const subscribePayloads = [
          { op: "subscribe", talkgroup: tg },
          { action: "subscribe", talkgroup: tg },
          { type: "subscribe", talkgroup: tg },
          { room: `tg${tg}` },
          { room: String(tg) },
          { tgid: tg },
          { talkgroup: tg },
          { subscribe: tg },
        ];
        const subscribeEvents = [
          "subscribe",
          "sub",
          "join",
          "room",
          "talkgroup",
          "tg",
          "filter",
          "tgid",
          "lastheard",
        ];
        for (const ev of subscribeEvents) {
          for (const payload of subscribePayloads) {
            try {
              socket.emit(ev, payload);
            } catch {
              // Keep trying other combinations.
            }
          }
        }

        if (waitTimer) clearTimeout(waitTimer);
        waitTimer = setTimeout(() => {
          if (buffer.length) {
            finish(buffer.slice());
            return;
          }
          connectCandidate();
        }, 10000);
      });

      socket.on("connect_error", () => {
        if (waitTimer) clearTimeout(waitTimer);
        connectCandidate();
      });
      socket.io.on("reconnect_attempt", (attempt) => {
        const backoffSec = Math.min(12, Math.round(1.2 * Math.pow(1.5, attempt)));
        setStatus(`Reconnecting... attempt ${attempt} (~${backoffSec}s)`, "warn");
      });
      socket.on("error", (err) => setStatus(`Socket error: ${String(err)}`, "error"));
      socket.on("disconnect", () => setStatus("Socket disconnected", "warn"));

      ["lastheard", "message", "data", "packet", "lh"].forEach((eventName) => {
        socket.on(eventName, ingest);
      });

      // Catch all event names; some BM relays emit custom names.
      socket.onAny((eventName, ...args) => {
        const payload = args.length <= 1 ? args[0] : args;
        const parsed = parseInboundPayload(payload);
        if (Array.isArray(parsed)) noteEvents(parsed.length);
        else if (parsed != null) noteEvents(1);
        ingest(payload);
        if (!buffer.length) return;
        setStatus(`Socket event: ${eventName}`, "ok");
      });
    };

    connectCandidate();
  });
}

function connectWebSocket(config) {
  return new Promise((resolve, reject) => {
    const buffer = [];
    let resolved = false;
    let receivedAnyMessage = false;
    const url = buildEndpoint(config);
    ws = new WebSocket(url);

    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(buffer.slice());
    };

    ws.addEventListener("open", () => {
      setStatus("WebSocket connected", "ok");
      const tg = Number(config.talkgroup);
      const subscribeCandidates = [
        { op: "subscribe", talkgroup: tg },
        { action: "subscribe", talkgroup: tg },
        { type: "subscribe", talkgroup: tg },
        { subscribe: tg },
        { tgid: tg },
      ];
      for (const msg of subscribeCandidates) {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          // Ignore and continue; some servers are receive-only.
        }
      }
    });
    ws.addEventListener("error", () => {
      if (!resolved) finish();
      setStatus("WebSocket error", "warn");
    });
    ws.addEventListener("close", (event) => {
      if (receivedAnyMessage) {
        setStatus("WebSocket disconnected (after data)", "warn");
        return;
      }
      const reason = event.reason ? ` ${event.reason}` : "";
      wsReconnectAttempts += 1;
      const backoffMs = Math.min(12000, 1000 * Math.pow(1.7, wsReconnectAttempts));
      const msg = `WebSocket closed code ${event.code}.${reason} Reconnect in ${Math.round(
        backoffMs / 1000
      )}s`;
      setStatus(msg, "warn");
      if (!resolved) finish();
      wsRetryTimer = setTimeout(() => {
        pollOnce(config);
      }, backoffMs);
    });
    ws.addEventListener("message", (event) => {
      wsReconnectAttempts = 0;
      receivedAnyMessage = true;
      try {
        const parsed = JSON.parse(event.data);
        const batch = Array.isArray(parsed) ? parsed : [parsed];
        buffer.push(...batch);
        noteEvents(batch.length);
        mergeHistory(batch);
        pushEventsToServer(batch, config);
      } catch {
        // Some feeds emit non-JSON control frames.
        return;
      }

      if (buffer.length > 250) buffer.shift();
      renderRows(
        historyEvents,
        Number(config.talkgroup),
        Number(config.maxRows),
        String(config.filterMode || "talkgroup")
      );
      setDebugInfo(buffer);
      els.updatedAt.textContent = new Date().toLocaleTimeString();
      finish();
    });

    setTimeout(finish, 2000);
  });
}

function stopTimers() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  disconnectRealtime();
}

async function pollOnce(config) {
  const talkgroup = Number(config.talkgroup);
  const maxRows = Number(config.maxRows);

  if (!talkgroup || !config.endpoint) {
    setStatus("Missing talkgroup or endpoint", "warn");
    return;
  }

  try {
    setStatus("Fetching...", "warn");
    const events =
      config.sourceType === "socket"
        ? await connectSocket(config)
        : config.sourceType === "websocket"
          ? await connectWebSocket(config)
          : await fetchRest(config);

    mergeHistory(events);
    if (Array.isArray(events) && events.length) noteEvents(events.length);
    renderRows(historyEvents, talkgroup, maxRows, String(config.filterMode || "talkgroup"));
    setDebugInfo(events);
    els.updatedAt.textContent = new Date().toLocaleTimeString();
    if ((config.sourceType === "socket" || config.sourceType === "websocket") && !events.length) {
      setStatus("Connected, waiting for live traffic...", "warn");
    } else {
      setStatus(`OK (${events.length} events)`, "ok");
    }
  } catch (error) {
    console.error(error);
    setStatus(`Error: ${error.message}`, "error");
    const isRealtime = config.sourceType === "socket" || config.sourceType === "websocket";
    els.rows.innerHTML = isRealtime
      ? '<tr><td colspan="7" class="empty">Realtime connection failed. Try Socket.IO mode with `https://api.brandmeister.network`.</td></tr>'
      : '<tr><td colspan="7" class="empty">Request failed. Recommended: run `node server.js` and open http://127.0.0.1:8787</td></tr>';
  }
}

function applyAndStart() {
  const config = {
    talkgroup: Number(els.talkgroupInput.value),
    maxRows: Number(els.maxRowsInput.value),
    filterMode: els.filterModeInput.value,
    showDebug: els.debugToggleInput.checked,
    pollSec: Number(els.pollSecInput.value),
    sourceType: els.sourceTypeInput.value,
    endpoint: normalizeEndpointTemplate(els.endpointInput.value.trim()),
    authMode: els.authModeInput.value,
    apiKey: els.apiKeyInput.value.trim(),
    widgetToken: els.widgetTokenInput.value.trim(),
  };

  saveConfig(config);
  els.title.textContent = `BrandMeister TG ${config.talkgroup}`;
  els.endpointInput.value = buildEndpoint(config);
  loadTalkgroupRegions(config);
  if (!config.showDebug) els.debugBox.hidden = true;

  stopTimers();
  pollOnce(config);

  if (config.sourceType === "rest") {
    pollTimer = setInterval(() => pollOnce(config), config.pollSec * 1000);
  }
}

function bootstrap() {
  const config = loadConfig();
  historyEvents = loadHistory();
  els.talkgroupInput.value = config.talkgroup;
  els.maxRowsInput.value = config.maxRows;
  els.filterModeInput.value = config.filterMode || "talkgroup";
  els.debugToggleInput.checked = Boolean(config.showDebug);
  els.pollSecInput.value = config.pollSec;
  els.sourceTypeInput.value = config.sourceType;
  els.endpointInput.value = normalizeEndpointTemplate(config.endpoint);
  els.authModeInput.value = config.authMode;
  els.apiKeyInput.value = config.apiKey;
  els.widgetTokenInput.value = config.widgetToken || "";

  loadTalkgroupRegions(config);
  setInterval(updateEventsRate, 1000);
  els.debugToggleInput.addEventListener("change", () => {
    if (!els.debugToggleInput.checked) els.debugBox.hidden = true;
  });
  els.configBtn.addEventListener("click", () => {
    els.configDialog.showModal();
  });
  els.closeConfigBtn.addEventListener("click", () => {
    if (els.configDialog.open) els.configDialog.close();
  });
  els.clearLogBtn.addEventListener("click", () => {
    historyEvents = [];
    saveHistory(historyEvents);
    renderRows([], Number(els.talkgroupInput.value || 214), Number(els.maxRowsInput.value || 8));
  });
  els.applyBtn.addEventListener("click", applyAndStart);
  applyAndStart();
}

bootstrap();
