//! Native navigation events drive loading state without waiting for page scripts.
use super::*;
use webview2_com::{CoTaskMemPWSTR, HistoryChangedEventHandler, NavigationStartingEventHandler, NavigationCompletedEventHandler, NewWindowRequestedEventHandler};

pub async fn install(view: &WebviewWindow, app: AppHandle, scope: String, tab: u32) -> Result<(), String> {
    let generation = app.state::<BrowserState>().0.lock().unwrap().get(&scope).ok_or("Browser closed")?.generation;
    on_view(view, move |core, tx| unsafe {
        let result = (|| {
            let popup_app = app.clone(); let popup_scope = scope.clone();
            // Resolve target=_blank directly on the WebView apartment. Creating the shared
            // tab happens later in the shell, without holding a new-window COM deferral.
            let popup = NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                args.SetHandled(true)?;
                let mut uri = Default::default(); args.Uri(&mut uri)?;
                let uri = CoTaskMemPWSTR::from(uri).to_string();
                let current = popup_app.state::<BrowserState>().0.lock().unwrap().get(&popup_scope)
                    .is_some_and(|session| session.generation == generation && session.active == tab);
                if current && allowed_url(&uri) {
                    let _ = popup_app.emit_to("main", "shared-browser-popup", json!({"scope":popup_scope,"tab":tab,"url":uri}));
                }
                Ok(())
            }));
            let start_app = app.clone(); let start_scope = scope.clone();
            let starting = NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args { let mut id = 0; args.NavigationId(&mut id)?;
                    publish(&start_app, &start_scope, tab, generation, id, true); }
                Ok(())
            }));
            let completed_app = app.clone(); let completed_scope = scope.clone();
            let complete = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args { let mut id = 0; args.NavigationId(&mut id)?;
                    publish(&completed_app, &completed_scope, tab, generation, id, false); }
                Ok(())
            }));
            let history = HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                let Some(sender) = sender else { return Ok(()); };
                let mut back = Default::default(); let mut forward = Default::default();
                sender.CanGoBack(&mut back)?; sender.CanGoForward(&mut forward)?;
                let update = {
                    let state = app.state::<BrowserState>(); let mut sessions = state.0.lock().unwrap();
                    let Some(session) = sessions.get_mut(&scope).filter(|session| session.generation == generation) else { return Ok(()); };
                    let Some(page) = session.tabs.iter_mut().find(|page| page.id == tab) else { return Ok(()); };
                    page.can_back = back.as_bool(); page.can_forward = forward.as_bool();
                    let loading = page.loading;
                    session.serial = session.serial.saturating_add(1);
                    json!({"scope":scope,"tab":tab,"loading":loading,"canBack":back.as_bool(),"canForward":forward.as_bool(),"serial":session.serial})
                };
                let _ = app.emit_to("main", "shared-browser-loading", update);
                Ok(())
            }));
            let mut token = 0;
            core.add_NavigationStarting(&starting, &mut token)?;
            core.add_NavigationCompleted(&complete, &mut token)?;
            core.add_HistoryChanged(&history, &mut token)?;
            core.add_NewWindowRequested(&popup, &mut token)?;
            Ok::<(), windows_capture_api::core::Error>(())
        })().map_err(|e| e.to_string());
        let _ = tx.send(result);
    }).await
}

fn publish(app: &AppHandle, scope: &str, tab: u32, generation: u64, id: u64, loading: bool) {
    let (serial, back, forward) = {
        let state = app.state::<BrowserState>(); let mut sessions = state.0.lock().unwrap();
        let Some(session) = sessions.get_mut(scope) else { return; };
        if session.generation != generation { return; }
        let Some(page) = session.tabs.iter_mut().find(|page| page.id == tab) else { return; };
        if !update_navigation(page, id, loading) { return; }
        let (back, forward) = (page.can_back, page.can_forward);
        session.serial = session.serial.saturating_add(1); (session.serial, back, forward)
    };
    let _ = app.emit_to("main", "shared-browser-loading", json!({"scope":scope,"tab":tab,"loading":loading,"serial":serial,"canBack":back,"canForward":forward}));
}
