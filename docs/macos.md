# macOS support

P2Sharer targets macOS 13 or newer, on Intel and Apple Silicon. macOS uses WKWebView; Windows keeps WebView2, WASAPI, WGC and optional NVENC.

## Local development and installation

Install Xcode Command Line Tools, stable Rust, Node.js 22.14 or newer, pnpm 10.30.1, CMake and NASM. Use the same package manager and default Cargo target directory as Windows:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm run test:native --release --locked
pnpm run tauri:build -- --locked
```

Tauri automatically merges `src-tauri/tauri.macos.conf.json`. The native executable is `src-tauri/target/release/p2sharer`; the application is `src-tauri/target/release/bundle/macos/P2Sharer.app`; the installer is under `src-tauri/target/release/bundle/dmg/`. Open the disk image and drag P2Sharer into Applications before testing. A local unsigned build is for development; public distribution uses Developer ID signing and Apple notarization.

## Native appearance and motion

The main macOS window uses Tauri's decorated overlay title bar and real AppKit traffic lights. The React title region reserves space for native controls; fullscreen, Option-click zoom, hover symbols and accessibility remain owned by macOS. Windows retains its existing custom caption controls. Native appearance follows the selected application theme.

Appearance settings include an AMOLED palette with a pure black canvas and distinct panel, input, hover and focus tokens. Fresh macOS profiles default to AMOLED; stored Dark, Light, System and AMOLED choices are preserved. The native host injects presentation-only platform metadata before React initializes, including detached webviews.

The macOS motion recipes preserve shared popup/dialog lifetimes while using smaller transform/opacity transitions, explicit hover transition properties, an opaque modal backdrop instead of filtering live video, and a transform-based skeleton highlight. They avoid permanent compositor promotion on dialog surfaces. System Reduce Motion disables decorative motion and removes modal exit delays. Compare responsiveness while receiving media during interactive checks; packaging and DOM tests do not measure frame rate.

## Permissions and media

- Screen and window enumeration/capture use the existing xcap/JPEG/WebSocket bridge. On first use, macOS requests Screen Recording access. Enable P2Sharer in System Settings > Privacy & Security > Screen Recording (Screen & System Audio Recording on newer systems), then quit and reopen it if requested.
- System audio uses Apple's ScreenCaptureKit with 48 kHz stereo float PCM, delivered through the existing audio event bridge. It needs Screen Recording consent, not a virtual audio driver. Full, include and exclude modes select applications by PID, executable name, application name or bundle identifier. P2Sharer's own playback is always excluded to prevent feedback. Application selections are snapshots taken at capture start; restart audio sharing after launching or restarting selected applications. Filtering applies to whole applications, not individual tabs or windows.
- Camera and microphone descriptions and hardened runtime entitlements are bundled. WKWebView and macOS prompt for access. Only the main window can request camera or microphone permissions.
- Saved room invitations are stored in the login Keychain, under `com.p2sharer.desktop.rooms`. Local `.vault` files contain discovery markers only. File locks preserve the existing invitation revision checks across multiple instances. Windows DPAPI remains unchanged.
- macOS uses the generic canvas/WebRTC video route. Windows NVENC and GPU scaling are not available on macOS. The current xcap fallback does not draw the Windows cursor overlay on macOS. Hardware capture, WKWebView media compatibility and performance need interactive verification on both architectures.

## CI and GitHub Releases

Validation runs native frontend/Rust checks on `macos-15` (Apple Silicon) and `macos-15-intel`. Pushes to `feat/macos-support` and pull requests to main additionally generate unsigned test `.dmg` and `.app.tar.gz` workflow artifacts. The archive preserves application executable permissions. Main validation does not generate installers.

The existing release workflow adds signed, notarized macOS builds to the same draft GitHub Release as Windows. The distributed artifacts are architecture-specific `.dmg` installers and `.app.tar.gz` application/updater archives with Tauri signatures. A `.app` is a directory bundle and must be archived for download; `.pkg` is not required for this drag-and-drop application. macOS release jobs run after Windows and serialize updater manifest updates to preserve all platform entries. The artifact check requires the current Mac architecture and validates all existing Mac entries against the unchanged updater key.

Configure these repository Actions secrets before an official macOS release:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded exported Developer ID Application certificate (`.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | Export password |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application signing identity |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Developer team identifier |
| `TAURI_SIGNING_PRIVATE_KEY` | Existing Tauri updater signing key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Existing updater key password, if applicable |

Never put signing material in Git. Prepare a new synchronized application version and tag following [releases.md](releases.md); published releases are immutable. Dispatch from the corrected workflow revision only when rebuilding an unpublished tag. An old Windows-only tag cannot be converted into a macOS-compatible application by packaging configuration alone: the tag must contain the native port. Review both architectures and `latest.json` before manually publishing the draft. Branch pushes do not publish Releases.

## Interactive acceptance checks

1. Install the app from the `.dmg`, launch it from Applications, and verify window controls, theme, Portuguese/English selection and quit/relaunch.
2. Create a room, relaunch, verify its saved invitation, and connect to a Windows peer. Check chat, file transfers, synchronized room apps and receiving remote media.
3. Grant Screen Recording consent; share an entire display and an individual window to the Windows peer. Stop and restart sharing, and check a denied-permission case.
4. Play audio in a selected application. Check full audio, include and exclude modes at the peer, and ensure received peer audio is not sent back. Restart sharing after changing running target applications.
5. Grant camera/microphone access and check both media streams with the Windows peer. Check PiP and cleanup after leaving the room.
6. For official releases, test installation and an explicitly accepted signed update on both Intel and Apple Silicon. Never treat compilation alone as verification of hardware permissions, media or updater installation.

References: [Tauri macOS bundles](https://v2.tauri.app/distribute/macos-application-bundle/), [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit).
