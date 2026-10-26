//! Same-host STUN discovers IPv4 interfaces hidden by WebView2's media permission filter.
//! This is not a public STUN service or a relay; remote-source packets are discarded.
use std::{collections::{BTreeMap, BTreeSet}, net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4}, sync::Mutex};
use tokio::{net::UdpSocket, task::JoinHandle};

const COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
const MAX_INTERFACES: usize = 16;

struct Listener {
    url: String,
    task: JoinHandle<()>,
}

impl Drop for Listener {
    fn drop(&mut self) { self.task.abort(); }
}

#[derive(Default)]
pub struct InterfaceStunState(Mutex<BTreeMap<Ipv4Addr, Listener>>);

fn binding_response(request: &[u8], source: SocketAddrV4, local: Ipv4Addr) -> Option<[u8; 32]> {
    if *source.ip() != local || request.len() < 20 || request[..2] != [0, 1]
        || request[4..8] != COOKIE {
        return None;
    }
    let length = u16::from_be_bytes([request[2], request[3]]) as usize;
    if length % 4 != 0 || request.len() != 20 + length { return None; }
    // Validate attribute boundaries, including their four-byte padding.
    let mut cursor = 20;
    while cursor < request.len() {
        if cursor + 4 > request.len() { return None; }
        let size = u16::from_be_bytes([request[cursor + 2], request[cursor + 3]]) as usize;
        cursor += 4 + (size + 3) / 4 * 4;
        if cursor > request.len() { return None; }
    }
    let mut response = [0; 32];
    response[..4].copy_from_slice(&[1, 1, 0, 12]);
    response[4..20].copy_from_slice(&request[4..20]);
    response[20..26].copy_from_slice(&[0, 0x20, 0, 8, 0, 1]);
    response[26..28].copy_from_slice(&(source.port() ^ 0x2112).to_be_bytes());
    for (index, byte) in source.ip().octets().iter().enumerate() {
        response[28 + index] = byte ^ COOKIE[index];
    }
    Some(response)
}

fn bind_interface(ip: Ipv4Addr) -> std::io::Result<Listener> {
    // Binding a concrete assigned address lets the browser's wildcard socket use
    // that interface's route, even when browser enumeration exposes only the default.
    let socket = std::net::UdpSocket::bind(SocketAddrV4::new(ip, 0))?;
    socket.set_nonblocking(true)?;
    let port = socket.local_addr()?.port();
    let socket = UdpSocket::from_std(socket)?;
    let task = tokio::spawn(async move {
        let mut packet = [0; 1024];
        while let Ok((length, source)) = socket.recv_from(&mut packet).await {
            let SocketAddr::V4(source) = source else { continue; };
            if let Some(response) = binding_response(&packet[..length], source, ip) {
                let _ = socket.send_to(&response, source).await;
            }
        }
    });
    Ok(Listener { url: format!("stun:{ip}:{port}"), task })
}

#[tauri::command]
pub async fn get_interface_stun_servers(window: tauri::Window,
    state: tauri::State<'_, InterfaceStunState>) -> Result<Vec<String>, String> {
    if window.label() != "main" { return Err("Only the main window can discover ICE interfaces".into()); }
    let ips = tauri::async_runtime::spawn_blocking(|| {
        crate::lan_signaling::interfaces().into_iter()
            .filter_map(|interface| match interface.address.parse() {
                Ok(IpAddr::V4(ip)) => Some(ip), _ => None,
            }).take(MAX_INTERFACES).collect::<BTreeSet<_>>()
    }).await.map_err(|e| e.to_string())?;
    let mut listeners = state.0.lock().unwrap();
    listeners.retain(|ip, _| ips.contains(ip));
    for ip in ips {
        if let std::collections::btree_map::Entry::Vacant(entry) = listeners.entry(ip) {
            if let Ok(listener) = bind_interface(ip) { entry.insert(listener); }
        }
    }
    Ok(listeners.values().map(|listener| listener.url.clone()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Vec<u8> {
        let mut request = vec![0; 20];
        request[1] = 1;
        request[4..8].copy_from_slice(&COOKIE);
        request[8..20].copy_from_slice(b"transaction!");
        request
    }

    #[test]
    fn binding_response_preserves_transaction_and_encodes_observed_endpoint() {
        let ip = Ipv4Addr::new(192, 0, 2, 1);
        let response = binding_response(&request(), SocketAddrV4::new(ip, 45678), ip).unwrap();
        assert_eq!(&response[..8], &[1, 1, 0, 12, 0x21, 0x12, 0xa4, 0x42]);
        assert_eq!(&response[8..20], b"transaction!");
        assert_eq!(u16::from_be_bytes([response[26], response[27]]) ^ 0x2112, 45678);
        assert_eq!(std::array::from_fn::<_, 4, _>(|i| response[28 + i] ^ COOKIE[i]), ip.octets());
    }

    #[test]
    fn remote_sources_and_malformed_or_nonbinding_messages_are_rejected() {
        let ip = Ipv4Addr::LOCALHOST;
        let source = SocketAddrV4::new(ip, 12345);
        assert!(binding_response(&request(), SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 2), 12345), ip).is_none());
        for index in [0, 1, 3, 4] {
            let mut packet = request(); packet[index] ^= 0xff;
            assert!(binding_response(&packet, source, ip).is_none());
        }
        let mut packet = request(); packet[3] = 4; packet.extend([0, 1, 0, 8]);
        assert!(binding_response(&packet, source, ip).is_none());
        assert!(binding_response(&request()[..19], source, ip).is_none());
    }

    #[tokio::test]
    async fn socket_answers_same_host_binding_and_closes_with_owner() {
        let listener = bind_interface(Ipv4Addr::LOCALHOST).unwrap();
        let port: u16 = listener.url.rsplit(':').next().unwrap().parse().unwrap();
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        let client = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        client.send_to(&request(), address).await.unwrap();
        let mut response = [0; 128];
        let (length, source) = tokio::time::timeout(std::time::Duration::from_secs(2), client.recv_from(&mut response)).await.unwrap().unwrap();
        assert_eq!(length, 32);
        assert_eq!(source, SocketAddr::V4(address));
        assert_eq!(&response[8..20], b"transaction!");
        listener.task.abort();
        while !listener.task.is_finished() { tokio::task::yield_now().await; }
        drop(listener);
        assert!(std::net::UdpSocket::bind(address).is_ok());
    }
}
