use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{Manager, Webview};
use tauri_plugin_updater::UpdaterExt;

const RELEASES_URL: &str = "https://api.github.com/repos/DMVMarcio/p2sharer/releases?per_page=100";

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    assets: Vec<ReleaseAsset>,
}

/// Select by semantic precedence, not publication order, and never downgrade.
fn newest_release(releases: &[Release], current: &Version) -> Option<(Version, String)> {
    releases
        .iter()
        .filter_map(|release| {
            if release.draft
                || !release
                    .assets
                    .iter()
                    .any(|asset| asset.name == "latest.json")
            {
                return None;
            }
            let version = Version::parse(release.tag_name.strip_prefix('v')?).ok()?;
            version
                .cmp_precedence(current)
                .is_gt()
                .then(|| (version, release.tag_name.clone()))
        })
        .max_by(|left, right| left.0.cmp_precedence(&right.0))
}

fn stable_update_allowed(current: &Version, offered: &Version) -> bool {
    offered.pre.is_empty() && (!current.pre.is_empty() || offered.cmp_precedence(current).is_gt())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    body: Option<String>,
    raw_json: serde_json::Value,
}

/// Only discovery differs: downloads and installation use the official plugin resource.
#[tauri::command]
pub async fn check_app_update(
    webview: Webview,
    include_prereleases: bool,
) -> Result<Option<UpdateMetadata>, String> {
    if webview.label() != "main" {
        return Err("Only the main window can check updates".into());
    }
    let updater = if include_prereleases {
        preview_updater(&webview).await?
    } else {
        Some(
            webview
                .updater_builder()
                .timeout(Duration::from_secs(15))
                .version_comparator(|current, release| {
                    stable_update_allowed(&current, &release.version)
                })
                .build()
                .map_err(|error| error.to_string())?,
        )
    };
    let Some(updater) = updater else {
        return Ok(None);
    };
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

async fn preview_updater(
    webview: &Webview,
) -> Result<Option<tauri_plugin_updater::Updater>, String> {
    let current = webview.app_handle().package_info().version.clone();
    let client = reqwest::Client::builder()
        .user_agent("P2Sharer updater")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    // GitHub exposes published prereleases here, while /releases/latest excludes them.
    let releases: Vec<Release> = client
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let Some((expected, tag)) = newest_release(&releases, &current) else {
        return Ok(None);
    };
    let endpoint = reqwest::Url::parse(&format!(
        "https://github.com/DMVMarcio/p2sharer/releases/download/{tag}/latest.json"
    ))
    .map_err(|error| error.to_string())?;
    let updater = webview
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(15))
        .version_comparator(move |current, release| {
            release.version == expected && release.version.cmp_precedence(&current).is_gt()
        })
        .build()
        .map_err(|error| error.to_string())?;
    Ok(Some(updater))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, manifest: bool) -> Release {
        Release {
            tag_name: tag.into(),
            draft,
            assets: if manifest {
                vec![ReleaseAsset {
                    name: "latest.json".into(),
                }]
            } else {
                vec![]
            },
        }
    }

    #[test]
    fn preview_channel_uses_semver_including_newer_stable_releases() {
        let releases = vec![
            release("v1.1.0-beta.2", false, true),
            release("v1.1.0-beta.10", false, true),
            release("v1.1.0", false, true),
        ];
        assert_eq!(
            newest_release(&releases, &Version::parse("1.0.0").unwrap())
                .unwrap()
                .1,
            "v1.1.0"
        );
        assert_eq!(
            newest_release(&releases[..2], &Version::parse("1.0.0").unwrap())
                .unwrap()
                .1,
            "v1.1.0-beta.10"
        );
    }

    #[test]
    fn drafts_invalid_tags_missing_manifests_and_downgrades_are_not_updates() {
        let releases = vec![
            release("v9.0.0-beta.1", true, true),
            release("v8.0.0", false, false),
            release("invalid", false, true),
            release("v1.0.0", false, true),
            release("v1.1.0-beta.1", false, true),
        ];
        assert!(newest_release(&releases, &Version::parse("1.1.0-beta.2").unwrap()).is_none());
        assert!(newest_release(
            &[release("v1.0.0+other", false, true)],
            &Version::parse("1.0.0").unwrap()
        )
        .is_none());
    }

    #[test]
    fn only_an_installed_prerelease_may_return_to_an_older_stable_version() {
        let stable = Version::parse("1.0.0").unwrap();
        let beta = Version::parse("1.1.0-beta.2").unwrap();
        assert!(stable_update_allowed(&beta, &stable));
        assert!(!stable_update_allowed(
            &Version::parse("1.1.0").unwrap(),
            &stable
        ));
        assert!(!stable_update_allowed(&stable, &stable));
        assert!(!stable_update_allowed(&stable, &beta));
        assert!(stable_update_allowed(
            &stable,
            &Version::parse("1.1.0").unwrap()
        ));
        assert!(stable_update_allowed(
            &beta,
            &Version::parse("1.1.0").unwrap()
        ));
    }
}
