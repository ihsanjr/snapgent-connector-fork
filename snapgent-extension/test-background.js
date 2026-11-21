// Node smoke test for background.js (run: node test-background.js). Not shipped.
//
// Why this exists: the review of PR #3 asked for one specific guarantee that
// cannot be checked by reading the diff - a retried call_tool must never repeat
// a side effect that already happened. `send()` therefore reports whether the
// frame actually left the extension:
//
//   sent: false - it never reached the bridge (failed while waiting for the
//                 socket, or ws.send threw), so re-sending is safe.
//   sent: true  - the frame went out; the bridge may have executed the tool,
//                 so the caller must NOT silently retry a write.
//
// These tests drive the REAL send()/failAllPending() against a stub WebSocket,
// so the behaviour is pinned to the code that ships rather than a copy of it.
const fs = require("fs");

const ok = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) process.exitCode = 1;
};

// ── Minimal chrome + WebSocket stubs ───────────────────────────────────────
const listeners = [];
const noEvent = { addListener: () => {}, removeListener: () => {} };
global.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onStartup: noEvent,
    onInstalled: noEvent,
    sendMessage: () => Promise.resolve(),
  },
  tabs: {
    query: (_f, cb) => cb && cb([]),
    sendMessage: () => Promise.resolve(),
    get: (_id, cb) => cb && cb(null),
    create: () => Promise.resolve({ id: 999 }),
    update: () => Promise.resolve({}),
    remove: () => Promise.resolve(),
    onRemoved: noEvent,
    onUpdated: noEvent,
  },
  storage: { local: { get: (_k, cb) => cb && cb({}), set: () => {} } },
  alarms: { create: () => {}, onAlarm: noEvent, clear: () => {} },
};

// A WebSocket that never opens and never delivers: lets us exercise the
// "waiting for a connection" path deterministically.
class DeadSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    DeadSocket.last = this;
  }
  send() {
    throw new Error("send on a closed socket");
  }
  close() {}
  addEventListener() {}
}
global.WebSocket = DeadSocket;

// background.js runs as an IIFE-less module body; evaluate it and grab the
// internals we need through a trailing export hook.
//
// ZSGuard is injected here exactly as the worker gets it via importScripts, so
// the heartbeat in the test runs the same rule the service worker runs.
const guardSrc = fs.readFileSync(__dirname + "/core/guard.js", "utf8");
const ZSGuard = (0, eval)(guardSrc + "\n; ZSGuard;");
const src = fs.readFileSync(__dirname + "/background.js", "utf8");
const internals = new Function(
  "chrome",
  "WebSocket",
  "ZSGuard",
  src + "\n; return { send, failAllPending, resolvePending, pending, SUBAGENT_PROVIDER_URLS, SUBAGENT_PROVIDER_ALIASES, resolveSubagentProvider, isGatewayApiProvider, spawnSubagentTab, spawnSubagentBatch, settleSubagent, subagentSessions, setConnected: (v) => { connected = v; }, setWs: (w) => { ws = w; }, setAiProvidersCache: (list) => { aiProvidersCache = list; } };"
)(global.chrome, global.WebSocket, ZSGuard);

const { send, failAllPending, resolvePending, pending, SUBAGENT_PROVIDER_URLS, SUBAGENT_PROVIDER_ALIASES, resolveSubagentProvider, isGatewayApiProvider, spawnSubagentTab, spawnSubagentBatch, settleSubagent, subagentSessions } = internals;

(async () => {
  // ── 1. Nothing connected: the request never left ─────────────────────────
  // waitForConnection runs for CONNECT_WAIT_MS, so keep this short by using a
  // fast probe type (CONNECT_WAIT_MS is 2500, well inside a test budget).
  {
    const t0 = Date.now();
    const r = await send({ type: "ping" }, 2000);
    ok("unconnected socket reports disconnected", r.ok === false && r.kind === "disconnected");
    ok("unconnected socket is NOT marked sent", r.sent === false);
    ok("the wait is bounded by CONNECT_WAIT_MS", Date.now() - t0 < 6000);
  }

  // ── 2. Frame went out, then the socket died ──────────────────────────────
  // This is the dangerous case: the bridge may already have run the tool.
  {
    const live = { readyState: 1, send: () => {}, close: () => {} };
    internals.setConnected(true);
    internals.setWs(live);
    const p = send({ type: "call_tool", name: "write_file", arguments: { path: "a.txt" } }, 5000);
    // Let send() register the pending entry before failing it.
    await new Promise((r) => setTimeout(r, 10));
    ok("a delivered request is pending", pending.size === 1);
    const [entry] = [...pending.values()];
    ok("the pending entry records that it was sent", entry.sent === true);
    failAllPending("connection lost");
    const r = await p;
    ok("dropped mid-flight reports disconnected", r.kind === "disconnected");
    ok("dropped mid-flight IS marked sent (no blind retry)", r.sent === true);
  }

  // ── 3. ws.send throws: nothing reached the bridge ────────────────────────
  {
    const throwing = {
      readyState: 1,
      send: () => { throw new Error("boom"); },
      close: () => {},
    };
    internals.setConnected(true);
    internals.setWs(throwing);
    const r = await send({ type: "call_tool", name: "list_dir", arguments: {} }, 5000);
    ok("a failed ws.send reports disconnected", r.kind === "disconnected");
    ok("a failed ws.send is NOT marked sent (safe to retry)", r.sent === false);
    ok("the failed entry is cleaned out of pending", pending.size === 0);
  }

  // ── 4. Ping has a real case in the dispatcher ────────────────────────────
  // Before the fix, bg({type:"ping"}) fell through to `default:` and answered
  // {ok:false,error:"unknown message"}, which every caller reads as "bridge
  // down" even though a manual ping answered in 1 ms.
  {
    ok("the dispatcher registered a listener", listeners.length > 0);
    const handler = listeners[0];
    const reply = await new Promise((resolve) => {
      // Bridge is disconnected: the honest answer is ok:false with a kind, NOT
      // an "unknown message" error from the default branch.
      handler({ type: "ping" }, {}, resolve);
      setTimeout(() => resolve({ timedOut: true }), 9000);
    });
    ok("ping is a known message type", !(reply && reply.error === "unknown message"));
    ok("ping answers a structured failure when the bridge is down",
      reply && (reply.ok === true || typeof reply.kind === "string"));
  }

  // -- 5. Subagent provider routing, aliases, batch limits, and cleanup --
  {
    ok("all 12 canonical subagent providers have URLs", Object.keys(SUBAGENT_PROVIDER_URLS).length === 12);
    const gpt = resolveSubagentProvider("gpt");
    const lechat = resolveSubagentProvider("lechat");
    const zai = resolveSubagentProvider("z.ai");
    ok("aliases normalize to canonical providers", gpt.ok && gpt.provider === "chatgpt" && lechat.provider === "mistral" && zai.provider === "glm");

    const unknown = resolveSubagentProvider("nonexistent-ai");
    ok("unknown provider returns explicit error with supported list", unknown.ok === false && /Supported providers:/i.test(unknown.error) && /claude/i.test(unknown.error));

    const emptyTask = await spawnSubagentTab({ task: "   " }, {});
    ok("spawnSubagentTab rejects blank task", emptyTask && emptyTask.ok === false);

    const tooMany = await spawnSubagentBatch({ tasks: ["a", "b", "c", "d", "e", "f", "g"] }, {});
    ok("spawnSubagentBatch enforces max parallel cap", tooMany && tooMany.ok === false && /maximum is 6/i.test(tooMany.error));

    let closedTabId = null;
    chrome.tabs.remove = (tabId) => { closedTabId = tabId; return Promise.resolve(); };
    let settledPayload = null;
    const fakeTimer = setTimeout(() => {}, 60000);
    subagentSessions.set("sa_test_1", {
      parentTabId: 10,
      childTabId: 42,
      provider: "claude",
      autoClose: true,
      stage: "running_task",
      resolve: (v) => { settledPayload = v; },
      timer: fakeTimer,
    });
    const handled = settleSubagent("sa_test_1", { ok: true, result: "done" });
    clearTimeout(fakeTimer);
    ok("settleSubagent cleans up session, closes tab when autoClose is true, and resolves", handled === true && !subagentSessions.has("sa_test_1") && closedTabId === 42 && settledPayload && settledPayload.ok === true);

    // Hybrid AI Gateway routing tests.
    internals.setAiProvidersCache([
      { id: "ollama", enabled: true, defaultModel: "llama3.2" },
      { id: "openrouter", enabled: false, defaultModel: "openai/gpt-4o-mini" },
    ]);
    ok("isGatewayApiProvider matches enabled provider, model prefix, and auto", isGatewayApiProvider("ollama") === true && isGatewayApiProvider("ollama/llama3.2") === true && isGatewayApiProvider("auto") === true && isGatewayApiProvider("openrouter") === false && isGatewayApiProvider("claude") === false);

    const sentFrames = [];
    const gwWs = { readyState: 1, send: (data) => sentFrames.push(data), close: () => {} };
    internals.setWs(gwWs);
    internals.setConnected(true);
    const gwPromise = spawnSubagentTab({ task: "Summarize file", provider: "ollama", target_server: "vscode" }, {});
    await new Promise((r) => setTimeout(r, 10));
    const gwReq = JSON.parse(sentFrames[0]);
    ok("spawnSubagentTab dispatches gateway_subagent for enabled API provider", gwReq.type === "gateway_subagent" && gwReq.provider === "ollama" && gwReq.task === "Summarize file");
    resolvePending(gwReq.id, { type: "gateway_subagent_result", id: gwReq.id, ok: true, provider: "ollama", model: "llama3.2", result: "headless-ok" });
    const gwOut = await gwPromise;
    ok("spawnSubagentTab returns headless gateway result", gwOut && gwOut.ok === true && gwOut.via === "gateway" && gwOut.result === "headless-ok");

    // Gateway failure with fallback: false returns error directly without opening a browser tab.
    const gwNoFbPromise = spawnSubagentTab({ task: "Fail no fallback", provider: "ollama", fallback: false }, {});
    await new Promise((r) => setTimeout(r, 10));
    const gwNoFbReq = JSON.parse(sentFrames[1]);
    resolvePending(gwNoFbReq.id, { type: "gateway_subagent_result", id: gwNoFbReq.id, ok: false, error: "503 down", fallback_browser: "claude" });
    const gwNoFbOut = await gwNoFbPromise;
    ok("spawnSubagentTab respects fallback: false on gateway error", gwNoFbOut && gwNoFbOut.ok === false && /503 down/.test(gwNoFbOut.error));

    // Gateway failure with fallback_browser opens the fallback browser tab.
    const origTabsCreate = chrome.tabs.create;
    const origTabsGet = chrome.tabs.get;
    let fallbackTabOpts = null;
    chrome.tabs.create = (opts) => {
      fallbackTabOpts = opts;
      return Promise.resolve({ id: 777 });
    };
    chrome.tabs.get = (_id, cb) => cb && cb({ status: "complete" });
    const gwFbPromise = spawnSubagentTab({ task: "Fallback to browser", provider: "ollama" }, {});
    await new Promise((r) => setTimeout(r, 10));
    const gwFbReq = JSON.parse(sentFrames[2]);
    resolvePending(gwFbReq.id, { type: "gateway_subagent_result", id: gwFbReq.id, ok: false, error: "503 down", fallback_browser: "claude" });
    await new Promise((r) => setTimeout(r, 20));
    const fbSessionEntry = [...subagentSessions.entries()].find(([, s]) => s.provider === "claude");
    if (fbSessionEntry) {
      settleSubagent(fbSessionEntry[0], { ok: true, provider: "claude", result: "browser-fallback-ok" });
    }
    const gwFbOut = await gwFbPromise;
    chrome.tabs.create = origTabsCreate;
    chrome.tabs.get = origTabsGet;
    ok(
      "spawnSubagentTab opens fallback browser tab when gateway fails with fallback_browser",
      Boolean(fallbackTabOpts) && fallbackTabOpts.url === SUBAGENT_PROVIDER_URLS.claude && gwFbOut && gwFbOut.ok === true && gwFbOut.result === "browser-fallback-ok"
    );

    // Cleanup fake socket state.
    internals.setWs(null);
    internals.setConnected(false);
    internals.setAiProvidersCache([]);
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
