//! Bounded binary IPC shared by proxy sockets and virtual IP packets.
use std::{collections::HashMap, sync::Mutex};
use serde_json::{json, Value};
use tauri::{ipc::{Channel, InvokeBody, Request, Response}, Manager, State};

#[derive(Default)]
pub struct PayloadState(Mutex<HashMap<String, Channel<Response>>>);
fn valid_scope(scope: &str) -> bool {
    (scope.len() == 32 || scope.len() == 36) && scope.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}
pub fn encode(header: &Value, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let metadata = serde_json::to_vec(header).map_err(|e| e.to_string())?;
    if metadata.len() > 2048 || bytes.len() > 65507 { return Err("Peer payload exceeds limit".into()); }
    let mut frame = Vec::with_capacity(2 + metadata.len() + bytes.len());
    frame.extend_from_slice(&(metadata.len() as u16).to_be_bytes()); frame.extend(metadata); frame.extend_from_slice(bytes);
    Ok(frame)
}
fn decode(frame: &[u8]) -> Result<(Value, &[u8]), String> {
    if frame.len() < 2 || frame.len() > 67557 { return Err("Invalid peer payload".into()); }
    let length = u16::from_be_bytes([frame[0], frame[1]]) as usize;
    if length == 0 || length > 2048 || 2 + length > frame.len() { return Err("Invalid peer header".into()); }
    let header: Value = serde_json::from_slice(&frame[2..2+length]).map_err(|_| "Invalid peer header")?;
    if !header.is_object() { return Err("Invalid peer header".into()); }
    Ok((header, &frame[2+length..]))
}
pub fn emit(app: &tauri::AppHandle, scope: &str, header: Value, bytes: &[u8]) -> Option<Result<(), String>> {
    let state = app.state::<PayloadState>();
    let channel = state.0.lock().unwrap().get(scope).cloned()?;
    Some(encode(&header, bytes).and_then(|frame| channel.send(Response::new(frame)).map_err(|e| e.to_string())))
}
#[tauri::command]
pub fn subscribe_tunnel_payloads(window: tauri::Window, state: State<'_, PayloadState>, scope: String, channel: Channel<Response>) -> Result<(), String> {
    if window.label() != "main" || !valid_scope(&scope) { return Err("Invalid tunnel subscriber".into()); }
    let mut channels = state.0.lock().unwrap();
    if channels.len() >= 24 && !channels.contains_key(&scope) { return Err("Tunnel subscriber limit reached".into()); }
    channels.insert(scope, channel); Ok(())
}
#[tauri::command]
pub fn unsubscribe_tunnel_payloads(window: tauri::Window, state: State<'_, PayloadState>, scope: String) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window can operate tunnels".into()); }
    state.0.lock().unwrap().remove(&scope); Ok(())
}
#[tauri::command]
pub async fn receive_tunnel_payload(window: tauri::Window, request: Request<'_>) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window can operate tunnels".into()); }
    let InvokeBody::Raw(frame) = request.body() else { return Err("Binary tunnel payload required".into()); };
    let (header, bytes) = decode(frame)?;
    let scope = header["scope"].as_str().filter(|s| valid_scope(s)).ok_or("Invalid tunnel scope")?.to_owned();
    let peer = header["peer"].as_str().filter(|s| !s.is_empty() && s.len() <= 100).ok_or("Invalid tunnel peer")?.to_owned();
    match header["type"].as_str() {
        Some("virtual-packet") => crate::virtual_network::receive_bytes(&window.state::<crate::virtual_network::VirtualNetworkState>(), scope, peer, bytes.to_vec()),
        Some("wire") => {
            let mut packet = header["packet"].clone();
            // The legacy command retains Base64 serialization; the hot path never encodes it.
            let data = packet.get_mut("data");
            if data.is_some() { return Err("Unexpected tunnel data header".into()); }
            let packet = if packet["kind"] == "data" || packet["kind"] == "datagram" {
                let session = packet["session"].as_str().ok_or("Invalid session")?.into();
                let sequence = packet["sequence"].as_u64().filter(|n| *n <= u32::MAX as u64).ok_or("Invalid sequence")? as u32;
                if packet["kind"] == "datagram" { crate::port_tunnel::Packet::Datagram { session, sequence, data: bytes.to_vec() } }
                else { crate::port_tunnel::Packet::Data { session, sequence, data: bytes.to_vec() } }
            } else {
                if !bytes.is_empty() { return Err("Unexpected control bytes".into()); }
                serde_json::from_value(packet).map_err(|_| "Invalid tunnel control")?
            };
            window.state::<crate::port_tunnel::TunnelState>().receive_binary(window.app_handle().clone(), scope, peer, packet).await
        }
        _ => Err("Invalid tunnel payload type".into()),
    }
}

pub fn virtual_header(scope: &str, peer: &str, sequence: u64) -> Value {
    json!({ "type": "virtual-packet", "scope": scope, "peer": peer, "sequence": sequence })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_frames_preserve_bytes_and_reject_unbounded_headers() {
        let header = json!({"type":"wire","scope":"test"});
        let frame = encode(&header, &[0, 255, 1]).unwrap();
        let (decoded, bytes) = decode(&frame).unwrap();
        assert_eq!(decoded, header); assert_eq!(bytes, &[0,255,1]);
        for bytes in [&[][..], &[0][..], &[8,0,1][..], &[0,2,b'[',b']'][..]] { assert!(decode(bytes).is_err()); }
        assert!(encode(&json!({"large":"x".repeat(2048)}), &[]).is_err());
        assert!(encode(&header, &vec![0;65508]).is_err());
    }
}
