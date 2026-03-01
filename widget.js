const STORAGE_KEY = "bm-widget-config-v1";

const els = {
  title: document.getElementById("title"),
  status: document.getElementById("status"),
  eventsPerMin: document.getElementById("eventsPerMin"),
  updatedAt: document.getElementById("updatedAt"),
  talkgroupInput: document.getElementById("talkgroupInput"),
  maxRowsInput: document.getElementById("maxRowsInput"),
  filterModeInput: document.getElementById("filterModeInput"),
  debugToggleInput: document.getElementById("debugToggleInput"),
  pollSecInput: document.getElementById("pollSecInput"),
  sourceTypeInput: document.getElementById("sourceTypeInput"),
  endpointInput: document.getElementById("endpointInput"),
  authModeInput: document.getElementById("authModeInput"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  applyBtn: document.getElementById("applyBtn"),
  rows: document.getElementById("rows"),
  debugBox: document.getElementById("debugBox"),
};

let pollTimer = null;
let socket = null;
let ws = null;
let wsRetryTimer = null;
let wsReconnectAttempts = 0;
const recentEventTimes = [];

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
    els.rows.innerHTML = `<tr><td colspan="5" class="empty">No recent traffic found for TG ${talkgroup}.</td></tr>`;
    return;
  }

  const normalized = events
    .map(normalizeEvent)
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
        ? `<tr><td colspan="5" class="empty">Connected but no decodable events yet.</td></tr>`
        : `<tr><td colspan="5" class="empty">No matching rows for TG ${talkgroup} in current payload.</td></tr>`;
    return;
  }

  els.rows.innerHTML = filtered
    .map(
      (ev) => `
        <tr>
          <td>${formatTimestamp(ev.timestampMs)}</td>
          <td>${ev.callsign}</td>
          <td>${ev.dmrId}</td>
          <td>${ev.tg ?? "-"}</td>
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
      if (Array.isArray(parsed)) buffer.push(...parsed);
      else buffer.push(parsed);
      if (buffer.length > 250) buffer.shift();
      renderRows(
        buffer,
        Number(config.talkgroup),
        Number(config.maxRows),
        String(config.filterMode || "talkgroup")
      );
      setDebugInfo(buffer);
      els.updatedAt.textContent = new Date().toLocaleTimeString();
      if (buffer.length) finish(buffer.slice());
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
        if (Array.isArray(parsed)) buffer.push(...parsed);
        else buffer.push(parsed);
        if (Array.isArray(parsed)) noteEvents(parsed.length);
        else noteEvents(1);
      } catch {
        // Some feeds emit non-JSON control frames.
        return;
      }

      if (buffer.length > 250) buffer.shift();
      renderRows(
        buffer,
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

    renderRows(events, talkgroup, maxRows, String(config.filterMode || "talkgroup"));
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
      ? '<tr><td colspan="5" class="empty">Realtime connection failed. Try Socket.IO mode with `https://api.brandmeister.network`.</td></tr>'
      : '<tr><td colspan="5" class="empty">Request failed. Recommended: run `node server.js` and open http://127.0.0.1:8787</td></tr>';
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
  };

  saveConfig(config);
  els.title.textContent = `BrandMeister TG ${config.talkgroup}`;
  els.endpointInput.value = buildEndpoint(config);
  recentEventTimes.length = 0;
  updateEventsRate();
  if (!config.showDebug) els.debugBox.hidden = true;

  stopTimers();
  pollOnce(config);

  if (config.sourceType === "rest") {
    pollTimer = setInterval(() => pollOnce(config), config.pollSec * 1000);
  }
}

function bootstrap() {
  const config = loadConfig();
  els.talkgroupInput.value = config.talkgroup;
  els.maxRowsInput.value = config.maxRows;
  els.filterModeInput.value = config.filterMode || "talkgroup";
  els.debugToggleInput.checked = Boolean(config.showDebug);
  els.pollSecInput.value = config.pollSec;
  els.sourceTypeInput.value = config.sourceType;
  els.endpointInput.value = normalizeEndpointTemplate(config.endpoint);
  els.authModeInput.value = config.authMode;
  els.apiKeyInput.value = config.apiKey;

  setInterval(updateEventsRate, 1000);
  els.debugToggleInput.addEventListener("change", () => {
    if (!els.debugToggleInput.checked) els.debugBox.hidden = true;
  });
  els.applyBtn.addEventListener("click", applyAndStart);
  applyAndStart();
}

bootstrap();
