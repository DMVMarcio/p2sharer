//! Cursor telemetry comes from a private isolated world, never the page's app bridge.
use super::*;
use webview2_com::{CoTaskMemPWSTR, DevToolsProtocolEventReceivedEventHandler};
use windows_capture_api::core::{HSTRING, PCWSTR};

pub async fn install(view: &WebviewWindow, app: AppHandle, scope: String, tab: u32) -> Result<(), String> {
    let generation = app.state::<BrowserState>().0.lock().unwrap().get(&scope).ok_or("Browser closed")?.generation;
    let mut random = [0u8; 16]; getrandom::getrandom(&mut random).map_err(|e| e.to_string())?;
    let binding = format!("__p2sharer_cursor_{}", random.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
    let callback_binding = binding.clone();
    on_view(view, move |core, tx| unsafe {
        let result = (|| {
            let receiver = core.GetDevToolsProtocolEventReceiver(PCWSTR(HSTRING::from("Runtime.bindingCalled").as_ptr()))?;
            let callback = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                let mut data = Default::default(); args.ParameterObjectAsJson(&mut data)?;
                let data = CoTaskMemPWSTR::from(data).to_string();
                if data.len() > 2048 { return Ok(()); }
                let Ok(value) = serde_json::from_str::<Value>(&data) else { return Ok(()); };
                if value["name"].as_str() != Some(callback_binding.as_str()) { return Ok(()); }
                let Some(shape) = value["payload"].as_str().filter(|shape| matches!(*shape, "default" | "text" | "pointer")) else { return Ok(()); };
                {
                    let state = app.state::<BrowserState>(); let mut sessions = state.0.lock().unwrap();
                    let Some(session) = sessions.get_mut(&scope).filter(|session| session.generation == generation && session.active == tab) else { return Ok(()); };
                    if session.cursor_shape == shape { return Ok(()); }
                    session.cursor_shape = shape.into();
                }
                let _ = app.emit_to("main", "shared-browser-cursor", json!({"scope":scope,"tab":tab,"shape":shape}));
                Ok(())
            }));
            receiver.add_DevToolsProtocolEventReceived(&callback, &mut 0)?;
            Ok::<(), windows_capture_api::core::Error>(())
        })().map_err(|e| e.to_string());
        let _ = tx.send(result);
    }).await?;
    cdp(view, "Runtime.enable", json!({})).await?;
    cdp(view, "Runtime.addBinding", json!({"name":binding,"executionContextName":"p2sharer-cursor"})).await?;
    let script = include_str!("browser_cursor.js").replace("__P2SHARER_CURSOR_BINDING__", &serde_json::to_string(&binding).map_err(|e| e.to_string())?);
    cdp(view, "Page.addScriptToEvaluateOnNewDocument", json!({"source":script,"worldName":"p2sharer-cursor"})).await?;
    Ok(())
}
