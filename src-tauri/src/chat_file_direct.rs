//! One-use, consent-scoped TLS streams for directly reachable host candidates.
use crate::chat_files::{self, ChatFileState};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::{IpAddr, SocketAddr}, sync::{Arc, Mutex}, time::Duration};
use subtle::ConstantTimeEq;
use tauri::{ipc::Channel, Manager, State};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, task::AbortHandle, time::{timeout, Instant}};
use tokio_rustls::{rustls::{self, pki_types::{CertificateDer, PrivatePkcs8KeyDer, ServerName}}, TlsAcceptor, TlsConnector};

const SERVER_LIFETIME: Duration = Duration::from_secs(20);
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const BUFFER: usize = 256 * 1024;

#[derive(Default)]
pub struct DirectFileState(Mutex<HashMap<String, AbortHandle>>);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectFileOffer { pub address: String, pub port: u16, pub certificate: String, pub token: String }

#[derive(Serialize)]
pub struct DirectFileResult { bytes: u64, error: Option<String> }

fn direct_address(address: &str) -> Result<IpAddr, String> {
    if address.len() > 64 { return Err("Invalid direct peer address".into()); }
    let ip: IpAddr = address.parse().map_err(|_| "Invalid direct peer address")?;
    if crate::lan_signaling::usable_ip(ip) { Ok(ip) }
    else { Err("Unusable direct peer address".into()) }
}

fn validate_offer(offer: &DirectFileOffer) -> Result<Vec<u8>, String> {
    direct_address(&offer.address)?;
    if offer.port == 0 || offer.token.len() != 64 || !offer.token.bytes().all(|b| b.is_ascii_hexdigit()) ||
        offer.certificate.len() > 8192 { return Err("Invalid direct file offer".into()); }
    STANDARD.decode(&offer.certificate).map_err(|_| "Invalid direct file certificate".into())
}

async fn serve(listener: TcpListener, acceptor: TlsAcceptor, token: String, source: std::fs::File,
    size: u64) -> Result<(), String> {
    let deadline = Instant::now() + SERVER_LIFETIME;
    for _ in 0..8 {
        let (socket, _) = tokio::time::timeout_at(deadline, listener.accept()).await
            .map_err(|_| "Direct file offer expired")?.map_err(|e| e.to_string())?;
        socket.set_nodelay(true).map_err(|e| e.to_string())?;
        let handshake = async {
            let mut stream = acceptor.accept(socket).await.map_err(|e| e.to_string())?;
            let mut received = [0u8; 64];
            stream.read_exact(&mut received).await.map_err(|e| e.to_string())?;
            if !bool::from(received.ct_eq(token.as_bytes())) { return Err("Invalid file capability".into()); }
            Ok::<_, String>(stream)
        };
        let Ok(Ok(mut stream)) = timeout(Duration::from_secs(2), handshake).await else { continue; };
        drop(listener);
        let mut file = tokio::fs::File::from_std(source).take(size);
        let mut buffer = vec![0u8; BUFFER];
        let mut sent = 0;
        while sent < size {
            let count = file.read(&mut buffer).await.map_err(|e| e.to_string())?;
            if count == 0 { return Err("Source size changed".into()); }
            timeout(IO_TIMEOUT, stream.write_all(&buffer[..count])).await
                .map_err(|_| "Direct file send timed out")?.map_err(|e| e.to_string())?;
            sent += count as u64;
        }
        timeout(IO_TIMEOUT, stream.shutdown()).await.map_err(|_| "Direct file shutdown timed out")?
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("Direct file authentication limit reached".into())
}

#[tauri::command]
pub async fn offer_direct_chat_file(app: tauri::AppHandle, state: State<'_, ChatFileState>,
    direct: State<'_, DirectFileState>, id: String, source_id: String, address: String,
    size: u64) -> Result<DirectFileOffer, String> {
    if id.is_empty() || id.len() > 80 { return Err("Invalid transfer ID".into()); }
    let source = chat_files::open_direct_source(&state, &source_id, size)?;
    let listener = TcpListener::bind(SocketAddr::new(direct_address(&address)?, 0)).await.map_err(|e| e.to_string())?;
    let endpoint = listener.local_addr().map_err(|e| e.to_string())?;
    let generated = rcgen::generate_simple_self_signed(vec!["p2sharer-file.local".into()]).map_err(|e| e.to_string())?;
    let certificate = generated.cert.der().clone();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider).with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?.with_no_client_auth().with_single_cert(vec![certificate.clone()],
            PrivatePkcs8KeyDer::from(generated.key_pair.serialize_der()).into()).map_err(|e| e.to_string())?;
    let token = format!("{}{}", chat_files::random_id()?, chat_files::random_id()?);
    let offer = DirectFileOffer { address: endpoint.ip().to_string(), port: endpoint.port(),
        certificate: STANDARD.encode(certificate.as_ref()), token: token.clone() };
    let mut tasks = direct.0.lock().map_err(|e| e.to_string())?;
    tasks.retain(|_, task| !task.is_finished());
    if tasks.len() >= 8 || tasks.contains_key(&id) { return Err("Too many direct file transfers".into()); }
    let task_id = id.clone();
    // A gate prevents completion/removal racing registration in the managed map.
    let (start, started) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _ = started.await;
        let _ = serve(listener, TlsAcceptor::from(Arc::new(config)), token, source, size).await;
        if let Ok(mut tasks) = app.state::<DirectFileState>().0.lock() { tasks.remove(&task_id); }
    });
    tasks.insert(id, task.abort_handle());
    let _ = start.send(());
    Ok(offer)
}

async fn receive(app: &tauri::AppHandle, id: &str, address: IpAddr, offer: DirectFileOffer,
    certificate: Vec<u8>, size: u64, progress: Channel<u64>, bytes: &mut u64) -> Result<(), String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(certificate)).map_err(|e| e.to_string())?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?.with_root_certificates(roots).with_no_client_auth();
    let mut stream = timeout(Duration::from_secs(2), async {
        let socket = TcpStream::connect(SocketAddr::new(address, offer.port)).await?;
        socket.set_nodelay(true)?;
        TlsConnector::from(Arc::new(config)).connect(ServerName::try_from("p2sharer-file.local").unwrap(), socket).await
    }).await.map_err(|_| "Direct file connection timed out")?.map_err(|e| e.to_string())?;
    stream.write_all(offer.token.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; BUFFER];
    let mut last = Instant::now();
    while *bytes < size {
        let limit = BUFFER.min((size - *bytes) as usize);
        let mut filled = 0;
        // TLS can yield individual records. Coalesce them before synchronous disk writes,
        // while retaining a stall timeout per read rather than a minimum transfer speed.
        while filled < limit {
            let count = timeout(IO_TIMEOUT, stream.read(&mut buffer[filled..limit])).await
                .map_err(|_| "Direct file receive timed out")?.map_err(|e| e.to_string())?;
            if count == 0 { return Err("Incomplete direct file transfer".into()); }
            filled += count;
            if last.elapsed() >= Duration::from_millis(100) { break; }
        }
        *bytes = chat_files::write_download_bytes(&app.state::<ChatFileState>(), id, *bytes, &buffer[..filled])?;
        if last.elapsed() >= Duration::from_millis(100) {
            progress.send(*bytes).map_err(|e| e.to_string())?;
            last = Instant::now();
        }
    }
    progress.send(*bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn receive_direct_chat_file(app: tauri::AppHandle, direct: State<'_, DirectFileState>,
    id: String, address: String, offer: DirectFileOffer, size: u64, progress: Channel<u64>) -> Result<DirectFileResult, String> {
    chat_files::validate_direct_download(&app.state::<ChatFileState>(), &id, size)?;
    let address = direct_address(&address)?;
    if address != direct_address(&offer.address)? { return Err("Direct file endpoint mismatch".into()); }
    let certificate = validate_offer(&offer)?;
    let (start, started) = tokio::sync::oneshot::channel();
    let task_id = id.clone();
    let task_app = app.clone();
    let task = {
        let mut tasks = direct.0.lock().map_err(|e| e.to_string())?;
        tasks.retain(|_, task| !task.is_finished());
        if tasks.len() >= 8 || tasks.contains_key(&id) { return Err("Too many direct file transfers".into()); }
        let task = tokio::spawn(async move {
            let _ = started.await;
            let mut bytes = 0;
            let error = receive(&task_app, &task_id, address, offer, certificate, size, progress, &mut bytes).await.err();
            DirectFileResult { bytes, error }
        });
        tasks.insert(id.clone(), task.abort_handle());
        let _ = start.send(());
        task
    };
    let result = task.await.map_err(|e| e.to_string());
    if let Ok(mut tasks) = app.state::<DirectFileState>().0.lock() { tasks.remove(&id); }
    result
}

#[tauri::command]
pub fn cancel_direct_chat_file(state: State<'_, DirectFileState>, id: String) {
    if let Ok(mut tasks) = state.0.lock() { if let Some(task) = tasks.remove(&id) { task.abort(); } }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_routes_and_capabilities_are_bounded() {
        assert!(direct_address("192.0.2.1").is_ok());
        assert!(direct_address("2001:db8::1").is_ok());
        for address in ["127.0.0.1", "0.0.0.0", "::1", "localhost", "https://example.org"] {
            assert!(direct_address(address).is_err());
        }
        let mut offer = DirectFileOffer { address: "192.0.2.1".into(), port: 1,
            certificate: STANDARD.encode([1, 2, 3]), token: "a".repeat(64) };
        assert_eq!(validate_offer(&offer).unwrap(), [1, 2, 3]);
        offer.token.push('a');
        assert!(validate_offer(&offer).is_err());
    }

    #[tokio::test]
    async fn tls_stream_requires_the_pinned_certificate_and_one_use_capability() {
        let generated = rcgen::generate_simple_self_signed(vec!["p2sharer-file.local".into()]).unwrap();
        let certificate = generated.cert.der().clone();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let server = rustls::ServerConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().unwrap()
            .with_no_client_auth().with_single_cert(vec![certificate.clone()],
                PrivatePkcs8KeyDer::from(generated.key_pair.serialize_der()).into()).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(certificate).unwrap();
        let config = rustls::ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().unwrap()
            .with_root_certificates(roots).with_no_client_auth();
        let connector = TlsConnector::from(Arc::new(config));
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let path = std::env::temp_dir().join(format!("p2sharer-direct-{}.bin", chat_files::random_id().unwrap()));
        let expected = vec![0x93u8; BUFFER * 2 + 37];
        std::fs::write(&path, &expected).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let task = tokio::spawn(serve(listener, TlsAcceptor::from(Arc::new(server)), "a".repeat(64), file, expected.len() as u64));
        let untrusted = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().unwrap()
            .with_root_certificates(rustls::RootCertStore::empty()).with_no_client_auth();
        assert!(TlsConnector::from(Arc::new(untrusted)).connect(ServerName::try_from("p2sharer-file.local").unwrap(),
            TcpStream::connect(address).await.unwrap()).await.is_err());
        let mut wrong = connector.connect(ServerName::try_from("p2sharer-file.local").unwrap(),
            TcpStream::connect(address).await.unwrap()).await.unwrap();
        wrong.write_all(&[b'b'; 64]).await.unwrap();
        let mut byte = [0];
        assert!(!matches!(wrong.read(&mut byte).await, Ok(n) if n > 0));
        let mut stream = connector.connect(ServerName::try_from("p2sharer-file.local").unwrap(),
            TcpStream::connect(address).await.unwrap()).await.unwrap();
        stream.write_all(&[b'a'; 64]).await.unwrap();
        let mut received = Vec::new();
        stream.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, expected);
        task.await.unwrap().unwrap();
        assert!(TcpStream::connect(address).await.is_err());
        std::fs::remove_file(path).unwrap();
    }
}
