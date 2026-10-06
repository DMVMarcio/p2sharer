//! Room-scoped LAN rendezvous. This service never transports media or room actions.
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Emitter;
use tokio::{
    net::TcpListener,
    sync::{mpsc, Semaphore},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{
    accept_async_with_config, connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

const MAX_FRAME: usize = 128 * 1024;

/// Virtual LANs do not necessarily forward multicast DNS. Use numeric ICE host candidates.
pub fn browser_arguments(current: &str) -> String {
    const FEATURE: &str = "WebRtcHideLocalIpsWithMdns";
    if let Some(disabled) = current
        .split_whitespace()
        .find(|arg| arg.starts_with("--disable-features="))
    {
        if !disabled
            .trim_start_matches("--disable-features=")
            .split(',')
            .any(|name| name == FEATURE)
        {
            return current.replacen(disabled, &format!("{disabled},{FEATURE}"), 1);
        }
        current.to_owned()
    } else {
        format!("{current} --disable-features={FEATURE}")
            .trim_start()
            .to_owned()
    }
}
type Hub = Arc<Mutex<HashMap<u64, Subscriber>>>;
struct Subscriber {
    topics: HashSet<String>,
    sender: mpsc::Sender<Message>,
}
struct Host {
    room: String,
    endpoint: String,
    token: String,
    task: JoinHandle<()>,
}
struct Client {
    sender: mpsc::Sender<Message>,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct LanSignalingState {
    host: Mutex<Option<Host>>,
    clients: Mutex<HashMap<String, Client>>,
}

#[derive(Serialize)]
pub struct LanInterface {
    name: String,
    address: String,
}

fn interfaces() -> Vec<LanInterface> {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let mut result = Vec::new();
    for (name, network) in &networks {
        for ip in network.ip_networks() {
            if usable_ip(ip.addr) {
                result.push(LanInterface {
                    name: name.clone(),
                    address: ip.addr.to_string(),
                });
            }
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name).then(a.address.cmp(&b.address)));
    result.dedup_by(|a, b| a.address == b.address);
    result
}

fn usable_ip(ip: IpAddr) -> bool {
    !ip.is_loopback()
        && !ip.is_unspecified()
        && !ip.is_multicast()
        && match ip {
            IpAddr::V4(ip) => ip.octets()[0] != 0 && ip.octets()[0] < 224,
            IpAddr::V6(ip) => {
                (ip.segments()[0] & 0xffc0) != 0xfe80 && ip.to_ipv4_mapped().is_none()
            }
        }
}

fn endpoint_address(endpoint: &str) -> Result<SocketAddr, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "Invalid LAN endpoint")?;
    if url.scheme() != "ws"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != endpoint
    {
        return Err("Invalid LAN endpoint".into());
    }
    let ip: IpAddr = url
        .host_str()
        .ok_or("Missing LAN address")?
        .trim_matches(['[', ']'])
        .parse()
        .map_err(|_| "LAN endpoints must use an IP address")?;
    if !usable_ip(ip) {
        return Err("Invalid LAN address".into());
    }
    let port = url
        .port()
        .filter(|port| *port != 0)
        .ok_or("Missing LAN port")?;
    Ok(SocketAddr::new(ip, port))
}

fn hex_id(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn topic_valid(topic: &str) -> bool {
    !topic.is_empty() && topic.len() <= 96 && topic.bytes().all(|c| c.is_ascii_alphanumeric())
}
fn main_only(window: &tauri::Window) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can manage LAN rooms".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Frame {
    Auth { room: String, token: String },
    Subscribe { topic: String },
    Unsubscribe { topic: String },
    Publish { topic: String, data: String },
}

async fn broker_client(
    stream: tokio::net::TcpStream,
    room: String,
    token: String,
    hub: Hub,
    id: u64,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let config = WebSocketConfig {
        max_message_size: Some(MAX_FRAME),
        max_frame_size: Some(MAX_FRAME),
        ..Default::default()
    };
    let Ok(Ok(mut socket)) = timeout(
        Duration::from_secs(5),
        accept_async_with_config(stream, Some(config)),
    )
    .await
    else {
        return;
    };
    let Ok(Some(Ok(Message::Text(auth)))) = timeout(Duration::from_secs(5), socket.next()).await
    else {
        return;
    };
    if !matches!(serde_json::from_str::<Frame>(&auth), Ok(Frame::Auth { room: ref r, token: ref t }) if r == &room && t == &token)
    {
        let _ = socket.close(None).await;
        return;
    }
    if socket
        .send(Message::Text("{\"kind\":\"ready\"}".into()))
        .await
        .is_err()
    {
        return;
    }
    let (tx, mut rx) = mpsc::channel(64);
    hub.lock().unwrap().insert(
        id,
        Subscriber {
            topics: HashSet::new(),
            sender: tx,
        },
    );
    let mut rate_start = std::time::Instant::now();
    let mut rate_count = 0;
    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                let Some(message) = outgoing else { break; };
                if socket.send(message).await.is_err() { break; }
            }
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Ping(data) => { if socket.send(Message::Pong(data)).await.is_err() { break; } }
                    Message::Pong(_) => {},
                    Message::Close(_) => break,
                    Message::Text(raw) => {
                        if rate_start.elapsed() >= Duration::from_secs(1) { rate_start = std::time::Instant::now(); rate_count = 0; }
                        rate_count += 1;
                        if rate_count > 128 { break; }
                        let Ok(frame) = serde_json::from_str::<Frame>(&raw) else { break; };
                        let mut peers = hub.lock().unwrap();
                        match frame {
                            Frame::Subscribe { topic } if topic_valid(&topic) => {
                                let Some(peer) = peers.get_mut(&id) else { break; };
                                if peer.topics.len() >= 2 && !peer.topics.contains(&topic) { break; }
                                peer.topics.insert(topic);
                            }
                            Frame::Unsubscribe { topic } if topic_valid(&topic) => {
                                if let Some(peer) = peers.get_mut(&id) { peer.topics.remove(&topic); }
                            }
                            Frame::Publish { topic, data } if topic_valid(&topic) && data.len() <= MAX_FRAME / 2 => {
                                let delivery = Message::Text(serde_json::json!({ "kind": "message", "topic": topic, "data": data }).to_string());
                                // A slow consumer cannot block rendezvous for the other peers.
                                peers.retain(|peer_id, peer| *peer_id == id || !peer.topics.contains(&topic) || peer.sender.try_send(delivery.clone()).is_ok());
                            }
                            _ => break,
                        }
                    }
                    _ => break,
                }
            }
        }
    }
    hub.lock().unwrap().remove(&id);
    let _ = socket.close(None).await;
}

async fn run_broker(listener: TcpListener, room: String, token: String) {
    let hub: Hub = Arc::new(Mutex::new(HashMap::new()));
    let slots = Arc::new(Semaphore::new(32));
    let mut tasks = tokio::task::JoinSet::new();
    let mut id = 0u64;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break; };
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue; };
                id = id.wrapping_add(1);
                tasks.spawn(broker_client(stream, room.clone(), token.clone(), hub.clone(), id, permit));
            }
            _ = tasks.join_next(), if !tasks.is_empty() => {},
        }
    }
}

#[tauri::command]
pub fn list_lan_interfaces(window: tauri::Window) -> Result<Vec<LanInterface>, String> {
    main_only(&window)?;
    Ok(interfaces())
}

#[tauri::command]
pub async fn start_lan_signaling(
    window: tauri::Window,
    state: tauri::State<'_, LanSignalingState>,
    room: String,
    endpoint: String,
    token: String,
) -> Result<(), String> {
    main_only(&window)?;
    if !hex_id(&room, 32) || !hex_id(&token, 64) {
        return Err("Invalid LAN room capability".into());
    }
    let address = endpoint_address(&endpoint)?;
    if !interfaces()
        .iter()
        .any(|interface| interface.address == address.ip().to_string())
    {
        return Err("Selected LAN interface is no longer available".into());
    }
    // Bind synchronously while holding the lifecycle lock, then adopt the socket in Tokio.
    let mut host = state.host.lock().unwrap();
    if let Some(current) = host.as_ref() {
        if current.room == room && current.endpoint == endpoint && current.token == token {
            return Ok(());
        }
        return Err("Another LAN room is still hosted by this app".into());
    }
    let listener = std::net::TcpListener::bind(address)
        .map_err(|_| "Could not bind the LAN port; it may already be in use")?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let listener = TcpListener::from_std(listener).map_err(|e| e.to_string())?;
    let task = tokio::spawn(run_broker(listener, room.clone(), token.clone()));
    *host = Some(Host {
        room,
        endpoint,
        token,
        task,
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_lan_signaling(
    window: tauri::Window,
    state: tauri::State<'_, LanSignalingState>,
    room: String,
) -> Result<(), String> {
    main_only(&window)?;
    let task = {
        let mut host = state.host.lock().unwrap();
        if host.as_ref().is_some_and(|host| host.room == room) {
            host.take().map(|host| host.task)
        } else {
            None
        }
    };
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_lan_signaling(
    window: tauri::Window,
    state: tauri::State<'_, LanSignalingState>,
    id: String,
    room: String,
    endpoint: String,
    token: String,
) -> Result<(), String> {
    main_only(&window)?;
    if !hex_id(&id, 32) || !hex_id(&room, 32) || !hex_id(&token, 64) {
        return Err("Invalid LAN session".into());
    }
    endpoint_address(&endpoint)?;
    if state.clients.lock().unwrap().len() >= 4 {
        return Err("Too many LAN signaling sessions".into());
    }
    let config = WebSocketConfig {
        max_message_size: Some(MAX_FRAME),
        max_frame_size: Some(MAX_FRAME),
        ..Default::default()
    };
    let (mut socket, _) = timeout(
        Duration::from_secs(8),
        connect_async_with_config(&endpoint, Some(config), false),
    )
    .await
    .map_err(|_| "LAN host connection timed out; check the VPN and firewall")?
    .map_err(|_| "Could not connect to the LAN host; check the VPN and firewall")?;
    socket
        .send(Message::Text(
            serde_json::json!({ "kind": "auth", "room": room, "token": token }).to_string(),
        ))
        .await
        .map_err(|_| "LAN authentication failed")?;
    let ready = timeout(Duration::from_secs(5), socket.next())
        .await
        .map_err(|_| "LAN authentication timed out")?;
    if !matches!(ready, Some(Ok(Message::Text(ref raw))) if raw == "{\"kind\":\"ready\"}") {
        return Err("LAN authentication failed".into());
    }
    let (sender, mut receiver) = mpsc::channel::<Message>(64);
    let event = format!("lan-signaling-{id}");
    let mut clients = state.clients.lock().unwrap();
    if clients.contains_key(&id) {
        return Err("LAN session is already connected".into());
    }
    let task = tokio::spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_secs(15));
        loop {
            tokio::select! {
                _ = ping.tick() => { if socket.send(Message::Ping(Vec::new())).await.is_err() { break; } }
                outgoing = receiver.recv() => {
                    let Some(message) = outgoing else { break; };
                    if socket.send(message).await.is_err() { break; }
                }
                incoming = socket.next() => {
                    match incoming {
                        Some(Ok(Message::Text(raw))) if raw.len() <= MAX_FRAME => {
                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                                if value.get("kind").and_then(|v| v.as_str()) == Some("message") { let _ = window.emit(&event, value); }
                            }
                        }
                        Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break; } }
                        Some(Ok(Message::Pong(_))) => {},
                        _ => break,
                    }
                }
            }
        }
        let _ = window.emit(&event, serde_json::json!({ "kind": "closed" }));
        let _ = socket.close(None).await;
    });
    clients.insert(id, Client { sender, task });
    Ok(())
}

#[tauri::command]
pub fn send_lan_signaling(
    window: tauri::Window,
    state: tauri::State<'_, LanSignalingState>,
    id: String,
    data: String,
) -> Result<(), String> {
    main_only(&window)?;
    if data.len() > MAX_FRAME
        || !matches!(
            serde_json::from_str::<Frame>(&data),
            Ok(Frame::Subscribe { .. } | Frame::Unsubscribe { .. } | Frame::Publish { .. })
        )
    {
        return Err("Invalid LAN signal".into());
    }
    let clients = state.clients.lock().unwrap();
    let client = clients.get(&id).ok_or("LAN session is disconnected")?;
    client
        .sender
        .try_send(Message::Text(data))
        .map_err(|_| "LAN signaling queue is unavailable".into())
}

#[tauri::command]
pub fn disconnect_lan_signaling(
    window: tauri::Window,
    state: tauri::State<'_, LanSignalingState>,
    id: String,
) -> Result<(), String> {
    main_only(&window)?;
    if let Some(client) = state.clients.lock().unwrap().remove(&id) {
        client.task.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::connect_async;

    #[test]
    fn numeric_host_candidates_preserve_existing_browser_feature_flags() {
        let input =
            "--enable-zero-copy --disable-features=ExistingFeature --remote-debugging-port=0";
        let output = browser_arguments(input);
        assert!(output.contains("--disable-features=ExistingFeature,WebRtcHideLocalIpsWithMdns"));
        assert!(output.contains("--enable-zero-copy"));
        assert!(output.contains("--remote-debugging-port=0"));
        assert_eq!(browser_arguments(&output), output);
    }

    #[tokio::test]
    async fn authenticated_broker_routes_only_subscribed_signals_and_rejects_wrong_capabilities() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        exercise_broker(listener).await;
    }

    #[tokio::test]
    #[ignore = "Requires a running Radmin VPN adapter; checks local adapter binding and signaling, not a remote peer"]
    async fn radmin_adapter_hosts_authenticated_signaling() {
        let adapter = interfaces()
            .into_iter()
            .find(|interface| {
                interface.name.to_ascii_lowercase().contains("radmin")
                    && !interface.address.contains(':')
            })
            .expect("Start Radmin VPN before running this explicit network check");
        let ip: IpAddr = adapter.address.parse().unwrap();
        let listener = TcpListener::bind(SocketAddr::new(ip, 0))
            .await
            .expect("Could not bind the Radmin adapter");
        exercise_broker(listener).await;
    }

    async fn exercise_broker(listener: TcpListener) {
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let room = "a".repeat(32);
        let token = "b".repeat(64);
        let task = tokio::spawn(run_broker(listener, room.clone(), token.clone()));
        let (mut rejected, _) = connect_async(&endpoint).await.unwrap();
        rejected
            .send(Message::Text(
                serde_json::json!({ "kind": "auth", "room": room, "token": "invalid" }).to_string(),
            ))
            .await
            .unwrap();
        assert!(matches!(
            rejected.next().await,
            Some(Ok(Message::Close(_))) | None
        ));
        let (mut a, _) = connect_async(&endpoint).await.unwrap();
        let (mut b, _) = connect_async(&endpoint).await.unwrap();
        for client in [&mut a, &mut b] {
            client
                .send(Message::Text(
                    serde_json::json!({ "kind": "auth", "room": room, "token": token }).to_string(),
                ))
                .await
                .unwrap();
            assert_eq!(
                client.next().await.unwrap().unwrap().into_text().unwrap(),
                "{\"kind\":\"ready\"}"
            );
        }
        a.send(Message::Text(
            "{\"kind\":\"subscribe\",\"topic\":\"shared\"}".into(),
        ))
        .await
        .unwrap();
        // A message sent back on the same socket is a barrier for subscription processing.
        a.send(Message::Ping(vec![1])).await.unwrap();
        assert!(matches!(a.next().await, Some(Ok(Message::Pong(_)))));
        b.send(Message::Text(
            "{\"kind\":\"publish\",\"topic\":\"shared\",\"data\":\"encrypted-offer\"}".into(),
        ))
        .await
        .unwrap();
        let message = timeout(Duration::from_secs(2), a.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        let message: serde_json::Value = serde_json::from_str(&message).unwrap();
        assert_eq!(message["topic"], "shared");
        assert_eq!(message["data"], "encrypted-offer");
        assert!(timeout(Duration::from_millis(50), b.next()).await.is_err());
        task.abort();
        task.await.unwrap_err();
        assert!(timeout(Duration::from_secs(2), a.next())
            .await
            .unwrap()
            .is_some());
    }

    #[test]
    fn network_endpoints_require_numeric_unicast_addresses() {
        assert!(endpoint_address("ws://192.0.2.1:49154/").is_ok());
        assert!(endpoint_address("ws://[2001:db8::1]:49154/").is_ok());
        let mapped_loopback = std::net::Ipv4Addr::LOCALHOST.to_ipv6_mapped();
        assert!(endpoint_address(&format!("ws://[{mapped_loopback}]:49154/")).is_err());
        for endpoint in [
            "ws://localhost:49154/",
            "ws://127.0.0.1:49154/",
            "ws://0.0.0.0:49154/",
            "ws://[::1]:49154/",
            "ws://192.0.2.1:49154/?token=secret",
        ] {
            assert!(endpoint_address(endpoint).is_err());
        }
    }
}
