//! Store links resolve to bounded packages imported through the same managed installer.
use super::extension_packages::{self, Package};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq)]
pub struct StoreExtension {
    pub id: String,
    pub edge: bool,
}
impl StoreExtension {
    pub fn parse(raw: &str) -> Option<Self> {
        if raw.len() > 4096 {
            return None;
        }
        let url = tauri::Url::parse(raw).ok()?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return None;
        }
        let edge = match url.host_str()? {
            "microsoftedge.microsoft.com" if url.path().starts_with("/addons/detail/") => true,
            "chromewebstore.google.com" if url.path().starts_with("/detail/") => false,
            "chrome.google.com" if url.path().starts_with("/webstore/detail/") => false,
            _ => return None,
        };
        let id = url
            .path_segments()?
            .filter(|part| !part.is_empty())
            .next_back()?;
        if id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
            return None;
        }
        Some(Self {
            id: id.into(),
            edge,
        })
    }
    pub fn page(&self) -> String {
        if self.edge {
            format!(
                "https://microsoftedge.microsoft.com/addons/detail/{}",
                self.id
            )
        } else {
            format!("https://chromewebstore.google.com/detail/{}", self.id)
        }
    }
}

pub fn intercepted_request(raw: &str) -> Option<StoreExtension> {
    let url = tauri::Url::parse(raw).ok()?;
    let edge = match (url.host_str()?, url.path()) {
        ("edge.microsoft.com", "/extensionwebstorebase/v1/crx") => true,
        ("clients2.google.com", "/service/update2/crx") => false,
        _ => return None,
    };
    if url.scheme() != "https" {
        return None;
    }
    for (_, value) in url.query_pairs().filter(|(key, _)| key == "x") {
        for (key, id) in tauri::Url::parse(&format!("https://example.invalid/?{value}"))
            .ok()?
            .query_pairs()
        {
            if key == "id" && id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
                return Some(StoreExtension {
                    id: id.into(),
                    edge,
                });
            }
        }
    }
    None
}
fn approved_download(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.host_str().is_some_and(|host| {
            [
                "google.com",
                "googleusercontent.com",
                "gvt1.com",
                "microsoft.com",
                "msedge.net",
                "azureedge.net",
            ]
            .iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
        })
}
struct Download(PathBuf);
impl Drop for Download {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
pub async fn download(raw: &str, profile: &Path, version: &str) -> Result<Package, String> {
    let store = StoreExtension::parse(raw).ok_or("Use a Chrome Web Store or Edge Add-ons link")?;
    let endpoint = if store.edge {
        "https://edge.microsoft.com/extensionwebstorebase/v1/crx"
    } else {
        "https://clients2.google.com/service/update2/crx"
    };
    let mut url = tauri::Url::parse(endpoint).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("response", "redirect")
        .append_pair("prodversion", version)
        .append_pair("acceptformat", "crx2,crx3")
        .append_pair("x", &format!("id={}&installsource=ondemand&uc", store.id));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 5 && approved_download(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Could not download extension")?
        .error_for_status()
        .map_err(|_| "Could not download extension")?;
    if !approved_download(response.url())
        || response.status().is_redirection()
        || response
            .content_length()
            .is_some_and(|length| length > 64 * 1024 * 1024)
    {
        return Err("Could not download extension".into());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not download extension")?
    {
        if data.len() + chunk.len() > 64 * 1024 * 1024 {
            return Err("Extension package exceeds size limit".into());
        }
        data.extend_from_slice(&chunk);
    }
    if !data.starts_with(b"Cr24") && !data.starts_with(b"PK") {
        return Err("Could not open extension package".into());
    }
    let mut nonce = [0; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let profile = profile.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let temporary =
            Download(profile.join(format!("download-{:032x}.crx", u128::from_le_bytes(nonce))));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary.0)
            .map_err(|e| e.to_string())?;
        file.write_all(&data).map_err(|e| e.to_string())?;
        drop(file);
        extension_packages::import(&temporary.0, &profile)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
pub async fn install_interceptor(
    view: &tauri::WebviewWindow,
    app: tauri::AppHandle,
    scope: String,
) -> Result<(), String> {
    use tauri::Emitter;
    use webview2_com::{
        CoTaskMemPWSTR, LaunchingExternalUriSchemeEventHandler, Microsoft::Web::WebView2::Win32::*,
        WebResourceRequestedEventHandler,
    };
    use windows_capture_api::core::{Interface, HSTRING, PCWSTR};
    super::on_view(view, move |core, tx| unsafe {
        let result = (|| {
            let environment = core.cast::<ICoreWebView2_2>()?.Environment()?;
            let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let request = args.Request()?;
                    let mut uri = Default::default();
                    request.Uri(&mut uri)?;
                    if let Some(store) = intercepted_request(&CoTaskMemPWSTR::from(uri).to_string())
                    {
                        let response = environment.CreateWebResourceResponse(
                            None,
                            403,
                            PCWSTR(HSTRING::from("Install in P2Sharer").as_ptr()),
                            PCWSTR::null(),
                        )?;
                        args.SetResponse(&response)?;
                        let _ = app.emit_to(
                            "main",
                            "shared-browser-extension-request",
                            serde_json::json!({"scope":scope,"url":store.page()}),
                        );
                    }
                }
                Ok(())
            }));
            let mut token = 0;
            for filter in [
                "https://edge.microsoft.com/extensionwebstorebase/v1/crx*",
                "https://clients2.google.com/service/update2/crx*",
            ] {
                core.AddWebResourceRequestedFilter(
                    PCWSTR(HSTRING::from(filter).as_ptr()),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                )?;
            }
            core.add_WebResourceRequested(&handler, &mut token)?;
            // Confine all external-protocol prompts to the shared browser's own UI.
            let external =
                LaunchingExternalUriSchemeEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                }));
            core.cast::<ICoreWebView2_18>()?
                .add_LaunchingExternalUriScheme(&external, &mut token)?;
            Ok::<(), windows_capture_api::core::Error>(())
        })()
        .map_err(|e| e.to_string());
        let _ = tx.send(result);
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn store_links_and_redirects_cannot_select_arbitrary_downloads() {
        let id = "a".repeat(32);
        assert!(
            StoreExtension::parse(&format!(
                "https://microsoftedge.microsoft.com/addons/detail/test/{id}"
            ))
            .unwrap()
            .edge
        );
        assert!(
            !StoreExtension::parse(&format!(
                "https://chromewebstore.google.com/detail/test/{id}"
            ))
            .unwrap()
            .edge
        );
        for raw in ["file:///extension.crx", "https://example.invalid/detail/test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "https://chromewebstore.google.com.evil.invalid/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] { assert!(StoreExtension::parse(raw).is_none()); }
        let request = format!("https://clients2.google.com/service/update2/crx?x=id%3D{id}%26uc");
        assert_eq!(intercepted_request(&request).unwrap().id, id);
        for raw in [
            "http://clients2.google.com/test",
            "https://example.invalid/file.crx",
            "https://google.com.evil.invalid/file",
            "https://localhost/file",
        ] {
            assert!(!approved_download(&tauri::Url::parse(raw).unwrap()));
        }
    }
}
