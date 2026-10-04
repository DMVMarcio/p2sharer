# Release and update plan

This document describes the recommended release process. The repository does not yet contain a release workflow or an in-app updater. The commands below are a future release procedure, not an enabled publishing pipeline.

## Version policy

Use one application version across `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, including the root package entry in `src-tauri/Cargo.lock`. A release check should reject mismatches between these files and the tag.

Currently, the JavaScript package declares `0.1.0`, while Tauri and Cargo declare `1.0.0`. Reconcile these before the first release. Start with `1.0.0` if declaring a stable application, or an explicit prerelease such as `1.0.0-beta.1` during public testing. Do not silently change the version policy of already distributed builds.

Apply [Semantic Versioning](https://semver.org/) to the application's compatibility contract:

| Change | Example |
| --- | --- |
| Compatible bug fix | `1.0.0` to `1.0.1` |
| Compatible feature | `1.0.1` to `1.1.0` |
| Incompatible change to supported behavior, room protocol or saved data | `1.1.0` to `2.0.0` |
| Preview for testing | `1.1.0-beta.1` |

Use annotated tags named `vX.Y.Z`. Commits retain Conventional Commit messages; release notes explain user-visible changes, known limitations and migration requirements. Never move a published tag or replace its installer with different binaries. Correct a faulty release with a higher version.

## GitHub publication

Build official Windows x64 artifacts in GitHub Actions from the tagged commit. Use the official [Tauri action](https://github.com/tauri-apps/tauri-action) to upload installers and updater metadata to a draft GitHub Release. Configure the job for this repository's pnpm launcher and native prerequisites, including MSVC, CMake and NASM. Install dependencies with `pnpm install --frozen-lockfile`.

The proposed maintainer procedure is:

1. Update matching versions and lockfiles, write release notes and commit the changes.
2. Run frontend and native regressions plus `pnpm run tauri:build`. Inspect the executable and installers in the default `src-tauri/target/` directory.
3. Create and push the release tag. For example, after preparing version `1.0.1`:

   ```powershell
   git tag -a v1.0.1 -m "P2Sharer 1.0.1"
   git push origin main
   git push origin v1.0.1
   ```

4. Let the tag-triggered workflow validate the version, run portable tests, build and sign the installers, and prepare a draft release. A build failure must prevent a publishable release.
5. Download the draft artifacts and test installation, startup, capture, room joining and an actual upgrade from the previous release. Verify saved settings survive. CI cannot replace live media checks.
6. Publish the reviewed draft. Stable releases become the normal download/update destination. Mark preview builds as prereleases and keep them outside the stable update channel.

Keep installers in Release assets, not in Git. Use narrowly scoped workflow permissions and expose signing secrets only to trusted release jobs.

## In-app updates

Integrate the official [Tauri updater](https://v2.tauri.app/plugin/updater/), enable `createUpdaterArtifacts`, and distribute its generated signatures and `latest.json` with the installers. For a public release repository, use:

```text
https://github.com/DMVMarcio/p2sharer/releases/latest/download/latest.json
```

The updater requires signed artifacts. Commit only the public verification key; keep the private key and its password in GitHub Actions secrets, with a separate protected backup. Never embed a GitHub credential in the application. A private release repository requires another distribution arrangement.

Recommended application behavior: check at startup, provide a manual check in settings, show the available version and download progress, and let the user choose when to install. Preserve room and media cleanup before installation. Windows installation closes the app; do not interrupt an active session without consent. Older builds without updater support need a manual installation of the first updater-enabled version.

Updater signatures and [Windows Authenticode signing](https://v2.tauri.app/distribute/sign/windows/) serve different purposes. Evaluate Authenticode separately for installer publisher identity; updater signing does not address Windows reputation warnings.

## Implementation acceptance

- A release version command and tag validation keep every version declaration consistent.
- Trusted tag builds produce reviewed draft releases with working installer links and updater metadata.
- Update permissions are restricted to the main window, and UI uses existing canonical controls.
- Missing connectivity, no available update, invalid signatures, download failures and cancelled installation produce meaningful states without breaking normal application use.
- A packaged version A successfully discovers and installs a signed version B, preserving user data and releasing native media resources.
- The first release is published only after the updater key, CI secrets and installed upgrade path have been validated.
