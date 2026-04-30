/* ============================================================
   tv-tail · log-tap.js
   ============================================================
   The canonical drop-in client shim for any browser app. Forwards
   console + errors + heartbeats to a single shared signal-argh
   channel ("tv-logs") so the hosted dashboard at
   tv-tail.mullmania.com (and the agent CLI ~/.claude/tools/tv-tail)
   can see every TV / mobile / headless app at once with per-app
   filters.

   The protocol is three customMessage topics on the shared channel:

     hello {appId, sessionId, ua, screen, version, url}
     log   {appId, sessionId, batch:[{ts, level, msg, url}], dropped}
     bye   {appId, sessionId}

   Self-contained: lazy-loads @microsoft/signalr from a CDN if it
   isn't already on the page. Loads BEFORE module scripts so it
   captures module-load failures too. Fails closed (silent) so a
   broken telemetry hub never breaks the host app.

   Usage in HTML (must come before module scripts):
     <script src="https://tv-tail.mullmania.com/log-tap.js"></script>

   Optional globals (set BEFORE this script runs):
     window.LOG_TAP_APP_ID   = "my-app";       // default: <meta name=repo-name>
     window.LOG_TAP_HUB      = "https://signalargh.mullmania.com";
     window.LOG_TAP_CHANNEL  = "tv-logs";       // default
     window.LOG_TAP_VERSION  = "1.2.3";         // surfaced on dashboard
     window.LOG_TAP_DISABLE  = true;            // no-op
   ============================================================ */

(function () {
  if (window.LOG_TAP_DISABLE) return;
  if (window.__logTap) return;

  // ── Config ────────────────────────────────────────────────
  function deriveBaseHost() {
    var h = location.hostname || "";
    if (!h || h === "localhost" || h === "127.0.0.1" || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return "mullmania.com";
    var parts = h.split(".");
    return parts.length <= 2 ? h : parts.slice(-2).join(".");
  }

  var META_REPO = (document.querySelector('meta[name=repo-name]') || {}).content || "unknown";
  var APP_ID = String(window.LOG_TAP_APP_ID || META_REPO).slice(0, 80);
  var HUB = window.LOG_TAP_HUB || ("https://signalargh." + deriveBaseHost());
  var CHANNEL = window.LOG_TAP_CHANNEL || "tv-logs";
  var VERSION = window.LOG_TAP_VERSION || "";
  var SESSION = (Math.random().toString(36).slice(2, 8)) + "-" + Date.now().toString(36);
  var SIGNALR_CDN = "https://cdnjs.cloudflare.com/ajax/libs/microsoft-signalr/8.0.0/signalr.min.js";

  // ── State ─────────────────────────────────────────────────
  var buffer = [];
  var MAX_BUFFER = 400;
  var conn = null;
  var connStarting = null;
  var flushTimer = null;
  var dropped = 0;
  var ready = false;
  var helloSent = false;

  // ── Capture ───────────────────────────────────────────────
  function record(level, args) {
    var msg = "";
    try {
      msg = Array.prototype.slice.call(args).map(function (a) {
        if (typeof a === "string") return a;
        if (a instanceof Error) return (a.stack || a.message || String(a));
        if (a === null || a === undefined) return String(a);
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(" ");
    } catch (e) { msg = "[unserializable]"; }
    if (msg.length > 4000) msg = msg.slice(0, 4000) + "…[trunc]";
    buffer.push({
      ts: new Date().toISOString(),
      level: level,
      msg: msg,
      url: location.href,
    });
    while (buffer.length > MAX_BUFFER) { buffer.shift(); dropped += 1; }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 1200);
  }

  function flush() {
    flushTimer = null;
    if (!buffer.length) return;
    if (!ready) { ensureConn(); return; }
    var batch = buffer.slice();
    buffer = [];
    var dropSnap = dropped;
    dropped = 0;
    sendCustom("log", { appId: APP_ID, sessionId: SESSION, batch: batch, dropped: dropSnap }).catch(function () {
      buffer = batch.concat(buffer).slice(-MAX_BUFFER);
      dropped += dropSnap;
    });
  }

  function sendCustom(topic, payload) {
    if (!conn) return Promise.reject(new Error("no conn"));
    var msg = JSON.stringify(payload);
    return conn.invoke("SendCustomMessage", CHANNEL, topic, msg);
  }

  function safeNav() {
    try { return navigator || {}; } catch (e) { return {}; }
  }
  function safeScreen() {
    try { return { w: screen && screen.width || 0, h: screen && screen.height || 0, dpr: (window.devicePixelRatio || 1) }; }
    catch (e) { return { w: 0, h: 0, dpr: 1 }; }
  }
  function safeOnline() {
    try { return safeNav().onLine !== false; } catch (e) { return true; }
  }

  function announceHello() {
    if (helloSent || !ready) return;
    helloSent = true;
    sendCustom("hello", {
      appId: APP_ID,
      sessionId: SESSION,
      version: VERSION,
      url: (location && location.href) || "",
      referrer: (document && document.referrer) || "",
      ua: (safeNav().userAgent || "").slice(0, 220),
      screen: safeScreen(),
      online: safeOnline(),
    }).catch(function () { helloSent = false; /* retry next cycle */ });
  }

  // ── SignalR (lazy) ────────────────────────────────────────
  function ensureSignalRLib() {
    if (window.signalR) return Promise.resolve();
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = SIGNALR_CDN;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { resolve(); /* signalR stays undefined; we'll retry later */ };
      document.head.appendChild(s);
    });
  }

  function ensureConn() {
    if (conn || connStarting) return connStarting;
    connStarting = ensureSignalRLib().then(function () {
      if (!window.signalR) return null;
      var url = HUB + "/hub?channelId=" + encodeURIComponent(CHANNEL) + "&userId=" + encodeURIComponent("tap-" + APP_ID + "-" + SESSION);
      conn = new window.signalR.HubConnectionBuilder()
        .withUrl(url, { withCredentials: false })
        .withAutomaticReconnect([0, 250, 1000, 3000, 5000, 10000, 30000])
        .configureLogging(window.signalR.LogLevel.None)
        .build();
      conn.onreconnected(function () { ready = true; helloSent = false; announceHello(); scheduleFlush(); });
      conn.onclose(function () { ready = false; });
      return conn.start().then(function () {
        ready = true;
        announceHello();
        scheduleFlush();
      }).catch(function () { conn = null; ready = false; });
    });
    return connStarting;
  }

  // ── Console patching ──────────────────────────────────────
  var levels = ["log", "info", "warn", "error", "debug"];
  levels.forEach(function (level) {
    var orig = console[level] || console.log;
    console[level] = function () {
      try { record(level, arguments); } catch (e) {}
      try { orig.apply(console, arguments); } catch (e) {}
    };
  });

  // ── Global error capture ─────────────────────────────────
  window.addEventListener("error", function (e) {
    var loc = (e.filename || "?") + ":" + (e.lineno || 0) + ":" + (e.colno || 0);
    record("error", ["[window.error]", e.message, loc, e.error && e.error.stack]);
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    record("error", ["[unhandledrejection]", r && (r.stack || r.message || String(r))]);
  });

  // ── Lifecycle ────────────────────────────────────────────
  window.addEventListener("pagehide", function () {
    flush();
    if (ready) sendCustom("bye", { appId: APP_ID, sessionId: SESSION }).catch(function () {});
  });
  window.addEventListener("beforeunload", function () { flush(); });
  setInterval(function () {
    var visible = true;
    try { visible = !document.hidden; } catch (e) { /* old WebKit */ }
    record("info", ["[heartbeat]", { online: safeOnline(), visible: visible }]);
  }, 15000);

  // ── Public surface ───────────────────────────────────────
  window.__logTap = {
    appId: APP_ID, channel: CHANNEL, sessionId: SESSION, hub: HUB, version: VERSION,
    record: function (level, msg, extra) { record(level, extra ? [msg, extra] : [msg]); },
    flush: flush,
    state: function () { return { ready: ready, queued: buffer.length, dropped: dropped }; },
  };

  // Boot ping (recorded immediately, sent once the connection comes up).
  record("info", ["[boot] log-tap online", {
    appId: APP_ID, version: VERSION, channel: CHANNEL, sessionId: SESSION,
    href: location.href,
  }]);

  ensureConn();
})();
