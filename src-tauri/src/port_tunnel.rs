//! Explicitly enabled, loopback-only port forwarding over authenticated room actions.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, net::SocketAddr, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::{Emitter, Manager, State};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream, UdpSocket}, sync::{mpsc, watch}};

const MAX_SESSIONS: usize = 32;
const MAX_DATAGRAM: usize = 65_507;
const TCP_CHUNK: usize = 16 * 1024;
type Sink = Arc<dyn Fn(Event) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Export { pub id: String, pub name: String, pub port: u16, pub protocol: String, pub generation: String }

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Packet {
    Open { session: String, tunnel: String, generation: String, protocol: String },
    Ready { session: String },
    Data { session: String, sequence: u32, #[serde(with = "base64_bytes")] data: Vec<u8> },
    Datagram { session: String, sequence: u32, #[serde(with = "base64_bytes")] data: Vec<u8> },
    Ack { session: String, sequence: u32 },
    End { session: String },
    Close { session: String },
}
impl Packet {
    fn session(&self) -> &str { match self { Self::Open { session, .. } | Self::Ready { session } |
        Self::Data { session, .. } | Self::Datagram { session, .. } | Self::Ack { session, .. } | Self::End { session } | Self::Close { session } => session } }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event { scope: String, peer: String, packet: Packet }
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counters { pub sent: u64, pub received: u64, pub sessions: usize,
    pub peers: HashMap<String, crate::traffic_counters::TrafficTotals> }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo { pub id: String, pub peer: String, pub tunnel: String, pub port: u16, pub protocol: String }
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub counters: HashMap<String, Counters>, pub forwards: Vec<ForwardInfo> }

struct Session { tunnel: String, generation: String, local: bool, commands: mpsc::Sender<Command>, cancel: watch::Sender<bool> }
struct Forward { info: ForwardInfo, cancel: watch::Sender<bool> }
#[derive(Default)]
struct Scope { exports: HashMap<String, Export>, peers: HashSet<String>, sessions: HashMap<(String, String), Session>,
    forwards: HashMap<String, Forward>, counters: HashMap<String, Counters> }
#[derive(Clone, Default)]
pub struct TunnelState { scopes: Arc<Mutex<HashMap<String, Scope>>> }
enum Command { Ready, Ack(u32), Data(u32, Vec<u8>, bool), LocalData(Vec<u8>), End }
enum Socket { Tcp(TcpStream), Udp(Arc<UdpSocket>, Option<SocketAddr>) }

fn valid_id(id: &str) -> bool { (id.len() == 32 || id.len() == 36) && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') }
fn valid_peer(peer: &str) -> bool { !peer.is_empty() && peer.len() <= 100 }
fn accept_datagram(window: &mut Option<(u32, u64)>, sequence: u32) -> bool {
    let Some((highest, seen)) = window.as_mut() else { *window = Some((sequence, 1)); return true; };
    if sequence > *highest {
        let distance = sequence - *highest;
        *seen = if distance >= 64 { 1 } else { (*seen << distance) | 1 };
        *highest = sequence; return true;
    }
    let distance = *highest - sequence;
    if distance >= 64 || (*seen & (1u64 << distance)) != 0 { return false; }
    *seen |= 1u64 << distance; true
}
fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16]; getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn main_only(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("Only the main window can operate tunnels".into()) }
}
mod base64_bytes {
    use super::*;
    pub fn serialize<S: serde::Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> { serializer.serialize_str(&STANDARD.encode(bytes)) }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let data = String::deserialize(deserializer)?;
        if data.len() > MAX_DATAGRAM.div_ceil(3) * 4 { return Err(serde::de::Error::custom("Tunnel packet is too large")); }
        STANDARD.decode(data).map_err(serde::de::Error::custom)
    }
}
fn sink(app: tauri::AppHandle) -> Sink { Arc::new(move |event| {
    let (packet, bytes) = match &event.packet {
        Packet::Data { session, sequence, data } => (serde_json::json!({"kind":"data","session":session,"sequence":sequence}), data.as_slice()),
        Packet::Datagram { session, sequence, data } => (serde_json::json!({"kind":"datagram","session":session,"sequence":sequence}), data.as_slice()),
        packet => (serde_json::to_value(packet).map_err(|e| e.to_string())?, &[][..]),
    };
    let header = serde_json::json!({"type":"wire","scope":event.scope,"peer":event.peer,"packet":packet});
    if let Some(result) = crate::peer_payload::emit(&app, &event.scope, header, bytes) { return result; }
    app.emit_to("main", "port-tunnel-event", event).map_err(|e| e.to_string())
}) }
fn emit(sink: &Sink, scope: &str, peer: &str, packet: Packet) -> Result<(), String> {
    sink(Event { scope: scope.into(), peer: peer.into(), packet })
}

impl TunnelState {
    pub(crate) async fn receive_binary(&self, app: tauri::AppHandle, scope: String, peer: String, packet: Packet) -> Result<(), String> {
        self.receive(scope, peer, packet, sink(app)).await
    }
    fn configure(&self, scope: &str, exports: Vec<Export>, peers: Vec<String>) -> Result<(), String> {
        if !valid_id(scope) || exports.len() > 32 || peers.len() > 128 || peers.iter().any(|p| !valid_peer(p)) ||
            exports.iter().any(|e| !valid_id(&e.id) || !valid_id(&e.generation) || e.port == 0 ||
                !matches!(e.protocol.as_str(), "tcp" | "udp") || e.name.is_empty() || e.name.len() > 240) {
            return Err("Invalid tunnel configuration".into());
        }
        let next: HashMap<_, _> = exports.into_iter().map(|e| (e.id.clone(), e)).collect();
        let mut scopes = self.scopes.lock().unwrap();
        if !scopes.contains_key(scope) && scopes.len() >= 24 { return Err("Tunnel scope limit reached".into()); }
        let state = scopes.entry(scope.into()).or_default();
        state.peers = peers.into_iter().collect();
        state.sessions.retain(|(peer, _), s| {
            let keep = state.peers.contains(peer) && (s.local || next.get(&s.tunnel).is_some_and(|e| e.generation == s.generation));
            if !keep { let _ = s.cancel.send(true); } keep
        });
        state.forwards.retain(|_, f| {
            let keep = state.peers.contains(&f.info.peer); if !keep { let _ = f.cancel.send(true); } keep
        });
        state.exports = next;
        Ok(())
    }
    fn stop(&self, scope: &str) {
        if let Some(state) = self.scopes.lock().unwrap().remove(scope) {
            for s in state.sessions.values() { let _ = s.cancel.send(true); }
            for f in state.forwards.values() { let _ = f.cancel.send(true); }
        }
    }
    fn remove_forward(&self, scope: &str, id: &str) {
        if let Some(state) = self.scopes.lock().unwrap().get_mut(scope) {
            if let Some(f) = state.forwards.remove(id) { let _ = f.cancel.send(true); }
            state.counters.remove(id);
            state.sessions.retain(|_, s| { let keep = !s.local || s.tunnel != id;
                if !keep { let _ = s.cancel.send(true); } keep });
        }
    }
    fn status(&self, scope: &str) -> Status {
        let scopes = self.scopes.lock().unwrap();
        let Some(state) = scopes.get(scope) else { return Status::default(); };
        let mut counters = state.counters.clone();
        for c in counters.values_mut() { c.sessions = 0; }
        for s in state.sessions.values() { counters.entry(s.tunnel.clone()).or_default().sessions += 1; }
        Status { counters, forwards: state.forwards.values().map(|f| f.info.clone()).collect() }
    }
    fn register(&self, scope: &str, peer: &str, session: &str, tunnel: &str, generation: &str, local: bool)
        -> Result<(mpsc::Receiver<Command>, watch::Receiver<bool>), String> {
        let mut scopes = self.scopes.lock().unwrap();
        let total: usize = scopes.values().map(|s| s.sessions.len()).sum();
        if total >= MAX_SESSIONS { return Err("Tunnel connection limit reached".into()); }
        let state = scopes.get_mut(scope).ok_or("Tunnel is closed")?;
        if !state.peers.contains(peer) || state.sessions.contains_key(&(peer.into(), session.into())) {
            return Err("Peer unavailable or duplicate connection".into());
        }
        if local {
            if !state.forwards.contains_key(tunnel) { return Err("Forward is closed".into()); }
        } else if !state.exports.get(tunnel).is_some_and(|e| e.generation == generation) {
            return Err("Tunnel is disabled".into());
        }
        let (tx, rx) = mpsc::channel(128);
        let (cancel, cancelled) = watch::channel(false);
        state.sessions.insert((peer.into(), session.into()), Session { tunnel: tunnel.into(), generation: generation.into(), local, commands: tx, cancel });
        Ok((rx, cancelled))
    }
    fn count(&self, scope: &str, tunnel: &str, peer: &str, sent: usize, received: usize) {
        if let Some(state) = self.scopes.lock().unwrap().get_mut(scope) {
            let c = state.counters.entry(tunnel.into()).or_default();
            c.sent = c.sent.saturating_add(sent as u64); c.received = c.received.saturating_add(received as u64);
            crate::traffic_counters::record_peer_traffic(&mut c.peers, peer, sent, received);
        }
    }
    fn close_session(&self, scope: &str, peer: &str, session: &str) {
        if let Some(s) = self.scopes.lock().unwrap().get_mut(scope).and_then(|s| s.sessions.remove(&(peer.into(), session.into()))) {
            let _ = s.cancel.send(true);
        }
    }
    fn queue(&self, scope: &str, peer: &str, session: &str, command: Command) -> Result<(), String> {
        let scopes = self.scopes.lock().unwrap();
        let state = scopes.get(scope).ok_or("Tunnel is closed")?;
        if !state.peers.contains(peer) { return Err("Peer unavailable".into()); }
        let entry = state.sessions.get(&(peer.into(), session.into())).ok_or("Connection is closed")?;
        match entry.commands.try_send(command) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(Command::Data(_, _, true))) => Ok(()),
            Err(_) => Err("Tunnel queue is full".into()),
        }
    }
    async fn receive(&self, scope: String, peer: String, packet: Packet, output: Sink) -> Result<(), String> {
        if !valid_id(&scope) || !valid_peer(&peer) || !valid_id(packet.session()) { return Err("Invalid tunnel packet".into()); }
        let session = packet.session().to_owned();
        let is_datagram = matches!(&packet, Packet::Datagram { .. });
        let result = match packet {
            Packet::Open { tunnel, generation, protocol, .. } => {
                let export = { let scopes = self.scopes.lock().unwrap();
                    let state = scopes.get(&scope).ok_or("Tunnel is closed")?;
                    if !state.peers.contains(&peer) { return Err("Peer unavailable".into()); }
                    state.exports.get(&tunnel).filter(|e| e.generation == generation && e.protocol == protocol).cloned()
                };
                if let Some(export) = export {
                    let (commands, cancel) = self.register(&scope, &peer, &session, &tunnel, &generation, false)?;
                    let hub = self.clone();
                    let (scope, peer, session, output) = (scope.clone(), peer.clone(), session.clone(), output.clone());
                    tokio::spawn(async move {
                        let connect = async {
                            if protocol == "tcp" {
                                let stream = TcpStream::connect(("127.0.0.1", export.port)).await.map_err(|e| e.to_string())?;
                                stream.set_nodelay(true).map_err(|e| e.to_string())?;
                                Ok(Socket::Tcp(stream))
                            } else {
                                let socket = UdpSocket::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
                                socket.connect(("127.0.0.1", export.port)).await.map_err(|e| e.to_string())?;
                                Ok::<_, String>(Socket::Udp(Arc::new(socket), None))
                            }
                        };
                        if let Ok(Ok(socket)) = tokio::time::timeout(Duration::from_secs(8), connect).await {
                            if !*cancel.borrow() && emit(&output, &scope, &peer, Packet::Ready { session: session.clone() }).is_ok() {
                                hub.pump(scope, peer, session, tunnel, socket, commands, cancel, output, true).await;
                                return;
                            }
                        }
                        hub.close_session(&scope, &peer, &session);
                        let _ = emit(&output, &scope, &peer, Packet::Close { session });
                    });
                    Ok(())
                } else { Err("Tunnel is disabled".into()) }
            }
            Packet::Ready { .. } => self.queue(&scope, &peer, &session, Command::Ready),
            Packet::Ack { sequence, .. } => self.queue(&scope, &peer, &session, Command::Ack(sequence)),
            Packet::End { .. } => self.queue(&scope, &peer, &session, Command::End),
            Packet::Data { sequence, data, .. } | Packet::Datagram { sequence, data, .. } => {
                let bytes = data;
                if bytes.len() > MAX_DATAGRAM { return Err("Tunnel packet is too large".into()); }
                self.queue(&scope, &peer, &session, Command::Data(sequence, bytes, is_datagram))
            }
            Packet::Close { .. } => { self.close_session(&scope, &peer, &session); Ok(()) }
        };
        if result.is_err() {
            self.close_session(&scope, &peer, &session);
            let _ = emit(&output, &scope, &peer, Packet::Close { session });
        }
        result
    }
    async fn pump(&self, scope: String, peer: String, session: String, tunnel: String, mut socket: Socket,
        mut commands: mpsc::Receiver<Command>, mut cancel: watch::Receiver<bool>, output: Sink, mut ready: bool) {
        let udp = matches!(socket, Socket::Udp(..));
        let mut buffer = vec![0u8; if udp { MAX_DATAGRAM + 1 } else { TCP_CHUNK }];
        let mut outgoing = 0u32;
        let mut incoming = 0u32;
        let mut datagrams = None;
        // Keep a bounded window moving instead of waiting one network RTT per read.
        let mut pending = std::collections::VecDeque::<(u32, Instant)>::new();
        let window = if udp { 32 } else { 16 };
        let mut first_datagram: Option<Vec<u8>> = None;
        let mut local_ended = false;
        let mut remote_ended = false;
        let mut activity = Instant::now();
        let mut timer = tokio::time::interval(Duration::from_secs(2));
        loop {
            if *cancel.borrow() { break; }
            if local_ended && remote_ended && pending.is_empty() { break; }
            let data = tokio::select! {
                _ = cancel.changed() => break,
                data = async { first_datagram.take().unwrap() }, if ready && pending.len() < window && first_datagram.is_some() => data,
                _ = timer.tick() => {
                    if (!ready && activity.elapsed() > Duration::from_secs(10)) ||
                        pending.front().is_some_and(|(_, t)| t.elapsed() > Duration::from_secs(20)) ||
                        (udp && activity.elapsed() > Duration::from_secs(60)) { break; }
                    continue;
                }
                command = commands.recv() => {
                    match command {
                        Some(Command::Ready) if !ready => { ready = true; activity = Instant::now(); continue; }
                        Some(Command::Ack(seq)) if pending.front().is_some_and(|(n, _)| *n == seq) => { pending.pop_front(); continue; }
                        Some(Command::End) if ready && !udp && !remote_ended => {
                            let Socket::Tcp(stream) = &mut socket else { break; };
                            if stream.shutdown().await.is_err() { break; }
                            remote_ended = true; continue;
                        }
                        Some(Command::Data(seq, data, datagram)) if ready && !remote_ended && datagram == udp && (udp || seq == incoming) => {
                            if udp && !accept_datagram(&mut datagrams, seq) { continue; }
                            let written = tokio::time::timeout(Duration::from_secs(10), async {
                                match &mut socket {
                                    Socket::Tcp(s) => s.write_all(&data).await.map(|_| data.len()),
                                    Socket::Udp(s, Some(addr)) => s.send_to(&data, *addr).await,
                                    Socket::Udp(s, None) => s.send(&data).await,
                                }
                            }).await;
                            if !matches!(written, Ok(Ok(n)) if n == data.len()) { break; }
                            self.count(&scope, &tunnel, &peer, 0, data.len());
                            activity = Instant::now();
                            if !udp {
                                let Some(next) = incoming.checked_add(1) else { break; }; incoming = next;
                                if emit(&output, &scope, &peer, Packet::Ack { session: session.clone(), sequence: seq }).is_err() { break; }
                            }
                            continue;
                        }
                        Some(Command::LocalData(data)) if ready && pending.len() < window => data,
                        Some(Command::LocalData(data)) if !ready && udp && first_datagram.is_none() => { first_datagram = Some(data); continue; }
                        Some(Command::LocalData(_)) if udp => continue, // Bounded datagram queues drop under congestion.
                        _ => break,
                    }
                }
                read = async {
                    match &mut socket {
                        Socket::Tcp(s) => s.read(&mut buffer).await,
                        Socket::Udp(s, None) => s.recv(&mut buffer).await,
                        Socket::Udp(_, Some(_)) => std::future::pending().await,
                    }
                }, if ready && pending.len() < window && !local_ended => {
                    match read {
                        Ok(0) if !udp => {
                            local_ended = true;
                            if emit(&output, &scope, &peer, Packet::End { session: session.clone() }).is_err() { break; }
                            continue;
                        }
                        Ok(n) if n <= MAX_DATAGRAM => buffer[..n].to_vec(), _ => break
                    }
                }
            };
            let length = data.len();
            let packet = if udp { Packet::Datagram { session: session.clone(), sequence: outgoing, data } }
                else { Packet::Data { session: session.clone(), sequence: outgoing, data } };
            if emit(&output, &scope, &peer, packet).is_err() { break; }
            self.count(&scope, &tunnel, &peer, length, 0);
            if !udp { pending.push_back((outgoing, Instant::now())); }
            let Some(next) = outgoing.checked_add(1) else { break; }; outgoing = next;
            activity = Instant::now();
        }
        self.close_session(&scope, &peer, &session);
        let _ = emit(&output, &scope, &peer, Packet::Close { session });
    }
    async fn forward(&self, scope: String, peer: String, export: Export, port: u16, output: Sink) -> Result<ForwardInfo, String> {
        if !valid_id(&export.id) || !valid_id(&export.generation) || !matches!(export.protocol.as_str(), "tcp" | "udp") {
            return Err("Invalid tunnel".into());
        }
        let tcp = if export.protocol == "tcp" { Some(TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| e.to_string())?) } else { None };
        let udp = if tcp.is_none() { Some(Arc::new(UdpSocket::bind(("127.0.0.1", port)).await.map_err(|e| e.to_string())?)) } else { None };
        let port = if let Some(tcp) = &tcp { tcp.local_addr() } else { udp.as_ref().unwrap().local_addr() }.map_err(|e| e.to_string())?.port();
        let info = ForwardInfo { id: random_id()?, peer: peer.clone(), tunnel: export.id.clone(), port, protocol: export.protocol.clone() };
        let (cancel, mut cancelled) = watch::channel(false);
        {
            let mut scopes = self.scopes.lock().unwrap();
            let state = scopes.get_mut(&scope).ok_or("Tunnel is closed")?;
            if !state.peers.contains(&peer) || state.forwards.len() >= 32 { return Err("Peer unavailable or forward limit reached".into()); }
            state.forwards.insert(info.id.clone(), Forward { info: info.clone(), cancel });
        }
        let id = info.id.clone();
        let hub = self.clone();
        tokio::spawn(async move {
            if let Some(listener) = tcp {
                loop {
                    let accepted = tokio::select! { _ = cancelled.changed() => break, result = listener.accept() => result };
                    let Ok((stream, _)) = accepted else { break; };
                    let Ok(session) = random_id() else { break; };
                    let _ = stream.set_nodelay(true);
                    let Ok((commands, stopped)) = hub.register(&scope, &peer, &session, &id, &export.generation, true) else { continue; };
                    if emit(&output, &scope, &peer, Packet::Open { session: session.clone(), tunnel: export.id.clone(), generation: export.generation.clone(), protocol: "tcp".into() }).is_err() {
                        hub.close_session(&scope, &peer, &session); continue;
                    }
                    let (h, s, p, t, o) = (hub.clone(), scope.clone(), peer.clone(), id.clone(), output.clone());
                    tokio::spawn(async move { h.pump(s, p, session, t, Socket::Tcp(stream), commands, stopped, o, false).await; });
                }
            } else if let Some(socket) = udp {
                let mut clients = HashMap::<SocketAddr, String>::new();
                let mut buffer = vec![0u8; MAX_DATAGRAM + 1];
                loop {
                    let received = tokio::select! { _ = cancelled.changed() => break, result = socket.recv_from(&mut buffer) => result };
                    let Ok((n, address)) = received else { break; };
                    if n > MAX_DATAGRAM { continue; }
                    clients.retain(|_, sid| hub.scopes.lock().unwrap().get(&scope).is_some_and(|s| s.sessions.contains_key(&(peer.clone(), sid.clone()))));
                    let session = if let Some(session) = clients.get(&address) { session.clone() } else {
                        let Ok(session) = random_id() else { break; };
                        let Ok((commands, stopped)) = hub.register(&scope, &peer, &session, &id, &export.generation, true) else { continue; };
                        if emit(&output, &scope, &peer, Packet::Open { session: session.clone(), tunnel: export.id.clone(), generation: export.generation.clone(), protocol: "udp".into() }).is_err() {
                            hub.close_session(&scope, &peer, &session); continue;
                        }
                        let (h, s, p, t, o, sock, sid) = (hub.clone(), scope.clone(), peer.clone(), id.clone(), output.clone(), socket.clone(), session.clone());
                        tokio::spawn(async move { h.pump(s, p, sid, t, Socket::Udp(sock, Some(address)), commands, stopped, o, false).await; });
                        clients.insert(address, session.clone()); session
                    };
                    // The first datagram waits for Ready; subsequent overload is intentionally dropped.
                    let _ = hub.queue(&scope, &peer, &session, Command::LocalData(buffer[..n].to_vec()));
                }
            }
            hub.remove_forward(&scope, &id);
        });
        Ok(info)
    }
}

#[tauri::command]
pub fn configure_port_tunnels(window: tauri::Window, state: State<'_, TunnelState>, scope: String, exports: Vec<Export>, peers: Vec<String>) -> Result<(), String> {
    main_only(&window)?; state.configure(&scope, exports, peers)
}
#[tauri::command]
pub fn stop_port_tunnels(window: tauri::Window, state: State<'_, TunnelState>, scope: String) -> Result<(), String> {
    main_only(&window)?; state.stop(&scope); Ok(())
}
#[tauri::command]
pub fn get_port_tunnel_status(window: tauri::Window, state: State<'_, TunnelState>, scope: String) -> Result<Status, String> {
    main_only(&window)?; Ok(state.status(&scope))
}
#[tauri::command]
pub async fn connect_port_tunnel(window: tauri::Window, state: State<'_, TunnelState>, scope: String, peer: String, export: Export, port: u16) -> Result<ForwardInfo, String> {
    main_only(&window)?; state.forward(scope, peer, export, port, sink(window.app_handle().clone())).await
}
#[tauri::command]
pub fn disconnect_port_tunnel(window: tauri::Window, state: State<'_, TunnelState>, scope: String, id: String) -> Result<(), String> {
    main_only(&window)?; state.remove_forward(&scope, &id); Ok(())
}
#[tauri::command]
pub async fn receive_port_tunnel(window: tauri::Window, state: State<'_, TunnelState>, scope: String, peer: String, packet: Packet) -> Result<(), String> {
    main_only(&window)?; state.receive(scope, peer, packet, sink(window.app_handle().clone())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn datagrams_allow_reordering_and_loss_without_replay_or_head_of_line_waits() {
        let mut window = None;
        assert!(accept_datagram(&mut window, 2));
        assert!(accept_datagram(&mut window, 0));
        assert!(accept_datagram(&mut window, 1));
        assert!(!accept_datagram(&mut window, 2));
        assert!(accept_datagram(&mut window, 100));
        assert!(!accept_datagram(&mut window, 1));
        assert!(accept_datagram(&mut window, 99));
    }
    #[test]
    fn traffic_totals_keep_participants_and_directions_independent() {
        let state = TunnelState::default(); let e = export(12345, "tcp");
        state.configure(SCOPE, vec![e.clone()], vec!["first".into(), "second".into()]).unwrap();
        state.count(SCOPE, &e.id, "first", 100, 25);
        state.count(SCOPE, &e.id, "second", 40, 80);
        state.count(SCOPE, &e.id, "first", 5, 10);
        let status = state.status(SCOPE);
        let totals = &status.counters[&e.id];
        assert_eq!((totals.sent, totals.received), (145, 115));
        assert_eq!((totals.peers["first"].sent, totals.peers["first"].received), (105, 35));
        assert_eq!((totals.peers["second"].sent, totals.peers["second"].received), (40, 80));
        let wire = serde_json::to_value(status).unwrap();
        assert_eq!(wire["counters"][&e.id]["peers"]["first"]["sent"], 105);
        state.stop(SCOPE);
        assert!(state.status(SCOPE).counters.is_empty());
    }
    #[tokio::test]
    async fn congested_udp_drops_packets_without_destroying_the_session() {
        let state = TunnelState::default(); let e = export(12345, "udp");
        state.configure(SCOPE, vec![e.clone()], vec!["peer".into()]).unwrap();
        let session = "44444444444444444444444444444444";
        let (_commands, cancel) = state.register(SCOPE, "peer", session, &e.id, &e.generation, false).unwrap();
        for sequence in 0..256 {
            state.queue(SCOPE, "peer", session, Command::Data(sequence, vec![1], true)).unwrap();
        }
        assert!(!*cancel.borrow());
        assert_eq!(state.status(SCOPE).counters[&e.id].sessions, 1);
        state.stop(SCOPE);
    }
    #[tokio::test]
    async fn tcp_pipeline_emits_multiple_reads_without_waiting_for_remote_acknowledgement() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
            let (stream, _) = listener.accept().await.unwrap();
            let state = TunnelState::default(); let e = export(12345, "tcp");
            state.configure(SCOPE, vec![e.clone()], vec!["peer".into()]).unwrap();
            let session = "44444444444444444444444444444444";
            let (commands, cancel) = state.register(SCOPE, "peer", session, &e.id, &e.generation, false).unwrap();
            let (send, mut receive) = mpsc::unbounded_channel();
            let sink: Sink = Arc::new(move |event| send.send(event).map_err(|e| e.to_string()));
            let pump = tokio::spawn({ let state = state.clone(); async move {
                state.pump(SCOPE.into(), "peer".into(), session.into(), e.id, Socket::Tcp(stream), commands, cancel, sink, true).await;
            } });
            client.write_all(&vec![7; TCP_CHUNK * 3]).await.unwrap();
            let mut total = 0;
            while total < TCP_CHUNK * 3 {
                match receive.recv().await.unwrap().packet {
                    Packet::Data { data, .. } => total += data.len(), _ => panic!("Unexpected control packet"),
                }
            }
            state.stop(SCOPE); pump.await.unwrap();
        }).await.unwrap();
    }
    const SCOPE: &str = "11111111-1111-4111-8111-111111111111";
    fn export(port: u16, protocol: &str) -> Export {
        Export { id: "22222222-2222-4222-8222-222222222222".into(), generation: "33333333-3333-4333-8333-333333333333".into(),
            name: "Test service".into(), port, protocol: protocol.into() }
    }
    fn pair(e: Export) -> (TunnelState, TunnelState, Sink, tokio::task::JoinHandle<()>) {
        let left = TunnelState::default(); let right = TunnelState::default();
        left.configure(SCOPE, vec![], vec!["right".into()]).unwrap();
        right.configure(SCOPE, vec![e], vec!["left".into()]).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<(bool, Event)>();
        let a = tx.clone(); let b = tx;
        let left_sink: Sink = Arc::new(move |e| a.send((true, e)).map_err(|e| e.to_string()));
        let right_sink: Sink = Arc::new(move |e| b.send((false, e)).map_err(|e| e.to_string()));
        let (l, r, ls) = (left.clone(), right.clone(), left_sink.clone());
        let router = tokio::spawn(async move {
            while let Some((from_left, e)) = rx.recv().await {
                let (hub, peer, output) = if from_left { (&r, "left", right_sink.clone()) } else { (&l, "right", ls.clone()) };
                let _ = hub.receive(e.scope, peer.into(), e.packet, output).await;
            }
        });
        (left, right, left_sink, router)
    }

    #[tokio::test]
    async fn tcp_roundtrip_preserves_bytes_and_half_close() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let service = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let e = export(service.local_addr().unwrap().port(), "tcp");
            let echo = tokio::spawn(async move {
                let (mut socket, _) = service.accept().await.unwrap();
                let mut bytes = Vec::new(); socket.read_to_end(&mut bytes).await.unwrap();
                socket.write_all(&bytes).await.unwrap(); socket.shutdown().await.unwrap();
            });
            let (left, right, output, router) = pair(e.clone());
            let f = left.forward(SCOPE.into(), "right".into(), e, 0, output).await.unwrap();
            let mut client = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
            let bytes: Vec<u8> = (0..90_000).map(|i| (i % 251) as u8).collect();
            client.write_all(&bytes).await.unwrap(); client.shutdown().await.unwrap();
            let mut received = Vec::new(); client.read_to_end(&mut received).await.unwrap();
            assert_eq!(received, bytes);
            assert_eq!(right.status(SCOPE).counters.values().map(|c| c.received).sum::<u64>(), bytes.len() as u64);
            let status = right.status(SCOPE);
            let totals = status.counters.values().next().unwrap();
            assert_eq!(totals.peers["left"].received, bytes.len() as u64);
            left.stop(SCOPE); right.stop(SCOPE); router.abort(); echo.await.unwrap();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn udp_roundtrip_preserves_first_empty_and_large_datagrams() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let service = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
            let e = export(service.local_addr().unwrap().port(), "udp");
            let echo = tokio::spawn(async move {
                let mut buffer = vec![0u8; MAX_DATAGRAM];
                for _ in 0..3 {
                    let (n, source) = service.recv_from(&mut buffer).await.unwrap();
                    service.send_to(&buffer[..n], source).await.unwrap();
                }
            });
            let (left, right, output, router) = pair(e.clone());
            let f = left.forward(SCOPE.into(), "right".into(), e, 0, output).await.unwrap();
            let client = UdpSocket::bind(("127.0.0.1", 0)).await.unwrap();
            client.connect(("127.0.0.1", f.port)).await.unwrap();
            for bytes in [vec![1, 2, 3], vec![], vec![42; 40_000]] {
                client.send(&bytes).await.unwrap();
                let mut buffer = vec![0u8; MAX_DATAGRAM];
                let n = client.recv(&mut buffer).await.unwrap();
                assert_eq!(&buffer[..n], &bytes);
            }
            left.stop(SCOPE); right.stop(SCOPE); router.abort(); echo.await.unwrap();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn revocation_and_membership_remove_sessions_and_listeners() {
        let state = TunnelState::default();
        let e = export(12345, "tcp");
        state.configure(SCOPE, vec![e.clone()], vec!["peer".into()]).unwrap();
        let (_, cancelled) = state.register(SCOPE, "peer", "44444444444444444444444444444444", &e.id, &e.generation, false).unwrap();
        state.configure(SCOPE, vec![], vec!["peer".into()]).unwrap();
        assert!(*cancelled.borrow());
        let output: Sink = Arc::new(|_| Ok(()));
        let f = state.forward(SCOPE.into(), "peer".into(), e.clone(), 0, output.clone()).await.unwrap();
        state.configure(SCOPE, vec![], vec![]).unwrap();
        assert!(state.status(SCOPE).forwards.is_empty());
        assert!(state.receive(SCOPE.into(), "peer".into(), Packet::Open { session: "55555555555555555555555555555555".into(),
            tunnel: e.id, generation: e.generation, protocol: e.protocol }, output).await.is_err());
        assert!(state.status(SCOPE).forwards.iter().all(|entry| entry.id != f.id));
        state.stop(SCOPE);
    }

    #[tokio::test]
    async fn unauthorized_packets_and_session_overflow_are_rejected() {
        let state = TunnelState::default(); let e = export(12345, "tcp");
        state.configure(SCOPE, vec![e.clone()], vec!["peer".into()]).unwrap();
        let mut receivers = Vec::new();
        for i in 0..MAX_SESSIONS { receivers.push(state.register(SCOPE, "peer", &format!("{i:032x}"), &e.id, &e.generation, false).unwrap()); }
        assert!(state.register(SCOPE, "peer", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", &e.id, &e.generation, false).is_err());
        let output: Sink = Arc::new(|_| Ok(()));
        assert!(state.receive(SCOPE.into(), "unjoined".into(), Packet::Ack { session: format!("{:032x}", 0), sequence: 0 }, output).await.is_err());
        state.stop(SCOPE);
        assert!(receivers.iter().all(|(_, cancel)| *cancel.borrow()));
    }
}
