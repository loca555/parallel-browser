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
An optional requestId makes creation idempotent. POST /api/pages/cancel
{requestId} cancels pending or completed creation, including late responses.
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
Each panel accepts at most eight queued operations. Metadata is best effort:
after 1.5 seconds it returns the cached title and scroll ratio with the current
URL and viewport. Only one metadata request runs in the renderer at a time,
including after this soft timeout; slow metadata never closes the panel.
Navigation and input invalidate older metadata results. A completed scroll
input also updates the cached ratio while fresh measurements are pending.

JPEG capture has a seven-second timeout. On capture failure the last good JPEG
can be reused for at most 30 seconds from its original capture time. Frame
responses include X-Preview-Stale (0 or 1) and X-Preview-Captured-At (Unix ms).
Without a recent image, the server returns JSON 503 with code frame_timed_out.
Input and frame operations retain a hard 15-second deadline (navigation 30).
A truly stuck operation closes its panel without closing the other panels.

GET /healthz includes instanceStartedAt, uptimeSeconds, browser state and a
best-effort memory object: usedBytes/limitBytes from Linux cgroups, usageRatio,
and nodeRssBytes for the Node process alone. Unavailable cgroup values are null.
At 88% of a known cgroup memory limit, new contexts or pages are rejected with
JSON 503 browser_capacity_soft; existing panels are kept. This guard reduces
pressure but cannot prevent every out-of-memory event or guarantee a particular
number of heavy websites within a shared memory/CPU limit.
Operational errors log bounded operation/code/status fields only, without
website URLs, query strings, tokens, exception messages or typed input.

The client keeps its last frame during temporary failures and retries after
about 1, 2, 4, 8 and 15 seconds before offering manual Reload. Expired sessions and
missing pages reconnect with the current URL, viewport and scroll position.
Only a fresh frame resets this retry budget. Metadata refreshes independently
at most once every five seconds; a slow metadata response never blocks a JPEG.

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
