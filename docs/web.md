# Web and desktop workspace

The pnpm workspace contains three execution targets without duplicating the React application:

| Location | Responsibility |
| --- | --- |
| Root `package.json`, `src/`, `src-tauri/` | Existing desktop build, shared React interface, room services and P2P protocol |
| `apps/web/` | React landing page and browser entry point at `/app` |
| `apps/server/` | Node.js HTTP backend, same-origin public API and production static hosting |
| `src/platform/` | Browser implementations for commands that previously required native persistence or file dialogs |

The desktop paths remain stable for Tauri, signing, release tools and native build caches. pnpm handles the small workspace directly; a separate task orchestrator is not required. Dependencies and shared source remain at the root rather than copying components into another application. Extract independent packages when they have independent consumers or release boundaries.

## Environment configuration

Copy `.env.example` to `.env` at the repository root. Backend scripts and both Vite configurations automatically read that root regardless of their working directory. Actual environment files are ignored by Git; templates are tracked. Use literal values rather than shell interpolation.

Files load in this order: `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`. Later files override earlier ones; variables supplied by the shell or service manager override every file. Development commands use development mode; builds and `web:start` use production mode. Restart development processes after editing environment files. Public `VITE_*` values are embedded at build time: rebuild clients when changing deployment addresses; restarting the backend alone does not update distributed clients.

| Variable | Purpose / automatic default |
| --- | --- |
| `BACKEND_HOST` | Node listening interface; `127.0.0.1` |
| `BACKEND_PORT` | HTTP and MQTT/WebSocket port; `3000`; `PORT` is accepted when unset |
| `WEB_DEV_PORT` | Web Vite port; `1422` |
| `VITE_PUBLIC_SITE_URL` | Desktop website/invitation origin; local web dev URL or `https://p2sharer.com` |
| `VITE_PUBLIC_API_URL` | Backend HTTP origin, without `/api`; local backend port or `https://api.p2sharer.com` |
| `VITE_PUBLIC_BROKER_URL` | Full broker WebSocket URL; derived from the API origin with `/mqtt` unless provided |
| `API_ALLOWED_ORIGINS` | Optional replacement HTTP origin allowlist; defaults include configured site/API and Tauri origins |
| `BROKER_ALLOWED_ORIGINS` | Optional replacement WebSocket origin allowlist; defaults include configured site/API and Tauri origins |
| `BROKER_TRUST_PROXY` | `0` by default; use `1` only behind a trusted proxy that overwrites `X-Forwarded-For` |

Blank public URLs select automatic development/production defaults. Changing only `BACKEND_PORT` changes the local API, broker and Vite proxy destinations together. An explicit public URL overrides automatic derivation. Allowlists are comma-separated. `VITE_*` values are public; server-only credentials must not use that prefix. Custom server lists saved through app settings still override factory defaults.

## Run locally

Use Node.js 22.14+ and pnpm 10.30.1:

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm run server:dev
```

Do not overwrite an existing `.env`. In a second terminal run `pnpm run web:dev`. The default site is `http://localhost:1422/`, the app is `/app`, and the backend is `http://127.0.0.1:3000`. The browser uses the configured API origin with CORS and the configured broker directly. Vite also proxies `/api` and `/mqtt` for same-origin consumers. `pnpm run tauri:dev` uses that same backend.

For example, `BACKEND_PORT=4317` moves the local backend, API requests and broker to port 4317. Leave public URLs blank for automatic local configuration. To use a remote development backend, fill in its public API/broker URLs and allow the local site origin on that server.

## Deploy on a VPS

Copy `.env.production.example` to `.env.production` on the build machine and VPS. It separates `https://p2sharer.com` from `https://api.p2sharer.com`, with `wss://api.p2sharer.com/mqtt` for signaling. Customize the addresses and listening port, then run:

```powershell
pnpm run web:build
pnpm run web:start
```

Run `pnpm run tauri:build` with the same production public URLs when packaging desktop clients. `web:start` loads production environment files automatically. The Node service serves `apps/web/dist`, HTTP API and broker on the configured backend port. A reverse proxy can route both hostnames to that listener, or host the static distribution separately. The API hostname must forward `/api/*` and WebSocket Upgrade requests for `/mqtt`. Default allowlists derive the configured site/API origins and retain desktop origins.

Use HTTPS for both public hostnames. The Node listener stays HTTP behind the proxy and binds to loopback by default. Forward the original Host header, use an idle timeout longer than MQTT keepalive, and overwrite `X-Forwarded-For` before enabling proxy trust. Deployment credentials, certificates and generated files do not belong in Git. Building does not publish the site, provision DNS or configure a VPS.

Room URLs use `/app/<short-code>` with the complete random identifier, never a password or signed invitation. Browser room links use the current site origin. Opening a link waits for profile setup and opens the normal room preview without bypassing admission; returning home preserves the unsaved-room confirmation.

## Backend contract

| Endpoint | Result |
| --- | --- |
| `GET /api/health` | Health response |
| `GET /api/config` | Public runtime metadata and official release-page URL |
| `GET /api/download` | Redirect to official Windows releases |
| `GET /api/downloads` | Latest stable release's available installer, MSI and portable downloads |

Download links on the landing page and web app header open `/download`; the app header uses a new tab to preserve the current room. The page offers two steps: enabled system buttons, then a flat package list with direct download actions. Unavailable systems and packages remain disabled. The page uses `/api/downloads`. The backend coalesces GitHub requests, caches successful results for five minutes and only advertises official, published assets that actually exist. macOS and Linux remain unavailable until packaging support is added. Temporary GitHub failures return an error with a retry option rather than fabricated download URLs.

The HTTP API does not accept room messages, profile data, invitations or file uploads. Room admission, signatures, public multi-transport discovery and WebRTC media/data channels remain shared with the desktop application. The first-party MQTT broker provides rendezvous signaling; it is not an account service, room database or media relay. Existing TURN configuration remains available in settings for networks that require a relay; hosting this HTTP backend alone does not provide TURN. Custom discovery services and content sources must permit browser requests and comply with HTTPS/CORS rules.

The production host restricts methods, rejects traversal and hidden-file requests, sets a content security policy and serves only the web distribution directory. Only hashed build assets receive immutable caching. App HTML and API responses are not cached. `/app` and `/app/` load the same entry; unknown asset/API paths return errors instead of HTML.

## Browser capabilities and limits

- Internet rooms, signed invitations, chat, media subscriptions, camera/screen sharing, shared notes, whiteboard and synchronized YouTube reuse the existing implementation. Capture starts from a user gesture through browser permission prompts; available sources, codecs and audio depend on browser support.
- Saved rooms, room identities, profile images and document libraries live in origin-local IndexedDB. Preferences remain in origin-local storage. Clearing site data removes these records; desktop and browser storage are separate and do not synchronize through the backend.
- Chat attachments use the existing consent-based signed WebRTC transfer protocol. Browser-selected sources are immutable blobs for the current tab session, with at most 32 sources and 256 MB aggregate source data. Active downloads share a 256 MB aggregate limit and verify the complete SHA-256 before exporting through the browser. Save As and default downloads both use the browser's download preferences; filesystem reveal and restoring source files after a reload are unavailable.
- The browser can view/control a shared browser hosted by a Windows participant. Starting its own native browser host, process audio filtering, native encoders, LAN discovery, tunnels and virtual networking require the desktop runtime. Unsupported OS commands fail explicitly; the web API never proxies native commands.
- Native detached app windows and native PiP controls remain desktop integrations. Web video uses browser picture-in-picture when available. Mobile layouts of the shared desktop-oriented workspace may still need further adaptation.
- Changing a shared screen source in the browser requires stopping that transmission and starting another capture. This keeps source audio tied to the browser permission prompt; desktop live source editing remains available. Browser-selected profile animations are saved as a static PNG.
- Browser transmission settings expose resolution, frame rate and sending bitrate. Resolution/frame rate are capture preferences constrained by browser and device support, not guarantees. Native quality, encoder, cursor-overlay and automatic picker-persistence controls are omitted. Capture cards hint at screen versus window/tab selection; the browser retains the final permission picker. Camera names are shown only when the browser exposes actual device identities.

Web builds and automated checks are not interactive interoperability verification. User-operated checks should cover two independent browser sessions, browser-to-desktop rooms, permissions/cancellation, audio support, reconnects and actual transfers on the intended browsers and networks.

## Validation

`pnpm run test:web` validates HTTP routes, static hosting and access boundaries. The frontend suite includes browser persistence and file-integrity regressions with isolated IndexedDB, in addition to existing desktop behavior tests. Run `pnpm run web:build` for browser compilation. Application changes must also finish with `pnpm run tauri:build` according to the central workspace validation rules.

## First-party rendezvous broker

The Node process also accepts MQTT 3.1.1 over WebSocket at `/mqtt`. Production clients use `wss://api.p2sharer.com/mqtt` unless public API/broker settings override it. Browser defaults enable only that broker. Desktop defaults retain the supported public MQTT, Nostr and WebTorrent fallbacks. Custom lists remain supported. Untouched legacy factory lists upgrade automatically; customized lists retain user choices while retired hosts are removed. WebSocket URLs without TLS are accepted only for loopback development.

Deploy this as a long-running Node service behind HTTPS with WebSocket Upgrade forwarding on `/mqtt`, and a proxy idle timeout greater than the MQTT keepalive. A static host or request-only serverless function cannot host it. Building the app does not deploy or activate `p2sharer.com`. Publish the backend before distributing clients that depend on that endpoint. A single instance keeps all rendezvous in memory; multiple replicas require a shared MQTT backend or routing all `/mqtt` traffic to one broker, not independent in-memory instances.

The broker accepts clean sessions, QoS 0 and the exact alphanumeric topic format used by Trystero. It rejects wildcard subscriptions, retained publications, wills and persistent sessions. It limits total connections (512), connections per source IP (64), subscriptions per client (32), MQTT/WS packets (128 KiB), inbound packet/byte rates and slow receiver buffers. It does not persist or log topic contents, SDP, client identifiers or source addresses. Public hashed topics provide discovery, not room authorization: the existing signed invitation, preview and admission policies remain mandatory. The service still observes live network metadata and signaling payloads, as a public broker would.

`BROKER_ALLOWED_ORIGINS` replaces the derived origin allowlist; same-host requests and originless MQTT clients remain supported. The defaults include configured site/API origins, Tauri origins and local development origins when appropriate. `BROKER_TRUST_PROXY=1` enables per-IP limits using `X-Forwarded-For`; enable it only behind a trusted reverse proxy that overwrites that header and prevents direct access to the Node listener. Otherwise limits use the socket peer address.

The broker replaces public rendezvous endpoints, not STUN/TURN or external content services. No deployment or antivirus reputation guarantee follows from using a first-party hostname.

### Client routing

The web entry owns one React root and a React Router data router. The site layout retains its header and footer between the landing and download routes; `/downloads` aliases `/download`. The application route loads its runtime and styles on demand. `NavigationFeedback` subscribes directly to router state outside `RouterProvider`, keeping its top progress bar and localized status independent of deferred route rendering. Lazy application loading yields a paint before evaluating the module; a timer fallback handles suspended animation frames in hidden tabs. Same-origin links request native View Transitions through the DOM RouterProvider, using shared content entrance/exit recipes and both system and application reduced-motion preferences. `WebsiteLink` uses client navigation for same-origin links inside this router and preserves ordinary links in desktop windows, downloads, hash anchors and explicit new tabs.

`AppPage` adapts room URL synchronization to the router instead of overwriting its history state. Active-room navigation is blocked until the existing room-exit dialog approves; room teardown completes before the destination mounts. Room-code changes within `/app` retain the app instance and use the canonical invitation preview. The server serves the SPA entry for supported direct routes. Favicons live at stable public URLs and use the existing desktop application icon.


Room-invitation cancellation replaces the URL with `/app` only after the preview
closes and connection teardown settles; admitted rooms keep their public code.
Invitation routes schedule one desktop-protocol attempt per room and document in
a hidden frame, using `p2sharer://invite/<short-code>`. Plain `/app`, the
landing page and room URL changes after joining do not launch the desktop.
Cleanup removes pending timers and protocol frames. The CSP permits only the
P2Sharer custom scheme alongside the existing video frame origins. Browser policy
may require confirmation or block automatic protocol launches; the web preview
remains usable without installation detection, success assumptions or redirects.
The desktop accepts both signed invitations and public short codes. Short codes
open canonical room discovery and preview; admission and signature verification
continue through the existing join flow.
