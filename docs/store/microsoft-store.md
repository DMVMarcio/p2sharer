# Microsoft Store (MSIX)

P2Sharer ships to the Microsoft Store as an MSIX package. The Store signs the package during certification, so no code-signing certificate is needed for this channel. GitHub releases keep the NSIS/MSI installers and the built-in updater.

## How the Store build differs

- `tools/msix.mjs` stages the release `p2sharer.exe`, the Wintun license, Store logos from `src-tauri/icons/` and a generated `AppxManifest.xml`, then builds `resources.pri` and an unsigned `.msix` with the Windows SDK (`makepri`, `makeappx`).
- The manifest template is `src-tauri/windows/msix/AppxManifest.template.xml`. It declares the `p2sharer:` protocol, full-trust desktop entry point, network, webcam/microphone, `runFullTrust` and `allowElevation` capabilities, and the 13 app languages.
- At runtime `app_distribution.rs` detects MSIX package identity. Inside the Store package the built-in updater never checks GitHub and Application settings explains that the Store delivers updates.
- Wintun is extracted to the per-user cache, which works inside the package. The WebView2 Runtime must already be present (it is part of Windows 11 and installed on up-to-date Windows 10 PCs); MSIX cannot run the WebView2 bootstrapper.

## One-time Partner Center setup

1. Partner Center → Apps and games → New product → **MSIX or PWA app**, reserve the name `P2Sharer`.
2. Product management → **Product identity**. Copy these three values into `src-tauri/windows/msix/store.json`:
   - `Package/Identity/Name` → `identityName`
   - `Package/Identity/Publisher` (full `CN=...` value) → `publisher`
   - `Package/Properties/PublisherDisplayName` → `publisherDisplayName`
   These values are public package metadata, not secrets.

## Build and upload

```powershell
pnpm run store:msix
```

The unsigned package is written to `src-tauri/target/release/bundle/msix/P2Sharer_<version>_x64.msix`. Upload it in the submission's **Packages** page. Each new submission needs a higher application version (`pnpm run release:version <version>`); MSIX uses `<major>.<minor>.<patch>.0`. Prerelease versions are rejected because the Store has no beta channel here.

## Local test before submitting

Enable Windows Developer Mode, then:

```powershell
pnpm run store:msix:local
```

```powershell
Add-AppxPackage -Register "src-tauri\target\release\msix\layout\AppxManifest.xml"
```

Remove it afterwards from Settings → Apps, or with `Get-AppxPackage *P2Sharer.LocalTest* | Remove-AppxPackage`. Verify inside the packaged app: launch from Start, `p2sharer:` invitation links, screen/audio/camera sharing, LAN rooms, the shared browser, tunnels, the Wintun virtual network (UAC prompt), ViGEmBus installation and elevated remote control, and that Application settings shows the Store update notice.

## Restricted capability justifications

Partner Center asks why restricted capabilities are declared. Suggested text:

- **runFullTrust**: "P2Sharer is a Win32 desktop application (Tauri/WebView2) that captures screens and per-application audio, hosts a WebView2-based shared browser and runs peer-to-peer networking, which require full-trust desktop execution."
- **allowElevation**: "Optional features ask the user for administrator rights through the standard Windows UAC prompt: creating a virtual network adapter (Wintun), installing the ViGEmBus virtual gamepad driver and controlling elevated windows during user-approved remote control. Elevation only happens after explicit consent in the app."

## Store listing

Ready-to-paste listing text is in [listing.en.md](listing.en.md) and [listing.pt-BR.md](listing.pt-BR.md). The privacy policy URL is `https://p2sharer.com/privacy`.
