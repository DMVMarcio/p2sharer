//! Bridge page context into the trusted shell without opening an offscreen native menu.
use super::*;
use webview2_com::{CoTaskMemPWSTR, ContextMenuRequestedEventHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2_11};
use windows_capture_api::core::Interface;

pub async fn install(view: &WebviewWindow, app: AppHandle, scope: String, tab: u32) -> Result<(), String> {
    let generation = app.state::<BrowserState>().0.lock().unwrap().get(&scope).ok_or("Browser closed")?.generation;
    on_view(view, move |core, tx| unsafe {
        let result = (|| {
            core.Settings()?.SetAreDefaultContextMenusEnabled(true)?;
            let callback = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                args.SetHandled(true)?;
                let point = app.state::<BrowserState>().0.lock().unwrap().get(&scope)
                    .filter(|session| session.generation == generation && session.active == tab).map(|session| session.pointer);
                let Some((x, y)) = point else { return Ok(()); };
                let target = args.ContextMenuTarget()?;
                let mut editable = Default::default(); target.IsEditable(&mut editable)?;
                let mut link = Default::default(); let mut source = Default::default(); let mut selection = Default::default();
                let _ = target.LinkUri(&mut link); let _ = target.SourceUri(&mut source); let _ = target.SelectionText(&mut selection);
                let link = CoTaskMemPWSTR::from(link).to_string(); let source = CoTaskMemPWSTR::from(source).to_string();
                let selection: String = CoTaskMemPWSTR::from(selection).to_string().chars().take(4096).collect();
                let _ = app.emit_to("main", "shared-browser-context", json!({"scope":scope,"menu":{
                    "tab":tab,"x":x,"y":y,"editable":editable.as_bool(),"link":if allowed_url(&link) { link } else { String::new() },
                    "source":if allowed_url(&source) { source } else { String::new() },"selection":selection
                }}));
                Ok(())
            }));
            core.cast::<ICoreWebView2_11>()?.add_ContextMenuRequested(&callback, &mut 0)?;
            Ok::<(), windows_capture_api::core::Error>(())
        })().map_err(|e| e.to_string());
        let _ = tx.send(result);
    }).await
}
