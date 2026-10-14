//! Isolated third-party WebViews. Only the trusted main window can operate them.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(windows)]
#[path = "browser_dialogs.rs"]
mod dialogs;
#[cfg(windows)]
#[path = "browser_navigation.rs"]
mod navigation;
const BROWSER_HOME: &str = "https://www.google.com/";
static NEXT_BROWSER_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct BrowserState(Mutex<HashMap<String, Session>>, tokio::sync::Mutex<()>);
impl BrowserState {
    pub async fn shutdown(&self, app: &AppHandle) {
        let _operation = self.1.lock().await;
        let scopes: Vec<String> = self.0.lock().unwrap().keys().cloned().collect();
        for scope in scopes {
            close_session(app, self, &scope);
        }
    }
}
struct Session {
    generation: u64,
    tabs: Vec<Tab>,
    active: u32,
    next: u32,
    temporary: bool,
    directory: PathBuf,
    audio: Option<Arc<AtomicBool>>,
    serial: u64,
    pointer: (f64, f64),
    buttons: u8,
    saved: Option<SavedTabs>,
    language: Option<String>,
    capture_widths: HashMap<u32, u32>,
    capture_id: Option<String>,
}
#[derive(Default, Clone, PartialEq, Serialize, Deserialize)]
struct SavedTabs {
    urls: Vec<String>,
    active_index: usize,
}
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Tab {
    pub id: u32,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub loading: bool,
    #[serde(skip)]
    navigation_id: u64,
}

fn trusted(window: &WebviewWindow, scope: &str) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Browser commands require the main window".into());
    }
    if scope.len() != 36 || !scope.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("Invalid browser scope".into());
    }
    Ok(())
}
fn label(scope: &str, tab: u32) -> String {
    format!("browser-{scope}-{tab}")
}
fn valid_capture_width(width: u32) -> bool {
    matches!(width, 1280 | 1920)
}
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("SharedBrowser"))
        .map_err(|e| e.to_string())
}
fn allowed_url(raw: &str) -> bool {
    if raw.len() > 4096 {
        return false;
    }
    if raw == "about:blank" {
        return true;
    }
    let Ok(url) = tauri::Url::parse(raw) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.host_str() != Some("tauri.localhost")
        && !(url.host_str() == Some("localhost") && url.port() == Some(1420))
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(windows)]
async fn on_view<T: Send + 'static>(
    view: &WebviewWindow,
    task: impl FnOnce(
            webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
            tokio::sync::oneshot::Sender<Result<T, String>>,
        ) + Send
        + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |webview| unsafe {
        // Keep the renderer available for capture while its native host window is hidden.
        let _ = webview.controller().SetIsVisible(true);
        match webview.controller().CoreWebView2() {
            Ok(core) => task(core, tx),
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
            }
        }
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| "Browser operation timed out".to_string())?
        .map_err(|_| "Browser closed".to_string())?
}

#[cfg(windows)]
async fn cdp(view: &WebviewWindow, method: &str, params: Value) -> Result<Value, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_capture_api::core::{HSTRING, PCWSTR};
    let method = method.to_string();
    on_view(view, move |core, tx| unsafe {
        let tx = Arc::new(Mutex::new(Some(tx)));
        let done = tx.clone();
        let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
            move |result, response| {
                let value = result
                    .map_err(|e| e.to_string())
                    .and_then(|_| serde_json::from_str(&response).map_err(|e| e.to_string()));
                if let Some(tx) = done.lock().unwrap().take() {
                    let _ = tx.send(value);
                }
                Ok(())
            },
        ));
        if let Err(e) = core.CallDevToolsProtocolMethod(
            PCWSTR(HSTRING::from(method).as_ptr()),
            PCWSTR(HSTRING::from(params.to_string()).as_ptr()),
            &callback,
        ) {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(Err(e.to_string()));
            }
        }
    })
    .await
}

fn build_tab(
    app: &AppHandle,
    scope: &str,
    id: u32,
    directory: PathBuf,
    temporary: bool,
    url: &str,
    language: Option<&str>,
) -> Result<WebviewWindow, String> {
    if !allowed_url(url) {
        return Err("Only HTTP and HTTPS pages are supported".into());
    }
    let popup_app = app.clone();
    let popup_scope = scope.to_string();
    let copy = crate::localization::browser_dialog_copy(language);
    let view = WebviewWindowBuilder::new(app, label(scope, id), WebviewUrl::External(tauri::Url::parse("about:blank").map_err(|e| e.to_string())?))
        .title("P2Sharer Browser").inner_size(1280.0, 720.0).visible(false).decorations(false)
        .shadow(false).skip_taskbar(true).focused(false).focusable(false)
        .data_directory(directory).incognito(temporary).browser_extensions_enabled(true)
        .additional_browser_args(&format!("{} --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default()))
        .on_navigation(|url| allowed_url(url.as_str()))
        .on_new_window(move |url, _| {
            if allowed_url(url.as_str()) {
                let _ = popup_app.emit_to("main", "shared-browser-popup", json!({"scope": popup_scope, "url": url.as_str()}));
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(move |_, event| {
            if let tauri::webview::DownloadEvent::Requested { destination, .. } = event {
                let name = destination.file_name().unwrap_or_default().to_string_lossy();
                if let Some(path) = rfd::FileDialog::new().set_title(copy.download_title).set_file_name(name.as_ref()).save_file() {
                    *destination = path; return true;
                }
                return false;
            }
            true
        })
        .build().map_err(|e| e.to_string())?;
    Ok(view)
}

#[tauri::command]
pub async fn start_shared_browser(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    scope: String,
    temporary: bool,
    language: Option<String>,
) -> Result<Value, String> {
    trusted(&window, &scope)?;
    let _operation = state.1.lock().await;
    let base = root(&app)?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let directory = if temporary {
        base.join(format!(
            "temporary-{scope}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        ))
    } else {
        let generation =
            std::fs::read_to_string(base.join("generation")).unwrap_or_else(|_| "default".into());
        if generation.len() > 80
            || !generation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Invalid browser profile".into());
        }
        base.join(format!("profile-{generation}"))
    };
    {
        let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
        if !sessions.is_empty() {
            return Err("Another shared browser is already running on this device".into());
        }
        sessions.insert(
            scope.clone(),
            Session {
                generation: NEXT_BROWSER_GENERATION.fetch_add(1, Ordering::Relaxed),
                tabs: vec![],
                active: 0,
                next: 1,
                temporary,
                directory: directory.clone(),
                audio: None,
                serial: 0,
                pointer: (0.0, 0.0),
                buttons: 0,
                saved: None,
                language,
                capture_widths: HashMap::new(),
                capture_id: None,
            },
        );
    }
    let saved = if temporary {
        SavedTabs::default()
    } else {
        std::fs::read(base.join("tabs.json"))
            .ok()
            .and_then(|v| serde_json::from_slice::<SavedTabs>(&v).ok())
            .unwrap_or_default()
    };
    let mut urls: Vec<String> = saved
        .urls
        .into_iter()
        .filter(|url| allowed_url(url))
        .take(16)
        .collect();
    if urls.is_empty() {
        urls.push(BROWSER_HOME.into());
    }
    for url in urls {
        let url = if url == "about:blank" { BROWSER_HOME } else { &url };
        if let Err(e) = add_tab(&app, &state, &scope, &url).await {
            close_session(&app, &state, &scope);
            return Err(e);
        }
    }
    let first = {
        let mut sessions = state.0.lock().unwrap();
        let session = sessions.get_mut(&scope).ok_or("Browser closed")?;
        let first = session
            .tabs
            .get(saved.active_index)
            .or_else(|| session.tabs.first())
            .ok_or("Browser closed")?
            .id;
        session.active = first;
        first
    };
    #[cfg(windows)]
    {
        let view = app
            .get_webview_window(&label(&scope, first))
            .ok_or("Browser missing")?;
        let pid = on_view(&view, |core, tx| unsafe {
            let mut pid = 0;
            let result = core
                .BrowserProcessId(&mut pid)
                .map(|_| pid)
                .map_err(|e| e.to_string());
            let _ = tx.send(result);
        })
        .await?;
        let audio = crate::audio_loopback::start_browser_audio(
            app.clone(),
            pid,
            format!("shared-browser-audio-{scope}"),
        );
        if let Some(session) = state.0.lock().unwrap().get_mut(&scope) {
            session.audio = Some(audio);
        } else {
            audio.store(false, Ordering::SeqCst);
            return Err("Browser closed".into());
        }
    }
    browser_state(&app, &state, &scope).await
}

async fn add_tab(
    app: &AppHandle,
    state: &BrowserState,
    scope: &str,
    url: &str,
) -> Result<u32, String> {
    let (id, directory, temporary, language) = {
        let mut sessions = state.0.lock().unwrap();
        let session = sessions.get_mut(scope).ok_or("Browser closed")?;
        if session.tabs.len() >= 16 {
            return Err("Browser tab limit reached".into());
        }
        let id = session.next;
        session.next += 1;
        (
            id,
            session.directory.clone(),
            session.temporary,
            session.language.clone(),
        )
    };
    let view = build_tab(
        app,
        scope,
        id,
        directory,
        temporary,
        url,
        language.as_deref(),
    )?;
    {
        let mut sessions = state.0.lock().unwrap();
        if let Some(session) = sessions.get_mut(scope) {
            session.tabs.push(Tab {
                id,
                url: url.into(),
                title: String::new(),
                ..Default::default()
            });
        } else {
            let _ = view.close();
            return Err("Browser closed".into());
        }
    }
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2_13,
        };
        use windows_capture_api::core::Interface;
        on_view(&view, |core, tx| unsafe {
            let result = (|| {
                let settings = core.Settings()?;
                settings.SetIsWebMessageEnabled(false)?;
                settings.SetAreDevToolsEnabled(false)?;
                settings.SetAreDefaultContextMenusEnabled(false)?;
                settings
                    .cast::<ICoreWebView2Settings3>()?
                    .SetAreBrowserAcceleratorKeysEnabled(false)?;
                settings
                    .cast::<ICoreWebView2Settings4>()?
                    .SetIsGeneralAutofillEnabled(false)?;
                settings
                    .cast::<ICoreWebView2Settings4>()?
                    .SetIsPasswordAutosaveEnabled(false)?;
                let _ = core.cast::<ICoreWebView2_13>()?.Profile()?;
                Ok::<(), windows_capture_api::core::Error>(())
            })()
            .map_err(|e| e.to_string());
            let _ = tx.send(result);
        })
        .await?;
        configure_viewport(&view, 1280).await?;
        navigation::install(&view, app.clone(), scope.to_string(), id).await?;
        dialogs::install(&view, app.clone(), scope.to_string(), id).await?;
    }
    if url != "about:blank" {
        view.navigate(tauri::Url::parse(url).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    let mut sessions = state.0.lock().unwrap();
    if let Some(session) = sessions.get_mut(scope) {
        session.active = id;
    } else {
        let _ = view.close();
        return Err("Browser closed".into());
    }
    Ok(id)
}

async fn browser_state(
    app: &AppHandle,
    state: &BrowserState,
    scope: &str,
) -> Result<Value, String> {
    let (tabs, active, temporary) = {
        let sessions = state.0.lock().unwrap();
        let session = sessions.get(scope).ok_or("Browser closed")?;
        (session.tabs.clone(), session.active, session.temporary)
    };
    let mut updated = vec![];
    for mut tab in tabs {
        #[cfg(windows)]
        if let Some(view) = app.get_webview_window(&label(scope, tab.id)) {
            use webview2_com::{CoTaskMemPWSTR, Microsoft::Web::WebView2::Win32::ICoreWebView2_8};
            use windows_capture_api::core::Interface;
            let metadata = on_view(&view, move |core, tx| unsafe {
                let result = (|| {
                    let mut url = Default::default();
                    let mut title = Default::default();
                    core.Source(&mut url)?;
                    core.DocumentTitle(&mut title)?;
                    core.cast::<ICoreWebView2_8>()?
                        .SetIsMuted(tab.id != active)?;
                    Ok::<_, windows_capture_api::core::Error>((
                        CoTaskMemPWSTR::from(url).to_string(),
                        CoTaskMemPWSTR::from(title).to_string(),
                    ))
                })()
                .map_err(|e| e.to_string());
                let _ = tx.send(result);
            })
            .await?;
            tab.url = metadata.0;
            tab.title = metadata.1.chars().take(200).collect();
        }
        updated.push(tab);
    }
    let serial = {
        let mut sessions = state.0.lock().unwrap();
        let session = sessions.get_mut(scope).ok_or("Browser closed")?;
        for tab in &mut updated {
            if let Some(current) = session.tabs.iter().find(|t| t.id == tab.id) {
                tab.loading = current.loading; tab.navigation_id = current.navigation_id;
            }
        }
        session.tabs = updated.clone();
        session.serial = session.serial.saturating_add(1);
        session.serial
    };
    if !temporary {
        let saved = SavedTabs {
            urls: updated.iter().map(|t| t.url.clone()).collect(),
            active_index: updated.iter().position(|t| t.id == active).unwrap_or(0),
        };
        let changed = {
            state
                .0
                .lock()
                .unwrap()
                .get(scope)
                .ok_or("Browser closed")?
                .saved
                .as_ref()
                != Some(&saved)
        };
        if changed {
            let base = root(app)?;
            let bytes = serde_json::to_vec(&saved).map_err(|e| e.to_string())?;
            std::fs::write(base.join("tabs.tmp"), bytes).map_err(|e| e.to_string())?;
            std::fs::rename(base.join("tabs.tmp"), base.join("tabs.json"))
                .map_err(|e| e.to_string())?;
            if let Some(session) = state.0.lock().unwrap().get_mut(scope) {
                session.saved = Some(saved);
            }
        }
    }
    Ok(json!({"tabs": updated, "active": active, "temporary": temporary, "serial": serial}))
}

fn close_session(app: &AppHandle, state: &BrowserState, scope: &str) {
    let session = { state.0.lock().unwrap().remove(scope) };
    if let Some(session) = session {
        if let Some(id) = session.capture_id { let _ = crate::screen_sources::stop_capture_session(id); }
        if let Some(flag) = session.audio {
            flag.store(false, Ordering::SeqCst);
        }
        for tab in session.tabs {
            if let Some(view) = app.get_webview_window(&label(scope, tab.id)) {
                #[cfg(windows)]
                dialogs::dismiss(&view);
                let _ = view.close();
            }
        }
        if session.temporary {
            cleanup_directory(session.directory);
        }
    }
}
fn cleanup_directory(directory: PathBuf) {
    // The caller supplies only app-generated profile directories, never a room path.
    std::thread::spawn(move || {
        for _ in 0..30 {
            if std::fs::remove_dir_all(&directory).is_ok() || !directory.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

#[tauri::command]
pub async fn stop_shared_browser(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    scope: String,
) -> Result<(), String> {
    trusted(&window, &scope)?;
    // Closing the target cancels pending page work instead of waiting for its input queue.
    close_session(&app, &state, &scope);
    Ok(())
}

#[tauri::command]
pub async fn resolve_browser_dialog(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    scope: String,
    tab: u32,
    id: String,
    accept: bool,
    text: String,
) -> Result<(), String> {
    trusted(&window, &scope)?;
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) || text.len() > 16384 {
        return Err("Invalid browser dialog response".into());
    }
    let exists = state
        .0
        .lock()
        .unwrap()
        .get(&scope)
        .map(|s| s.tabs.iter().any(|t| t.id == tab))
        .unwrap_or(false);
    if !exists {
        return Err("Browser closed".into());
    }
    let view = app
        .get_webview_window(&label(&scope, tab))
        .ok_or("Browser closed")?;
    // Bypass the operation lock: a paused page may be awaiting this answer.
    #[cfg(windows)]
    dialogs::resolve(&view, id, accept, text).await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum BrowserCommand {
    Navigate {
        url: String,
    },
    NewTab {
        url: String,
    },
    SelectTab {
        id: u32,
    },
    CloseTab {
        id: u32,
    },
    Back,
    Forward,
    Reload,
    Mouse {
        event: String,
        x: f64,
        y: f64,
        button: String,
        buttons: u32,
        delta_x: f64,
        delta_y: f64,
        modifiers: u32,
        clicks: u32,
    },
    Key {
        event: String,
        key: String,
        code: String,
        modifiers: u32,
        virtual_key: u32,
    },
    Text {
        text: String,
    },
    Release,
}
fn input_method(command: &BrowserCommand) -> Result<(&'static str, Value), String> {
    match command {
        BrowserCommand::Mouse {
            event,
            x,
            y,
            button,
            buttons,
            delta_x,
            delta_y,
            modifiers,
            clicks,
        } => {
            if !["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]
                .contains(&event.as_str())
                || !["none", "left", "middle", "right"].contains(&button.as_str())
                || !x.is_finite()
                || !y.is_finite()
                || !(0.0..=1280.0).contains(x)
                || !(0.0..=720.0).contains(y)
                || *buttons > 7
                || *modifiers > 15
                || *clicks > 3
                || !delta_x.is_finite()
                || !delta_y.is_finite()
                || delta_x.abs() > 5000.0
                || delta_y.abs() > 5000.0
            {
                return Err("Invalid browser mouse input".into());
            }
            Ok((
                "Input.dispatchMouseEvent",
                json!({"type":event,"x":x,"y":y,"button":button,"buttons":buttons,
                "deltaX":delta_x,"deltaY":delta_y,"modifiers":modifiers,"clickCount":clicks}),
            ))
        }
        BrowserCommand::Key {
            event,
            key,
            code,
            modifiers,
            virtual_key,
        } => {
            if !["keyDown", "keyUp"].contains(&event.as_str())
                || key.len() > 80
                || code.len() > 80
                || *modifiers > 15
                || *virtual_key > 255
            {
                return Err("Invalid browser keyboard input".into());
            }
            Ok((
                "Input.dispatchKeyEvent",
                json!({"type":event,"key":key,"code":code,"modifiers":modifiers,"windowsVirtualKeyCode":virtual_key}),
            ))
        }
        BrowserCommand::Text { text }
            if !text.is_empty() && text.len() <= 16384 && text.encode_utf16().count() <= 4096 =>
        {
            Ok(("Input.insertText", json!({"text":text})))
        }
        _ => Err("Invalid browser input".into()),
    }
}

#[tauri::command]
pub async fn control_shared_browser(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    scope: String,
    command: BrowserCommand,
) -> Result<Value, String> {
    trusted(&window, &scope)?;
    let _operation = state.1.lock().await;
    let active = {
        state.0.lock().unwrap().get(&scope).ok_or("Browser closed")?.active
    };
    let view = app
        .get_webview_window(&label(&scope, active))
        .ok_or("Browser closed")?;
    let input_only = matches!(
        command,
        BrowserCommand::Mouse { .. }
            | BrowserCommand::Key { .. }
            | BrowserCommand::Text { .. }
            | BrowserCommand::Release
    );
    match command {
        BrowserCommand::Navigate { url } => {
            if !allowed_url(&url) {
                return Err("Only HTTP and HTTPS pages are supported".into());
            }
            view.navigate(tauri::Url::parse(&url).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
        BrowserCommand::NewTab { url } => {
            add_tab(&app, &state, &scope, &url).await?;
        }
        BrowserCommand::SelectTab { id } => {
            let mut sessions = state.0.lock().unwrap();
            let session = sessions.get_mut(&scope).ok_or("Browser closed")?;
            if !session.tabs.iter().any(|t| t.id == id) {
                return Err("Unknown browser tab".into());
            }
            session.active = id;
        }
        BrowserCommand::CloseTab { id } => {
            {
                let mut sessions = state.0.lock().unwrap();
                let session = sessions.get_mut(&scope).ok_or("Browser closed")?;
                if !session.tabs.iter().any(|t| t.id == id) {
                    return Err("Unknown browser tab".into());
                }
                session.tabs.retain(|t| t.id != id);
                session.capture_widths.remove(&id);
                if session.active == id {
                    session.active = session.tabs.first().map(|t| t.id).unwrap_or(0);
                }
            }
            if let Some(view) = app.get_webview_window(&label(&scope, id)) {
                #[cfg(windows)]
                dialogs::dismiss(&view);
                view.close().map_err(|e| e.to_string())?;
            }
            let empty = {
                state
                    .0
                    .lock()
                    .unwrap()
                    .get(&scope)
                    .ok_or("Browser closed")?
                    .tabs
                    .is_empty()
            };
            if empty {
                add_tab(&app, &state, &scope, BROWSER_HOME).await?;
            }
        }
        BrowserCommand::Back | BrowserCommand::Forward => {
            #[cfg(windows)]
            {
                let backwards = matches!(command, BrowserCommand::Back);
                on_view(&view, move |core, tx| unsafe {
                    let _ = tx.send(
                        (if backwards {
                            core.GoBack()
                        } else {
                            core.GoForward()
                        })
                        .map_err(|e| e.to_string()),
                    );
                })
                .await?;
            }
        }
        BrowserCommand::Reload => {
            #[cfg(windows)]
            on_view(&view, |core, tx| unsafe {
                let _ = tx.send(core.Reload().map_err(|e| e.to_string()));
            })
            .await?;
        }
        BrowserCommand::Release => {
            let (pointer, buttons) = {
                let mut sessions = state.0.lock().unwrap();
                let session = sessions.get_mut(&scope).ok_or("Browser closed")?;
                let buttons = session.buttons; session.buttons = 0;
                (session.pointer, buttons)
            };
            #[cfg(windows)]
            for (button, remaining) in release_buttons(buttons) {
                cdp(&view, "Input.dispatchMouseEvent", json!({"type":"mouseReleased","x":pointer.0,"y":pointer.1,"button":button,"buttons":remaining})).await?;
            }
        }
        input => {
            let (method, params) = input_method(&input)?;
            #[cfg(windows)]
            cdp(&view, method, params).await?;
            if let BrowserCommand::Mouse { x, y, buttons, .. } = input {
                if let Some(session) = state.0.lock().unwrap().get_mut(&scope) {
                    session.pointer = (x, y);
                    session.buttons = buttons as u8;
                }
            }
        }
    }
    if input_only {
        Ok(Value::Null)
    } else {
        browser_state(&app, &state, &scope).await
    }
}

#[tauri::command]
pub async fn prepare_shared_browser_capture(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    scope: String,
    width: u32,
    probe: bool,
    session_id: String,
) -> Result<Value, String> {
    trusted(&window, &scope)?;
    if !valid_capture_width(width) {
        return Err("Invalid browser capture size".into());
    }
    if !session_id.starts_with(&format!("browser-{scope}-")) || session_id.len() > 100
        || !session_id.bytes().all(|b| b.is_ascii_hexdigit() || b.is_ascii_lowercase() || b == b'-') {
        return Err("Invalid browser capture session".into());
    }
    let _operation = state.1.lock().await;
    let (active, generation) = {
        let sessions = state.0.lock().unwrap();
        let session = sessions.get(&scope).ok_or("Browser closed")?;
        (session.active, session.generation)
    };
    let view = app
        .get_webview_window(&label(&scope, active))
        .ok_or("Browser closed")?;
    #[cfg(windows)]
    {
        let prepared_width = state.0.lock().unwrap().get(&scope)
            .and_then(|session| session.capture_widths.get(&active)).copied();
        // WGC captures a live compositor surface; hidden/minimized windows have none.
        // Keep the source outside the entire virtual desktop and never activate it.
        let height = width * 9 / 16;
        let size = tauri::PhysicalSize::new(width, height);
        if prepared_width != Some(width) || view.inner_size().map_err(|e| e.to_string())? != size {
            let desktop_left = unsafe { windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics(windows::Win32::UI::WindowsAndMessaging::SM_XVIRTUALSCREEN) };
            view.set_position(tauri::PhysicalPosition::new(desktop_left.saturating_sub(width as i32 + 128), 0)).map_err(|e| e.to_string())?;
            // Position first: WM_DPICHANGED may apply a different suggested size.
            view.set_size(size).map_err(|e| e.to_string())?;
            state.0.lock().unwrap().get_mut(&scope).ok_or("Browser closed")?.capture_widths.insert(active, width);
        }
        if !view.is_visible().map_err(|e| e.to_string())? { view.show().map_err(|e| e.to_string())?; }
        configure_viewport(&view, width).await?;
        let tabs = state.0.lock().unwrap().get(&scope).ok_or("Browser closed")?.tabs.clone();
        for tab in tabs { if tab.id != active { if let Some(other) = app.get_webview_window(&label(&scope, tab.id)) { if other.is_visible().unwrap_or(false) { let _ = other.hide(); } } } }
        let previous_id = state.0.lock().unwrap().get_mut(&scope).ok_or("Browser closed")?.capture_id.replace(session_id.clone());
        if let Some(previous) = previous_id { if previous != session_id { let _ = crate::screen_sources::stop_capture_session(previous); } }
        // A busy page must not hold the input lock while the optional JS probe runs.
        drop(_operation);
        let playing = if probe { Some(probe_video(&view).await.unwrap_or(false)) } else { None };
        let _metadata_operation = state.1.lock().await;
        let current = {
            let sessions = state.0.lock().unwrap();
            let session = sessions.get(&scope).ok_or("Browser closed")?;
            if session.generation != generation { return Err("Browser closed".into()); }
            session.active
        };
        if current != active {
            let state = browser_state(&app, &state, &scope).await?;
            return Ok(json!({"sourceId":null, "state":state, "playing":null}));
        }
        let source_id = format!("window:{}", view.hwnd().map_err(|e| e.to_string())?.0 as usize);
        let state = browser_state(&app, &state, &scope).await?;
        Ok(json!({"sourceId":source_id, "state": state, "playing": playing}))
    }
    #[cfg(not(windows))]
    {
        let _ = (view, probe);
        Err("Shared browser requires Windows".into())
    }
}

#[cfg(windows)]
async fn configure_viewport(view: &WebviewWindow, width: u32) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Controller3, COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS};
    use windows_capture_api::{core::Interface, Win32::Foundation::RECT};
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |webview| unsafe {
        let result = (|| {
            let controller = webview.controller();
            let scaled = controller.cast::<ICoreWebView2Controller3>()?;
            scaled.SetShouldDetectMonitorScaleChanges(false)?;
            scaled.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS)?;
            let mut scale = 0.0;
            scaled.RasterizationScale(&mut scale)?;
            let target_scale = width as f64 / 1280.0;
            if (scale - target_scale).abs() > 0.001 { scaled.SetRasterizationScale(target_scale)?; }
            let bounds = RECT { left: 0, top: 0, right: width as i32, bottom: (width * 9 / 16) as i32 };
            let mut current = RECT::default(); controller.Bounds(&mut current)?;
            if current != bounds { controller.SetBounds(bounds)?; }
            controller.SetIsVisible(true)?;
            Ok::<(), windows_capture_api::core::Error>(())
        })().map_err(|e| e.to_string());
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

fn update_navigation(tab: &mut Tab, id: u64, loading: bool) -> bool {
    if loading { if id < tab.navigation_id { return false; } tab.navigation_id = id; }
    else if id != tab.navigation_id { return false; }
    tab.loading = loading; true
}

fn release_buttons(mut buttons: u8) -> Vec<(&'static str, u8)> {
    let mut released = vec![];
    for (name, mask) in [("left", 1), ("right", 2), ("middle", 4)] {
        if buttons & mask != 0 { buttons &= !mask; released.push((name, buttons)); }
    }
    released
}

#[cfg(windows)]
async fn probe_video(view: &WebviewWindow) -> Result<bool, String> {
    // Isolated worlds also inspect embedded players without granting cross-origin access.
    let tree = cdp(view, "Page.getFrameTree", json!({})).await?;
    let mut pending = vec![&tree["frameTree"]];
    let mut frames = 0;
    while let Some(frame) = pending.pop() {
        frames += 1;
        if frames > 16 { break; }
        if let Some(children) = frame["childFrames"].as_array() { pending.extend(children); }
        let Some(id) = frame["frame"]["id"].as_str() else { continue; };
        let Ok(world) = cdp(view, "Page.createIsolatedWorld",
            json!({"frameId":id,"worldName":"p2sharer-media-probe"})).await else { continue; };
        let Some(context) = world["executionContextId"].as_u64() else { continue; };
        let Ok(result) = cdp(view, "Runtime.evaluate", json!({
            "expression":include_str!("browser_video_probe.js"),"contextId":context,
            "returnByValue":true,"timeout":50,"silent":true
        })).await else { continue; };
        if result["result"]["value"].as_bool() == Some(true) { return Ok(true); }
    }
    Ok(false)
}

#[tauri::command]
pub async fn clear_shared_browser(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    scope: String,
    mode: String,
) -> Result<(), String> {
    trusted(&window, &scope)?;
    let _operation = state.1.lock().await;
    let (active, directory, temporary) = {
        let sessions = state.0.lock().unwrap();
        let session = sessions.get(&scope).ok_or("Browser closed")?;
        (session.active, session.directory.clone(), session.temporary)
    };
    if mode == "reset" {
        close_session(&app, &state, &scope);
        if !temporary {
            let base = root(&app)?;
            std::fs::write(
                base.join("generation"),
                format!(
                    "{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|e| e.to_string())?
                        .as_nanos()
                ),
            )
            .map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(base.join("tabs.json"));
            cleanup_directory(directory);
        }
        return Ok(());
    }
    if !["cache", "sites", "history"].contains(&mode.as_str()) {
        return Err("Invalid browser cleanup mode".into());
    }
    let view = app
        .get_webview_window(&label(&scope, active))
        .ok_or("Browser closed")?;
    #[cfg(windows)]
    {
        use webview2_com::{ClearBrowsingDataCompletedHandler, Microsoft::Web::WebView2::Win32::*};
        use windows_capture_api::core::Interface;
        on_view(&view, move |core, tx| unsafe {
            let tx = Arc::new(Mutex::new(Some(tx)));
            let done = tx.clone();
            let callback = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                if let Some(tx) = done.lock().unwrap().take() {
                    let _ = tx.send(result.map_err(|e| e.to_string()));
                }
                Ok(())
            }));
            let kinds = match mode.as_str() {
                "cache" => COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
                "history" => COREWEBVIEW2_BROWSING_DATA_KINDS_BROWSING_HISTORY,
                _ => COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_SITE,
            };
            let result = core
                .cast::<ICoreWebView2_13>()
                .and_then(|c| c.Profile())
                .and_then(|p| p.cast::<ICoreWebView2Profile2>())
                .and_then(|p| p.ClearBrowsingData(kinds, &callback));
            if let Err(e) = result {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_extensions(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    scope: String,
    action: String,
    id: Option<String>,
    language: Option<String>,
) -> Result<Value, String> {
    trusted(&window, &scope)?;
    let _operation = state.1.lock().await;
    let active = {
        state
            .0
            .lock()
            .unwrap()
            .get(&scope)
            .ok_or("Browser closed")?
            .active
    };
    let view = app
        .get_webview_window(&label(&scope, active))
        .ok_or("Browser closed")?;
    #[cfg(windows)]
    {
        use webview2_com::{
            BrowserExtensionEnableCompletedHandler, BrowserExtensionRemoveCompletedHandler,
            CoTaskMemPWSTR, Microsoft::Web::WebView2::Win32::*,
            ProfileAddBrowserExtensionCompletedHandler,
            ProfileGetBrowserExtensionsCompletedHandler,
        };
        use windows_capture_api::core::{Interface, HSTRING, PCWSTR};
        if action == "install" {
            let folder = rfd::AsyncFileDialog::new()
                .set_title(
                    crate::localization::browser_dialog_copy(language.as_deref()).extension_title,
                )
                .pick_folder()
                .await
                .ok_or("Extension installation cancelled")?;
            if !folder.path().join("manifest.json").is_file() {
                return Err("Extension folder must contain manifest.json".into());
            }
            let path = folder.path().to_string_lossy().to_string();
            on_view(&view, move |core, tx| unsafe {
                let tx = Arc::new(Mutex::new(Some(tx)));
                let done = tx.clone();
                let callback = ProfileAddBrowserExtensionCompletedHandler::create(Box::new(
                    move |result, _| {
                        if let Some(tx) = done.lock().unwrap().take() {
                            let _ = tx.send(result.map_err(|e| e.to_string()));
                        }
                        Ok(())
                    },
                ));
                let result = core
                    .cast::<ICoreWebView2_13>()
                    .and_then(|c| c.Profile())
                    .and_then(|p| p.cast::<ICoreWebView2Profile7>())
                    .and_then(|p| {
                        p.AddBrowserExtension(PCWSTR(HSTRING::from(path).as_ptr()), &callback)
                    });
                if let Err(e) = result {
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(Err(e.to_string()));
                    }
                }
            })
            .await?;
        }
        if !["install", "list", "remove", "enable", "disable"].contains(&action.as_str()) {
            return Err("Invalid extension action".into());
        }
        let extensions = on_view(&view, move |core, tx| unsafe {
            let tx = Arc::new(Mutex::new(Some(tx))); let done = tx.clone();
            let callback = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |result, list| {
                let mut mutation_pending = false;
                let result = result.and_then(|_| {
                    let list = list.ok_or_else(|| windows_capture_api::core::Error::new(windows_capture_api::core::HRESULT(0x80004005u32 as i32), "Missing extension list"))?;
                    let mut count = 0; list.Count(&mut count)?; let mut rows = vec![];
                    for index in 0..count.min(100) {
                        let extension = list.GetValueAtIndex(index)?;
                        let mut extension_id = Default::default(); let mut name = Default::default(); let mut enabled = Default::default();
                        extension.Id(&mut extension_id)?; extension.Name(&mut name)?; extension.IsEnabled(&mut enabled)?;
                        let extension_id = CoTaskMemPWSTR::from(extension_id).to_string();
                        if id.as_ref() == Some(&extension_id) {
                            if action == "remove" {
                                let complete = done.clone();
                                extension.Remove(&BrowserExtensionRemoveCompletedHandler::create(Box::new(move |result| {
                                    if let Some(tx) = complete.lock().unwrap().take() { let _ = tx.send(result.map(|_| Value::Null).map_err(|e| e.to_string())); } Ok(())
                                })))?;
                                mutation_pending = true;
                            }
                            if action == "enable" || action == "disable" {
                                let complete = done.clone();
                                extension.Enable(action == "enable", &BrowserExtensionEnableCompletedHandler::create(Box::new(move |result| {
                                    if let Some(tx) = complete.lock().unwrap().take() { let _ = tx.send(result.map(|_| Value::Null).map_err(|e| e.to_string())); } Ok(())
                                })))?;
                                mutation_pending = true;
                            }
                        }
                        rows.push(json!({"id":extension_id,"name":CoTaskMemPWSTR::from(name).to_string(),"enabled":enabled.as_bool()}));
                    }
                    Ok(json!(rows))
                }).map_err(|e| e.to_string());
                if !mutation_pending || result.is_err() {
                    if let Some(tx) = done.lock().unwrap().take() { let _ = tx.send(result); }
                }
                Ok(())
            }));
            let result = core.cast::<ICoreWebView2_13>().and_then(|c| c.Profile()).and_then(|p| p.cast::<ICoreWebView2Profile7>()).and_then(|p| p.GetBrowserExtensions(&callback));
            if let Err(e) = result { if let Some(tx) = tx.lock().unwrap().take() { let _ = tx.send(Err(e.to_string())); } }
        }).await?;
        return Ok(extensions);
    }
    #[cfg(not(windows))]
    {
        let _ = (view, action, id);
        Err("Browser extensions require Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_navigation_completion_cannot_hide_a_new_page_loading() {
        let mut tab = Tab::default();
        assert!(update_navigation(&mut tab, 1, true));
        assert!(tab.loading);
        assert!(update_navigation(&mut tab, 2, true));
        assert!(!update_navigation(&mut tab, 1, false));
        assert!(tab.loading);
        assert!(update_navigation(&mut tab, 2, false));
        assert!(!tab.loading);
    }
    #[test]
    fn idle_release_never_synthesizes_a_right_click() {
        assert!(release_buttons(0).is_empty());
        assert_eq!(release_buttons(1), vec![("left", 0)]);
        assert_eq!(release_buttons(5), vec![("left", 4), ("middle", 0)]);
        assert_eq!(release_buttons(2), vec![("right", 0)]);
    }
    #[test]
    fn capture_allows_only_bounded_quality_profiles() {
        assert!(valid_capture_width(1280));
        assert!(valid_capture_width(1920));
        for width in [0, 1, 3840, u32::MAX] { assert!(!valid_capture_width(width)); }
    }
    #[test]
    fn navigation_cannot_reach_application_origins_or_protocols() {
        for url in [
            "file:///test",
            "javascript:alert(1)",
            "http://tauri.localhost",
            "http://localhost:1420",
            "data:text/html,test",
        ] {
            assert!(!allowed_url(url));
        }
        assert!(allowed_url("https://example.com"));
        assert!(allowed_url("about:blank"));
        let mut credentials = tauri::Url::parse("https://example.com").unwrap();
        credentials.set_username("fixture-user").unwrap();
        credentials.set_password(Some("fixture-password")).unwrap();
        assert!(!allowed_url(credentials.as_str()));
    }
    #[test]
    fn input_rejects_unbounded_and_unknown_commands() {
        assert!(serde_json::from_value::<BrowserCommand>(
            json!({"kind":"evaluate","script":"test"})
        )
        .is_err());
        assert!(input_method(&BrowserCommand::Text {
            text: "x".repeat(4097)
        })
        .is_err());
        assert!(input_method(&BrowserCommand::Text {
            text: "\u{00e9}".repeat(4096)
        })
        .is_ok());
        assert!(input_method(&BrowserCommand::Mouse {
            event: "mouseMoved".into(),
            x: f64::NAN,
            y: 0.0,
            button: "none".into(),
            buttons: 0,
            delta_x: 0.0,
            delta_y: 0.0,
            modifiers: 0,
            clicks: 0
        })
        .is_err());
    }
}
