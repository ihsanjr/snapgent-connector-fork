// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:PORT).
// Keeping the socket here (not in the content script) avoids https→ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.

// Shared execution policy, so the heartbeat runs the SAME rule the tests pin.
// core/guard.js is plain top-level script (no modules), so importing it here
// defines the identical `ZSGuard` binding in the worker global scope that the
// content scripts get from manifest.json. Without this the worker carried an
// inline copy of the rule while the tests covered the guard.js one - the very
// "tested logic is not the running logic" mistake the retry path already had.
//
// `importScripts` only exists in the worker; node-based tests inject ZSGuard
// themselves (see test-background.js), so the absence of it is not an error.
if (typeof importScripts === "function" && typeof ZSGuard === "undefined") {
  try { importScripts("core/guard.js"); } catch (e) { console.warn("guard.js not loaded:", e); }
}

const PORT = 17613;
const URL = `ws://127.0.0.1:${PORT}`;

// Chat sites where a snapgentV3 provider content script runs. Status pushes go
// to every tab matching these. Add the new provider's URL pattern here (and in
// manifest.json content_scripts + host_permissions) when integrating another AI.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*", "https://gemini.google.com/*", "https://www.kimi.ai/*", "https://kimi.ai/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://www.meta.ai/*", "https://meta.ai/*", "https://ptero.pro/*", "https://grok.com/*", "https://chat.mistral.ai/*"];

const SUBAGENT_PROVIDER_URLS = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/app",
  deepseek: "https://chat.deepseek.com/",
  kimi: "https://www.kimi.ai/",
  glm: "https://chat.z.ai/",
  qwen: "https://chat.qwen.ai/",
  arena: "https://arena.ai/text/direct",
  meta: "https://www.meta.ai/",
  ptero: "https://ptero.pro/",
  grok: "https://grok.com/",
  mistral: "https://chat.mistral.ai/code",
};

const SUBAGENT_PROVIDER_ALIASES = {
  gpt: "chatgpt",
  openai: "chatgpt",
  "chatgpt-cm": "chatgpt",
  anthropic: "claude",
  google: "gemini",
  zai: "glm",
  "z.ai": "glm",
  chatglm: "glm",
  "qwen-net": "qwen",
  "meta-ai": "meta",
  lechat: "mistral",
};

const MAX_PARALLEL_SUBAGENTS = 6;

// Active multi-tab subagent registry: subagentId -> { parentTabId, childTabId, provider, autoClose, stage, resolve, timer }
const subagentSessions = new Map();
let nextSubagentSeq = 1;
// Serialized foreground-hydration queue so parallel subagents open and handshake
// one tab at a time without focus races, then restore focus to parentTabId once
// the queue drains.
let subagentFocusChain = Promise.resolve();
let subagentFocusPending = 0;

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 5000;
const HEARTBEAT_MS = 10000;
// If no message (incl. pong) arrives within this window while we believe we're
// connected, the socket is half-open: force a reconnect instead of letting
// pending requests slowly time out. Kept at 60s so a very large frame in flight
// (big project data) does not delay the pong past the limit and cause a false
// reconnect. Must stay below the bridge ping_timeout (90s).
const STALE_SOCKET_MS = 60000;
const REQUEST_TIMEOUT_DEFAULT = 130000; // a bit above the 120s tool timeout
// Cheap probe types (liveness pings, status reads) must not inherit the full
// tool budget: a local bridge answers in single-digit milliseconds, so waiting
// two minutes for a ping only delays the "offline" report the UI needs.
//
// MEASURED on a live bridge (v3.9.4, port 17613, 16 Nov 2026), including the
// worst case of a target server that is NOT connected:
//
//   ping              0.4 ms     list_tools                   2.3 ms (0.8 ms again)
//   get_tools         0.4 ms     get_tools(roblox, offline)   0.3 ms
//   capabilities      0.3 ms     studio_status               46.3 ms (0.2 ms again)
//   list_mcp_servers  0.8 ms     get_servers                  0.5 ms
//
// The slowest observed answer is one cold studio_status at 46 ms - three orders
// of magnitude below the 6000 ms cap. A false timeout therefore needs a bridge
// that is genuinely stuck, which is exactly what the cap is meant to surface.
const FAST_TIMEOUT = 6000;
// Probes the bridge answers instantly (single-digit ms on a healthy local
// socket). They must not inherit the full tool budget, otherwise the loop sits
// waiting two minutes just to learn the bridge is offline.
const FAST_TYPES = new Set([
  "ping", "studio_status", "list_mcp_servers", "get_servers",
  "list_tools", "get_tools", "capabilities",
]);
// How long to wait for a socket that is not open before declaring it offline.
// The reconnect ceiling is 2s and connecting to a LOCAL socket takes a few ms,
// so a healthy bridge reconnects well inside this window; waiting longer is
// exactly the "bridge is unreachable" delay users complained about.
//
// DELIBERATELY shorter than the 4314 ms measured for a socket that was MID-
// RECONNECT: the first probe is expected to lose that race, and runTool's
// preflight allows one more attempt.
//
// Be precise about what the two attempts cover. The 8000 ms in the preflight is
// only the RACE timeout around bg({type:"ping"}); the second ping still waits at
// most CONNECT_WAIT_MS (2.5 s) for the socket itself. So the two attempts spend
// roughly 2 x 2.5 s = 5 s waiting on the connection, which is what makes the
// measured 4.3 s case land on the retry. Without the retry, blocking the FIRST
// attempt for 4.3 s would tax every ordinary cold start to cover a case the
// second attempt already handles.
const CONNECT_WAIT_MS = 2500;

let ws = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0; // timestamp of the last frame received from the bridge
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
let toolsCache = [];
let mcpAlive = false;
let serversCache = [];
let bridgeVersion = null;
// true/false = a PLACE is loaded and usable in Roblox Studio; null = unknown.
// The MCP process stays alive when Studio is closed or its MCP option is off,
// so this is probed separately (bridge "studio_status").
let studioConnected = null;
// true/false = a Roblox Studio app is connected to the MCP server at all; null =
// unknown. studioApp=true with studioConnected=false means "Studio open but no
// place"; studioApp=false means "Studio closed OR its MCP option disabled".
let studioApp = null;
// true/false = a Roblox Studio WINDOW/PROCESS exists on this machine (checked
// bridge-side via tasklist); null = unknown/old bridge. Distinguishes the two
// studioApp=false sub-cases the UI must word differently: Studio genuinely not
// launched ("open Roblox Studio") vs Studio OPEN but its MCP plugin never
// registered with the bridge - the documented fix for the latter is opening
// Assistant Settings > MCP Servers inside Studio (validated live 3x), which
// "open Roblox Studio" wording completely fails to convey.
let studioProc = null;

function log(...a) {
  console.log("[zs-bg]", ...a);
}

// ── WebSocket lifecycle ─────────────────────────────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(URL);
  } catch (e) {
    log("WebSocket ctor failed", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    reconnectDelay = RECONNECT_MIN;
    lastMessageAt = Date.now();
    log("connected to bridge");
    startHeartbeat();
    broadcastStatus();
  };

  ws.onmessage = (ev) => {
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleBridgeMessage(msg);
  };

  ws.onclose = () => {
    connected = false;
    mcpAlive = false;
    studioConnected = null;
    studioApp = null;
    studioProc = null;
    serversCache = [];
    bridgeVersion = null;
    stopHeartbeat();
    failAllPending("bridge connection closed");
    broadcastStatus();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will follow; nothing to do here but avoid an unhandled error.
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (connected) {
      // Half-open socket: the WS still reports OPEN but nothing comes through.
      //
      // STALENESS IS PROVED, NOT GUESSED. Chrome suspends an idle MV3 service
      // worker and setInterval does not run while suspended, so on wake-up
      // lastMessageAt is ALWAYS older than STALE_SOCKET_MS. Closing on elapsed
      // time alone therefore killed a perfectly healthy socket, onclose
      // reconnected, the worker idled again and the cycle repeated (measured:
      // 203 connect/disconnect events in a day while a manual ping answered in
      // 1 ms). So ask the bridge for a real pong and close only when it does
      // not answer.
      //
      // The decision itself lives in ZSGuard.heartbeatDecision (imported at the
      // top of this file) so the tested rule is the rule that runs.
      const decision = ZSGuard.heartbeatDecision({
        now: Date.now(),
        lastMessageAt,
        staleMs: STALE_SOCKET_MS,
      });
      if (decision.shouldProbe) {
        const pong = await send({ type: "ping" }, 4000).catch(() => null);
        const answered = !!(pong && pong.ok);
        const final = ZSGuard.heartbeatDecision({
          now: Date.now(),
          lastMessageAt,
          staleMs: STALE_SOCKET_MS,
          pongAnswered: answered,
        });
        if (connected && final.close) {
          log("socket stale after failed ping, forcing reconnect");
          try { ws.close(); } catch {}
        } else {
          // The bridge answered, so the socket is healthy: the gap was the
          // suspended worker, not a dead half-open socket.
          lastMessageAt = Date.now();
        }
        return;
      }
      // Keeps the MV3 service worker alive AND detects a half-open socket.
      send({ type: "ping" }).catch(() => {});
      refreshStudioStatus();
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Resolve once the socket is OPEN, or false after `timeout` ms.
function waitForConnection(timeout = 8000) {
  return new Promise((resolve) => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) return resolve(true);
    connect(); // nudge a (re)connection - important after a worker wake-up
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

// ── request/response over the socket ────────────────────────────────────
async function send(obj, timeout = REQUEST_TIMEOUT_DEFAULT) {
  // The MV3 service worker can be suspended; the first message after a wake-up
  // arrives before the socket has re-opened. Wait for it instead of failing -
  // otherwise Kimi wrongly hears "bridge offline". Probe types fail fast so the
  // loop learns "offline" quickly instead of staring at a spinner; a real tool
  // run still waits the longer budget.
  const fast = FAST_TYPES.has(obj && obj.type);
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    await waitForConnection(fast ? CONNECT_WAIT_MS : 8000);
  }
  return new Promise((resolve) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, kind: "disconnected", sent: false, error: "bridge not connected" });
      return;
    }
    const id = nextId++;
    const payload = { ...obj, id };
    // A probe the bridge answers in milliseconds must not inherit the full tool
    // budget; otherwise "offline" takes two minutes to surface.
    const effectiveTimeout = fast ? Math.min(timeout, FAST_TIMEOUT) : timeout;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, kind: "timeout", error: "bridge did not respond in time" });
      }
    }, effectiveTimeout);
    pending.set(id, { resolve, timer, sent: false });
    try {
      ws.send(JSON.stringify(payload));
      // Past this line the bridge may already have executed the request. A
      // caller that retries has to know the difference: retrying a write_file
      // or a git_commit that did land would apply it twice.
      const entry = pending.get(id);
      if (entry) entry.sent = true;
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", sent: false, error: String(e) });
    }
  });
}

// Ask the bridge whether a Roblox Studio instance is actually connected to the
// MCP server. Broadcasts only on change so the UI updates promptly but quietly.
let studioProbing = false;
async function refreshStudioStatus() {
  if (studioProbing || !connected) return;
  studioProbing = true;
  try {
    const r = await send({ type: "studio_status" }, 12000);
    const v = r && r.ok && typeof r.studio === "boolean" ? r.studio : null;
    if (v !== studioConnected) {
      studioConnected = v;
      broadcastStatus();
    }
  } finally {
    studioProbing = false;
  }
}

function handleBridgeMessage(msg) {
  if ("studio" in msg && (typeof msg.studio === "boolean" || msg.studio === null)) {
    studioConnected = msg.studio;
  }
  if ("studio_app" in msg && (typeof msg.studio_app === "boolean" || msg.studio_app === null)) {
    studioApp = msg.studio_app;
  }
  if ("studio_proc" in msg && (typeof msg.studio_proc === "boolean" || msg.studio_proc === null)) {
    studioProc = msg.studio_proc;
  }
  if (msg.type === "studio_status") {
    resolvePending(msg.id, { ok: true, studio: studioConnected });
    broadcastStatus();
    return;
  }
  if (msg.type === "connected") {
    bridgeVersion = typeof msg.bridge_version === "string" ? msg.bridge_version : null;
    mcpAlive = !!msg.mcp_alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    broadcastStatus();
    return;
  }
  if (msg.type === "pong") {
    resolvePending(msg.id, { ok: true });
    return;
  }
  if (msg.type === "tools") {
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    mcpAlive = !!msg.mcp_alive;
    resolvePending(msg.id, { ok: true, tools: toolsCache });
    broadcastStatus();
    return;
  }
  if (msg.type === "tool_result") {
    resolvePending(msg.id, msg.ok
      ? { ok: true, text: msg.text, images: msg.images || [] }
      : { ok: false, kind: msg.kind, error: msg.error });
    return;
  }
  if (msg.type === "mcp_status") {
    mcpAlive = !!msg.alive;
    if (Array.isArray(msg.tools)) toolsCache = msg.tools;
    if (Array.isArray(msg.servers)) serversCache = msg.servers;
    resolvePending(msg.id, { ok: !!msg.ok, alive: msg.alive, error: msg.error });
    broadcastStatus();
    return;
  }
  if (msg.type === "server_changed") {
    // The bridge acks, then restarts itself to reload config.json. The socket
    // will drop right after this - the content script shows a spinner until the
    // reconnect lands and a fresh status arrives.
    resolvePending(msg.id, { ok: !!msg.ok, error: msg.error, restarting: !!msg.restarting });
    return;
  }
  if (msg.type === "error") {
    resolvePending(msg.id, { ok: false, error: msg.error });
    return;
  }
}

function resolvePending(id, value) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    // `sent` tells the caller whether the frame left the extension. A request
    // still waiting on waitForConnection never reached the bridge, so it is
    // safe to re-send; one that had gone out may already have run.
    p.resolve({ ok: false, kind: "disconnected", sent: !!p.sent, error: reason });
  }
  pending.clear();
}

// ── status push to any open DeepSeek tab + popup ─────────────────────────
function statusObj() {
  return { type: "zs-status", connected, mcpAlive, bridgeVersion, studio: studioConnected, studioApp, studioProc, tools: toolsCache.length, servers: serversCache };
}

function broadcastStatus() {
  chrome.runtime.sendMessage(statusObj()).catch(() => {});
  chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, statusObj()).catch(() => {});
  });
}

// ── messages from content.js / popup.js ─────────────────────────────────
// -- Multi-tab subagent orchestration --
function settleSubagent(subagentId, payload) {
  const session = subagentSessions.get(subagentId);
  if (!session) return false;
  subagentSessions.delete(subagentId);
  clearTimeout(session.timer);
  if (typeof session.releaseFocus === "function") {
    try { session.releaseFocus(); } catch (_) {}
    session.releaseFocus = null;
  }
  if (session.autoClose && typeof session.childTabId === "number") {
    chrome.tabs.remove(session.childTabId).catch(() => {});
  }
  session.resolve(payload);
  return true;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [subagentId, session] of subagentSessions.entries()) {
    if (session.childTabId === tabId) {
      session.childTabId = null;
      settleSubagent(subagentId, {
        ok: false,
        error: "Subagent tab was closed before finishing.",
      });
    }
  }
});

function waitTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(ok);
    };
    const onUpdated = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) finish(false);
      else if (tab && tab.status === "complete") finish(true);
    });
  });
}

async function deliverSubagentBoot(tabId, bootMsg, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ack = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, bootMsg, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp || null);
      });
    });
    if (ack && ack.ok) return { ok: true };
    if (ack && ack.error) return { ok: false, error: ack.error };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, error: "Subagent content script did not respond in time." };
}

function resolveSubagentProvider(rawInput, fallback = "gemini") {
  const raw = typeof rawInput === "string" ? rawInput.trim().toLowerCase() : "";
  const normalized = SUBAGENT_PROVIDER_ALIASES[raw] || raw || fallback;
  const url = SUBAGENT_PROVIDER_URLS[normalized];
  if (!url) {
    const supported = Object.keys(SUBAGENT_PROVIDER_URLS).join(", ");
    return { ok: false, rawProvider: raw, error: `Unknown subagent provider "${raw}". Supported providers: ${supported}.` };
  }
  return { ok: true, provider: normalized, url };
}

function enqueueSubagentFocus(parentTabId, fn) {
  subagentFocusPending++;
  const run = subagentFocusChain.then(async () => {
    try {
      return await fn();
    } finally {
      subagentFocusPending = Math.max(0, subagentFocusPending - 1);
      if (subagentFocusPending === 0 && typeof parentTabId === "number") {
        try { await chrome.tabs.update(parentTabId, { active: true }); } catch (_) {}
      }
    }
  });
  subagentFocusChain = run.catch(() => {});
  return run;
}

async function spawnSubagentTab(msg, sender) {
  const task = typeof msg.task === "string" ? msg.task.trim() : "";
  if (!task) return { ok: false, error: "Subagent 'task' parameter is required." };
  const prov = resolveSubagentProvider(msg.provider, "gemini");
  if (!prov.ok) return { ok: false, error: prov.error };
  const { provider: resolvedProvider, url } = prov;
  const autoClose = msg.auto_close !== false;
  const timeoutMs = Math.max(30000, Math.min(Number(msg.timeout) || 240000, 600000));
  const parentTabId = sender && sender.tab ? sender.tab.id : null;
  const subagentId = `sa_${Date.now()}_${nextSubagentSeq++}`;

  return new Promise(async (resolve) => {
    let stage = "creating_tab";
    const timer = setTimeout(() => {
      settleSubagent(subagentId, {
        ok: false,
        error: `Subagent timed out after ${Math.round(timeoutMs / 1000)}s (last stage: ${stage}).`,
      });
    }, timeoutMs);

    subagentSessions.set(subagentId, {
      parentTabId,
      childTabId: null,
      provider: resolvedProvider,
      autoClose,
      stage,
      resolve,
      timer,
    });

    const hydrated = await enqueueSubagentFocus(parentTabId, async () => {
      if (!subagentSessions.has(subagentId)) return { ok: false, error: "Subagent cancelled before tab creation." };
      let createdTab;
      try {
        // Open active briefly so Chromium/Edge hydrates the SPA without background throttling,
        // then serialize focus across concurrent spawns before restoring parentTabId.
        createdTab = await chrome.tabs.create({ url, active: true });
      } catch (e) {
        return { ok: false, error: `Failed to open subagent tab: ${String(e && e.message || e)}` };
      }
      const childTabId = createdTab && createdTab.id;
      if (typeof childTabId !== "number") {
        return { ok: false, error: "Browser did not return a valid tab ID for subagent." };
      }
      const sess = subagentSessions.get(subagentId);
      if (sess) sess.childTabId = childTabId;

      stage = "loading_tab";
      if (sess) sess.stage = stage;
      const loaded = await waitTabComplete(childTabId, 30000);
      if (!subagentSessions.has(subagentId)) return { ok: false, error: "Subagent closed during load." };
      if (!loaded) {
        return { ok: false, error: "Subagent tab failed to finish loading." };
      }

      stage = "handshaking_content_script";
      if (sess) sess.stage = stage;
      const boot = await deliverSubagentBoot(childTabId, {
        type: "zs-subagent-start",
        subagentId,
        task,
        targetServer: msg.target_server || "vscode",
        allowTools: msg.allow_tools !== false,
      }, 20000);
      if (!boot || !boot.ok) return boot;

      stage = "running_task";
      if (sess) sess.stage = stage;

      // Keep the child tab active until prompt submission (or full completion for
      // SPA providers that throttle streaming/DOM updates in background).
      const holdUntilDone = ["chatgpt", "gemini", "qwen", "deepseek"].includes(resolvedProvider);
      await new Promise((done) => {
        let finished = false;
        const release = () => {
          if (finished) return;
          finished = true;
          if (focusGuard) clearTimeout(focusGuard);
          done();
        };
        const focusGuard = holdUntilDone ? null : setTimeout(release, 35000);
        const activeSess = subagentSessions.get(subagentId);
        if (!activeSess) {
          release();
          return;
        }
        activeSess.releaseFocus = release;
      });
      return boot;
    });

    if (!subagentSessions.has(subagentId)) return;
    if (!hydrated || !hydrated.ok) {
      settleSubagent(subagentId, {
        ok: false,
        error: (hydrated && hydrated.error) || "Failed to initialize subagent.",
      });
      return;
    }
    stage = "running_task";
    const sess = subagentSessions.get(subagentId);
    if (sess) sess.stage = stage;
    log(`subagent ${subagentId} started on ${resolvedProvider} (tab ${sess ? sess.childTabId : "?"})`);
  });
}

async function spawnSubagentBatch(msg, sender) {
  const rawTasks = Array.isArray(msg.tasks) ? msg.tasks : null;
  if (!rawTasks || rawTasks.length === 0) {
    return { ok: false, error: "Batch 'tasks' parameter must be a non-empty array." };
  }
  if (rawTasks.length > MAX_PARALLEL_SUBAGENTS) {
    return { ok: false, error: `Too many parallel subagents (${rawTasks.length}); maximum is ${MAX_PARALLEL_SUBAGENTS}.` };
  }
  const defaultProvider = typeof msg.provider === "string" && msg.provider.trim() ? msg.provider.trim() : "gemini";
  const defaultAutoClose = msg.auto_close !== false;
  const defaultTimeout = typeof msg.timeout === "number" ? msg.timeout : 240000;

  const normalized = [];
  for (let i = 0; i < rawTasks.length; i++) {
    const item = rawTasks[i];
    const isObj = item && typeof item === "object";
    const task = isObj ? String(item.task || "").trim() : String(item || "").trim();
    if (!task) {
      return { ok: false, error: `Batch task at index ${i} must be a non-empty string.` };
    }
    const prov = resolveSubagentProvider(isObj && item.provider ? item.provider : defaultProvider, "gemini");
    if (!prov.ok) {
      return { ok: false, error: `Batch task at index ${i}: ${prov.error}` };
    }
    normalized.push({
      task,
      provider: prov.provider,
      auto_close: isObj && typeof item.auto_close === "boolean" ? item.auto_close : defaultAutoClose,
      timeout: isObj && typeof item.timeout === "number" ? item.timeout : defaultTimeout,
      target_server: (isObj && item.target_server) || msg.target_server || "vscode",
      allow_tools: isObj && typeof item.allow_tools === "boolean" ? item.allow_tools : (msg.allow_tools !== false),
    });
  }

  const results = await Promise.all(
    normalized.map((entry, index) =>
      spawnSubagentTab(entry, sender).then((r) => ({ index, provider: entry.provider, ...r }))
    )
  );
  return {
    ok: results.every((r) => r.ok),
    results,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "spawn_subagent": {
        const r = await spawnSubagentTab(msg, sender);
        sendResponse(r);
        break;
      }
      case "spawn_subagents": {
        const r = await spawnSubagentBatch(msg, sender);
        sendResponse(r);
        break;
      }
      case "zs-subagent-submitted": {
        const session = subagentSessions.get(msg.subagentId);
        const holdUntilDone = session && ["chatgpt", "gemini", "qwen", "deepseek"].includes(session.provider);
        if (session && !holdUntilDone && typeof session.releaseFocus === "function") {
          try { session.releaseFocus(); } catch (_) {}
          session.releaseFocus = null;
        }
        sendResponse({ ok: Boolean(session) });
        break;
      }
      case "zs-subagent-done": {
        const handled = settleSubagent(msg.subagentId, {
          ok: !!msg.ok,
          result: msg.result || "",
          error: msg.error || "",
          provider: msg.provider || "",
        });
        sendResponse({ ok: handled });
        break;
      }
      case "status":
        if (!connected) connect(); // self-heal after a worker wake-up
        sendResponse(statusObj());
        break;
      // Liveness probe for the content script. Without this case a
      // bg({type:"ping"}) falls through to `default:` and answers
      // {ok:false, error:"unknown message"} - which any caller reads as "the
      // bridge is down" even though it is perfectly healthy (measured: ping
      // 1 ms, 28 tools listed). Keeping the case here makes the answer
      // truthful: ok only when the bridge actually returned a pong.
      case "ping":
        send({ type: "ping" }, FAST_TIMEOUT).then((r) => {
          sendResponse(r && r.ok
            ? { ok: true }
            : { ok: false, kind: (r && r.kind) || "no_pong", error: (r && r.error) || "bridge did not answer the ping" });
        }).catch((e) => {
          sendResponse({ ok: false, kind: "error", error: String(e) });
        });
        break;
      case "list_tools": {
        // Prefer a live refresh; fall back to cache so the loop never stalls.
        // 10s, not 25s: a catalogue request only blocks this long when one of the
        // MCP servers is dead (typically Roblox in a degraded, Blender-only
        // session), and in that exact case we already hold a perfectly good cached
        // catalogue. Waiting the full 25s just froze the boot for no new data.
        const r = await send({ type: "list_tools" }, 10000);
        if (r.ok) sendResponse({ ok: true, tools: r.tools });
        else sendResponse({ ok: toolsCache.length > 0, tools: toolsCache, error: r.error });
        break;
      }
      case "call_tool": {
        const timeout = (msg.timeout || 120000) + 10000;
        const r = await send(
          { type: "call_tool", name: msg.name, arguments: msg.arguments, timeout: msg.timeout, server: msg.server },
          timeout
        );
        sendResponse(r);
        break;
      }
      case "restart_mcp": {
        const r = await send({ type: "restart_mcp" }, 30000);
        sendResponse(r);
        break;
      }
      case "add_server": {
        const r = await send({
          type: "add_server", server_id: msg.server_id,
          command: msg.command, args: msg.args, env: msg.env,
        }, 15000);
        sendResponse(r);
        break;
      }
      case "remove_server": {
        const r = await send({ type: "remove_server", server_id: msg.server_id }, 15000);
        sendResponse(r);
        break;
      }
      case "fetch_image": {
        // Only Google-hosted image URLs; the extension must not become a general proxy.
        try {
          const u = new URL(msg.url);
          if (!/(^|\.)googleusercontent\.com$|(^|\.)google\.com$/.test(u.hostname)) {
            sendResponse({ ok: false, error: "host not allowed" });
            break;
          }
          const res = await fetch(u.href, { credentials: "omit" });
          if (!res.ok) {
            sendResponse({ ok: false, error: `HTTP ${res.status}` });
            break;
          }
          const blob = await res.blob();
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          }
          sendResponse({ ok: true, mimeType: blob.type || "image/png", data: btoa(bin) });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        break;
      }
      case "reconnect":
        reconnectDelay = RECONNECT_MIN;
        connect();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

// Wake/keepalive hooks.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

connect();
