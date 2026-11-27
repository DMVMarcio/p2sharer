//! Script-dialog deferrals stay on the WebView2 UI apartment.
use super::*;
use std::cell::RefCell;
use webview2_com::{
    CoTaskMemPWSTR, Microsoft::Web::WebView2::Win32::*, ScriptDialogOpeningEventHandler,
};
use windows_capture_api::core::{HSTRING, PCWSTR};
struct Pending {
    id: String,
    args: ICoreWebView2ScriptDialogOpeningEventArgs,
    deferral: ICoreWebView2Deferral,
}
thread_local! { static PENDING: RefCell<HashMap<String, Pending>> = RefCell::new(HashMap::new()); }

pub async fn install(
    view: &WebviewWindow,
    app: AppHandle,
    scope: String,
    tab: u32,
) -> Result<(), String> {
    let key = view.label().to_string();
    let directory = app
        .state::<BrowserState>()
        .0
        .lock()
        .unwrap()
        .get(&scope)
        .ok_or("Browser closed")?
        .directory
        .clone();
    on_view(view, move |core, tx| unsafe {
        let result = (|| {
            core.Settings()?.SetAreDefaultScriptDialogsEnabled(false)?;
            let callback = ScriptDialogOpeningEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                let current = app.state::<BrowserState>().0.lock().unwrap().get(&scope)
                    .map(|session| session.directory == directory && session.tabs.iter().any(|t| t.id == tab)).unwrap_or(false);
                if !current { return Ok(()); }
                let mut message = Default::default(); let mut default_text = Default::default(); let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND::default();
                args.Message(&mut message)?; args.DefaultText(&mut default_text)?; args.Kind(&mut kind)?;
                let message: String = CoTaskMemPWSTR::from(message).to_string().chars().take(4096).collect();
                let default_text: String = CoTaskMemPWSTR::from(default_text).to_string().chars().take(4096).collect();
                let mut random = [0u8;16];
                if getrandom::getrandom(&mut random).is_err() { return Ok(()); }
                let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
                let deferral = args.GetDeferral()?;
                let old = PENDING.with(|pending| pending.borrow_mut().insert(key.clone(), Pending { id: id.clone(), args, deferral }));
                if let Some(old) = old { let _ = old.deferral.Complete(); }
                let kind = match kind { COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT => "prompt", COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT => "alert", _ => "confirm" };
                let _ = app.emit_to("main", "shared-browser-dialog", json!({"scope":scope,"dialog":{"id":id,"tab":tab,"kind":kind,"message":message,"defaultText":default_text}}));
                Ok(())
            }));
            core.add_ScriptDialogOpening(&callback, &mut 0)?;
            Ok::<(), windows_capture_api::core::Error>(())
        })().map_err(|e| e.to_string());
        let _ = tx.send(result);
    }).await
}

pub async fn resolve(
    view: &WebviewWindow,
    id: String,
    accept: bool,
    text: String,
) -> Result<(), String> {
    let key = view.label().to_string();
    on_view(view, move |_, tx| unsafe {
        let pending = PENDING.with(|pending| {
            let mut pending = pending.borrow_mut();
            if pending.get(&key).map(|p| p.id.as_str()) != Some(id.as_str()) {
                return Err("Browser dialog has already closed".to_string());
            }
            Ok(pending.remove(&key).unwrap())
        });
        let result = pending.and_then(|pending| {
            let result = if accept {
                pending
                    .args
                    .SetResultText(PCWSTR(HSTRING::from(text).as_ptr()))
                    .and_then(|_| pending.args.Accept())
            } else {
                Ok(())
            };
            let completed = pending.deferral.Complete();
            result.and(completed).map_err(|e| e.to_string())
        });
        let _ = tx.send(result);
    })
    .await
}

pub fn dismiss(view: &WebviewWindow) {
    let key = view.label().to_string();
    let _ = view.with_webview(move |_| unsafe {
        let pending = PENDING.with(|pending| pending.borrow_mut().remove(&key));
        if let Some(pending) = pending {
            let _ = pending.deferral.Complete();
        }
    });
}
