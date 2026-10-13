---
name: canonical-design
description: Enforces canonical component reuse, design system tokens, native host integration for mods/plugins, and backend utility centralization. Use this skill before creating or modifying visual components, game mods, or utility functions.
---

# Skill: Canonical Design & Code Reusability

## Scope
Enforces the "audit-before-creation" rule across user interfaces, host software extensions, and backend utilities.

## 1. Visual Interfaces (Web, Desktop, Mobile)
- **Rule Scope**: Reuse the current design system, but do not promote task-specific layouts, wording, dimensions, icons, or feature requests into permanent rules. Persist only explicitly established standing conventions under the central memory policy. Test observable interactions and accessibility when needed; do not freeze incidental styling through source-text assertions.
- **Prior Discovery**: Search the codebase for existing UI elements (buttons, dialogs, inputs, cards, tooltips) before authoring new ones.
- **Design Tokens**: Adhere strictly to defined color variables, spacing scales, typography standards, and transition constants.
- **Mandatory Componentization**: If a needed component does not exist:
  - Create it as a modular, parameter-driven, reusable unit in the project's canonical UI folder (`components/`, `views/common/`, `widgets/`).
  - Never write ad-hoc, throwaway visual primitives directly into feature screens.

### P2Sharer interface methodology

Apply the explicit visual direction in `.agents/knowledge.md` to new and modified application surfaces. Inspect the current implementation and the control catalog in `.agents/knowledge/frontend-ui-state.md` before choosing a recipe.

- **Comfort and identity**: Preserve the current soft, distinctive visual language. Prefer restrained depth, readable hierarchy, and balanced use of available space. Avoid generic Material-style replacements, repetitive bordered boxes, oversized decorative controls, and excessive empty padding. Existing internal room-app layouts remain the baseline; theme adaptation alone does not justify redesigning them.
- **Theme-derived surfaces**: Use `core/background_color.ts`, `core/accent_color.ts`, `useAppTheme`, and shared CSS tokens. Cover dark, light, OLED, and custom background/accent colors across content, headers, cards, inputs, selected/hover/disabled states, menus, tooltips, dialogs, and notifications. Keep content layers distinguishable from their headers. Avoid fixed light/dark UI fills; fixed artwork, brand colors, and readable overlays directly over media are deliberate exceptions.
- **Depth and borders**: Prefer tonal separation and soft shared shadows over decorative outlines and separators. Selection should remain clear and restrained, covering the entire intended control when a contour is appropriate. Preserve visible keyboard focus, meaningful state indicators, and necessary structural/editor borders; reducing decoration never removes accessibility feedback.
- **Canonical controls and feedback**: Extend the existing component family instead of creating parallel variants. Reuse the themed scrollbar, input/select/switch recipes, `Tooltip` / `TooltipButton`, `ModalDialog`, and `ToastContainer`. Icon-only actions need accessible names and tooltips. Preserve toast dismissal and countdown pause on hover/focus, dialog Escape handling, and each dialog's deliberate backdrop-dismissal policy.
- **Complete motion**: Reuse existing family timings and presence hooks for entry, exit, view/tab replacement, and stack repositioning. Retain outgoing content as inert, clean up timers and animations, handle interrupted changes, and honor reduced motion. An entrance animation alone does not cover a replacement or dismissal lifecycle.
- **Verification scope**: Apply the central validation matrix. CSS, layout, copy and decorative assets need the final `pnpm run tauri:build` to generate the executable and installers; no Rust regressions. Review only affected themes/states and use relevant regressions when behavior, accessibility or lifecycle contracts change. Do not freeze decorative geometry through source-text assertions. The user performs interactive checks unless explicitly requesting agent-operated verification. Tauri's final packaging already compiles the frontend; avoid an extra standalone build unless tests or diagnosis require it.

These principles govern future work because the user explicitly requested continuity of this methodology. Individual colors, pixel values, labels, artwork positions, and task-specific layouts are not permanent rules. Later explicit user instructions may revise this direction.

## 2. Native Integration (Mods, Plugins, OS Utilities)
- **Authentic Integration**: Extensions and mods must blend seamlessly into the host environment.
- **Ban on Invasive Overlays**: Do not draw arbitrary floating windows or alien overlays unless explicitly demanded by the user.
- **Host System Hooks**: Prefer host application APIs, native menus, system dark/light mode hooks, and built-in dialog engines before crafting custom workarounds.

## 3. Backend, Core Logic & CLI Utilities
- **Centralized Helpers**: Do not implement duplicate helper functions (e.g., date formatters, sanitizers, serialization routines, HTTP clients) in local scopes.
- Search `utils/`, `helpers/`, `services/`, or `core/` first. Abstract any recurring logic into the canonical shared layer.
