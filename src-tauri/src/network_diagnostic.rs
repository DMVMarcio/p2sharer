//! Network diagnostics for NAT traversal, STUN, CGNAT and UPnP detection.
//!
//! Evaluates local NAT type (RFC 3489 / RFC 5389), measures STUN latency,
//! detects Carrier-Grade NAT (RFC 6598) and Double NAT via UPnP gateway discovery,
//! and verifies UDP port mapping readiness for direct P2P connections.

use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddrV4},
    time::{Duration, Instant},
};
use tokio::net::UdpSocket;

pub const STUN_MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
pub const DEFAULT_STUN_SERVERS: [&str; 2] = [
    "stun.cloudflare.com:3478",
    "stun.l.google.com:19302",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NatType {
    Cone,
    Symmetric,
    Blocked,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NetworkDiagnosticResult {
    pub nat_type: NatType,
    pub nat_description: String,
    pub public_ip: Option<String>,
    pub cgnat_detected: bool,
    pub double_nat_detected: bool,
    pub cgnat_details: Option<String>,
    pub upnp_available: bool,
    pub upnp_gateway: Option<String>,
    pub upnp_external_ip: Option<String>,
    pub upnp_port_mapped: bool,
    pub stun_latency_ms: Option<u64>,
    pub recommendation: String,
}

pub fn is_cgnat_ip(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

pub fn is_private_ip(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
        || octets[0] == 127
}

pub fn create_stun_request() -> ([u8; 20], [u8; 12]) {
    let mut request = [0u8; 20];
    request[0] = 0x00;
    request[1] = 0x01; // Binding Request
    request[2] = 0x00;
    request[3] = 0x00; // Message Length = 0
    request[4..8].copy_from_slice(&STUN_MAGIC_COOKIE);
    let mut tx_id = [0u8; 12];
    let _ = getrandom::getrandom(&mut tx_id);
    request[8..20].copy_from_slice(&tx_id);
    (request, tx_id)
}

pub fn parse_stun_response(response: &[u8], tx_id: &[u8; 12]) -> Option<SocketAddrV4> {
    if response.len() < 20 {
        return None;
    }
    // Check Binding Response type (0x0101)
    if response[0] != 0x01 || response[1] != 0x01 {
        return None;
    }
    // Check Cookie
    if response[4..8] != STUN_MAGIC_COOKIE {
        return None;
    }
    // Check Transaction ID
    if response[8..20] != *tx_id {
        return None;
    }

    let msg_len = u16::from_be_bytes([response[2], response[3]]) as usize;
    let limit = std::cmp::min(response.len(), 20 + msg_len);
    let mut cursor = 20;

    while cursor + 4 <= limit {
        let attr_type = u16::from_be_bytes([response[cursor], response[cursor + 1]]);
        let attr_len = u16::from_be_bytes([response[cursor + 2], response[cursor + 3]]) as usize;
        cursor += 4;
        if cursor + attr_len > limit {
            break;
        }

        // XOR-MAPPED-ADDRESS: 0x0020
        if attr_type == 0x0020 && attr_len >= 8 {
            let family = response[cursor + 1];
            if family == 0x01 {
                let x_port = u16::from_be_bytes([response[cursor + 2], response[cursor + 3]]);
                let port = x_port ^ 0x2112;
                let ip_bytes = [
                    response[cursor + 4] ^ STUN_MAGIC_COOKIE[0],
                    response[cursor + 5] ^ STUN_MAGIC_COOKIE[1],
                    response[cursor + 6] ^ STUN_MAGIC_COOKIE[2],
                    response[cursor + 7] ^ STUN_MAGIC_COOKIE[3],
                ];
                return Some(SocketAddrV4::new(Ipv4Addr::from(ip_bytes), port));
            }
        }

        // MAPPED-ADDRESS: 0x0001
        if attr_type == 0x0001 && attr_len >= 8 {
            let family = response[cursor + 1];
            if family == 0x01 {
                let port = u16::from_be_bytes([response[cursor + 2], response[cursor + 3]]);
                let ip_bytes = [
                    response[cursor + 4],
                    response[cursor + 5],
                    response[cursor + 6],
                    response[cursor + 7],
                ];
                return Some(SocketAddrV4::new(Ipv4Addr::from(ip_bytes), port));
            }
        }

        cursor += (attr_len + 3) / 4 * 4;
    }

    None
}

async fn query_stun_server(socket: &UdpSocket, server_str: &str) -> Result<(SocketAddrV4, Duration), String> {
    let addrs = tokio::net::lookup_host(server_str)
        .await
        .map_err(|e| format!("Host lookup failed for {server_str}: {e}"))?;

    let target_addr = addrs
        .into_iter()
        .find(|addr| addr.is_ipv4())
        .ok_or_else(|| format!("No IPv4 address resolved for {server_str}"))?;

    let (req, tx_id) = create_stun_request();
    let start = Instant::now();
    socket.send_to(&req, target_addr).await.map_err(|e| e.to_string())?;

    let mut buf = [0u8; 1024];
    let endpoint = tokio::time::timeout(Duration::from_millis(2500), async {
        loop {
            let (len, _from) = socket.recv_from(&mut buf).await.map_err(|e| e.to_string())?;
            if let Some(ep) = parse_stun_response(&buf[..len], &tx_id) {
                return Ok(ep);
            }
        }
    })
    .await
    .map_err(|_| format!("STUN request to {server_str} timed out"))?
    .map_err(|e: String| e)?;

    let elapsed = start.elapsed();
    Ok((endpoint, elapsed))
}

#[tauri::command]
pub async fn run_network_diagnostics(
    upnp_state: tauri::State<'_, crate::upnp::UpnpState>,
) -> Result<NetworkDiagnosticResult, String> {
    // 1. UPnP Discovery & Status
    upnp_state.init_discovery().await;
    let upnp_status = upnp_state.status();
    let upnp_available = upnp_status.available;
    let upnp_gateway = upnp_status.gateway.clone();
    let upnp_external_ip = upnp_state.get_external_ip().await;

    // Test UPnP UDP port mapping on a dynamic port
    let upnp_port_mapped = if upnp_available {
        upnp_state.map_port(54320, "UDP").await
    } else {
        false
    };

    // 2. STUN Resolution & NAT Type Determination
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("Failed to bind local UDP socket: {e}"))?;

    let primary_res = query_stun_server(&socket, DEFAULT_STUN_SERVERS[0]).await;
    let secondary_res = query_stun_server(&socket, DEFAULT_STUN_SERVERS[1]).await;

    let (nat_type, public_ip, stun_latency_ms) = match (&primary_res, &secondary_res) {
        (Ok((ep1, rtt1)), Ok((ep2, _rtt2))) => {
            let ip_str = ep1.ip().to_string();
            let latency = rtt1.as_millis() as u64;
            if ep1.port() == ep2.port() {
                (NatType::Cone, Some(ip_str), Some(latency))
            } else {
                (NatType::Symmetric, Some(ip_str), Some(latency))
            }
        }
        (Ok((ep, rtt)), Err(_)) => {
            (NatType::Cone, Some(ep.ip().to_string()), Some(rtt.as_millis() as u64))
        }
        (Err(_), Ok((ep, rtt))) => {
            (NatType::Cone, Some(ep.ip().to_string()), Some(rtt.as_millis() as u64))
        }
        (Err(_), Err(_)) => (NatType::Blocked, None, None),
    };

    // 3. CGNAT & Double NAT Classification
    let mut cgnat_detected = false;
    let mut double_nat_detected = false;
    let mut cgnat_details = None;

    if let Some(ext_ip_str) = &upnp_external_ip {
        if let Ok(ip) = ext_ip_str.parse::<Ipv4Addr>() {
            if is_cgnat_ip(ip) {
                cgnat_detected = true;
                cgnat_details = Some("Carrier-Grade NAT (RFC 6598) detected on gateway WAN".into());
            } else if is_private_ip(ip) {
                double_nat_detected = true;
                cgnat_details = Some("Double NAT detected (gateway WAN IP is in a private network range)".into());
            } else {
                cgnat_detected = false;
                cgnat_details = Some("Direct public IP confirmed on gateway WAN (no CGNAT)".into());
            }
        }
    } else {
        // Fallback: Check local adapters or symmetric NAT heuristic
        let local_interfaces = crate::lan_signaling::interfaces();
        let has_cgnat_interface = local_interfaces.iter().any(|i| {
            if let Ok(IpAddr::V4(ipv4)) = i.address.parse() {
                is_cgnat_ip(ipv4)
            } else {
                false
            }
        });

        if has_cgnat_interface {
            cgnat_detected = true;
            cgnat_details = Some("Carrier-Grade NAT IP found directly on a local network interface".into());
        } else if nat_type == NatType::Symmetric {
            cgnat_detected = true;
            cgnat_details = Some("Symmetric NAT detected via STUN (typical of strict ISP CGNAT or corporate firewalls)".into());
        }
    }

    // 4. Formulate Recommendation & Description
    let nat_description = match nat_type {
        NatType::Cone => "Cone NAT (Open / Moderate) - Destination-independent port mapping.".into(),
        NatType::Symmetric => "Symmetric NAT (Strict) - Port mapping changes for each remote destination.".into(),
        NatType::Blocked => "UDP Blocked - STUN / UDP traffic cannot traverse the network or firewall.".into(),
        NatType::Unknown => "Unknown NAT type.".into(),
    };

    let recommendation = match nat_type {
        NatType::Cone if !cgnat_detected || upnp_port_mapped => {
            "optimal".into()
        }
        NatType::Symmetric | NatType::Cone if cgnat_detected && !upnp_port_mapped => {
            "restricted".into()
        }
        NatType::Blocked => {
            "blocked".into()
        }
        _ => "moderate".into(),
    };

    Ok(NetworkDiagnosticResult {
        nat_type,
        nat_description,
        public_ip,
        cgnat_detected,
        double_nat_detected,
        cgnat_details,
        upnp_available,
        upnp_gateway,
        upnp_external_ip,
        upnp_port_mapped,
        stun_latency_ms,
        recommendation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_cgnat_ip() {
        assert!(is_cgnat_ip(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_cgnat_ip(Ipv4Addr::new(100, 127, 255, 254)));
        assert!(!is_cgnat_ip(Ipv4Addr::new(100, 63, 255, 255)));
        assert!(!is_cgnat_ip(Ipv4Addr::new(100, 128, 0, 1)));
        assert!(!is_cgnat_ip(Ipv4Addr::new(192, 168, 1, 1)));
    }

    #[test]
    fn test_is_private_ip() {
        assert!(is_private_ip(Ipv4Addr::new(192, 168, 0, 1)));
        assert!(is_private_ip(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(is_private_ip(Ipv4Addr::new(172, 16, 0, 1)));
        assert!(is_private_ip(Ipv4Addr::new(172, 31, 255, 255)));
        assert!(!is_private_ip(Ipv4Addr::new(172, 32, 0, 1)));
        assert!(!is_private_ip(Ipv4Addr::new(8, 8, 8, 8)));
    }

    #[test]
    fn test_stun_request_and_response_parser() {
        let (req, tx_id) = create_stun_request();
        assert_eq!(req[0..2], [0, 1]);
        assert_eq!(req[4..8], STUN_MAGIC_COOKIE);
        assert_eq!(req[8..20], tx_id);

        // Build a synthetic XOR-MAPPED-ADDRESS response for 198.51.100.1:40000
        let mut resp = vec![0u8; 32];
        resp[0] = 0x01;
        resp[1] = 0x01; // Binding Response
        resp[2] = 0x00;
        resp[3] = 0x0c; // Length = 12 bytes
        resp[4..8].copy_from_slice(&STUN_MAGIC_COOKIE);
        resp[8..20].copy_from_slice(&tx_id);

        // Attribute XOR-MAPPED-ADDRESS (0x0020), length 8
        resp[20..24].copy_from_slice(&[0x00, 0x20, 0x00, 0x08]);
        resp[24] = 0x00;
        resp[25] = 0x01; // IPv4
        let port: u16 = 40000;
        let x_port = port ^ 0x2112;
        resp[26..28].copy_from_slice(&x_port.to_be_bytes());
        let ip = Ipv4Addr::new(198, 51, 100, 1);
        for (i, b) in ip.octets().iter().enumerate() {
            resp[28 + i] = b ^ STUN_MAGIC_COOKIE[i];
        }

        let parsed = parse_stun_response(&resp, &tx_id).expect("Should parse synthetic response");
        assert_eq!(*parsed.ip(), ip);
        assert_eq!(parsed.port(), port);
    }
}
