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

To retry an unpublished draft after fixing the workflow, push the fix to `main`, then use **Actions > Build release draft > Run workflow**, select branch **main** and supply the existing tag (for example, `v1.0.0`). **Re-run jobs** on an old run uses its original workflow revision and will repeat an already-fixed workflow error. The application is still checked out from the requested tag; shared build setup comes from the selected workflow revision. The job refuses to rebuild a published release. Never delete or recreate a public tag to replace its binaries.

## Build caches

The [main-branch workflow](../.github/workflows/validate.yml) runs on pushes to `main` and can be dispatched manually on that branch. It runs repository checks, frontend/native tests and an unsigned desktop build, then warms dependency caches without creating or publishing a release. Both workflows use the same [build setup](../.github/actions/setup-build/action.yml).

- **pnpm:** cache downloaded packages only, keyed by the lockfile, workspace configuration and dependency patches. Each job still runs `pnpm install --frozen-lockfile`; `node_modules` and frontend output are recreated.
- **Rust:** cache Cargo downloads and compiled dependencies in the default `src-tauri/target/`. Keys account for Cargo manifests/lockfiles, Rust compiler, OS/architecture, native build environment and shared setup. Application crates, installers, incremental output and signing credentials are excluded. Successful main builds save the cache; release jobs only restore it.

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

Updates currently target installed Windows applications, using signed NSIS and MSI installers. The release workflow does not distribute a portable executable. A standalone executable contains update checks, but installation follows the installer flow rather than replacing that executable in place. Preserving portable operation during updates requires a separate implementation and validation.

The main window checks at startup and every six hours while automatic checks are enabled. **Settings > Profile** contains the persistent automatic-check switch and a manual check button. Changes to the switch apply when settings are saved.

An available version adds an update badge beside the header logo. Users can download, defer installation and explicitly choose **Install and restart**. Installation leaves the room and stops native capture/audio. Offline checks and download/signature failures retain normal application use and allow retries. Only the main window receives updater and restart permissions.

The stable manifest is served from:

```text
https://github.com/DMVMarcio/p2sharer/releases/latest/download/latest.json
```

The release repository/assets must be publicly downloadable for anonymous installed clients. Before the first stable release, this URL is unavailable and a manual check reports that it could not complete. Never embed GitHub authentication in the application.

Older builds without this updater require a manual installation of the first updater-enabled release. The identifier migration copies the previous Windows application data before opening WebView2, keeps the old directory for recovery, and never replaces an existing new profile. Test an installed version A updating to a signed higher version B before describing the full delivery path as validated.
