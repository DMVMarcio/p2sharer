## Summary

<!-- Briefly describe what this pull request changes and why. -->

## Changes

-

## Verification

<!-- Check the commands you ran after your final edit: -->
- [ ] `pnpm run build`
- [ ] `pnpm test`
- [ ] `pnpm run web:build` / `pnpm run test:web` (if web/server files changed)
- [ ] `pnpm run test:native --release` (if Rust/native behavior changed)
- [ ] `pnpm run tauri:build` (if desktop application behavior or assets changed)
- [ ] `pnpm run check:repository --staged`

## Checklist

- [ ] User-facing copy is translated across all 13 locale files under `src/i18n/locales/` (if applicable)
- [ ] `src/releases/current.json` is updated in all 13 languages for user-visible changes (if applicable)
- [ ] No private logs, credentials, local paths, or unredacted room data included
