# Web and desktop workspace

The pnpm workspace contains three execution targets without duplicating the React application:

| Location | Responsibility |
| --- | --- |
| Root `package.json`, `src/`, `src-tauri/` | Existing desktop build, shared React interface, room services and P2P protocol |
| `apps/web/` | React landing page and browser entry point at `/app` |
| `apps/server/` | Node.js HTTP backend, same-origin public API and production static hosting |
| `src/platform/` | Browser implementations for commands that previously required native persistence or file dialogs |

The desktop paths remain stable for Tauri, signing, release tools and native build caches. pnpm handles the small workspace directly; a separate task orchestrator is not required. Dependencies and shared source remain at the root rather than copying components into another application. Extract independent packages when they have independent consumers or release boundaries.

## Run locally

Use Node.js 22.14+ and pnpm 10.30.1:

```powershell
pnpm install --frozen-lockfile
pnpm run server:dev
```

In a second terminal run `pnpm run web:dev`. Open `http://localhost:1422/` for the landing page or `http://localhost:1422/app` for the application. Vite proxies `/api` to the backend on port 3000. The existing `pnpm run tauri:dev` remains the Windows development command.

For the production web build:

```powershell
pnpm run web:build
pnpm run web:start
```

The Node server serves `apps/web/dist` at `http://localhost:3000`. Configure `HOST` and `PORT` in the process environment when needed. Use HTTPS through a reverse proxy for remote users: camera, display capture, clipboard and Web Crypto depend on secure contexts and browser permissions. The server binds to loopback by default. Deployment credentials, certificates and generated distribution files do not belong in Git. This task does not configure a hosting provider or publish the site.

Production desktop links use `https://p2sharer.com`. Override the public origin with `VITE_PUBLIC_SITE_URL` when packaging another environment; development defaults to `http://localhost:1422`. Browser room links use the browser's current origin. The sanitized `.env.example` documents the setting. Room URLs use `/app/<short-code>` with the complete random room identifier, never a password or signed invitation. Opening a link waits for profile setup and opens the normal room preview; it does not bypass admission. Returning home keeps the existing unsaved-room confirmation.

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

The Node process also accepts MQTT 3.1.1 over WebSocket at `/mqtt`. Production desktop defaults use `wss://p2sharer.com/mqtt` (derived from `VITE_PUBLIC_SITE_URL`); web defaults use their current origin with only this broker enabled. Desktop defaults retain the other supported public MQTT, Nostr and WebTorrent fallbacks. Users can still configure custom servers. Untouched legacy factory lists upgrade automatically; customized lists retain user choices while retired hosts are removed. WebSocket URLs without TLS are accepted only for loopback development. Vite proxies `/mqtt` to the backend alongside `/api`.

Deploy this as a long-running Node service behind HTTPS with WebSocket Upgrade forwarding on `/mqtt`, and a proxy idle timeout greater than the MQTT keepalive. A static host or request-only serverless function cannot host it. Building the app does not deploy or activate `p2sharer.com`. Publish the backend before distributing clients that depend on that endpoint. A single instance keeps all rendezvous in memory; multiple replicas require a shared MQTT backend or routing all `/mqtt` traffic to one broker, not independent in-memory instances.

The broker accepts clean sessions, QoS 0 and the exact alphanumeric topic format used by Trystero. It rejects wildcard subscriptions, retained publications, wills and persistent sessions. It limits total connections (512), connections per source IP (64), subscriptions per client (32), MQTT/WS packets (128 KiB), inbound packet/byte rates and slow receiver buffers. It does not persist or log topic contents, SDP, client identifiers or source addresses. Public hashed topics provide discovery, not room authorization: the existing signed invitation, preview and admission policies remain mandatory. The service still observes live network metadata and signaling payloads, as a public broker would.

`BROKER_ALLOWED_ORIGINS` can replace the default comma-separated browser-origin allowlist; same-host browser requests and originless MQTT clients remain supported. The default list includes the public site, Tauri WebView origins and local Vite development origins. `BROKER_TRUST_PROXY=1` enables per-IP limits using `X-Forwarded-For`; use it only behind a trusted reverse proxy that overwrites that header and prevents direct access to the Node listener. Otherwise limits use the socket peer address. These process settings contain no credentials and are optional.

The broker replaces public rendezvous endpoints, not STUN/TURN or external content services. No deployment or antivirus reputation guarantee follows from using a first-party hostname.
