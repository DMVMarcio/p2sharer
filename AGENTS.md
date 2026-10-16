# P2Sharer agent instructions

## Primary workspace rule

Read `.agents/rules/agent-persistence.md` at the beginning of every task and follow it throughout the work. It is the central, always-on workspace rule. Its requirements cover language, Tauri validation, Git, persistent memory, canonical reuse, and agent management. Consult `.agents/knowledge.md` for the project context and recorded user preferences; apply relevant skills in addition to the central rule.

P2Sharer is a Windows desktop space for shared P2P experiences, built with Tauri v2. See [the product overview](docs/product-overview.md) for its purpose and current capabilities. The React/Vite frontend runs inside WebView2 and depends on native Rust commands, local media capture, and desktop packaging. Treat Vite browser mode as a frontend development aid, not as the product runtime.

## Package manager

Use pnpm 10.30.1, pinned in `package.json`, with Node.js 22.14 or newer. Run `pnpm install --frozen-lockfile`, `pnpm run <script>`, and `pnpm exec <tool>`. Commit `pnpm-lock.yaml`; keep dependency patches and build-script permissions in `pnpm-workspace.yaml`.

## Build and validation

- Select validation by impact using the matrix in `.agents/rules/agent-persistence.md`; do not run every suite for every task.
- Documentation and agent instruction changes need content/link/metadata review only. Every application change, including CSS, layout, copy, translations and frontend assets, must finish with `pnpm run tauri:build` to generate the final executable and installers. Tests apply only to affected behavior or accessibility contracts.
- Frontend behavior changes need relevant regressions and the final Tauri build. Rust, IPC, native dependencies, capabilities, WebView configuration and native/bundle asset changes need the native checks specified in the matrix and `pnpm run tauri:build`.
- After application changes, inspect the native executable and installer bundle under `src-tauri/target/release/` and `src-tauri/target/release/bundle/`. Tauri already runs the frontend build; avoid a separate build unless tests or diagnosis require it.
- Reuse successful checks while relevant inputs remain unchanged. Expand validation only for broader impact, failures, new evidence or an explicit request; stop once the required checks pass.
- Always use the default `src-tauri/target/` build directory. Never create or use alternate build directories. Check running processes by resolved executable path. A separately installed P2Sharer outside this workspace does not block the build. Request closure only for a process running a build/test executable under this workspace's `src-tauri/target/`, or one confirmed to lock a required build output, and wait for confirmation before retrying. Do not terminate the application automatically or bypass the lock with a different Cargo target directory.
- If the desktop build cannot finish, report the specific failure and treat native packaging as unverified.
- The user performs interactive checks on their computer. Do not launch or automate the application for interactive verification unless the user explicitly requests it. Automated checks follow the impact-based validation matrix. Do not describe a browser-only preview as a desktop app check.

## Workspace conventions

- Consult `.agents/knowledge.md` and the applicable `.agents/skills/` files before changing subsystems.
- Follow the component and design token rules in `.agents/skills/canonical-design/SKILL.md` for UI work.
- Write code, comments, documentation, and agent files in English. Match the user's language in conversation and user-facing localized strings.
