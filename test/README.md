# Application tests

Install the pinned toolchain dependencies with `pnpm install --frozen-lockfile`.

- `pnpm test` runs every `test/unit/*.test.ts` and `*.test.mjs` file using Node's test runner. It covers actual React components, hooks, application services, security, chat/file transfer, synchronization, P2P signaling and media bridges with isolated browser/native fixtures.
- `pnpm run test:native --release` runs the Rust library and integration tests on Windows. Install the native development prerequisites from the project README. The runner reuses the build's CMake discovery and Cargo's standard `src-tauri/target/` directory.
- `pnpm run tauri:build` validates the production desktop executable and installers after application changes. Unit tests and benchmarks do not replace this build.

Both test commands derive their checkout directory from the runner's own location. They do not require a specific username, drive, checkout directory, application installation, GPU, audio device, camera, or display configuration. Native tests require Windows because the product uses Windows APIs. D3D11 texture checks use Windows WARP software rendering.

`test/helpers/browser_mocks.ts` supplies deterministic fixtures for native IPC, Web Audio, media streams and browser APIs. Mocks isolate dependencies; assertions must exercise production code, not a separate implementation of the feature inside a fixture. Give every test an observable assertion and restore modified globals, timers, listeners and shared state.

## Hardware and interactive checks

Live capture, default-device audio and NVENC tests are marked `#[ignore]` with their requirements. A normal native run reports them as ignored. Run a named test explicitly only after checking its prerequisites:

```powershell
pnpm run test:native --release hardware_encodes_recreates_portrait_and_forces_recovery_keyframes -- --ignored --test-threads=1
pnpm run test:native --release live_capture_produces_images_and_stops_idempotently -- --ignored --test-threads=1
```

The Cargo `--` separates the test executable's flags from Cargo's flags. Do not run all ignored tests indiscriminately: some capture the desktop or play audio. The live tone fixture specifically requires a 32-bit floating-point default output mix; that requirement is local to this explicit manual check, not to the automatic suite. Hardware tests fail when explicitly requested on unsupported hardware, rather than returning early and reporting a false pass.

The preserved scripts in `test/bench/` and Rust examples are manual diagnostics. See `test/bench/README.md` for setup and limitations. FPS, wall-clock speed and CPU/GPU scheduling vary across contributors; do not make personal benchmark measurements universal acceptance thresholds.

## Maintenance review

The retired tier-based `test/e2e/` harness mostly validated handwritten DSP, signaling, IPC and UI models, with stale capture signatures. Its useful browser mocks were relocated to `test/helpers/`; actual codec selection and capture fallback remain covered by production-backed unit tests. This repository currently does not provide an automated end-to-end desktop suite.

The retired capture-cadence script extracted Rust source with regular expressions and no longer compiled against the current handler; the production frame-pacer regressions remain in the native suite. Removed native diagnostics measured `Instant`, `Vec`, polling thread timings or duplicated resource guards. Production resampler, downmix, continuity, clipping, serialization, transport authentication, JPEG/readback and event-guard lifetime checks remain. The encoder preference regression is now included in the standard frontend command. Retain regressions because they protect behavior, even when their filenames originated in an earlier milestone.

Keep generated results, packet fixtures, screenshots and logs under ignored output directories or outside the repository. Do not commit private room credentials, machine profiles, deployment addresses, personal paths or media captured during testing.
