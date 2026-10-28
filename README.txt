PARALLEL REMOTE BROWSER — LOCAL PROTOTYPE

This backend opens public HTTP(S) URLs as top-level Chromium pages.
It returns JPEG frames and accepts pointer, scroll and keyboard input. It does
not remove or rewrite the website's CSP headers and is not an open web proxy.

All HTTP(S) traffic uses a local validating forward proxy that resolves public
IPv4 addresses and connects to the vetted IP. Website CSP is preserved; HTTPS
uses a CONNECT tunnel without rewriting TLS or HTML. Private/reserved addresses,
URL credentials, nonstandard ports and the application itself are rejected.
Site requests are read-only GET/HEAD. Downloads, browser dialogs, permissions,
popups, service workers, WebSockets and page WebRTC/WebTransport are disabled.
No persistent profile, cookies or typed input are logged or saved to disk.

POST /api/sessions -> token, limits, mode, allowedHosts.
All subsequent /api routes require Authorization: Bearer <token>.
POST /api/pages {url,width,height} -> pageId, metadata.
GET /api/pages/:id -> pageId, metadata.
GET /api/pages/:id/frame -> image/jpeg, no-store.
POST /api/pages/:id/navigate {url} -> pageId, metadata.
POST /api/pages/:id/input {type,...} -> pageId, metadata.
Types: click {x,y,button?}, wheel {deltaX,deltaY,x?,y?}, key {key}, text {text},
resize {width,height}, scroll {ratio:0..1}.
DELETE /api/pages/:id -> closed; DELETE /api/session -> closed.
Metadata: title, url, viewport:{width,height}, scrollRatio.

The default global page limit is 4; each session permits up to 8 panels but
must fit within this shared limit. MAX_BROWSER_PAGES can be set from 2 to 8.
Sessions expire after 10 minutes idle or one hour total. Tokens remain only in
the browser client and Authorization headers, never in URLs or server logs.

Build: docker build -t parallel-remote .
Local run with the official Playwright seccomp profile:
docker run --rm -p 127.0.0.1:4181:10000 --memory=512m --cpus=0.1 --security-opt seccomp=seccomp_profile.json parallel-remote
Chromium sandbox is enabled by default. A host that cannot support Chromium's
sandbox rejects browser sessions and healthz reports browserState: failed.
The service never silently falls back to an unsandboxed public browser.
CHROMIUM_SANDBOX=0 is rejected in production and in public browsing mode.
An explicit local-only Augur allowlist test can use NODE_ENV=development,
PUBLIC_BROWSER=0 and CHROMIUM_SANDBOX=0, but this is not a public deployment.

Network policy tests inject controlled connections in egress.test.mjs; production
has no localhost/private-network fixture exceptions. PUBLIC_BROWSER=0 selects
the limited Augur allowlist for development diagnostics.

The local official profile came from:
https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/seccomp_profile.json
Tested locally: default Docker sandbox is unsupported; the official per-container
seccomp profile permits Chromium sandbox. A deployment host must be tested by
creating a real browser session before switching users to that service.
