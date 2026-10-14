//! Native navigation events drive loading state without waiting for page scripts.
use super::*;
use webview2_com::{NavigationStartingEventHandler, NavigationCompletedEventHandler};

pub async fn install(view: &WebviewWindow, app: AppHandle, scope: String, tab: u32) -> Result<(), String> {
    let generation = app.state::<BrowserState>().0.lock().unwrap().get(&scope).ok_or("Browser closed")?.generation;
    on_view(view, move |core, tx| unsafe {
        let result = (|| {
            let start_app = app.clone(); let start_scope = scope.clone();
            let starting = NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args { let mut id = 0; args.NavigationId(&mut id)?;
                    publish(&start_app, &start_scope, tab, generation, id, true); }
                Ok(())
            }));
            let complete = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args { let mut id = 0; args.NavigationId(&mut id)?;
                    publish(&app, &scope, tab, generation, id, false); }
                Ok(())
            }));
            let mut token = 0;
            core.add_NavigationStarting(&starting, &mut token)?;
            core.add_NavigationCompleted(&complete, &mut token)?;
            Ok::<(), windows_capture_api::core::Error>(())
        })().map_err(|e| e.to_string());
        let _ = tx.send(result);
    }).await
}

fn publish(app: &AppHandle, scope: &str, tab: u32, generation: u64, id: u64, loading: bool) {
    let serial = {
        let state = app.state::<BrowserState>(); let mut sessions = state.0.lock().unwrap();
        let Some(session) = sessions.get_mut(scope) else { return; };
        if session.generation != generation { return; }
        let Some(page) = session.tabs.iter_mut().find(|page| page.id == tab) else { return; };
        if !update_navigation(page, id, loading) { return; }
        session.serial = session.serial.saturating_add(1); session.serial
    };
    let _ = app.emit_to("main", "shared-browser-loading", json!({"scope":scope,"tab":tab,"loading":loading,"serial":serial}));
}
