# P2Sharer agent instructions

## Primary workspace rule

Read `.agents/rules/agent-persistence.md` at the beginning of every task and follow it throughout the work. It is the central, always-on workspace rule. Its requirements cover language, Tauri validation, Git, persistent memory, canonical reuse, and agent management. Consult `.agents/knowledge.md` for the project context and recorded user preferences; apply relevant skills in addition to the central rule.

P2Sharer is a Windows desktop application built with Tauri v2. The React/Vite frontend runs inside WebView2 and depends on native Rust commands, local media capture, and desktop packaging. Treat Vite browser mode as a frontend development aid, not as the product runtime.

## Package manager

Use pnpm 10.30.1, pinned in `package.json`, with Node.js 22.14 or newer. Run `pnpm install --frozen-lockfile`, `pnpm run <script>`, and `pnpm exec <tool>`. Commit `pnpm-lock.yaml`; keep dependency patches and build-script permissions in `pnpm-workspace.yaml`.

## Build and validation

- For code or asset changes intended for the application, run `pnpm run tauri:build` before reporting the work as validated or complete. This command runs the frontend build through Tauri's `beforeBuildCommand`, compiles the Rust application, and creates desktop bundles.
- `pnpm run build` checks only TypeScript and Vite. It does not replace `pnpm run tauri:build`.
- Inspect the build result and verify the native executable and installer bundle under `src-tauri/target/release/` and `src-tauri/target/release/bundle/`.
- Always use the default `src-tauri/target/` build directory. Never create or use alternate build directories. If the application is open or the executable is locked, present a questionnaire asking the user to close it and wait for confirmation before retrying. Do not terminate the application automatically or bypass the lock with a different Cargo target directory.
- If the desktop build cannot finish, report the specific failure and treat native packaging as unverified.
- Use `pnpm run tauri:dev` for interactive app checks when needed. Do not describe a browser-only preview as a desktop app check.

## Workspace conventions

- Consult `.agents/knowledge.md` and the applicable `.agents/skills/` files before changing subsystems.
- Follow the component and design token rules in `.agents/skills/canonical-design/SKILL.md` for UI work.
- Write code, comments, documentation, and agent files in English. Match the user's language in conversation and user-facing localized strings.
