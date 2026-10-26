//! Direct Rust-to-Rust WebRTC data channels for low-latency port tunnels and virtual network packets.
use bytes::{Bytes, BytesMut, BufMut};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine,
        setting_engine::SettingEngine, APIBuilder,
    },
    data_channel::{
        data_channel_init::RTCDataChannelInit, data_channel_message::DataChannelMessage,
        RTCDataChannel,
    },
    ice::network_type::NetworkType,
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    interceptor::registry::Registry,
    peer_connection::{
        configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState,
        policy::ice_transport_policy::RTCIceTransportPolicy,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
};

const TAG_VIRTUAL_PACKET: u8 = 0x01;
const TAG_TUNNEL_DATA: u8 = 0x02;
const TAG_TUNNEL_DATAGRAM: u8 = 0x03;
const TAG_TUNNEL_CONTROL: u8 = 0x04;
const MAX_LINKS: usize = 64;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSignal {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<RTCIceCandidateInit>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalEvent {
    scope: String,
    peer: String,
    signal: TunnelSignal,
}

struct PeerLink {
    id: String,
    pc: Arc<RTCPeerConnection>,
    reliable_open: Arc<AtomicBool>,
    datagram_open: Arc<AtomicBool>,
    tx_reliable: mpsc::Sender<Bytes>,
    tx_datagram: mpsc::Sender<Bytes>,
    remote_ready: AtomicBool,
    pending_candidates: Mutex<Vec<RTCIceCandidateInit>>,
    offer_sdp: Mutex<Option<String>>,
}

static LINKS: LazyLock<Mutex<HashMap<(String, String), Arc<PeerLink>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn valid_scope(scope: &str) -> bool {
    (scope.len() == 32 || scope.len() == 36)
        && scope.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn valid_peer(peer: &str) -> bool {
    !peer.is_empty() && peer.len() <= 100
}

fn valid_route_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn random_route_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn candidate_available(ip: std::net::IpAddr) -> bool {
    !ip.is_unspecified() && !ip.is_multicast() && std::net::UdpSocket::bind((ip, 0)).is_ok()
}

pub fn encode_virtual_frame(bytes: &[u8]) -> Bytes {
    let mut buf = BytesMut::with_capacity(1 + bytes.len());
    buf.put_u8(TAG_VIRTUAL_PACKET);
    buf.extend_from_slice(bytes);
    buf.freeze()
}

pub fn encode_tunnel_packet(packet: &crate::port_tunnel::Packet) -> Result<(bool, Bytes), String> {
    match packet {
        crate::port_tunnel::Packet::Data {
            session,
            sequence,
            data,
        } => {
            if session.len() > 64 {
                return Err("Invalid session ID".into());
            }
            let mut buf = BytesMut::with_capacity(6 + session.len() + data.len());
            buf.put_u8(TAG_TUNNEL_DATA);
            buf.put_u8(session.len() as u8);
            buf.extend_from_slice(session.as_bytes());
            buf.put_u32(*sequence);
            buf.extend_from_slice(data);
            Ok((false, buf.freeze()))
        }
        crate::port_tunnel::Packet::Datagram {
            session,
            sequence,
            data,
        } => {
            if session.len() > 64 {
                return Err("Invalid session ID".into());
            }
            let mut buf = BytesMut::with_capacity(6 + session.len() + data.len());
            buf.put_u8(TAG_TUNNEL_DATAGRAM);
            buf.put_u8(session.len() as u8);
            buf.extend_from_slice(session.as_bytes());
            buf.put_u32(*sequence);
            buf.extend_from_slice(data);
            Ok((true, buf.freeze()))
        }
        control => {
            let json = serde_json::to_vec(control).map_err(|e| e.to_string())?;
            let mut buf = BytesMut::with_capacity(1 + json.len());
            buf.put_u8(TAG_TUNNEL_CONTROL);
            buf.extend_from_slice(&json);
            Ok((false, buf.freeze()))
        }
    }
}

pub fn decode_tunnel_packet(frame: &[u8]) -> Result<crate::port_tunnel::Packet, String> {
    let Some(&tag) = frame.first() else {
        return Err("Empty tunnel frame".into());
    };
    match tag {
        TAG_TUNNEL_DATA | TAG_TUNNEL_DATAGRAM => {
            if frame.len() < 6 {
                return Err("Truncated tunnel data frame".into());
            }
            let session_len = frame[1] as usize;
            if session_len == 0 || session_len > 64 || frame.len() < 6 + session_len {
                return Err("Invalid tunnel session header".into());
            }
            let session = std::str::from_utf8(&frame[2..2 + session_len])
                .map_err(|_| "Invalid tunnel session UTF-8")?
                .to_owned();
            let seq_offset = 2 + session_len;
            let sequence = u32::from_be_bytes([
                frame[seq_offset],
                frame[seq_offset + 1],
                frame[seq_offset + 2],
                frame[seq_offset + 3],
            ]);
            let data = frame[seq_offset + 4..].to_vec();
            if tag == TAG_TUNNEL_DATAGRAM {
                Ok(crate::port_tunnel::Packet::Datagram {
                    session,
                    sequence,
                    data,
                })
            } else {
                Ok(crate::port_tunnel::Packet::Data {
                    session,
                    sequence,
                    data,
                })
            }
        }
        TAG_TUNNEL_CONTROL => {
            if frame.len() > 4096 {
                return Err("Tunnel control frame too large".into());
            }
            serde_json::from_slice(&frame[1..]).map_err(|_| "Invalid tunnel control JSON".into())
        }
        _ => Err("Unknown tunnel frame tag".into()),
    }
}

pub fn try_send_virtual(scope: &str, peer: &str, bytes: &[u8]) -> bool {
    let link = {
        let links = LINKS.lock().unwrap();
        links.get(&(scope.to_owned(), peer.to_owned())).cloned()
    };
    let Some(link) = link else {
        return false;
    };
    if !link.datagram_open.load(Ordering::Acquire) {
        return false;
    }
    let _ = link.tx_datagram.try_send(encode_virtual_frame(bytes));
    true
}

pub fn try_send_port_tunnel(
    scope: &str,
    peer: &str,
    packet: &crate::port_tunnel::Packet,
) -> bool {
    let link = {
        let links = LINKS.lock().unwrap();
        links.get(&(scope.to_owned(), peer.to_owned())).cloned()
    };
    let Some(link) = link else {
        return false;
    };
    if !link.reliable_open.load(Ordering::Acquire) {
        return false;
    }
    let Ok((is_datagram, frame)) = encode_tunnel_packet(packet) else {
        return false;
    };
    if is_datagram {
        if !link.datagram_open.load(Ordering::Acquire) {
            return false;
        }
        let _ = link.tx_datagram.try_send(frame);
        true
    } else {
        link.tx_reliable.try_send(frame).is_ok()
    }
}

pub fn retain_peers(scope: &str, peers: &HashSet<String>) {
    let removed: Vec<Arc<PeerLink>> = {
        let mut links = LINKS.lock().unwrap();
        let keys: Vec<(String, String)> = links
            .keys()
            .filter(|(s, p)| s == scope && !peers.contains(p))
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|k| links.remove(&k))
            .collect()
    };
    for link in removed {
        close_link(link);
    }
}

pub fn stop_scope(scope: &str) {
    let removed: Vec<Arc<PeerLink>> = {
        let mut links = LINKS.lock().unwrap();
        let keys: Vec<(String, String)> = links
            .keys()
            .filter(|(s, _)| s == scope)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|k| links.remove(&k))
            .collect()
    };
    for link in removed {
        close_link(link);
    }
}

fn close_link(link: Arc<PeerLink>) {
    link.reliable_open.store(false, Ordering::Release);
    link.datagram_open.store(false, Ordering::Release);
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let _ = link.pc.close().await;
        });
    }
}

async fn create_peer_link(
    app: Option<tauri::AppHandle>,
    scope: String,
    peer: String,
    id: String,
    ice_servers: Vec<IceServer>,
    relay_only: bool,
) -> Result<Arc<PeerLink>, String> {
    let mut engine = MediaEngine::default();
    let registry =
        register_default_interceptors(Registry::new(), &mut engine).map_err(|e| e.to_string())?;
    let mut setting = SettingEngine::default();
    setting.set_network_types(vec![NetworkType::Udp4, NetworkType::Tcp4]);
    setting.set_ip_filter(Box::new(candidate_available));
    setting.set_ice_timeouts(
        Some(Duration::from_secs(3)),
        Some(Duration::from_secs(8)),
        Some(Duration::from_secs(2)),
    );
    let api = APIBuilder::new()
        .with_media_engine(engine)
        .with_interceptor_registry(registry)
        .with_setting_engine(setting)
        .build();
    let servers = ice_servers
        .into_iter()
        .map(|s| RTCIceServer {
            urls: s.urls,
            username: s.username,
            credential: s.credential,
        })
        .collect();
    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers: servers,
            ice_transport_policy: if relay_only {
                RTCIceTransportPolicy::Relay
            } else {
                RTCIceTransportPolicy::All
            },
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?,
    );

    let reliable = pc
        .create_data_channel(
            "tunnel-reliable",
            Some(RTCDataChannelInit {
                ordered: Some(true),
                negotiated: Some(1),
                ..Default::default()
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    let datagram = pc
        .create_data_channel(
            "tunnel-datagram",
            Some(RTCDataChannelInit {
                ordered: Some(false),
                max_retransmits: Some(0),
                negotiated: Some(2),
                ..Default::default()
            }),
        )
        .await
        .map_err(|e| e.to_string())?;

    let reliable_open = Arc::new(AtomicBool::new(false));
    let datagram_open = Arc::new(AtomicBool::new(false));
    let (tx_reliable, mut rx_reliable) = mpsc::channel::<Bytes>(2048);
    let (tx_datagram, mut rx_datagram) = mpsc::channel::<Bytes>(4096);

    let link = Arc::new(PeerLink {
        id: id.clone(),
        pc: pc.clone(),
        reliable_open: reliable_open.clone(),
        datagram_open: datagram_open.clone(),
        tx_reliable,
        tx_datagram,
        remote_ready: AtomicBool::new(false),
        pending_candidates: Mutex::new(Vec::new()),
        offer_sdp: Mutex::new(None),
    });

    // Outgoing writer tasks
    let rel_dc = reliable.clone();
    let rel_flag = reliable_open.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx_reliable.recv().await {
            if !rel_flag.load(Ordering::Acquire) {
                continue;
            }
            if rel_dc.send(&frame).await.is_err() {
                rel_flag.store(false, Ordering::Release);
                break;
            }
        }
    });

    let dgram_dc = datagram.clone();
    let dgram_flag = datagram_open.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx_datagram.recv().await {
            if !dgram_flag.load(Ordering::Acquire) {
                continue;
            }
            if dgram_dc.send(&frame).await.is_err() {
                dgram_flag.store(false, Ordering::Release);
                break;
            }
        }
    });

    setup_channel_handlers(
        app.clone(),
        scope.clone(),
        peer.clone(),
        reliable,
        reliable_open.clone(),
        false,
    );
    setup_channel_handlers(
        app.clone(),
        scope.clone(),
        peer.clone(),
        datagram,
        datagram_open.clone(),
        true,
    );

    if let Some(app_handle) = app.clone() {
        let ice_scope = scope.clone();
        let ice_peer = peer.clone();
        let ice_id = id.clone();
        pc.on_ice_candidate(Box::new(move |candidate| {
            let app = app_handle.clone();
            let scope = ice_scope.clone();
            let peer = ice_peer.clone();
            let id = ice_id.clone();
            Box::pin(async move {
                if let Some(candidate) = candidate {
                    if let Ok(mut init) = candidate.to_json() {
                        init.sdp_mid = Some("0".into());
                        let _ = app.emit_to(
                            "main",
                            "native-tunnel-event",
                            SignalEvent {
                                scope,
                                peer,
                                signal: TunnelSignal {
                                    id,
                                    kind: "ice".into(),
                                    sdp: None,
                                    candidate: Some(init),
                                },
                            },
                        );
                    }
                }
            })
        }));
    }

    let state_scope = scope;
    let state_peer = peer;
    let state_id = id;
    let rel_flag = reliable_open;
    let dgram_flag = datagram_open;
    pc.on_peer_connection_state_change(Box::new(move |state| {
        let scope = state_scope.clone();
        let peer = state_peer.clone();
        let id = state_id.clone();
        let rel_flag = rel_flag.clone();
        let dgram_flag = dgram_flag.clone();
        Box::pin(async move {
            if matches!(
                state,
                RTCPeerConnectionState::Failed
                    | RTCPeerConnectionState::Closed
                    | RTCPeerConnectionState::Disconnected
            ) {
                rel_flag.store(false, Ordering::Release);
                dgram_flag.store(false, Ordering::Release);
                if matches!(
                    state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    let mut links = LINKS.lock().unwrap();
                    if links
                        .get(&(scope.clone(), peer.clone()))
                        .is_some_and(|l| l.id == id)
                    {
                        links.remove(&(scope, peer));
                    }
                }
            }
        })
    }));

    Ok(link)
}

fn setup_channel_handlers(
    app: Option<tauri::AppHandle>,
    scope: String,
    peer: String,
    dc: Arc<RTCDataChannel>,
    open_flag: Arc<AtomicBool>,
    is_datagram_channel: bool,
) {
    let open_set = open_flag.clone();
    dc.on_open(Box::new(move || {
        open_set.store(true, Ordering::Release);
        Box::pin(async {})
    }));
    let open_clear = open_flag;
    dc.on_close(Box::new(move || {
        open_clear.store(false, Ordering::Release);
        Box::pin(async {})
    }));

    let Some(app) = app else {
        return;
    };

    if is_datagram_channel {
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let app = app.clone();
            let scope = scope.clone();
            let peer = peer.clone();
            Box::pin(async move {
                let data = &msg.data;
                let Some(&tag) = data.first() else {
                    return;
                };
                if tag == TAG_VIRTUAL_PACKET {
                    let vnet = app.state::<crate::virtual_network::VirtualNetworkState>();
                    let _ = crate::virtual_network::receive_bytes(
                        &vnet,
                        scope,
                        peer,
                        data[1..].to_vec(),
                    );
                } else if tag == TAG_TUNNEL_DATAGRAM {
                    if let Ok(packet) = decode_tunnel_packet(data) {
                        let tunnels = app.state::<crate::port_tunnel::TunnelState>();
                        let _ = tunnels
                            .receive_binary(app.clone(), scope, peer, packet)
                            .await;
                    }
                }
            })
        }));
    } else {
        let (tx, mut rx) = mpsc::channel::<crate::port_tunnel::Packet>(4096);
        let worker_app = app.clone();
        let worker_scope = scope.clone();
        let worker_peer = peer.clone();
        tokio::spawn(async move {
            while let Some(packet) = rx.recv().await {
                let tunnels = worker_app.state::<crate::port_tunnel::TunnelState>();
                let _ = tunnels
                    .receive_binary(
                        worker_app.clone(),
                        worker_scope.clone(),
                        worker_peer.clone(),
                        packet,
                    )
                    .await;
            }
        });
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let tx = tx.clone();
            Box::pin(async move {
                if let Ok(packet) = decode_tunnel_packet(&msg.data) {
                    let _ = tx.send(packet).await;
                }
            })
        }));
    }
}

#[tauri::command]
pub async fn connect_native_tunnel_peer(
    window: tauri::Window,
    app: tauri::AppHandle,
    scope: String,
    peer: String,
    ice_servers: Vec<IceServer>,
    relay_only: bool,
) -> Result<Option<TunnelSignal>, String> {
    if window.label() != "main" {
        return Err("Only the main window can operate tunnels".into());
    }
    if !valid_scope(&scope) || !valid_peer(&peer) || ice_servers.len() > 8 {
        return Err("Invalid native tunnel peer parameters".into());
    }
    let existing = {
        let links = LINKS.lock().unwrap();
        links.get(&(scope.clone(), peer.clone())).cloned()
    };
    if let Some(link) = existing {
        if link.reliable_open.load(Ordering::Acquire) && link.datagram_open.load(Ordering::Acquire)
        {
            return Ok(None);
        }
        if let Some(sdp) = link.offer_sdp.lock().unwrap().clone() {
            return Ok(Some(TunnelSignal {
                id: link.id.clone(),
                kind: "offer".into(),
                sdp: Some(sdp),
                candidate: None,
            }));
        }
    }

    let id = random_route_id()?;
    let link = create_peer_link(
        Some(app),
        scope.clone(),
        peer.clone(),
        id.clone(),
        ice_servers,
        relay_only,
    )
    .await?;
    let offer = link.pc.create_offer(None).await.map_err(|e| e.to_string())?;
    let sdp = offer.sdp.clone();
    link.pc
        .set_local_description(offer)
        .await
        .map_err(|e| e.to_string())?;
    *link.offer_sdp.lock().unwrap() = Some(sdp.clone());

    let previous = {
        let mut links = LINKS.lock().unwrap();
        if links.len() >= MAX_LINKS && !links.contains_key(&(scope.clone(), peer.clone())) {
            close_link(link);
            return Err("Native tunnel peer limit reached".into());
        }
        links.insert((scope, peer), link)
    };
    if let Some(old) = previous {
        close_link(old);
    }

    Ok(Some(TunnelSignal {
        id,
        kind: "offer".into(),
        sdp: Some(sdp),
        candidate: None,
    }))
}

#[tauri::command]
pub async fn signal_native_tunnel_peer(
    window: tauri::Window,
    app: tauri::AppHandle,
    scope: String,
    peer: String,
    signal: TunnelSignal,
    ice_servers: Vec<IceServer>,
    relay_only: bool,
) -> Result<Option<TunnelSignal>, String> {
    if window.label() != "main" {
        return Err("Only the main window can operate tunnels".into());
    }
    if !valid_scope(&scope)
        || !valid_peer(&peer)
        || !valid_route_id(&signal.id)
        || ice_servers.len() > 8
    {
        return Err("Invalid native tunnel signal".into());
    }

    match signal.kind.as_str() {
        "offer" => {
            let sdp = signal
                .sdp
                .filter(|s| !s.is_empty() && s.len() <= 128 * 1024)
                .ok_or("Invalid tunnel offer SDP")?;
            let link = create_peer_link(
                Some(app),
                scope.clone(),
                peer.clone(),
                signal.id.clone(),
                ice_servers,
                relay_only,
            )
            .await?;
            let desc = RTCSessionDescription::offer(sdp).map_err(|e| e.to_string())?;
            link.pc
                .set_remote_description(desc)
                .await
                .map_err(|e| e.to_string())?;
            link.remote_ready.store(true, Ordering::Release);
            let answer = link
                .pc
                .create_answer(None)
                .await
                .map_err(|e| e.to_string())?;
            let answer_sdp = answer.sdp.clone();
            link.pc
                .set_local_description(answer)
                .await
                .map_err(|e| e.to_string())?;

            let previous = {
                let mut links = LINKS.lock().unwrap();
                if links.len() >= MAX_LINKS && !links.contains_key(&(scope.clone(), peer.clone())) {
                    close_link(link);
                    return Err("Native tunnel peer limit reached".into());
                }
                links.insert((scope, peer), link)
            };
            if let Some(old) = previous {
                close_link(old);
            }
            Ok(Some(TunnelSignal {
                id: signal.id,
                kind: "answer".into(),
                sdp: Some(answer_sdp),
                candidate: None,
            }))
        }
        "answer" => {
            let sdp = signal
                .sdp
                .filter(|s| !s.is_empty() && s.len() <= 128 * 1024)
                .ok_or("Invalid tunnel answer SDP")?;
            let link = {
                let links = LINKS.lock().unwrap();
                links
                    .get(&(scope, peer))
                    .filter(|l| l.id == signal.id)
                    .cloned()
            };
            let Some(link) = link else {
                return Ok(None);
            };
            if link.remote_ready.load(Ordering::Acquire) {
                return Ok(None);
            }
            let desc = RTCSessionDescription::answer(sdp).map_err(|e| e.to_string())?;
            link.pc
                .set_remote_description(desc)
                .await
                .map_err(|e| e.to_string())?;
            link.remote_ready.store(true, Ordering::Release);
            let pending: Vec<RTCIceCandidateInit> =
                link.pending_candidates.lock().unwrap().drain(..).collect();
            for candidate in pending {
                let _ = link.pc.add_ice_candidate(candidate).await;
            }
            Ok(None)
        }
        "ice" => {
            let Some(candidate) = signal
                .candidate
                .filter(|c| !c.candidate.is_empty() && c.candidate.len() <= 4096)
            else {
                return Ok(None);
            };
            let link = {
                let links = LINKS.lock().unwrap();
                links
                    .get(&(scope, peer))
                    .filter(|l| l.id == signal.id)
                    .cloned()
            };
            let Some(link) = link else {
                return Ok(None);
            };
            if link.remote_ready.load(Ordering::Acquire) {
                let _ = link.pc.add_ice_candidate(candidate).await;
            } else {
                let mut queue = link.pending_candidates.lock().unwrap();
                if queue.len() < 64 {
                    queue.push(candidate);
                }
            }
            Ok(None)
        }
        _ => Err("Unknown native tunnel signal kind".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_tunnel_frames_roundtrip_data_datagram_and_control() {
        let session = "11111111111111111111111111111111".to_owned();
        let data_pkt = crate::port_tunnel::Packet::Data {
            session: session.clone(),
            sequence: 42,
            data: vec![1, 2, 3, 255],
        };
        let (is_dgram, encoded) = encode_tunnel_packet(&data_pkt).unwrap();
        assert!(!is_dgram);
        match decode_tunnel_packet(&encoded).unwrap() {
            crate::port_tunnel::Packet::Data {
                session: s,
                sequence,
                data,
            } => {
                assert_eq!(s, session);
                assert_eq!(sequence, 42);
                assert_eq!(data, vec![1, 2, 3, 255]);
            }
            _ => panic!("Expected Data packet"),
        }

        let dgram_pkt = crate::port_tunnel::Packet::Datagram {
            session: session.clone(),
            sequence: 99,
            data: vec![9, 8, 7],
        };
        let (is_dgram, encoded) = encode_tunnel_packet(&dgram_pkt).unwrap();
        assert!(is_dgram);
        match decode_tunnel_packet(&encoded).unwrap() {
            crate::port_tunnel::Packet::Datagram {
                session: s,
                sequence,
                data,
            } => {
                assert_eq!(s, session);
                assert_eq!(sequence, 99);
                assert_eq!(data, vec![9, 8, 7]);
            }
            _ => panic!("Expected Datagram packet"),
        }

        let ack_pkt = crate::port_tunnel::Packet::Ack {
            session: session.clone(),
            sequence: 10,
        };
        let (is_dgram, encoded) = encode_tunnel_packet(&ack_pkt).unwrap();
        assert!(!is_dgram);
        match decode_tunnel_packet(&encoded).unwrap() {
            crate::port_tunnel::Packet::Ack {
                session: s,
                sequence,
            } => {
                assert_eq!(s, session);
                assert_eq!(sequence, 10);
            }
            _ => panic!("Expected Ack packet"),
        }
    }

    #[tokio::test]
    async fn direct_rust_webrtc_channels_open_and_route_packets() {
        let scope = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
        let route_id = "route_test_1".to_owned();
        let link_a = create_peer_link(
            None,
            scope.clone(),
            "peer-b".to_owned(),
            route_id.clone(),
            vec![],
            false,
        )
        .await
        .unwrap();
        let link_b = create_peer_link(
            None,
            scope.clone(),
            "peer-a".to_owned(),
            route_id.clone(),
            vec![],
            false,
        )
        .await
        .unwrap();

        let mut gather_a = link_a.pc.gathering_complete_promise().await;
        let offer = link_a.pc.create_offer(None).await.unwrap();
        link_a
            .pc
            .set_local_description(offer)
            .await
            .unwrap();
        let _ = gather_a.recv().await;
        let offer_full = link_a.pc.local_description().await.unwrap();

        let mut gather_b = link_b.pc.gathering_complete_promise().await;
        link_b
            .pc
            .set_remote_description(offer_full)
            .await
            .unwrap();
        let answer = link_b.pc.create_answer(None).await.unwrap();
        link_b
            .pc
            .set_local_description(answer)
            .await
            .unwrap();
        let _ = gather_b.recv().await;
        let answer_full = link_b.pc.local_description().await.unwrap();
        link_a
            .pc
            .set_remote_description(answer_full)
            .await
            .unwrap();

        for _ in 0..100 {
            if link_a.reliable_open.load(Ordering::Acquire)
                && link_a.datagram_open.load(Ordering::Acquire)
                && link_b.reliable_open.load(Ordering::Acquire)
                && link_b.datagram_open.load(Ordering::Acquire)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(link_a.reliable_open.load(Ordering::Acquire));
        assert!(link_a.datagram_open.load(Ordering::Acquire));
        assert!(link_b.reliable_open.load(Ordering::Acquire));
        assert!(link_b.datagram_open.load(Ordering::Acquire));

        LINKS
            .lock()
            .unwrap()
            .insert((scope.clone(), "peer-b".to_owned()), link_a.clone());
        assert!(try_send_virtual(&scope, "peer-b", &[0x45, 0x00, 0x00, 0x14]));
        assert!(try_send_port_tunnel(
            &scope,
            "peer-b",
            &crate::port_tunnel::Packet::Ack {
                session: "11111111111111111111111111111111".to_owned(),
                sequence: 1,
            },
        ));
        stop_scope(&scope);
        let _ = link_b.pc.close().await;
    }
}
