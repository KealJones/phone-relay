# phone-relay

Lets Claude drive a real browser tab on a phone (built for iPhone Safari) live: run JavaScript, read the page,
tap, type, take screenshots, read the console, and show you a message card with a reply box. Made to test
WebGPU models on the actual device instead of a desktop emulation, which doesn't have the phone's memory or GPU limits.

One Cloudflare Worker, `worker.js`, with no build step:

- **`/p/<PAGE_KEY>`** is the page you open on the phone. A full-screen iframe ("stage") holds whatever Claude
  loads, and a bar shows the connection and a Keep awake button. Add `?coi=1` for a cross-origin isolated page.
- **`/agent.js?k=<PAGE_KEY>`** is the in-page agent. It connects to `/ws`, runs commands and sends console
  output back. Any page can load it with a script tag.
- **`/ws`** is the WebSocket. A Durable Object (`Hub`) keeps the connected tabs, each tab's last 1000 log lines and
  the commands waiting for an answer.
- **`/mcp/<MCP_KEY>`** is the MCP server (JSON-RPC over POST). Add it as a custom connector. Tools: `list_devices`,
  `device_info`, `run_js`, `snapshot`, `click`, `type`, `screenshot` (html2canvas), `set_html`, `open_url`,
  `reload`, `say`, `get_logs`.
- **`/run.js`** serves `run_js` code as a script, for pages whose CSP blocks eval.
- **Everything else** mirrors kealjones.com with the agent injected, so Squiggle and its PR previews run top-level
  with the relay attached. To mirror another site, change the upstream at the bottom of `worker.js`.

## Deploy

```sh
npx wrangler deploy
npx wrangler secret put MCP_KEY    # any long random string
npx wrangler secret put PAGE_KEY   # another one
```

Then add `https://phone-relay.<you>.workers.dev/mcp/<MCP_KEY>` as a connector. On the phone, open
`/p/<PAGE_KEY>` and keep Safari in front.

## Things to know

- Both keys are the only access control. Anyone with the MCP URL can run code in your phone's tab; anyone with the
  page key can connect a tab or run code through `/run.js`.
- If the phone locks or Safari goes to the background, the tab goes offline until it's in front again. iOS also
  kills tabs that use too much memory. `get_logs` flags a reload that wasn't asked for.
- `say` puts a card over the page. Replies come back in `get_logs` with `src: "keal"`.
