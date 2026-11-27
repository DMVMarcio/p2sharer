# Project Structure, File Anatomy & Growth Rules

Verified reference for **where files live and how they are composed** in P2Sharer. Read it before creating, moving, or splitting files; apply it with `.agents/skills/code-structure/SKILL.md`. Keep it factual and current; it is not a task log.

---

## 1. Folder Map & Logic
| Path | Purpose / what belongs here | Organization |
| :--- | :--- | :--- |
| `src/components/common/` | Canonical, reusable UI controls shared by 2+ surfaces (see the control catalog in `knowledge/frontend-ui-state.md`), grouped by family: `inputs/` (`Select`, choice cards, color pickers, sliders), `overlays/` (context menus, tooltips, modal/fullscreen dialogs, text-editing actions), `feedback/` (toasts, status notices), `emoji/`, `code/` (code blocks and editing), `media/` (previews, seek bar, volume, loading overlay), `profile/` (avatars, nicknames, profile image/banner editors), `downloads/`, and `diagnostics/`. Small standalone pieces stay at the root. | By control family |
| `src/components/room/` | Room surface. The root holds the room shell (`RoomView`, `RoomSidebar`, `MobileRoomDock`, participants); areas live in `chat/` (chat pane, file transfer UI, filters, notices), `video/` (video cards/slots, layout context, PiP view), `stream/` (stream overlays, pointer, drawing, zoom, stats, watchers), `remote_control/`, and `voice/`. Area-only hooks, helpers, and CSS sit next to their components. | By room area |
| `src/components/modals/`, `header/`, `home/` | Modal dialogs (with `settings/` for the settings modal and its panes, `room/` for create/join/edit/security/invite dialogs, and `capture/` for screen and browser capture pickers); window header; home screen. | By surface |
| `src/apps/` | Room app framework at the root: `registry.ts` (registers apps), `room_apps_service.ts`, `models.ts` (shared `RoomAppModel` contract and update encoding; each app's model lives in its folder, e.g. `notepad/notepad_model.ts`), `types.ts`, the app window/card/slot components, and `apps.css`. | Framework files flat at the root |
| `src/apps/<app>/` | One folder per app: `whiteboard/`, `notepad/`, `browser/`, `youtube/`, `twitch/`, `tunnels/`. Each holds the app's view (`<Name>App.tsx`), its private components and hooks, engines/models/renderers (`<app>_*.ts`), and its CSS. | By app |
| `src/apps/games/` | Shared board-game infrastructure (lobby, planning overlay, `board_game_*`, timers, sounds, `games.css`) with one subfolder per game: `chess/`, `checkers/`, `tictactoe/` (`<Name>App.tsx` + engine). | By game |
| `src/apps/shared/` | Pieces used by more than one app: the document library dialog and its types (`DocumentFilesDialog.tsx`), document error formatting, library deletion events, and the image/interaction helpers shared by Whiteboard and Notepad. Apps import from here, never from another app's folder, and `shared/` never imports from an app folder. | Flat |
| `src/hooks/` | Cross-surface React hooks (`useX.ts`, one hook per file). The root keeps the app-wide hooks (`useRoom`, `useStore`, `useModal`, `useToast`, `useToastStack`, `useLocale`, `useAppTheme`, `useAppUpdates`); the rest are grouped in `presence/`, `media/` (capture, video, volume, audio filter, fullscreen), `stream/` (pointer, zoom, remote control), `room/` (room cards, exit, chat file input, PiP drag), and `ui/` (forms, focus, clipboard, sortable grid, panel size, mobile, idle). Hooks used by a single surface or app belong next to it instead (e.g., `src/apps/browser/useBrowser*.ts`). | By domain |
| `src/core/` | Framework-free domain logic and shared state. The root holds cross-cutting foundations only: `state_store.ts` (`stateStore` + `useStore`), `types.ts`, `logger.ts`, `platform.ts`, app runtime/updates/release notes, and small generic helpers (`file_size`, `ordered_items`, `diagnostic_id`, `png_animation`). Domain modules live in `chat/`, `room/` (rooms, invites, saved rooms, deep links, LAN/web room links), `profile/` (images, stats, nicknames), `appearance/` (colors, theme preferences), `emoji/` (catalog, preferences, rendering), `media/` (streams, sync, diagnostics, encoder/voice/audio-filter preferences), `stream/` (stream pointer, drawing, remote control), `network/` (peer auth/payload, ICE, tunnels, traffic/transfer rates), and `ui/` (text editing, toasts, sound cues, input bindings, clipboard images, code highlighting, fullscreen). | By domain
| `src/services/` | Stateful coordinators that orchestrate core + P2P + platform (`room_service.ts`, PiP, diagnostics, updates, deep links, receivers). | Flat |
| `src/p2p/` | Signaling failover, group room mesh, peer tracking, media coordination, data channels, LAN relay. Owned by `p2p-specialist`. | Flat |
| `src/audio/`, `src/video/` | TypeScript side of the native media bridges and voice/audio contexts. Owned by `native-media-specialist`. | Flat |
| `src/platform/` | Desktop vs. web runtime adapters (Tauri `commands.ts` vs. `web_commands.ts`, storage, files, PiP, rendering). | Flat |
| `src/i18n/` | i18next setup and `locales/<lang>.json` for the 13 supported languages. | By language |
| `src/style.css`, `src/styles/` | Global stylesheet: `style.css` only lists `@import`s in cascade order (component CSS first, then `styles/` partials: tokens → themes → accents → base → header/layout/home → buttons → room/streams/sidebar → modals/settings → notices/toasts/overlays → switch → pip → accessibility overrides → voice). Add new global rules to the matching partial; keep the import order, since later partials override earlier ones. Component-specific CSS stays next to its component. | One partial per surface/system |
| `src/ui/`, `src/releases/`, `src/assets/` | Sound effects; upcoming release notes (`current.json`); static assets. | Flat |
| `src-tauri/src/` | Rust host, one module per native capability, grouped in folders: `browser/` (shared browser and its child modules plus the injected `.js` scripts), `video/` (capture, readback, scaling, JPEG/NVENC encoding, pacing, screen sources, camera permission), `network/` (LAN signaling, STUN, port/native tunnels, payloads, traffic counters, UPnP, diagnostics, native RTC), `virtual_network/`, `input/` (gamepad, voice shortcuts, remote control, stream pointer), `app/` (updates, distribution, data migration, localization, window chrome/placement, PiP, invitation routing), `files/`, `integrations/` (YouTube, Twitch), `diagnostics/`, and `audio/`. The root keeps `lib.rs`, `main.rs`, `logger.rs`, and `test_support.rs`. Module names stay flat (`crate::video_nvenc`): `lib.rs` maps each module to its folder with `#[path = "video/video_nvenc.rs"]`, so new modules follow the same pattern. | By capability folder, flat module names |
| `src-tauri/native/`, `src-tauri/tests/` | Native C/C++ helpers (`mf`, `nvenc`); Rust integration tests. | By component |
| `apps/web/`, `apps/server/` | pnpm workspace packages: public website (`@p2sharer/web`) and Node signaling/download server (`@p2sharer/server`). | Package per app |
| `test/unit/` | Frontend regressions, `snake_case.test.ts` / `.test.mjs`, named after the module or behavior they exercise. `test/support/`, `test/helpers/` hold shared fixtures. | Flat |
| `tools/` | Node build, release, test, and hygiene scripts invoked by `package.json`. | Flat |

---

## 2. File Anatomy by Kind

### React component — `src/components/**/*.tsx`, `src/apps/**/*View.tsx`, `src/apps/**/*App.tsx`
1. Imports (components, `t` from `i18n`, hooks, React, core types; existing files do not enforce a strict group order)
2. `interface <Name>Props`
3. `export const <Name>: React.FC<<Name>Props> = ({ … }) => {` (named export, no default export)
4. `useLocale()` when the component renders translated copy
5. Store subscriptions (`useStore`) and local state
6. Derived values / memos, then effects
7. Event handlers
8. Early returns, then JSX

Reference files: `src/components/room/stream/WatchersTooltipContent.tsx`, `src/components/common/inputs/Select.tsx`.

### Hook — `src/hooks/**/use*.ts`, surface-local `use*.ts`
1. Imports
2. Exported types for the hook's inputs/outputs
3. Module-level manager or helpers when the hook wraps shared external state (e.g., a manager class plus a singleton read with `useSyncExternalStore`)
4. `export function useX(...)`: state/subscriptions → memoized callbacks (`useCallback`) → effects → returned object with a stable shape

Reference file: `src/hooks/useModal.ts`.

### Core / service / P2P module — `src/core/*.ts`, `src/services/*.ts`, `src/p2p/*.ts`
1. Imports
2. Exported types and constants
3. Pure helpers, then the exported functions or class
4. Singletons exported last (e.g., `export const stateStore = …`)

No React imports in `src/core/` or `src/p2p/`; React glue lives in hooks.

### Rust module — `src-tauri/src/*.rs`
1. `use` declarations
2. Out-of-line submodules (`mod x;`) when the module is a parent (e.g., `browser/shared_browser.rs`, whose `#[path]` children sit in the same folder)
3. Types and constants
4. Implementation and `#[tauri::command]` functions
5. `#[cfg(test)] mod tests { … }` at the end

### Test — `test/unit/*.test.ts|mjs`, `src-tauri/tests/*.rs`
Fixtures and setup → one observable behavior per test (arrange → act → assert). See the test maintenance rules in the central rule.

---

## 3. Naming & Colocation
- **File names**: React components and app views `PascalCase.tsx`; hooks `useCamelCase.ts`; everything else `snake_case.ts` / `snake_case.rs` / `snake_case.css`.
- **Exports**: named exports; no barrel files.
- **Colocation**: surface-specific hooks, helpers, and CSS sit next to their surface (e.g., `src/components/room/video/usePersistentSlotPlacements.ts`, `src/apps/whiteboard/useWhiteboardViewport.ts`). Move them to `src/hooks/` or `src/core/` only once a second surface needs them.
- **Page-specific components & hooks**: P2Sharer has no route pages; its "pages" are surfaces (home, room, settings modals) and room apps. A surface or app's private components and hooks stay in that surface's or app's folder; promote them to `src/components/common/` or `src/hooks/` only when a second surface uses them.
- **Room apps**: an app's view, hooks, engine/model, renderers, and CSS live in `src/apps/<app>/` and keep the app's name prefix. A new app gets its own folder with the same layout and is registered in `src/apps/registry.ts`. Code needed by a second app moves to `src/apps/shared/`.

---

## 4. Layer Boundaries (Dependency Direction)
- `components` / `apps` (views) → `hooks` → `services` → `core` / `p2p` / `audio` / `video` → `platform` (Tauri commands or web adapters) → Rust host via IPC.
- `src/core/` and `src/p2p/` stay framework-free: no React components or hooks (two exceptions exist today, `core/appearance/appearance_preferences.ts` and `core/emoji/emoji_visual.ts`; do not add more).
- New native calls go through `src/platform/` adapters or a hook/service. About 30 view files still import `@tauri-apps/api/core` directly (e.g., `components/header/AppHeader.tsx`); do not extend that pattern, and move calls behind an adapter when you touch them in scope.
- One app must not import another app's internals; share through `src/core/`, `src/hooks/`, or `src/components/common/`.

---

## 5. Size Budgets & Growth Thresholds
| Kind | Split the file when | Group into subfolders when |
| :--- | :--- | :--- |
| Component / app view | > ~400 lines, > ~6 state variables, > ~3 effects, or 2+ independent visual areas | One app or surface has 2+ files of its own and the folder is past ~12 mixed files |
| Hook | > ~250 lines or 2+ responsibilities | 3+ hooks with the same domain prefix |
| Core / service / P2P module | > ~600 lines or 2+ reasons to change | 3+ modules with one prefix in a folder past ~12 files |
| Rust module | > ~800 lines or 2+ native capabilities | A capability has 3+ modules (e.g., `video_*`, `browser_*`) |
| Folder (any) | — | > ~12 files from different units |

Budgets are higher than the generic defaults because many existing files are large; new code still aims well below them. Apply them to files a task touches; do not split untouched files.

---

## 6. Known Structure Debt
Observed, not yet fixed. Restructure gradually: small in-scope moves happen inside a task; larger moves are proposed to the user and committed separately as `refactor(structure)` with `git mv`.
- Oversized files whose remaining size is one large class, hook, or component. Split them by responsibility when a task changes that area, extracting collaborators with their own regression tests (not as a blind move):
  - `src/p2p/group_room.ts` (~6,900 lines, `GroupRoomManager`): seams are chat file transfer (request/offer/deny/send/receive, already typed in `chat_file_transfer_types.ts`), stream sharing and watching, room administration and host transfer, peer exchange/verification, and signaling switching.
  - `src/services/room_service.ts` (~2,850, `RoomService`): room lifecycle (create/join/leave), connecting overlay state, chat and file actions, and stream controls.
  - `src/apps/whiteboard/whiteboard_canvas2d.ts` (~2,200, `WhiteboardCanvas2DRenderer`): pure stroke/clip geometry helpers, layer canvas cache, live stroke sessions.
  - `src/apps/whiteboard/WhiteboardCanvas.tsx` (~1,800): pointer gesture handling, text editing overlay, and shape geometry helpers.
  - `src/hooks/stream/useRemoteControl.ts` (~1,500): immersive keyboard hook claims, mouse input, and gamepad forwarding.
  - `src/components/modals/settings/SettingsModal.tsx` (~1,300): one pane per tab, as the existing `*SettingsPane.tsx` files already do.
