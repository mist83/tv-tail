/* ============================================================
   tv-tail · dashboard
   ============================================================
   Subscribes to the shared signal-argh channel (default "tv-logs"),
   listens for the three protocol topics (hello / log / bye), and
   renders a live feed with per-app filters.
   ============================================================ */

await waitForGlobals(["signalR"], 8000).catch(() => {
  showFatal("could not load @microsoft/signalr from CDN — open devtools.");
});

const els = {
  feed: document.getElementById("feed"),
  emptyState: document.getElementById("empty-state"),
  appList: document.getElementById("app-list"),
  appCount: document.getElementById("app-count"),
  search: document.getElementById("search-input"),
  pauseBtn: document.getElementById("pause-btn"),
  clearBtn: document.getElementById("clear-btn"),
  copyBtn: document.getElementById("copy-btn"),
  autoscrollBtn: document.getElementById("autoscroll-btn"),
  reconnectBtn: document.getElementById("reconnect-btn"),
  channelInput: document.getElementById("channel-input"),
  hubInput: document.getElementById("hub-input"),
  connDot: document.getElementById("conn-dot"),
  stats: document.getElementById("stats"),
  emptyChannel: document.getElementById("empty-channel"),
  emptyHub: document.getElementById("empty-hub"),
  footerChannel: document.getElementById("footer-channel"),
  levelChecks: Array.from(document.querySelectorAll(".lvl input[type=checkbox]")),
};

const state = {
  conn: null,
  channel: localStorage.getItem("tv-tail.channel") || "tv-logs",
  hub: localStorage.getItem("tv-tail.hub") || `https://signalargh.${baseHost()}`,
  apps: new Map(),                  // appId -> { firstSeen, lastSeen, hello, sessionId, lineCount, levels: {error,warn,...} }
  selectedApp: null,
  paused: false,
  autoscroll: true,
  search: "",
  levels: { debug: false, log: true, info: true, warn: true, error: true },
  buffer: [],                       // all received items, capped
  MAX_LINES: 5000,
  renderedTo: 0,
};

function baseHost() {
  const h = location.hostname;
  if (!h || h === "localhost" || h === "127.0.0.1") return "mullmania.com";
  const parts = h.split(".");
  return parts.length <= 2 ? h : parts.slice(-2).join(".");
}

els.channelInput.value = state.channel;
els.hubInput.value = state.hub;
els.emptyChannel.textContent = state.channel;
els.emptyHub.textContent = state.hub.replace(/^https?:\/\//, "");
els.footerChannel.textContent = state.channel;

// ── Filter wiring ──────────────────────────────────────────

els.levelChecks.forEach((cb) => {
  cb.addEventListener("change", () => {
    state.levels[cb.dataset.level] = cb.checked;
    rerender();
  });
});
els.search.addEventListener("input", () => {
  state.search = els.search.value.trim().toLowerCase();
  rerender();
});
els.pauseBtn.addEventListener("click", () => {
  state.paused = !state.paused;
  els.pauseBtn.textContent = state.paused ? "RESUME" : "PAUSE";
  els.pauseBtn.setAttribute("aria-pressed", String(state.paused));
  if (!state.paused) rerender();
});
els.clearBtn.addEventListener("click", () => {
  state.buffer = [];
  state.renderedTo = 0;
  els.feed.innerHTML = "";
  refreshStats();
});
els.copyBtn.addEventListener("click", () => {
  const text = visibleItems().map(formatLine).join("\n");
  navigator.clipboard?.writeText(text).then(() => flashToast("copied " + text.split("\n").filter(Boolean).length + " lines"));
});
els.autoscrollBtn.addEventListener("click", () => {
  state.autoscroll = !state.autoscroll;
  els.autoscrollBtn.textContent = state.autoscroll ? "AUTO-SCROLL" : "MANUAL";
  els.autoscrollBtn.setAttribute("aria-pressed", String(state.autoscroll));
});
els.reconnectBtn.addEventListener("click", () => {
  state.channel = els.channelInput.value.trim() || "tv-logs";
  state.hub = els.hubInput.value.trim() || `https://signalargh.${baseHost()}`;
  localStorage.setItem("tv-tail.channel", state.channel);
  localStorage.setItem("tv-tail.hub", state.hub);
  els.emptyChannel.textContent = state.channel;
  els.emptyHub.textContent = state.hub.replace(/^https?:\/\//, "");
  els.footerChannel.textContent = state.channel;
  reconnect();
});

// Click an app pill to filter
els.appList.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-app]");
  if (!li) return;
  const appId = li.dataset.app;
  state.selectedApp = (state.selectedApp === appId) ? null : appId;
  Array.from(els.appList.children).forEach((c) => c.classList.toggle("selected", c.dataset.app === state.selectedApp));
  rerender();
});

// ── SignalR connection ─────────────────────────────────────

async function reconnect() {
  if (state.conn) {
    try { await state.conn.stop(); } catch { /* ignore */ }
    state.conn = null;
  }
  setConnState("connecting");
  const userId = "dash-" + Math.random().toString(36).slice(2, 8);
  const url = `${state.hub}/hub?channelId=${encodeURIComponent(state.channel)}&userId=${encodeURIComponent(userId)}`;
  const conn = new window.signalR.HubConnectionBuilder()
    .withUrl(url, { withCredentials: false })
    .withAutomaticReconnect([0, 500, 2000, 5000, 10000, 30000])
    .configureLogging(window.signalR.LogLevel.Warning)
    .build();

  conn.on("customMessage", onCustom);
  conn.onreconnected(() => setConnState("connected"));
  conn.onreconnecting(() => setConnState("reconnecting"));
  conn.onclose(() => setConnState("offline"));

  state.conn = conn;
  try {
    await conn.start();
    setConnState("connected");
  } catch (err) {
    console.warn("[tv-tail] connect failed", err);
    setConnState("offline");
  }
}

function setConnState(s) {
  els.connDot.dataset.state = s;
  els.connDot.title = s;
}

function onCustom({ topic, message, userId }) {
  let payload;
  try { payload = JSON.parse(message); } catch { return; }
  if (!payload || typeof payload !== "object") return;
  const appId = payload.appId || "unknown";

  if (topic === "hello") return upsertApp(appId, payload, true);
  if (topic === "bye")   return markAppGone(appId, payload);
  if (topic !== "log")   return;

  upsertApp(appId, payload, false);
  const items = Array.isArray(payload.batch) ? payload.batch : [];
  const sessionId = payload.sessionId || "";
  for (const it of items) {
    const item = {
      ts: it.ts || new Date().toISOString(),
      level: it.level || "log",
      msg: String(it.msg || ""),
      appId, sessionId,
      url: it.url || "",
    };
    state.buffer.push(item);
    if (state.buffer.length > state.MAX_LINES) state.buffer.shift();
    bumpAppLevel(appId, item.level);
  }
  if (!state.paused) renderIncremental();
  refreshStats();
  if (state.buffer.length) hideEmptyState();
}

// ── App registry ───────────────────────────────────────────

function upsertApp(appId, payload, isHello) {
  const now = Date.now();
  let app = state.apps.get(appId);
  if (!app) {
    app = {
      appId,
      firstSeen: now,
      lastSeen: now,
      sessionId: payload.sessionId || "",
      hello: null,
      lineCount: 0,
      levels: { debug: 0, log: 0, info: 0, warn: 0, error: 0 },
    };
    state.apps.set(appId, app);
  }
  app.lastSeen = now;
  if (isHello) app.hello = payload;
  if (payload.sessionId) app.sessionId = payload.sessionId;
  renderAppList();
}

function markAppGone(appId, payload) {
  const app = state.apps.get(appId);
  if (!app) return;
  app.gone = true;
  app.lastSeen = Date.now();
  renderAppList();
}

function bumpAppLevel(appId, level) {
  const app = state.apps.get(appId);
  if (!app) return;
  app.lineCount += 1;
  app.levels[level] = (app.levels[level] || 0) + 1;
}

// Re-render the app list every few seconds to update "alive" indicators.
setInterval(renderAppList, 4000);

function renderAppList() {
  const list = Array.from(state.apps.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  els.appCount.textContent = list.length;
  els.appList.innerHTML = "";
  for (const app of list) {
    const since = Math.max(0, Math.floor((Date.now() - app.lastSeen) / 1000));
    const alive = since < 25 && !app.gone;
    const li = document.createElement("li");
    li.dataset.app = app.appId;
    li.className = (state.selectedApp === app.appId ? "selected " : "") + (alive ? "alive" : "stale");
    li.innerHTML = `
      <div class="app-row">
        <span class="app-dot" style="background:${appColor(app.appId)}"></span>
        <span class="app-id" title="${escapeHtml(app.appId)}">${escapeHtml(app.appId)}</span>
        <span class="app-meta">${alive ? "live" : `${since}s`}</span>
      </div>
      <div class="app-row dim">
        <span class="app-counts">
          ${app.levels.error ? `<span class="lvl-error">e ${app.levels.error}</span>` : ""}
          ${app.levels.warn  ? `<span class="lvl-warn">w ${app.levels.warn}</span>`   : ""}
          <span class="lvl-info">${app.lineCount} lines</span>
        </span>
        ${app.hello && app.hello.version ? `<span class="app-version">${escapeHtml(app.hello.version)}</span>` : ""}
      </div>
    `;
    els.appList.appendChild(li);
  }
}

// ── Feed render ────────────────────────────────────────────

function visibleItems() {
  const term = state.search;
  return state.buffer.filter((it) => {
    if (state.selectedApp && it.appId !== state.selectedApp) return false;
    if (!state.levels[it.level]) return false;
    if (term && !it.msg.toLowerCase().includes(term)) return false;
    return true;
  });
}

function renderIncremental() {
  // Render only the new tail since last call. If filters change we fully rerender.
  const items = visibleItems();
  if (items.length < state.renderedTo) {
    rerender();
    return;
  }
  const next = items.slice(state.renderedTo);
  for (const it of next) els.feed.appendChild(renderRow(it));
  state.renderedTo = items.length;
  trimFeedDom();
  if (state.autoscroll) els.feed.scrollTop = els.feed.scrollHeight;
}

function rerender() {
  els.feed.innerHTML = "";
  const items = visibleItems();
  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(renderRow(it));
  els.feed.appendChild(frag);
  state.renderedTo = items.length;
  trimFeedDom();
  if (state.autoscroll) els.feed.scrollTop = els.feed.scrollHeight;
  if (items.length) hideEmptyState();
}

function trimFeedDom() {
  while (els.feed.children.length > state.MAX_LINES) els.feed.removeChild(els.feed.firstChild);
}

function renderRow(it) {
  const li = document.createElement("li");
  li.className = `row lvl-${it.level}`;
  li.innerHTML = `
    <span class="row-time">${(it.ts || "").slice(11, 23)}</span>
    <span class="row-level">${it.level.toUpperCase().padEnd(5, " ")}</span>
    <span class="row-app" style="color:${appColor(it.appId)}">${escapeHtml(it.appId)}</span>
    <span class="row-session">${escapeHtml((it.sessionId || "").slice(0, 6))}</span>
    <span class="row-msg">${escapeHtml(it.msg)}</span>
  `;
  return li;
}

function formatLine(it) {
  return `${it.ts}  ${it.level.toUpperCase().padEnd(5)}  ${it.appId}  ${(it.sessionId||"").slice(0,6)}  ${it.msg}`;
}

function refreshStats() {
  const aliveCount = Array.from(state.apps.values()).filter((a) => Date.now() - a.lastSeen < 25000 && !a.gone).length;
  els.stats.textContent = `${state.buffer.length} lines · ${aliveCount}/${state.apps.size} apps live`;
}

function hideEmptyState() { els.emptyState.style.display = "none"; }

// ── Helpers ────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

function appColor(appId) {
  // Stable hash → hue, so each app gets a consistent color.
  let h = 0;
  for (let i = 0; i < appId.length; i++) h = (h * 31 + appId.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 65%)`;
}

function flashToast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1400);
}

function showFatal(msg) {
  document.body.innerHTML = `<pre style="color:#ff2c4d;padding:40px;font-family:monospace">tv-tail: ${msg}</pre>`;
}

function waitForGlobals(names, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    function check() {
      if (names.every((n) => window[n])) return resolve();
      if (performance.now() - t0 > timeout) return reject(new Error("waitForGlobals timeout: " + names.join(",")));
      setTimeout(check, 80);
    }
    check();
  });
}

reconnect();
