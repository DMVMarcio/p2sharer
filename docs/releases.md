# Releases and application updates

P2Sharer uses version `1.0.0` and bundle identifier `com.p2sharer.desktop`. Official builds currently target Windows x64. The identifier is suitable for future macOS and Linux ports; those platforms still require native implementation and validation before adding release jobs.

## Versioning

Use [Semantic Versioning](https://semver.org/): patches for compatible fixes (`1.0.1`), minor versions for compatible features (`1.1.0`), and major versions for incompatible supported behavior, room protocol or saved data (`2.0.0`). Preview versions can use `1.1.0-beta.1`.

```powershell
pnpm run release:version 1.0.1
pnpm run release:check
```

The version command updates `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the application entry in `src-tauri/Cargo.lock`. Dependency versions remain unchanged. Commit the version change with its release changes. Tags use `vX.Y.Z` and must match every declaration. Published tags and binaries are immutable; fixes need a higher version.

## One-time updater signing setup

The [Tauri updater](https://v2.tauri.app/plugin/updater/) requires signed updates. The maintainer's public key is already configured. Keep the corresponding private key and password outside Git, with a protected backup. Losing either prevents signing updates accepted by existing installations.

To generate a key for a new, not-yet-distributed application:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.tauri" | Out-Null
pnpm run tauri signer generate -w "$env:USERPROFILE\.tauri\p2sharer.key"
pnpm run release:key "$env:USERPROFILE\.tauri\p2sharer.key.pub"
```

Do not regenerate or replace the configured key for this application. These commands describe initial setup, not a routine release step. The key command accepts only public key files.

Copy the entire `.key.pub` contents, including its final Base64 characters. Release validation rejects noncanonical encoding before compilation. When retrying an older unpublished tag, the workflow can restore missing Base64 padding without changing the decoded public key or touching signing secrets; malformed key material still fails validation.

In GitHub, open **Settings > Secrets and variables > Actions > New repository secret** and add:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Entire contents of the private `p2sharer.key` file, not its path and not the `.pub` file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password chosen when generating the key |

Copy the private file directly into the GitHub secret form; never paste it into issues, chats or tracked configuration. The workflow uses GitHub's automatic `GITHUB_TOKEN`, so a personal access token is unnecessary.

Updater signing is separate from [Windows Authenticode signing](https://v2.tauri.app/distribute/sign/windows/). Authenticode identifies the installer publisher and is a separate setup; this workflow does not provide it or guarantee absence of SmartScreen warnings.

## Choose when to launch a release

Ordinary pushes to `main` do not create releases. The [release workflow](../.github/workflows/release.yml) starts when a `v*` tag is pushed, or when manually dispatched with an existing matching tag. The official [Tauri action](https://github.com/tauri-apps/tauri-action) builds signed installers and creates a draft release. Only publishing that draft makes it available to users.

For the first release, after committing and pushing the reviewed implementation and configuring secrets:

```powershell
pnpm run release:check
git push origin main
git tag -a v1.0.0 -m "P2Sharer 1.0.0"
git push origin v1.0.0
```

For later releases, first run `pnpm run release:version <new-version>`, validate and commit the changes, then create and push the matching tag.

1. Inspect **Actions > Build release draft**. It installs pinned pnpm/Node dependencies and native prerequisites, checks versions and repository hygiene, runs frontend/native regressions, and builds using the default Cargo target directory.
2. Open the draft under **Releases**. Its assets should include `.exe` and `.msi` installers, `.sig` signatures, and `latest.json` updater metadata. A failed job or incomplete assets must be resolved before publication.
3. Download and test the actual draft installer. Check startup, saved settings, room joining and live media. For later releases, test a real upgrade from the previous installed release.
4. Review the generated release notes and add user-facing changes and known limitations.
5. Select **Publish release** when ready. Publish stable releases as the latest release; keep beta tags marked as prereleases. The stable updater endpoint excludes prereleases.

### Beta update channel

In **Settings > Application**, automatic update checks and **Receive beta versions** are saved preferences. Beta updates are disabled by default. The manual check uses the saved channel; save a changed channel before checking. Checks never install automatically.

Publish beta releases through the same signed workflow with versions such as `1.1.0-beta.1` and matching tags such as `v1.1.0-beta.1`. Review and publish the draft as a GitHub prerelease, without marking it as the latest stable release. No separate signing key or beta installer format is needed.

The beta channel examines the 100 most recent GitHub release records and selects the highest newer semantic version with a `latest.json` asset, including stable releases. Drafts, invalid tags, incomplete releases and older/equal versions are excluded. Discovery runs in Rust; the official updater still owns signature verification, downloads and installation. Switching channels discards any previously offered or downloaded update; an in-flight check from the old channel cannot restore it. Channel changes are blocked during download/installation.

Turning beta updates off and saving immediately checks the stable endpoint, even when automatic checks are disabled. If the installed application is a prerelease, the latest stable release is offered even when its version is lower (for example, `1.1.0-beta.2` back to `1.0.0`). Download and installation still require explicit user actions. Stable installations never receive older stable versions, and the stable channel rejects prerelease manifests. The Windows installer configuration permits downgrades; review compatibility of saved data when publishing betas that change its format.

To retry an unpublished draft after fixing the workflow, push the fix to `main`, then use **Actions > Build release draft > Run workflow**, select branch **main** and supply the existing tag (for example, `v1.0.0`). **Re-run jobs** on an old run uses its original workflow revision and will repeat an already-fixed workflow error. The application is still checked out from the requested tag; shared build setup comes from the selected workflow revision. The job refuses to rebuild a published release. Never delete or recreate a public tag to replace its binaries.

## Build caches

The [main-branch workflow](../.github/workflows/validate.yml) runs on pushes to `main` and can be dispatched manually on that branch. It runs repository checks, frontend tests and compilation, and native tests, then warms dependency caches without generating installers or creating a release. Native tests compile Rust dependencies in the release profile so they remain reusable by release builds. Installer generation and packaging validation run in the release workflow; packaging failures are therefore discovered when preparing a release. Both workflows use the same [build setup](../.github/actions/setup-build/action.yml).

- **pnpm:** cache downloaded packages only, keyed by the lockfile, workspace configuration and dependency patches. Each job still runs `pnpm install --frozen-lockfile`; `node_modules` and frontend output are recreated.
- **Rust:** cache Cargo downloads and compiled dependencies in the default `src-tauri/target/`. Keys account for Cargo manifests/lockfiles, Rust compiler, OS/architecture, native build environment and shared setup. Application crates, installers, incremental output and signing credentials are excluded. Successful main validation jobs save the cache; release jobs only restore it.

Adding, removing or replacing dependencies changes the relevant key. Rust can reuse compatible dependencies from an earlier lockfile, while Cargo validates build fingerprints and rebuilds what changed. Always commit updated lockfiles, patches and workspace settings; caches never bypass installation, tests or compilation. A missing or evicted cache results in a normal build from scratch.

Pass Cargo-only flags after Tauri's argument separator: `pnpm run tauri:build -- --locked`, or `--config src-tauri/tauri.release.conf.json -- --locked` in the release action's `args`. The separator forwards arguments to Cargo; it is not an extra pnpm script separator. Native tests invoke Cargo directly and retain `pnpm run test:native --release --locked`.

For the best reuse, wait for **Validate and warm build caches** to finish successfully on `main` before pushing a release tag. GitHub allows tags to restore default-branch caches, but unrelated release tags cannot share their own caches. A release already running uses its existing workflow; these changes apply to subsequent runs using commits that contain this setup.

## Local builds

`pnpm run tauri:build` produces ordinary local installers without requiring signing credentials. These builds still include the updater and its public verification key.

For a signed local release build, provide the existing private key and password through process environment variables:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\p2sharer.key"
$releasePassword = Read-Host "Signing key password" -AsSecureString
$releaseCredential = New-Object System.Management.Automation.PSCredential('signing', $releasePassword)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $releaseCredential.GetNetworkCredential().Password
try {
    pnpm run release:build
} finally {
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
```

The release configuration enables signed updater artifacts. Output remains under `src-tauri/target/release/` and `src-tauri/target/release/bundle/`. Local builds do not publish anything to GitHub.

## Installed update behavior

On Windows, installation preparation lets the updater's installer escape the app's process job while preserving automatic teardown of existing media/WebView children. Failed installation attempts restore normal child containment. Test an actual installed-version upgrade before publishing: successful downloads and signatures do not prove that the installer survives app shutdown. An already distributed version whose job kills the installer needs a manual installer upgrade to receive this fix.

### Installer formats and languages

Windows releases contain one `P2Sharer_<version>_x64-setup.exe` and one `P2Sharer_<version>_x64-setup.msi`. The EXE offers English and Brazilian Portuguese, using the Windows language when supported and English as the fallback. Its native selector allows users to change the choice; the standard NSIS registry handling can remember a previous explicit selection. The MSI uses English without a language selector. Both install the same application. Installer translations do not change the application's language.

The shared `src-tauri/tauri.windows.conf.json` is automatically merged into local Windows builds. Release builds load this packaging configuration and its small NSIS hook from the selected workflow revision, including retries of unpublished older tags. The standard Tauri/WiX path generates a separate MSI for each configured language, so keep its language set to `en-US`; NSIS embeds both languages in one executable. The hook preserves the native language dialog, translations, saved choice and cancel behavior, but skips the selector during passive/silent installations and updater runs. Keep Tauri's standard installer template and pages.

### Replacing an existing installation

Keep the published MSI UpgradeCode `7b204ccf-f6ba-5ddc-a719-cdf73e84ce2d` stable. MSI ProductCodes change between packages; the UpgradeCode identifies previous versions for `FindRelatedProducts` and `RemoveExistingProducts`. Changing installer format also requires migration: Windows Installer does not recognize an NSIS uninstall entry as a related MSI product.

The WiX fragment `src-tauri/windows/nsis-migration.wxs` recognizes the exact P2Sharer NSIS name, publisher, binary and saved directory in HKCU or HKLM. On installation it retires the legacy NSIS uninstall registration, binary, uninstaller and standard shortcuts, while MSI installs the replacement. It adopts the old NSIS directory unless an existing MSI takes priority. Only those named files and uninstall keys are removed; application profiles and preferences are preserved. The fragment is loaded from the workflow revision alongside the Windows configuration when retrying an unpublished tag.

| Previous installer | New installer | Replacement mechanism |
| --- | --- | --- |
| MSI | MSI | Stable UpgradeCode and the standard MSI major upgrade |
| EXE | MSI | WiX NSIS registration detection and restricted legacy cleanup |
| EXE | EXE | Standard NSIS detection and replacement in the saved directory |
| MSI | EXE | Standard Tauri NSIS reinstall page detects the MSI and requires its removal before continuing |

After building, run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-installer-artifacts.ps1`. This opens the actual MSI with machine state ignored, evaluates its compiled migration conditions and directory assignments, and checks the upgrade/removal tables without installing anything. It does not replace a real upgrade test.

Before publishing, exercise all four transitions in a disposable Windows VM using the actual previous release and the draft installers. Confirm one uninstall entry, working Start menu/desktop shortcuts, preserved preferences, launch and uninstall. Include EXE-to-MSI migration from a custom directory, cancellation/failure, and a machine already containing both formats. Test interactive and updater/passive flows separately; fully silent EXE migration is not established by the standard NSIS reinstall page checks. Do not use an existing personal installation as an automated fixture. Published older installers retain their original behavior; this migration requires a new release.

The release action publishes locale-free installer filenames with a consistent `-setup` suffix and matching `.sig` signatures. Its `[ext]` placeholder already includes the leading dot, so the naming pattern must use `-setup[ext]` without another dot. `latest.json` remains required for updater discovery and signature verification. After replacement assets and updater metadata have been validated, retries remove only the obsolete `_en-US.msi` and unsuffixed `.msi` names and their signatures from the same draft. Published releases remain immutable. Local MSI filenames may still carry `_en-US`, which is the bundler's internal naming convention.

Updates currently target installed Windows applications, using signed NSIS and MSI installers. The release workflow does not distribute a portable executable. A standalone executable contains update checks, but installation follows the installer flow rather than replacing that executable in place. Preserving portable operation during updates requires a separate implementation and validation.

The main window checks at startup and every 30 minutes while automatic checks are enabled. **Settings > Application** contains the persistent automatic-check switch and a manual check button. Changes to the switch apply when settings are saved. Saving a change to the beta channel checks in the background in either direction, even when periodic checks are disabled; it does not open the update dialog. The manual check button opens the dialog.

An available version adds an update badge beside the header logo. Users can download, defer installation and explicitly choose **Install and restart**. Installation leaves the room and stops native capture/audio. Offline checks and download/signature failures retain normal application use and allow retries. Only the main window receives updater and restart permissions.

The stable manifest is served from:

```text
https://github.com/DMVMarcio/p2sharer/releases/latest/download/latest.json
```

The release repository/assets must be publicly downloadable for anonymous installed clients. Before the first stable release, this URL is unavailable and a manual check reports that it could not complete. Never embed GitHub authentication in the application.

Older builds without this updater require a manual installation of the first updater-enabled release. The identifier migration copies the previous Windows application data before opening WebView2, keeps the old directory for recovery, and never replaces an existing new profile. Test an installed version A updating to a signed higher version B before describing the full delivery path as validated.
