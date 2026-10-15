//! Read bounded page selection without accessing the host's operating-system clipboard.
use super::*;

pub async fn read(view: &WebviewWindow) -> Result<String, String> {
    let tree = cdp(view, "Page.getFrameTree", json!({})).await?;
    let mut frame = &tree["frameTree"];
    let mut remaining = 32;
    for _ in 0..16 {
        let id = frame["frame"]["id"].as_str().ok_or("Browser selection unavailable")?;
        let world = cdp(view, "Page.createIsolatedWorld", json!({"frameId":id,"worldName":"p2sharer-selection"})).await?;
        let context = world["executionContextId"].as_u64().ok_or("Browser selection unavailable")?;
        let result = cdp(view, "Runtime.evaluate", json!({"expression":include_str!("browser_selection.js"),
            "contextId":context,"returnByValue":true,"timeout":50,"silent":true})).await?;
        if result["result"]["value"]["frame"].as_bool() != Some(true) {
            return Ok(result["result"]["value"]["text"].as_str().unwrap_or("").chars().take(65536).collect());
        }
        let mut next = None;
        for child in frame["childFrames"].as_array().into_iter().flatten() {
            if remaining == 0 { break; } remaining -= 1;
            let Some(id) = child["frame"]["id"].as_str() else { continue; };
            let Ok(owner) = cdp(view, "DOM.getFrameOwner", json!({"frameId":id})).await else { continue; };
            let Ok(node) = cdp(view, "DOM.resolveNode", json!({"backendNodeId":owner["backendNodeId"],"executionContextId":context})).await else { continue; };
            let Some(object) = node["object"]["objectId"].as_str() else { continue; };
            let active = cdp(view, "Runtime.callFunctionOn", json!({"objectId":object,
                "functionDeclaration":"function(){let e=document.activeElement;for(let i=0;e?.shadowRoot?.activeElement&&i<8;i++)e=e.shadowRoot.activeElement;return e===this;}",
                "returnByValue":true,"silent":true})).await;
            let _ = cdp(view, "Runtime.releaseObject", json!({"objectId":object})).await;
            if active.ok().is_some_and(|value| value["result"]["value"].as_bool() == Some(true)) { next = Some(child); break; }
        }
        let Some(child) = next else { return Ok(String::new()); };
        frame = child;
    }
    Ok(String::new())
}
