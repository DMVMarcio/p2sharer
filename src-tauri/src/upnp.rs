//! Lightweight asynchronous UPnP IGD port mapping for Desktop P2P.
//!
//! Uses SSDP (M-SEARCH UDP) to discover local Internet Gateway Devices (routers),
//! queries the gateway control URL, and manages port mappings via standard UPnP SOAP.
use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::net::UdpSocket;

#[derive(Default, Clone)]
pub struct UpnpState {
    inner: Arc<Mutex<UpnpInner>>,
}

#[derive(Default)]
struct UpnpInner {
    control_url: Option<String>,
    service_type: Option<String>,
    local_ip: Option<Ipv4Addr>,
    active_mappings: HashSet<(u16, String)>,
    available: bool,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct UpnpStatus {
    pub available: bool,
    pub gateway: Option<String>,
    pub mapped_ports: Vec<u16>,
}

impl UpnpState {
    pub async fn init_discovery(&self) {
        if let Ok((control_url, service_type, local_ip)) = discover_gateway().await {
            let mut inner = self.inner.lock().unwrap();
            inner.control_url = Some(control_url.clone());
            inner.service_type = Some(service_type);
            inner.local_ip = Some(local_ip);
            inner.available = true;
            log::info!("[UPnP] Discovered IGD gateway control URL: {}", control_url);
        } else {
            log::debug!("[UPnP] No UPnP IGD gateway discovered on local network");
        }
    }

    pub async fn map_port(&self, port: u16, protocol: &str) -> bool {
        let (control_url, service_type, local_ip) = {
            let inner = self.inner.lock().unwrap();
            match (&inner.control_url, &inner.service_type, inner.local_ip) {
                (Some(c), Some(s), Some(ip)) => (c.clone(), s.clone(), ip),
                _ => return false,
            }
        };

        let success = add_port_mapping(&control_url, &service_type, local_ip, port, protocol).await;
        if success {
            let mut inner = self.inner.lock().unwrap();
            inner.active_mappings.insert((port, protocol.to_uppercase()));
            log::info!("[UPnP] Successfully mapped external port {}/{} to local IP {}", port, protocol, local_ip);
        }
        success
    }

    pub async fn unmap_port(&self, port: u16, protocol: &str) -> bool {
        let (control_url, service_type) = {
            let mut inner = self.inner.lock().unwrap();
            inner.active_mappings.remove(&(port, protocol.to_uppercase()));
            match (&inner.control_url, &inner.service_type) {
                (Some(c), Some(s)) => (c.clone(), s.clone()),
                _ => return false,
            }
        };

        delete_port_mapping(&control_url, &service_type, port, protocol).await
    }

    pub fn status(&self) -> UpnpStatus {
        let inner = self.inner.lock().unwrap();
        let mapped_ports: Vec<u16> = inner.active_mappings.iter().map(|(p, _)| *p).collect();
        UpnpStatus {
            available: inner.available,
            gateway: inner.control_url.clone(),
            mapped_ports,
        }
    }
}

async fn discover_gateway() -> Result<(String, String, Ipv4Addr), String> {
    let socket = UdpSocket::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;

    let search_msg = concat!(
        "M-SEARCH * HTTP/1.1\r\n",
        "HOST: 239.255.255.250:1900\r\n",
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n",
        "MAN: \"ssdp:discover\"\r\n",
        "MX: 2\r\n",
        "\r\n"
    );

    let multicast_addr: SocketAddr = "239.255.255.250:1900".parse().unwrap();
    socket.send_to(search_msg.as_bytes(), multicast_addr).await.map_err(|e| e.to_string())?;

    let mut buf = [0u8; 2048];
    let location = tokio::time::timeout(Duration::from_millis(2500), async {
        loop {
            if let Ok((len, from_addr)) = socket.recv_from(&mut buf).await {
                let response = String::from_utf8_lossy(&buf[..len]);
                for line in response.lines() {
                    let lower = line.to_ascii_lowercase();
                    if lower.starts_with("location:") {
                        let url = line[9..].trim().to_string();
                        if let IpAddr::V4(ipv4) = from_addr.ip() {
                            return Ok((url, ipv4));
                        }
                    }
                }
            }
        }
    })
    .await
    .map_err(|_| "SSDP discovery timed out".to_string())?
    .map_err(|e: String| e)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(3000))
        .build()
        .map_err(|e| e.to_string())?;

    let (desc_url, gateway_ip) = location;
    let xml = client.get(&desc_url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;

    // Determine WANIPConnection or WANPPPConnection control URL
    let service_type = if xml.contains("urn:schemas-upnp-org:service:WANIPConnection:1") {
        "urn:schemas-upnp-org:service:WANIPConnection:1".to_string()
    } else if xml.contains("urn:schemas-upnp-org:service:WANPPPConnection:1") {
        "urn:schemas-upnp-org:service:WANPPPConnection:1".to_string()
    } else {
        return Err("No compatible WAN IP/PPP service found in IGD description".into());
    };

    let control_path = extract_control_url(&xml, &service_type)
        .ok_or_else(|| "Failed to extract controlURL from XML".to_string())?;

    let base_url = reqwest::Url::parse(&desc_url).map_err(|e| e.to_string())?;
    let full_control_url = base_url.join(&control_path).map_err(|e| e.to_string())?.to_string();

    // Determine local IPv4 that routes to the gateway
    let local_ip = get_local_ip_to(gateway_ip).unwrap_or(Ipv4Addr::new(127, 0, 0, 1));

    Ok((full_control_url, service_type, local_ip))
}

fn extract_control_url(xml: &str, service_type: &str) -> Option<String> {
    let service_idx = xml.find(service_type)?;
    let slice_after = &xml[service_idx..];
    let control_tag = "<controlURL>";
    let control_end_tag = "</controlURL>";
    let start_idx = slice_after.find(control_tag)? + control_tag.len();
    let end_idx = slice_after[start_idx..].find(control_end_tag)?;
    Some(slice_after[start_idx..start_idx + end_idx].trim().to_string())
}

fn get_local_ip_to(target: Ipv4Addr) -> Option<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect((target, 80)).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        _ => None,
    }
}

async fn add_port_mapping(
    control_url: &str,
    service_type: &str,
    local_ip: Ipv4Addr,
    port: u16,
    protocol: &str,
) -> bool {
    let soap_action = format!("\"{}#AddPortMapping\"", service_type);
    let proto = protocol.to_uppercase();
    let body = format!(
        concat!(
            "<?xml version=\"1.0\"?>\r\n",
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\r\n",
            "<s:Body>\r\n",
            "<u:AddPortMapping xmlns:u=\"{}\">\r\n",
            "  <NewRemoteHost></NewRemoteHost>\r\n",
            "  <NewExternalPort>{}</NewExternalPort>\r\n",
            "  <NewProtocol>{}</NewProtocol>\r\n",
            "  <NewInternalPort>{}</NewInternalPort>\r\n",
            "  <NewInternalClient>{}</NewInternalClient>\r\n",
            "  <NewEnabled>1</NewEnabled>\r\n",
            "  <NewPortMappingDescription>P2Sharer</NewPortMappingDescription>\r\n",
            "  <NewLeaseDuration>7200</NewLeaseDuration>\r\n",
            "</u:AddPortMapping>\r\n",
            "</s:Body>\r\n",
            "</s:Envelope>"
        ),
        service_type, port, proto, port, local_ip
    );

    let client = match reqwest::Client::builder().timeout(Duration::from_millis(3000)).build() {
        Ok(c) => c,
        Err(_) => return false,
    };

    let res = client
        .post(control_url)
        .header("SOAPAction", soap_action)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .body(body)
        .send()
        .await;

    match res {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

async fn delete_port_mapping(control_url: &str, service_type: &str, port: u16, protocol: &str) -> bool {
    let soap_action = format!("\"{}#DeletePortMapping\"", service_type);
    let proto = protocol.to_uppercase();
    let body = format!(
        concat!(
            "<?xml version=\"1.0\"?>\r\n",
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\r\n",
            "<s:Body>\r\n",
            "<u:DeletePortMapping xmlns:u=\"{}\">\r\n",
            "  <NewRemoteHost></NewRemoteHost>\r\n",
            "  <NewExternalPort>{}</NewExternalPort>\r\n",
            "  <NewProtocol>{}</NewProtocol>\r\n",
            "</u:DeletePortMapping>\r\n",
            "</s:Body>\r\n",
            "</s:Envelope>"
        ),
        service_type, port, proto
    );

    let client = match reqwest::Client::builder().timeout(Duration::from_millis(3000)).build() {
        Ok(c) => c,
        Err(_) => return false,
    };

    let res = client
        .post(control_url)
        .header("SOAPAction", soap_action)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .body(body)
        .send()
        .await;

    match res {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn get_upnp_status(state: tauri::State<'_, UpnpState>) -> Result<UpnpStatus, String> {
    Ok(state.status())
}

#[tauri::command]
pub async fn request_upnp_port(state: tauri::State<'_, UpnpState>, port: u16, protocol: String) -> Result<bool, String> {
    Ok(state.map_port(port, &protocol).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_control_url() {
        let xml = r#"
            <root>
                <service>
                    <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                    <controlURL>/ctl/IPConn</controlURL>
                </service>
            </root>
        "#;
        let url = extract_control_url(xml, "urn:schemas-upnp-org:service:WANIPConnection:1");
        assert_eq!(url.as_deref(), Some("/ctl/IPConn"));
    }

    #[test]
    fn test_upnp_state_default() {
        let state = UpnpState::default();
        let status = state.status();
        assert!(!status.available);
        assert!(status.mapped_ports.is_empty());
    }
}
