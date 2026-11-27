# Project Structure, File Anatomy & Growth Rules

Verified reference for **where files live and how they are composed** in P2Sharer. Read it before creating, moving, or splitting files; apply it with `.agents/skills/code-structure/SKILL.md`. Keep it factual and current; it is not a task log.

---

## 1. Folder Map & Logic
| Path | Purpose / what belongs here | Organization |
| :--- | :--- | :--- |
| `src/components/common/` | Canonical, reusable UI controls (`Select`, `ModalDialog`, `Tooltip`, `ContextMenu`, emoji, toasts…) shared by 2+ surfaces. See the control catalog in `knowledge/frontend-ui-state.md`. | Flat, one component per PascalCase file |
| `src/components/room/` | Room surface: video cards/slots, chat, participants, stream overlays (pointer, drawing, zoom), voice and remote-control UI. Room-only hooks and helpers may live here (`usePersistentSlotPlacements.ts`, `zoom_utils.ts`, `stream_*.css`). | Flat by surface |
| `src/components/modals/`, `header/`, `home/` | Modal dialogs and settings panes; window header; home screen. | Flat by surface |
| `src/apps/` | Room app framework at the root: `registry.ts` (registers apps), `room_apps_service.ts`, `models.ts` (shared `RoomAppModel` contract and update encoding; each app's model lives in its folder, e.g. `notepad/notepad_model.ts`), `types.ts`, the app window/card/slot components, and `apps.css`. | Framework files flat at the root |
| `src/apps/<app>/` | One folder per app: `whiteboard/`, `notepad/`, `browser/`, `youtube/`, `twitch/`, `tunnels/`. Each holds the app's view (`<Name>App.tsx`), its private components and hooks, engines/models/renderers (`<app>_*.ts`), and its CSS. | By app |
| `src/apps/games/` | Shared board-game infrastructure (lobby, planning overlay, `board_game_*`, timers, sounds, `games.css`) with one subfolder per game: `chess/`, `checkers/`, `tictactoe/` (`<Name>App.tsx` + engine). | By game |
| `src/apps/shared/` | Pieces used by more than one app (document files and image/interaction helpers shared by Whiteboard and Notepad). Apps import from here, never from another app's folder. | Flat |
| `src/hooks/` | Cross-surface React hooks (`useX.ts`, one hook per file). Hooks used by a single surface belong next to that surface instead. | Flat |
| `src/core/` | Framework-free domain logic and shared state: `state_store.ts` (`stateStore` + `useStore`), chat, media, profile, room, emoji, preferences, input bindings, `types.ts`. | Flat, `snake_case.ts` grouped by name prefix (`chat_*`, `room_*`, `profile_*`, `media_*`…) |
| `src/services/` | Stateful coordinators that orchestrate core + P2P + platform (`room_service.ts`, PiP, diagnostics, updates, deep links, receivers). | Flat |
| `src/p2p/` | Signaling failover, group room mesh, peer tracking, media coordination, data channels, LAN relay. Owned by `p2p-specialist`. | Flat |
| `src/audio/`, `src/video/` | TypeScript side of the native media bridges and voice/audio contexts. Owned by `native-media-specialist`. | Flat |
| `src/platform/` | Desktop vs. web runtime adapters (Tauri `commands.ts` vs. `web_commands.ts`, storage, files, PiP, rendering). | Flat |
| `src/i18n/` | i18next setup and `locales/<lang>.json` for the 13 supported languages. | By language |
| `src/ui/`, `src/releases/`, `src/assets/` | Sound effects; upcoming release notes (`current.json`); static assets. | Flat |
| `src-tauri/src/` | Rust host: one module per native capability (`video_*`, `browser_*`, `virtual_network*`, `audio_loopback`, `port_tunnel`…). `lib.rs` declares the modules and Tauri commands; `shared_browser.rs` declares its own out-of-line submodules. | Flat `snake_case.rs`, grouped by prefix |
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

Reference files: `src/components/room/WatchersTooltipContent.tsx`, `src/components/common/Select.tsx`.

### Hook — `src/hooks/use*.ts`, surface-local `use*.ts`
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
2. Out-of-line submodules (`mod x;`) when the module is a parent (e.g., `shared_browser.rs`)
3. Types and constants
4. Implementation and `#[tauri::command]` functions
5. `#[cfg(test)] mod tests { … }` at the end

### Test — `test/unit/*.test.ts|mjs`, `src-tauri/tests/*.rs`
Fixtures and setup → one observable behavior per test (arrange → act → assert). See the test maintenance rules in the central rule.

---

## 3. Naming & Colocation
- **File names**: React components and app views `PascalCase.tsx`; hooks `useCamelCase.ts`; everything else `snake_case.ts` / `snake_case.rs` / `snake_case.css`.
- **Exports**: named exports; no barrel files.
- **Colocation**: surface-specific hooks, helpers, and CSS sit next to their surface (e.g., `src/components/room/usePersistentSlotPlacements.ts`, `src/apps/whiteboard/useWhiteboardViewport.ts`). Move them to `src/hooks/` or `src/core/` only once a second surface needs them.
- **Page-specific components & hooks**: P2Sharer has no route pages; its "pages" are surfaces (home, room, settings modals) and room apps. A surface or app's private components and hooks stay in that surface's or app's folder; promote them to `src/components/common/` or `src/hooks/` only when a second surface uses them.
- **Room apps**: an app's view, hooks, engine/model, renderers, and CSS live in `src/apps/<app>/` and keep the app's name prefix. A new app gets its own folder with the same layout and is registered in `src/apps/registry.ts`. Code needed by a second app moves to `src/apps/shared/`.

---

## 4. Layer Boundaries (Dependency Direction)
- `components` / `apps` (views) → `hooks` → `services` → `core` / `p2p` / `audio` / `video` → `platform` (Tauri commands or web adapters) → Rust host via IPC.
- `src/core/` and `src/p2p/` stay framework-free: no React components or hooks (two exceptions exist today, `core/appearance_preferences.ts` and `core/emoji_visual.ts`; do not add more).
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
- `src/core/` is flat with 72 modules; prefixes such as `chat_*`, `room_*`, `profile_*`, `media_*`, `remote_control*` are candidate subfolders.
- `src/hooks/` is flat with 38 hooks; browser (`useBrowser*`), presence (`use*Presence`), and stream (`useStream*`) hooks are candidate groups, and single-surface hooks can move next to their surface.
- `src/components/common/` (62) and `src/components/room/` (51) are past the folder threshold; chat (`Chat*`), stream overlays (`Stream*`), and remote control (`RemoteControl*`) are candidate subfolders of `room/`.
- Oversized files: `src/style.css` (~8,900 lines), `src/p2p/group_room.ts` (~5,700), `src/services/room_service.ts` (~2,500), `src/apps/whiteboard/whiteboard_canvas2d.ts` (~2,200), `src/apps/whiteboard/WhiteboardCanvas.tsx` (~1,800), `src/hooks/useRemoteControl.ts` (~1,500), `src/components/modals/SettingsModal.tsx` (~1,300).
- `src-tauri/src/` is flat with ~70 modules; `video_*`, `browser_*`, and `virtual_network*` are candidates for module directories.
