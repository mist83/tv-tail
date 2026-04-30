/* ============================================================
   tv-tail · dashboard (canonical workspace-shell composition)
   ============================================================
   Boots the canonical Mullmania workspace shell via UI.mount, then
   subscribes to the shared signal-argh channel and re-mounts the
   sidebar / feed on each batch. No custom layout CSS — everything
   structural comes from ui.mullmania.com.
   ============================================================ */

await waitForGlobals(["UI", "signalR"], 8000).catch((err) => showFatal(err && err.message));
await window.UI.ready();

const STORAGE_KEY = {
  channel: "tv-tail.channel",
  hub: "tv-tail.hub",
  levels: "tv-tail.levels",
};

const state = {
  conn: null,
  channel: localStorage.getItem(STORAGE_KEY.channel) || "tv-logs",
  hub: localStorage.getItem(STORAGE_KEY.hub) || `https://signalargh.${baseHost()}`,
  connState: "connecting",                              // connecting | connected | reconnecting | offline
  apps: new Map(),                                      // appId -> { firstSeen, lastSeen, hello, lineCount, errors, warns, version }
  selectedApp: null,
  paused: false,
  autoScroll: true,
  search: "",
  levels: loadLevels(),
  buffer: [],                                           // rolling feed entries
  bufferMax: 2000,
  totalLines: 0,
  ts: 0,
};

function loadLevels() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY.levels) || "null");
    if (saved && typeof saved === "object") return { debug: false, log: true, info: true, warn: true, error: true, ...saved };
  } catch (e) { /* fallthrough */ }
  return { debug: false, log: true, info: true, warn: true, error: true };
}

function baseHost() {
  const h = location.hostname;
  if (!h || h === "localhost" || h === "127.0.0.1" || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return "mullmania.com";
  const parts = h.split(".");
  return parts.length <= 2 ? h : parts.slice(-2).join(".");
}

// ── Header (canonical .header) ───────────────────────────────

function renderHeader() {
  const headerEl = document.getElementById("header-container");
  if (!headerEl) return;
  const dot = state.connState === "connected" ? "var(--color-success)"
    : state.connState === "offline" ? "var(--color-danger)"
    : "var(--color-warning)";
  headerEl.innerHTML = `
    <h1>
      <i class="ti ti-broadcast"></i>
      <span>tv·tail</span>
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dot};box-shadow:0 0 10px ${dot};margin-left:10px" title="${state.connState}"></span>
    </h1>
    <div class="header-links">
      <a class="header-link" href="https://github.com/mist83/tv-tail" target="_blank" rel="noreferrer">
        <i class="ti ti-brand-github"></i><span>github</span>
      </a>
      <a class="header-link" href="https://agent.mullmania.com/doctrine/shared/rules/reference/reference_tv_telemetry.md" target="_blank" rel="noreferrer">
        <i class="ti ti-book-2"></i><span>canon</span>
      </a>
    </div>
  `;
}

// ── Workspace tabs (the canonical sidebar+content shape) ─────

function renderShell() {
  if (state.shell) {
    state.shell.sitemap = buildSitemap();
    return state.shell.loadTab("logs", state.selectedApp || "all", true);
  }
  state.shell = new window.TabsEverywhere({
    tabsContainerId: "tabs-container",
    contentContainerId: "content-container",
    sitemap: buildSitemap(),
  });
  return state.shell.init();
}

function buildSitemap() {
  return {
    tabs: [
      {
        id: "logs",
        label: "Logs",
        icon: "ti ti-list",
        layout: "workspace",
        sections: [
          {
            type: "list",
            inlineData: buildAppList(),
          },
        ],
      },
      {
        id: "about",
        label: "About",
        icon: "ti ti-info-circle",
        layout: "workspace",
        sections: [
          {
            type: "list",
            inlineData: [
              {
                id: "protocol",
                name: "Protocol",
                icon: "ti ti-protocol",
                description: "hello / log / bye on shared signal-argh channel",
                preset: "tv-tail.protocol",
              },
              {
                id: "wire-it",
                name: "Wire it into an app",
                icon: "ti ti-plug-connected",
                description: "One <script> tag — that's it",
                preset: "tv-tail.wire-it",
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildAppList() {
  const allRow = {
    id: "all",
    name: "All apps",
    icon: "ti ti-broadcast",
    description: `${state.apps.size} live · ${state.totalLines.toLocaleString()} lines total`,
    preset: "tv-tail.feed",
  };
  const entries = Array.from(state.apps.values())
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((app) => ({
      id: app.appId,
      name: app.appId,
      icon: app.errors > 0 ? "ti ti-alert-triangle" : app.warns > 0 ? "ti ti-alert-circle" : "ti ti-circle-dot",
      description: appBadge(app),
      preset: "tv-tail.feed",
    }));
  return [allRow, ...entries];
}

function appBadge(app) {
  const aliveSec = Math.floor((Date.now() - app.lastSeen) / 1000);
  const live = aliveSec < 30 ? "live" : `quiet ${aliveSec}s`;
  const tags = [];
  if (app.errors) tags.push(`${app.errors}e`);
  if (app.warns) tags.push(`${app.warns}w`);
  tags.push(`${app.lineCount} lines`);
  if (app.version) tags.push(`v${app.version}`);
  return `${live} · ${tags.join(" · ")}`;
}

// ── Custom presets that the workspace renders in the content pane ───

window.UI.presets = window.UI.presets || {};
window.UI.presets.register = window.UI.presets.register || ((id, fn) => { window.UI.presets[id] = fn; });

function feedPreset(detailItem) {
  const filterApp = detailItem && detailItem.id !== "all" ? detailItem.id : null;
  state.selectedApp = filterApp;
  return {
    component: "app",
    title: filterApp ? `Logs · ${filterApp}` : "All logs",
    subtitle: filterApp
      ? "Streaming events from one app. Topics: hello, log, bye."
      : "Streaming events from every browser app on the shared tv-logs channel.",
    sections: [
      controlsSection(),
      filtersSection(),
      feedSection(filterApp),
    ],
  };
}

function controlsSection() {
  return {
    component: "section",
    title: "Controls",
    description: `Channel ${state.channel} on ${state.hub}`,
    children: [
      UI.stack({
        direction: "row",
        gap: "sm",
        children: [
          UI.button({
            label: state.paused ? "RESUME" : "PAUSE",
            variant: state.paused ? "primary" : "secondary",
            icon: state.paused ? "ti ti-player-play" : "ti ti-player-pause",
            action: { type: "callback", callbackId: "tv-tail.pause" },
          }),
          UI.button({
            label: "CLEAR",
            variant: "secondary",
            icon: "ti ti-trash",
            action: { type: "callback", callbackId: "tv-tail.clear" },
          }),
          UI.button({
            label: "COPY",
            variant: "secondary",
            icon: "ti ti-copy",
            action: { type: "callback", callbackId: "tv-tail.copy" },
          }),
          UI.button({
            label: state.autoScroll ? "AUTO-SCROLL: ON" : "AUTO-SCROLL: OFF",
            variant: state.autoScroll ? "primary" : "secondary",
            icon: "ti ti-arrow-down",
            action: { type: "callback", callbackId: "tv-tail.autoscroll" },
          }),
          UI.button({
            label: "RECONNECT",
            variant: "secondary",
            icon: "ti ti-refresh",
            action: { type: "callback", callbackId: "tv-tail.reconnect" },
          }),
        ],
      }),
    ],
  };
}

function filtersSection() {
  const lvls = ["debug", "log", "info", "warn", "error"];
  return {
    component: "section",
    title: "Filters",
    description: "Tick off levels you don't care about. Search filters by message substring.",
    children: [
      UI.stack({
        direction: "row",
        gap: "md",
        children: [
          {
            tag: "label",
            attrs: { style: "display:inline-flex;align-items:center;gap:6px;font-size:var(--text-sm)" },
            children: [
              { tag: "span", attrs: { style: "color:var(--text-muted);letter-spacing:0.18em;font-size:var(--text-xs)" }, text: "SEARCH" },
              {
                tag: "input",
                attrs: {
                  type: "search",
                  id: "tv-tail-search",
                  value: state.search,
                  placeholder: "filter messages…",
                  style: "min-width:280px",
                  oninput: "window.tvTail.setSearch(this.value)",
                },
              },
            ],
          },
          ...lvls.map((lvl) => ({
            tag: "label",
            attrs: { style: "display:inline-flex;align-items:center;gap:4px;font-size:var(--text-sm);padding:2px 6px;border-radius:var(--radius-sm);cursor:pointer" },
            children: [
              {
                tag: "input",
                attrs: {
                  type: "checkbox",
                  ...(state.levels[lvl] ? { checked: "checked" } : {}),
                  onchange: `window.tvTail.toggleLevel('${lvl}', this.checked)`,
                  style: "accent-color:var(--color-primary)",
                },
              },
              { tag: "span", text: lvl },
            ],
          })),
        ],
      }),
    ],
  };
}

function feedSection(filterApp) {
  const visible = state.buffer.filter((row) => visibleRow(row, filterApp));
  if (!visible.length) {
    return {
      component: "section",
      title: "Feed",
      children: [
        UI.alert({
          tone: "info",
          title: "No matching log lines yet.",
          message: `Open any app on the device you want to watch and add this to its <head>: <code>&lt;script src="https://tv-tail.mullmania.com/log-tap.js"&gt;&lt;/script&gt;</code>`,
        }),
      ],
    };
  }
  // Render the feed as a fragment of plain rows (no UI primitive maps neatly
  // to a streaming log feed; per the directive, the wrapper section is still
  // the framework's UI.section).
  const rows = visible.slice(-1000).map((row) => {
    const session = (row.sessionId || "").slice(0, 6);
    return {
      tag: "li",
      attrs: { class: `feed-row lvl-${row.level}` },
      children: [
        { tag: "span", attrs: { class: "ts" }, text: (row.ts || "").slice(11, 23) },
        { tag: "span", attrs: { class: "lvl" }, text: row.level.toUpperCase() },
        { tag: "span", attrs: { class: "app" }, text: row.appId },
        { tag: "span", attrs: { class: "ses" }, text: session },
        { tag: "span", attrs: { class: "msg" }, text: row.msg },
      ],
    };
  });
  return {
    component: "section",
    title: `Feed · ${visible.length.toLocaleString()} lines`,
    description: filterApp ? `Filtered to ${filterApp}.` : "All apps.",
    children: [
      {
        tag: "ol",
        attrs: { id: "feed", style: "list-style:none;padding:0;margin:0;max-height:60vh;overflow:auto;border:1px solid var(--border-light);border-radius:var(--radius-md);background:var(--bg-secondary)" },
        children: rows,
      },
    ],
  };
}

function visibleRow(row, filterApp) {
  if (filterApp && row.appId !== filterApp) return false;
  if (!state.levels[row.level]) return false;
  if (state.search && !row.msg.toLowerCase().includes(state.search.toLowerCase())) return false;
  return true;
}

function aboutPreset(which) {
  return () => {
    if (which === "protocol") {
      return {
        component: "app",
        title: "Protocol",
        subtitle: "Three customMessage topics on the shared tv-logs channel.",
        sections: [
          {
            component: "section",
            title: "Topics",
            children: [
              UI.table({
                columns: [
                  { key: "topic", label: "topic" },
                  { key: "shape", label: "payload" },
                  { key: "meaning", label: "meaning" },
                ],
                rows: [
                  { topic: "hello", shape: "{appId, sessionId, ua, screen, version, url}", meaning: "App attached." },
                  { topic: "log",   shape: "{appId, sessionId, batch:[{ts,level,msg,url}], dropped}", meaning: "Batch of events." },
                  { topic: "bye",   shape: "{appId, sessionId}", meaning: "Pagehide best-effort." },
                ],
              }),
            ],
          },
        ],
      };
    }
    return {
      component: "app",
      title: "Wire tv-tail into an app",
      subtitle: "One script tag in the app's <head>, before any module scripts.",
      sections: [
        {
          component: "section",
          title: "The whole recipe",
          children: [
            {
              tag: "pre",
              attrs: { style: "background:var(--bg-secondary);border:1px solid var(--border-medium);padding:14px;border-radius:var(--radius-md);overflow:auto;color:var(--color-primary);user-select:all" },
              text: `<meta name="repo-name" content="my-app">\n<script src="https://tv-tail.mullmania.com/log-tap.js"></script>`,
            },
            UI.alert({
              tone: "info",
              title: "That's it.",
              message: `The shim derives the hub host from <code>location.hostname</code>, so the same line works on mullmania.com and mikesendpoint.com.`,
            }),
          ],
        },
      ],
    };
  };
}

// Register presets so the workspace shell can dispatch to them.
// (Use the framework's documented register() API — direct assignment to
// UI.presets[id] hits a private object the resolver doesn't see.)
function registerPresets() {
  const reg = window.UI.presets;
  reg.register("tv-tail.feed", (options) => feedPreset(options && options.item));
  reg.register("tv-tail.protocol", aboutPreset("protocol"));
  reg.register("tv-tail.wire-it", aboutPreset("wire-it"));
}

// Expose toggles the inline event handlers call.
window.tvTail = {
  setSearch(v) {
    state.search = v;
    rerender();
  },
  toggleLevel(lvl, on) {
    state.levels[lvl] = !!on;
    try { localStorage.setItem(STORAGE_KEY.levels, JSON.stringify(state.levels)); } catch (e) {}
    rerender();
  },
  togglePause() {
    state.paused = !state.paused;
    rerender();
  },
  clear() {
    state.buffer.length = 0;
    rerender();
  },
  copy() {
    const text = state.buffer
      .filter((row) => visibleRow(row, state.selectedApp))
      .map((row) => `${(row.ts || "").slice(11, 23)} ${row.level.toUpperCase().padEnd(5)} ${row.appId} ${row.msg}`)
      .join("\n");
    navigator.clipboard?.writeText(text).catch(() => {});
  },
  toggleAutoScroll() {
    state.autoScroll = !state.autoScroll;
    rerender();
  },
  reconnect() { startConnection(); },
};

// Wire UI button callbacks (the framework's "callback" action type).
window.UI.callbacks = window.UI.callbacks || {};
window.UI.callbacks["tv-tail.pause"] = () => window.tvTail.togglePause();
window.UI.callbacks["tv-tail.clear"] = () => window.tvTail.clear();
window.UI.callbacks["tv-tail.copy"]  = () => window.tvTail.copy();
window.UI.callbacks["tv-tail.autoscroll"] = () => window.tvTail.toggleAutoScroll();
window.UI.callbacks["tv-tail.reconnect"]  = () => window.tvTail.reconnect();

// ── Live wire (signal-argh) ──────────────────────────────────

async function startConnection() {
  if (state.conn) {
    try { await state.conn.stop(); } catch (e) { /* ignore */ }
    state.conn = null;
  }
  state.connState = "connecting";
  renderHeader();
  try {
    const conn = new window.signalR.HubConnectionBuilder()
      .withUrl(`${state.hub}/hub?channelId=${encodeURIComponent(state.channel)}&userId=tv-tail-dashboard-${Math.random().toString(36).slice(2, 8)}`, { withCredentials: false })
      .withAutomaticReconnect()
      .configureLogging(window.signalR.LogLevel.Warning)
      .build();
    conn.on("customMessage", onCustom);
    conn.on("systemNotification", () => { /* quiet */ });
    conn.on("channelChat", () => { /* quiet */ });
    conn.on("channelAnnouncement", () => { /* quiet */ });
    conn.onreconnecting(() => { state.connState = "reconnecting"; renderHeader(); });
    conn.onreconnected(() => { state.connState = "connected"; renderHeader(); });
    conn.onclose(() => { state.connState = "offline"; renderHeader(); });
    await conn.start();
    state.conn = conn;
    state.connState = "connected";
  } catch (err) {
    state.connState = "offline";
  }
  renderHeader();
}

function onCustom({ topic, message, userId }) {
  if (state.paused) return;
  let payload;
  try { payload = JSON.parse(message); } catch { return; }
  if (!payload) return;
  if (topic === "hello") return ingestHello(payload);
  if (topic === "log")   return ingestLog(payload);
  if (topic === "bye")   return ingestBye(payload);
}

function ensureApp(appId, payload) {
  let app = state.apps.get(appId);
  if (!app) {
    app = { appId, firstSeen: Date.now(), lastSeen: Date.now(), lineCount: 0, errors: 0, warns: 0, version: payload?.version || "" };
    state.apps.set(appId, app);
  }
  app.lastSeen = Date.now();
  if (payload?.version) app.version = payload.version;
  return app;
}

function ingestHello(payload) {
  const app = ensureApp(payload.appId || "unknown", payload);
  app.helloAt = Date.now();
  scheduleRender();
}

function ingestBye(payload) {
  const app = state.apps.get(payload.appId);
  if (app) app.lastSeen = 0;
  scheduleRender();
}

function ingestLog(payload) {
  const appId = payload.appId || "unknown";
  const app = ensureApp(appId, payload);
  const items = Array.isArray(payload.batch) ? payload.batch : [];
  for (const item of items) {
    state.buffer.push({
      ts: item.ts,
      level: item.level || "log",
      msg: item.msg || "",
      appId,
      sessionId: payload.sessionId || "",
    });
    app.lineCount += 1;
    state.totalLines += 1;
    if (item.level === "error") app.errors += 1;
    if (item.level === "warn") app.warns += 1;
  }
  while (state.buffer.length > state.bufferMax) state.buffer.shift();
  scheduleRender();
}

// ── Render orchestration ─────────────────────────────────────

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; rerender(); }, 250);
}

function rerender() {
  renderHeader();
  if (!state.shell) return;
  state.shell.sitemap = buildSitemap();
  // Force the shell to refresh its current pane.
  if (state.shell.currentTab) state.shell.loadTab(state.shell.currentTab.id, state.shell.currentItem?.id, true);
  // Auto-scroll the feed if user hasn't disabled it.
  if (state.autoScroll) {
    const feed = document.getElementById("feed");
    if (feed) feed.scrollTop = feed.scrollHeight;
  }
}

// ── Boot ──────────────────────────────────────────────────────

function showFatal(msg) {
  const c = document.getElementById("content-container") || document.body;
  c.innerHTML = `<div class="page-container"><div style="padding:40px"><h1 style="color:var(--color-danger)">tv-tail · boot failure</h1><pre>${(msg || "unknown").toString().replace(/[<>]/g, "")}</pre></div></div>`;
}

function waitForGlobals(names, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    function tick() {
      if (names.every((n) => window[n])) return resolve();
      if (performance.now() - t0 > timeout) return reject(new Error("waitForGlobals timeout: " + names.join(",")));
      setTimeout(tick, 80);
    }
    tick();
  });
}

(async function boot() {
  registerPresets();
  renderHeader();
  await renderShell();
  await startConnection();
})().catch((err) => showFatal(err && (err.stack || err.message)));
