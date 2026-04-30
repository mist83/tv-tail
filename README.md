# tv-tail

Live console + error streamer for any browser app. Drop a `<script>` tag in,
the app starts forwarding `console.*` and runtime errors to a shared
`signal-argh` channel. The hosted dashboard at <https://tv-tail.mullmania.com>
shows everything in real time with per-app filters. The agent CLI at
`~/.claude/tools/tv-tail` does the same from the terminal.

## Why

You can't open devtools on a TV remote, a Vision Pro, an embedded display, or
a friend's phone. This closes the loop:

```
deploy → operator tests on device → agent watches stream → fix → redeploy
```

Zero infra to provision — `signal-argh` is already running. One static site +
one client shim.

## Pieces

- `docs/log-tap.js` — drop-in client shim. Vendored copy in your app, or
  load it directly from `https://tv-tail.mullmania.com/log-tap.js`.
- `docs/index.html`, `docs/app.js`, `docs/styles.css` — the dashboard.
- `~/.claude/tools/tv-tail` — Node CLI subscriber for terminal use (lives in
  the operator's home, not in this repo).

## Wire it into an app

```html
<head>
  <meta name="repo-name" content="my-app">
  <!-- tv-tail must load BEFORE module scripts so it captures module-load failures -->
  <script src="https://tv-tail.mullmania.com/log-tap.js"></script>
  <!-- ...your normal scripts... -->
</head>
```

That's the whole integration. The shim:

- Patches `console.{log,info,warn,error,debug}`
- Captures `window.error` + `unhandledrejection`
- Sends a `hello` announce on first connect (so the dashboard shows your app)
- Sends 15s heartbeats so we can tell live apps from sleeping ones
- Batches events every ~1.2s and on `pagehide`

Optional config (set before the `<script>`):

```html
<script>
  window.LOG_TAP_APP_ID  = "my-app";              // overrides <meta name=repo-name>
  window.LOG_TAP_HUB     = "https://signalargh.mikesendpoint.com";
  window.LOG_TAP_CHANNEL = "tv-logs";              // shared by default
  window.LOG_TAP_VERSION = "2026.04.30-1";         // surfaced on the dashboard
  window.LOG_TAP_DISABLE = true;                   // no-op the whole thing
</script>
```

## Protocol (keep it dumb)

Everyone meets at one signal-argh channel: `tv-logs` (overridable). Three
topic types, all `customMessage` events:

| topic   | payload                                                          | meaning |
|---------|------------------------------------------------------------------|---------|
| `hello` | `{appId, sessionId, ua, screen, version, url}`                   | An app just attached |
| `log`   | `{appId, sessionId, batch: [{ts, level, msg, url}], dropped}`    | A batch of console / error events |
| `bye`   | `{appId, sessionId}`                                              | Best-effort on `pagehide` |

The `appId` is the canonical identifier — the dashboard groups, filters, and
labels by it.

## Local dev

```bash
cd /Users/mist83/Code/tv-tail
python3 -m http.server 4180 -d docs
# open http://127.0.0.1:4180/
```

## Deploy

```bash
./deploy.sh
```
