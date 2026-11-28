//! Native H264 -> RTP/SRTP. No decoded pixels or browser encoder enter this transport.
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, LazyLock,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;
use tokio::sync::Mutex;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine, APIBuilder,
    },
    data_channel::{
        data_channel_init::RTCDataChannelInit, data_channel_message::DataChannelMessage,
    },
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    interceptor::registry::Registry,
    peer_connection::policy::{
        bundle_policy::RTCBundlePolicy, ice_transport_policy::RTCIceTransportPolicy,
    },
    peer_connection::{
        configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
    rtcp::{
        payload_feedbacks::{
            full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
        },
        receiver_report::ReceiverReport,
    },
    rtp::{
        codecs::h264::H264Payloader,
        extension::{playout_delay_extension::PlayoutDelayExtension, HeaderExtension},
        header::Header,
        packet::Packet,
        packetizer::Payloader,
    },
    rtp_transceiver::{
        rtp_codec::{
            RTCRtpCodecCapability, RTCRtpCodecParameters, RTCRtpHeaderExtensionCapability,
            RTPCodecType,
        },
        RTCPFeedback,
    },
    track::track_local::{
        track_local_static_rtp::TrackLocalStaticRTP, TrackLocal, TrackLocalWriter,
    },
};

struct Route {
    pc: Arc<RTCPeerConnection>,
    session: String,
    token: String,
    active: Arc<AtomicBool>,
    budget: AtomicU32,
    cap: AtomicU32,
    bitrate: Arc<AtomicU32>,
    frames: AtomicU64,
    bytes: AtomicU64,
    keys: AtomicU64,
    gaps: AtomicU64,
    started: Instant,
    local_candidates: Arc<AtomicU64>,
    remote_candidates: AtomicU64,
    remote_ice_errors: AtomicU64,
    #[cfg(feature = "media-diagnostics")]
    diagnostics: RouteDiagnostics,
}

/// Allowlisted statistics only: never serialize native reports, candidate IDs,
/// addresses, ports, URLs, certificates or SDP into the session log.
fn summarize_native_ice(stats: &webrtc::stats::StatsReport) -> serde_json::Value {
    use webrtc::stats::StatsReportType;
    let mut candidates = HashMap::new();
    let (mut local, mut remote) = (0, 0);
    for (id, report) in &stats.reports {
        let (side, candidate) = match report {
            StatsReportType::LocalCandidate(c) => {
                local += 1;
                ("local", c)
            }
            StatsReportType::RemoteCandidate(c) => {
                remote += 1;
                ("remote", c)
            }
            _ => continue,
        };
        let family = match candidate.ip.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V4(_)) => "ipv4",
            Ok(std::net::IpAddr::V6(_)) => "ipv6",
            Err(_) => "unknown",
        };
        candidates.insert(
            id,
            serde_json::json!({ "side": side, "type": candidate.candidate_type.to_string(),
            "network": candidate.network_type.to_string(), "family": family }),
        );
    }
    let mut pairs: Vec<_> = stats
        .reports
        .values()
        .filter_map(|report| match report {
            StatsReportType::CandidatePair(pair) => Some(pair),
            _ => None,
        })
        .collect();
    pairs.sort_by_key(|pair| {
        (
            std::cmp::Reverse(pair.nominated),
            std::cmp::Reverse(pair.responses_received),
        )
    });
    serde_json::json!({ "schema": 1, "localCandidates": local, "remoteCandidates": remote,
        "candidateInventory": candidates.values().take(64).collect::<Vec<_>>(),
        "omittedCandidates": candidates.len().saturating_sub(64),
        "pairCount": pairs.len(), "omittedPairs": pairs.len().saturating_sub(24),
        "requestsSent": pairs.iter().map(|p| p.requests_sent).sum::<u64>(),
        "responsesReceived": pairs.iter().map(|p| p.responses_received).sum::<u64>(),
        "requestsReceived": pairs.iter().map(|p| p.requests_received).sum::<u64>(),
        "responsesSent": pairs.iter().map(|p| p.responses_sent).sum::<u64>(),
        "pairs": pairs.iter().take(24).map(|p| serde_json::json!({
            "state": p.state.to_string(), "nominated": p.nominated,
            "local": candidates.get(&p.local_candidate_id), "remote": candidates.get(&p.remote_candidate_id),
            "requestsSent": p.requests_sent, "responsesReceived": p.responses_received,
            "requestsReceived": p.requests_received, "responsesSent": p.responses_sent,
            "bytesSent": p.bytes_sent, "bytesReceived": p.bytes_received,
            "rttSeconds": p.current_round_trip_time,
        })).collect::<Vec<_>>() })
}

async fn log_native_route(id: &str, route: &Route, phase: &str) {
    let connection = route.pc.connection_state().to_string();
    let ice = route.pc.ice_connection_state().to_string();
    let dtls = route.pc.sctp().transport().state().to_string();
    let stats = match tokio::time::timeout(Duration::from_millis(750), route.pc.get_stats()).await {
        Ok(stats) => summarize_native_ice(&stats),
        Err(_) => serde_json::json!({ "status": "timeout" }),
    };
    crate::logger::log_msg("INFO", "transmission.native.ice", &serde_json::json!({
        "routeId": id, "phase": phase, "elapsedMs": route.started.elapsed().as_millis(),
        "connection": connection, "ice": ice, "dtls": dtls,
        "gathering": route.pc.ice_gathering_state().to_string(),
        "generatedCandidates": route.local_candidates.load(Ordering::Relaxed),
        "appliedCandidates": route.remote_candidates.load(Ordering::Relaxed),
        "candidateErrors": route.remote_ice_errors.load(Ordering::Relaxed),
        "frames": route.frames.load(Ordering::Relaxed), "bytes": route.bytes.load(Ordering::Relaxed),
        "routes": stats,
    }).to_string());
}

#[cfg(feature = "media-diagnostics")]
struct RouteDiagnostics {
    track: u32,
    loss: AtomicU32,
    rtt_us: AtomicU64,
    baseline_rtt_us: AtomicU64,
    queued: AtomicBool,
    reports: AtomicU64,
}

static ROUTES: LazyLock<Mutex<HashMap<String, Arc<Route>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    urls: Vec<String>,
    #[serde(default)]
    username: String,
    #[serde(default)]
    credential: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalEvent {
    id: String,
    kind: String,
    candidate: Option<RTCIceCandidateInit>,
    reason: Option<String>,
}

fn initial_rate(budget: u32, width: u32, height: u32, fps: u32) -> u32 {
    // Start close to the configured user budget while scaling the minimum floor
    // to picture geometry so text and edges are sharp from the first second.
    let geometry_floor = if width > 0 && height > 0 {
        let rate =
            4_000_000u64 * u64::from(width) * u64::from(height) * u64::from(fps.clamp(15, 120))
                / (1280 * 720 * 60);
        rate.clamp(2_000_000, 16_000_000) as u32
    } else {
        2_000_000
    };
    let budget_start = (u64::from(budget) * 70 / 100) as u32;
    geometry_floor.max(budget_start).min(budget)
}

/// Computes nanosecond wire-pacing credit per RTP packet using a burst multiplier
/// above the encoded bitrate so delta frames flush immediately while large IDRs
/// avoid overflowing UDP socket buffers.
fn packet_pacing_ns(payload_bytes: usize, bitrate: u32) -> u64 {
    let burst_bps = u64::from(bitrate)
        .max(100_000)
        .saturating_mul(3)
        .clamp(50_000_000, 120_000_000);
    let wire_bits = (payload_bytes as u64).saturating_add(64).saturating_mul(8);
    wire_bits.saturating_mul(1_000_000_000) / burst_bps
}

fn native_candidate_available(ip: std::net::IpAddr) -> bool {
    !ip.is_unspecified() && !ip.is_multicast() && std::net::UdpSocket::bind((ip, 0)).is_ok()
}

/// Cap STUN URLs to at most two distinct servers so multi-interface hosts do not
/// duplicate reflexive candidates across six public endpoints while keeping all TURN servers.
fn trim_native_ice_servers(ice_servers: Vec<IceServer>) -> Vec<RTCIceServer> {
    let mut seen_stun = std::collections::HashSet::new();
    let mut result = Vec::with_capacity(ice_servers.len());
    for server in ice_servers {
        let mut urls = Vec::with_capacity(server.urls.len());
        for url in server.urls {
            let normalized = url.trim().to_ascii_lowercase();
            if normalized.starts_with("stun:") {
                if seen_stun.len() < 2 && seen_stun.insert(normalized) {
                    urls.push(url);
                }
            } else {
                urls.push(url);
            }
        }
        if !urls.is_empty() {
            result.push(RTCIceServer {
                urls,
                username: server.username,
                credential: server.credential,
            });
        }
    }
    result
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'-' || v == b'_')
}
async fn route(id: &str, token: &str) -> Result<Arc<Route>, String> {
    let routes = ROUTES.lock().await;
    let value = routes.get(id).ok_or("Native route no longer exists")?;
    if value.token != token {
        return Err("Native route token mismatch".into());
    }
    Ok(value.clone())
}
async fn update_budget(session: &str, token: &str) {
    let routes = ROUTES.lock().await;
    let budget = routes
        .values()
        .filter(|r| r.session == session && r.token == token && r.active.load(Ordering::Relaxed))
        .map(|r| {
            r.cap
                .load(Ordering::Relaxed)
                .min(r.budget.load(Ordering::Relaxed))
        })
        .min();
    if let Some(budget) = budget {
        for r in routes
            .values()
            .filter(|r| r.session == session && r.token == token)
        {
            r.bitrate
                .store(budget.clamp(100_000, 50_000_000), Ordering::Relaxed);
        }
    }
}

async fn attach_rc_channel(
    pc: &RTCPeerConnection,
    label: &str,
    max_retransmits: u16,
    lane_is_datagram: bool,
    peer_id: &str,
    media_id: &str,
    session_id: &str,
    live: Arc<AtomicBool>,
) -> Result<(), String> {
    let channel = pc
        .create_data_channel(
            label,
            Some(RTCDataChannelInit {
                ordered: Some(false),
                max_retransmits: Some(max_retransmits),
                ..Default::default()
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    let peer = peer_id.to_string();
    let media = media_id.to_string();
    let session = session_id.to_string();
    let seq_state = Arc::new(std::sync::Mutex::new(
        crate::remote_control::NativeInputSeqState::default(),
    ));
    channel.on_message(Box::new(move |msg: DataChannelMessage| {
        let active = live.clone();
        let peer = peer.clone();
        let media = media.clone();
        let session = session.clone();
        let seq_state = seq_state.clone();
        Box::pin(async move {
            if !active.load(Ordering::Relaxed) || !crate::remote_control::is_host_control_active() {
                return;
            }
            if let Ok(mut seq) = seq_state.lock() {
                let _ = crate::remote_control::apply_native_datachannel_input(
                    &peer,
                    &media,
                    &session,
                    lane_is_datagram,
                    &mut seq,
                    &msg.data,
                );
            }
        })
    }));
    Ok(())
}

#[tauri::command]
pub async fn create_native_video_offer(
    app: tauri::AppHandle,
    id: String,
    session_id: String,
    feedback_token: String,
    peer_id: Option<String>,
    stream_id: String,
    track_id: String,
    bitrate: u32,
    ice_servers: Vec<IceServer>,
    relay_only: bool,
) -> Result<String, String> {
    if !valid_id(&id)
        || !valid_id(&stream_id)
        || !valid_id(&track_id)
        || peer_id
            .as_ref()
            .is_some_and(|p| p.is_empty() || p.len() > 240)
        || !(100_000..=50_000_000).contains(&bitrate)
        || ice_servers.len() > 8
    {
        return Err("Invalid native video offer parameters".into());
    }
    let capture = crate::screen_sources::encoded_capture(&session_id, &feedback_token)?;
    let mut routes = ROUTES.lock().await;
    if routes.contains_key(&id) || routes.len() >= 128 {
        return Err("Native route limit reached or ID reused".into());
    }
    let mut engine = MediaEngine::default();
    let rtcp_feedback = vec![
        RTCPFeedback {
            typ: "nack".into(),
            parameter: String::new(),
        },
        RTCPFeedback {
            typ: "nack".into(),
            parameter: "pli".into(),
        },
        RTCPFeedback {
            typ: "ccm".into(),
            parameter: "fir".into(),
        },
    ];
    for (payload_type, fmtp) in [
        (
            102u8,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640033",
        ),
        (
            103u8,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d0033",
        ),
        (
            104u8,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ),
        (
            105u8,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
        ),
    ] {
        engine
            .register_codec(
                RTCRtpCodecParameters {
                    capability: RTCRtpCodecCapability {
                        mime_type: "video/H264".into(),
                        clock_rate: 90_000,
                        sdp_fmtp_line: fmtp.into(),
                        rtcp_feedback: rtcp_feedback.clone(),
                        ..Default::default()
                    },
                    payload_type,
                    ..Default::default()
                },
                RTPCodecType::Video,
            )
            .map_err(|e| e.to_string())?;
    }
    // Leave sdp_fmtp_line empty on TrackLocalStaticRTP so webrtc-rs binds to whichever
    // H.264 profile the remote receiver accepts and rewrites packet payload_type automatically.
    let codec = RTCRtpCodecCapability {
        mime_type: "video/H264".into(),
        clock_rate: 90_000,
        rtcp_feedback,
        ..Default::default()
    };
    engine
        .register_header_extension(
            RTCRtpHeaderExtensionCapability {
                uri: "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay".into(),
            },
            RTPCodecType::Video,
            None,
        )
        .map_err(|e| e.to_string())?;
    let registry =
        register_default_interceptors(Registry::new(), &mut engine).map_err(|e| e.to_string())?;
    let mut setting = webrtc::api::setting_engine::SettingEngine::default();
    setting.set_network_types(vec![
        webrtc::ice::network_type::NetworkType::Udp4,
        webrtc::ice::network_type::NetworkType::Udp6,
        webrtc::ice::network_type::NetworkType::Tcp4,
        webrtc::ice::network_type::NetworkType::Tcp6,
    ]);
    // Windows can enumerate addresses from detached/retired adapters. Keep only
    // addresses that can actually own a local socket, including usable LAN/VPNs.
    setting.set_ip_filter(Box::new(native_candidate_available));
    setting.set_ice_timeouts(
        Some(Duration::from_secs(6)),
        Some(Duration::from_secs(18)),
        Some(Duration::from_secs(2)),
    );
    let api = APIBuilder::new()
        .with_media_engine(engine)
        .with_interceptor_registry(registry)
        .with_setting_engine(setting)
        .build();
    let servers = trim_native_ice_servers(ice_servers);
    let pc = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers: servers,
            bundle_policy: RTCBundlePolicy::MaxBundle,
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
    let live = Arc::new(AtomicBool::new(true));
    let local_candidates = Arc::new(AtomicU64::new(0));
    let geometry = capture.load.snapshot();
    let value = Arc::new(Route {
        pc: pc.clone(),
        session: session_id.clone(),
        token: feedback_token,
        active: live.clone(),
        budget: AtomicU32::new(bitrate),
        cap: AtomicU32::new(initial_rate(
            bitrate,
            geometry.output_width,
            geometry.output_height,
            geometry.effective_fps,
        )),
        bitrate: capture.bitrate.clone(),
        frames: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        keys: AtomicU64::new(0),
        gaps: AtomicU64::new(0),
        started: Instant::now(),
        local_candidates: local_candidates.clone(),
        remote_candidates: AtomicU64::new(0),
        remote_ice_errors: AtomicU64::new(0),
        #[cfg(feature = "media-diagnostics")]
        diagnostics: RouteDiagnostics {
            track: crate::media_diagnostics::opaque_id(&track_id),
            loss: AtomicU32::new(0),
            rtt_us: AtomicU64::new(0),
            baseline_rtt_us: AtomicU64::new(0),
            queued: AtomicBool::new(false),
            reports: AtomicU64::new(0),
        },
    });
    let media_id = stream_id.clone();
    let track = Arc::new(TrackLocalStaticRTP::new(codec, track_id, stream_id));
    let sender = match pc
        .add_track(track.clone() as Arc<dyn TrackLocal + Send + Sync>)
        .await
    {
        Ok(sender) => sender,
        Err(e) => {
            let _ = pc.close().await;
            return Err(e.to_string());
        }
    };
    if let Some(ref peer) = peer_id {
        for (label, retransmits, is_dgram) in
            [("p2_rc_datagram", 0u16, true), ("p2_rc_input", 2u16, false)]
        {
            if let Err(e) = attach_rc_channel(
                &pc,
                label,
                retransmits,
                is_dgram,
                peer,
                &media_id,
                &session_id,
                live.clone(),
            )
            .await
            {
                let _ = pc.close().await;
                return Err(e);
            }
        }
    }
    let ice_app = app.clone();
    let ice_id = id.clone();
    pc.on_ice_candidate(Box::new(move |candidate| {
        let app = ice_app.clone();
        let id = ice_id.clone();
        let generated = local_candidates.clone();
        Box::pin(async move {
            if let Some(candidate) = candidate {
                generated.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut candidate) = candidate.to_json() {
                    candidate.sdp_mid = Some("0".into());
                    let _ = app.emit(
                        "native-video-signal",
                        SignalEvent {
                            id,
                            kind: "ice".into(),
                            candidate: Some(candidate),
                            reason: None,
                        },
                    );
                }
            }
        })
    }));
    let state_app = app.clone();
    let ice_state_id = id.clone();
    let ice_state_route = Arc::downgrade(&value);
    pc.on_ice_connection_state_change(Box::new(move |state| {
        let id = ice_state_id.clone();
        let route = ice_state_route.upgrade();
        Box::pin(async move {
            if let Some(route) = route {
                crate::logger::log_msg(
                    "INFO",
                    "transmission.native.ice",
                    &serde_json::json!({
                        "routeId": id, "phase": "ice_state", "ice": state.to_string(),
                        "elapsedMs": route.started.elapsed().as_millis(),
                        "generatedCandidates": route.local_candidates.load(Ordering::Relaxed),
                        "appliedCandidates": route.remote_candidates.load(Ordering::Relaxed),
                    })
                    .to_string(),
                );
            }
        })
    }));
    let state_id = id.clone();
    let state_key = capture.keyframe.clone();
    let state_wgc_thread = capture.wgc_thread_id.clone();
    let diagnostic_route = Arc::downgrade(&value);
    pc.on_peer_connection_state_change(Box::new(move |state| {
        let app = state_app.clone();
        let id = state_id.clone();
        let key = state_key.clone();
        let wgc_thread = state_wgc_thread.clone();
        let diagnostic_route = diagnostic_route.clone();
        Box::pin(async move {
            crate::logger::log_msg(
                "INFO",
                "transmission.native.ice",
                &format!("Native sender state routeId={id} connection={state}"),
            );
            if state == RTCPeerConnectionState::Connected {
                crate::screen_sources::request_capture_keyframe(&key, &wgc_thread);
                if let Some(route) = diagnostic_route.upgrade() {
                    let id = id.clone();
                    tokio::spawn(async move {
                        log_native_route(&id, &route, "connected").await;
                    });
                }
            }
            if matches!(
                state,
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
            ) {
                let _ = app.emit(
                    "native-video-signal",
                    SignalEvent {
                        id,
                        kind: "failed".into(),
                        candidate: None,
                        reason: Some(state.to_string()),
                    },
                );
            }
        })
    }));
    routes.insert(id.clone(), value.clone());
    drop(routes);
    update_budget(&session_id, &value.token).await;
    let offer_result = async {
        let offer = pc.create_offer(None).await?;
        let sdp = offer.sdp.clone();
        pc.set_local_description(offer).await?;
        Ok::<_, webrtc::Error>(sdp)
    }
    .await;
    let sdp = match offer_result {
        Ok(sdp) => sdp,
        Err(e) => {
            close_native_video(id, value.token.clone()).await?;
            return Err(e.to_string());
        }
    };

    let rtcp_value = value.clone();
    let rtcp_key = capture.keyframe.clone();
    let rtcp_wgc_thread = capture.wgc_thread_id.clone();
    tokio::spawn(async move {
        let mut last_key = Instant::now() - Duration::from_secs(1);
        let mut last_adjust = Instant::now();
        let mut baseline_rtt = f64::INFINITY;
        while rtcp_value.active.load(Ordering::Relaxed) {
            let Ok((packets, _)) = sender.read_rtcp().await else {
                break;
            };
            let mut cap = rtcp_value.cap.load(Ordering::Relaxed);
            for p in packets {
                if (p.as_any().is::<PictureLossIndication>() || p.as_any().is::<FullIntraRequest>())
                    && last_key.elapsed() >= Duration::from_millis(250)
                {
                    crate::screen_sources::request_capture_keyframe(&rtcp_key, &rtcp_wgc_thread);
                    last_key = Instant::now();
                }
                if let Some(rr) = p.as_any().downcast_ref::<ReceiverReport>() {
                    #[cfg(feature = "media-diagnostics")]
                    rtcp_value
                        .diagnostics
                        .reports
                        .fetch_add(1, Ordering::Relaxed);
                    if last_adjust.elapsed() >= Duration::from_millis(1000) {
                        let loss = rr
                            .reports
                            .iter()
                            .map(|r| r.fraction_lost)
                            .max()
                            .unwrap_or(0);
                        let rtt = rr
                            .reports
                            .iter()
                            .filter_map(|r| report_rtt(r.last_sender_report, r.delay))
                            .reduce(f64::max);
                        if let Some(rtt) = rtt {
                            baseline_rtt = baseline_rtt.min(rtt);
                        }
                        let queued = rtt.is_some_and(|rtt| {
                            rtt > baseline_rtt + 0.080 && rtt > baseline_rtt * 1.6
                        });
                        #[cfg(feature = "media-diagnostics")]
                        {
                            let d = &rtcp_value.diagnostics;
                            d.loss.store(u32::from(loss), Ordering::Relaxed);
                            d.rtt_us.store(
                                (rtt.unwrap_or(0.0) * 1_000_000.0) as u64,
                                Ordering::Relaxed,
                            );
                            d.baseline_rtt_us.store(
                                (if baseline_rtt.is_finite() {
                                    baseline_rtt * 1_000_000.0
                                } else {
                                    0.0
                                }) as u64,
                                Ordering::Relaxed,
                            );
                            d.queued.store(queued, Ordering::Relaxed);
                        }
                        cap = adjust_rate(
                            cap,
                            rtcp_value.budget.load(Ordering::Relaxed),
                            if queued { loss.max(13) } else { loss },
                        );
                        last_adjust = Instant::now();
                    }
                }
            }
            if cap != rtcp_value.cap.swap(cap, Ordering::Relaxed) {
                update_budget(&rtcp_value.session, &rtcp_value.token).await;
            }
        }
    });
    tokio::spawn(async move {
        let _route_guard = capture.route_guard.clone();
        let mut rx = capture.frames;
        let mut gate = FrameGate::default();
        let mut payloader = H264Payloader::default();
        let mut seed = [0u8; 6];
        let _ = getrandom::getrandom(&mut seed);
        let mut sequence = u16::from_le_bytes(seed[..2].try_into().unwrap());
        let timestamp_origin = u32::from_le_bytes(seed[2..].try_into().unwrap());
        let mut first_time = None;
        let mut next_packet = tokio::time::Instant::now();
        let mut send_failures = 0;
        let mut recovery_age = RecoveryAgeBudget::default();
        let mut last_key = Instant::now() - Duration::from_secs(1);
        while live.load(Ordering::Relaxed) && capture.active.load(Ordering::Relaxed) {
            let packet = match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
                Ok(Ok(tokio_tungstenite::tungstenite::Message::Binary(p))) => p,
                Ok(Ok(_)) | Err(_) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                    gate.wait_key = true;
                    crate::screen_sources::request_capture_keyframe(
                        &capture.keyframe,
                        &capture.wgc_thread_id,
                    );
                    continue;
                }
                _ => break,
            };
            if packet.len() <= 4 {
                continue;
            }
            let Some(frame) = EncodedFrame::parse(&packet) else {
                break;
            };
            if pc.connection_state() != RTCPeerConnectionState::Connected {
                gate.wait_key = true;
                continue;
            }
            let age_us = capture
                .load
                .elapsed_ms()
                .saturating_mul(1000)
                .saturating_sub(frame.timestamp);
            let max_age_us = if gate.wait_key && frame.key {
                // Allow a higher latency ceiling for an initial/recovery IDR so slow hardware
                // encoders (>100 ms/frame) do not loop forever dropping keyframes and spamming IDRs.
                recovery_age.limit_us(Instant::now()).max(500_000)
            } else {
                recovery_age.limit_us(Instant::now())
            };
            if age_us > max_age_us {
                gate.wait_key = true;
                value.gaps.fetch_add(1, Ordering::Relaxed);
                if last_key.elapsed() >= Duration::from_millis(250) {
                    crate::screen_sources::request_capture_keyframe(
                        &capture.keyframe,
                        &capture.wgc_thread_id,
                    );
                    last_key = Instant::now();
                }
                continue;
            }
            let decision = gate.accept(&frame);
            if decision == Decision::Recover {
                value.gaps.fetch_add(1, Ordering::Relaxed);
                if last_key.elapsed() >= Duration::from_millis(250) {
                    crate::screen_sources::request_capture_keyframe(
                        &capture.keyframe,
                        &capture.wgc_thread_id,
                    );
                    last_key = Instant::now();
                }
                continue;
            }
            if decision == Decision::Skip {
                continue;
            }
            let Some(timestamp) = rtp_timestamp(
                timestamp_origin,
                *first_time.get_or_insert(frame.timestamp),
                frame.timestamp,
            ) else {
                gate.wait_key = true;
                continue;
            };
            let Ok(payloads) = payloader.payload(1188, &Bytes::copy_from_slice(frame.payload))
            else {
                gate.wait_key = true;
                continue;
            };
            let count = payloads.len();
            let send_started = Instant::now();
            let deadline = tokio::time::Instant::now()
                + Duration::from_millis(if frame.key { 200 } else { 80 });
            let mut complete = true;
            let current_bitrate = value.bitrate.load(Ordering::Relaxed);
            // Burst small delta frames directly at socket speed and sleep only when
            // pacing credit exceeds 1 ms during large keyframes or scene cuts.
            next_packet = next_packet.max(tokio::time::Instant::now());
            for (index, payload) in payloads.into_iter().enumerate() {
                let now = tokio::time::Instant::now();
                if next_packet > deadline {
                    complete = false;
                    break;
                }
                if next_packet > now + Duration::from_micros(1000) {
                    tokio::time::sleep_until(next_packet).await;
                }
                let bytes = payload.len();
                let packet = Packet {
                    header: Header {
                        version: 2,
                        payload_type: 102,
                        marker: index + 1 == count,
                        sequence_number: sequence,
                        timestamp,
                        ..Default::default()
                    },
                    payload,
                };
                sequence = sequence.wrapping_add(1);
                let write_result = if index == 0 {
                    let ext = [HeaderExtension::PlayoutDelay(PlayoutDelayExtension {
                        min_delay: 0,
                        max_delay: 0,
                    })];
                    tokio::time::timeout_at(
                        deadline,
                        track.write_rtp_with_extensions(&packet, &ext),
                    )
                    .await
                } else {
                    tokio::time::timeout_at(deadline, track.write_rtp(&packet)).await
                };
                if !matches!(write_result, Ok(Ok(_))) {
                    complete = false;
                    break;
                }
                value.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
                next_packet += Duration::from_nanos(packet_pacing_ns(bytes, current_bitrate));
            }
            if !complete {
                gate.wait_key = true;
                crate::screen_sources::request_capture_keyframe(
                    &capture.keyframe,
                    &capture.wgc_thread_id,
                );
                send_failures += 1;
                if send_failures >= 3 {
                    break;
                }
                continue;
            }
            send_failures = 0;
            value.frames.fetch_add(1, Ordering::Relaxed);
            if frame.key {
                value.keys.fetch_add(1, Ordering::Relaxed);
                recovery_age.sent_key(Instant::now(), send_started.elapsed());
            }
        }
        if live.load(Ordering::Relaxed) {
            let _ = app.emit(
                "native-video-signal",
                SignalEvent {
                    id: id.clone(),
                    kind: "failed".into(),
                    candidate: None,
                    reason: Some("Native capture ended or selected generic fallback".into()),
                },
            );
            let _ = close_native_video(id, value.token.clone()).await;
        }
    });
    Ok(sdp)
}

fn normalize_answer_sdp_ice(sdp: &str) -> String {
    let sep = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    let trailing_sep = sdp.ends_with('\n');
    let raw_lines: Vec<&str> = sdp.lines().collect();
    let mut in_media = false;
    let mut active_section = false;
    let mut primary_ufrag: Option<String> = None;
    let mut primary_pwd: Option<String> = None;
    let mut fallback_ufrag: Option<String> = None;
    let mut fallback_pwd: Option<String> = None;
    for line in &raw_lines {
        if let Some(rest) = line.strip_prefix("m=") {
            in_media = true;
            let port = rest.split_whitespace().nth(1);
            active_section = port != Some("0");
            continue;
        }
        if let Some(val) = line.strip_prefix("a=ice-ufrag:") {
            if !in_media || active_section {
                if primary_ufrag.is_none() {
                    primary_ufrag = Some(val.to_string());
                }
            } else if fallback_ufrag.is_none() {
                fallback_ufrag = Some(val.to_string());
            }
        } else if let Some(val) = line.strip_prefix("a=ice-pwd:") {
            if !in_media || active_section {
                if primary_pwd.is_none() {
                    primary_pwd = Some(val.to_string());
                }
            } else if fallback_pwd.is_none() {
                fallback_pwd = Some(val.to_string());
            }
        }
    }
    let chosen_ufrag = primary_ufrag.or(fallback_ufrag);
    let chosen_pwd = primary_pwd.or(fallback_pwd);
    let mut out: Vec<String> = Vec::with_capacity(raw_lines.len());
    for line in raw_lines {
        if line.starts_with("a=ice-ufrag:") {
            if let Some(ref u) = chosen_ufrag {
                out.push(format!("a=ice-ufrag:{u}"));
                continue;
            }
        } else if line.starts_with("a=ice-pwd:") {
            if let Some(ref p) = chosen_pwd {
                out.push(format!("a=ice-pwd:{p}"));
                continue;
            }
        }
        out.push(line.to_string());
    }
    let mut joined = out.join(sep);
    if trailing_sep && !joined.is_empty() {
        joined.push_str(sep);
    }
    joined
}

#[tauri::command]
pub async fn answer_native_video(
    id: String,
    feedback_token: String,
    sdp: String,
) -> Result<(), String> {
    if sdp.len() > 128 * 1024 {
        return Err("Answer too large".into());
    }
    let normalized = normalize_answer_sdp_ice(&sdp);
    route(&id, &feedback_token)
        .await?
        .pc
        .set_remote_description(
            RTCSessionDescription::answer(normalized).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn add_native_video_ice(
    id: String,
    feedback_token: String,
    candidate: RTCIceCandidateInit,
) -> Result<(), String> {
    if candidate.candidate.len() > 4096 {
        return Err("Candidate too large".into());
    }
    let r = route(&id, &feedback_token).await?;
    let result = r.pc.add_ice_candidate(candidate).await;
    if result.is_ok() {
        r.remote_candidates.fetch_add(1, Ordering::Relaxed);
    } else {
        r.remote_ice_errors.fetch_add(1, Ordering::Relaxed);
    }
    result.map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn set_native_video_bitrate(
    id: String,
    feedback_token: String,
    bitrate: u32,
) -> Result<(), String> {
    if !(100_000..=50_000_000).contains(&bitrate) {
        return Err("Invalid bitrate".into());
    }
    let r = route(&id, &feedback_token).await?;
    r.budget.store(bitrate, Ordering::Relaxed);
    r.cap.fetch_min(bitrate, Ordering::Relaxed);
    update_budget(&r.session, &r.token).await;
    Ok(())
}
#[tauri::command]
pub async fn close_native_video(id: String, feedback_token: String) -> Result<(), String> {
    let mut routes = ROUTES.lock().await;
    let Some(r) = routes.get(&id) else {
        return Ok(());
    };
    if r.token != feedback_token {
        return Err("Native route token mismatch".into());
    }
    let r = routes.remove(&id).unwrap();
    drop(routes);
    r.active.store(false, Ordering::Relaxed);
    // Sample before close destroys the ICE checklist. No per-frame polling.
    log_native_route(&id, &r, "before_close").await;
    r.bitrate
        .store(r.budget.load(Ordering::Relaxed), Ordering::Relaxed);
    let result = r.pc.close().await.map_err(|e| e.to_string());
    update_budget(&r.session, &r.token).await;
    result
}
#[tauri::command]
pub async fn get_native_video_stats(
    id: String,
    feedback_token: String,
) -> Result<serde_json::Value, String> {
    let r = route(&id, &feedback_token).await?;
    Ok(
        serde_json::json!({ "state": r.pc.connection_state().to_string(), "frames": r.frames.load(Ordering::Relaxed),
        "bytes": r.bytes.load(Ordering::Relaxed), "keyframes": r.keys.load(Ordering::Relaxed), "gaps": r.gaps.load(Ordering::Relaxed),
        "encoderBitrate": r.bitrate.load(Ordering::Relaxed), "budget": r.budget.load(Ordering::Relaxed), "cap": r.cap.load(Ordering::Relaxed), "routeCount": ROUTES.lock().await.len() }),
    )
}

fn adjust_rate(cap: u32, budget: u32, loss: u8) -> u32 {
    let next = if loss >= 13 {
        cap.saturating_mul(80) / 100
    } else if loss <= 2 {
        cap.saturating_add((cap / 3).max(200_000))
    } else {
        cap
    };
    next.clamp(100_000, budget)
}
fn report_rtt(last_sr: u32, delay: u32) -> Option<f64> {
    if last_sr == 0 {
        return None;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    let compact = (((now.as_secs() + 2_208_988_800) & 0xffff) as u32) << 16
        | ((u64::from(now.subsec_nanos()) * 65_536 / 1_000_000_000) as u32);
    let rtt = compact.wrapping_sub(last_sr).wrapping_sub(delay) as f64 / 65_536.0;
    if rtt <= 10.0 {
        Some(rtt)
    } else {
        None
    }
}
fn rtp_timestamp(origin: u32, first: u64, timestamp: u64) -> Option<u32> {
    let elapsed = timestamp.checked_sub(first)?;
    Some(
        origin.wrapping_add(
            ((u128::from(elapsed) * 90_000 / 1_000_000) & u128::from(u32::MAX)) as u32,
        ),
    )
}
struct EncodedFrame<'a> {
    sequence: u32,
    timestamp: u64,
    key: bool,
    width: u32,
    height: u32,
    payload: &'a [u8],
}
impl<'a> EncodedFrame<'a> {
    fn parse(p: &'a [u8]) -> Option<Self> {
        if p.len() <= 28
            || p.len() > 16 * 1024 * 1024 + 28
            || &p[..5] != b"P2NV\x01"
            || p[5] > 1
            || p[6] != 0
            || p[7] != 0
        {
            return None;
        }
        let width = u32::from_le_bytes(p[8..12].try_into().ok()?);
        let height = u32::from_le_bytes(p[12..16].try_into().ok()?);
        if width == 0 || height == 0 || width > 8192 || height > 8192 {
            return None;
        }
        Some(Self {
            sequence: u32::from_le_bytes(p[16..20].try_into().ok()?),
            timestamp: u64::from_le_bytes(p[20..28].try_into().ok()?),
            key: p[5] == 1,
            width,
            height,
            payload: &p[28..],
        })
    }
}
/// A bounded keyframe burst must not make its dependent pictures request another
/// key immediately. With 20% payload headroom, retire that serialization allowance
/// over at most 600 ms. Ordinary queue age stays at 100 ms; no send deadline grows.
#[derive(Default)]
struct RecoveryAgeBudget {
    completed: Option<Instant>,
    serialization_us: u64,
}
impl RecoveryAgeBudget {
    fn sent_key(&mut self, now: Instant, duration: Duration) {
        self.completed = Some(now);
        self.serialization_us = (duration.as_micros().min(120_000)) as u64;
    }
    fn limit_us(&self, now: Instant) -> u64 {
        let retired = self.completed.map_or(u64::MAX, |completed| {
            (now.saturating_duration_since(completed).as_micros() / 5).min(u64::MAX as u128) as u64
        });
        100_000 + self.serialization_us.saturating_sub(retired)
    }
}
#[derive(PartialEq, Debug)]
enum Decision {
    Send,
    Skip,
    Recover,
}
struct FrameGate {
    sequence: Option<u32>,
    dimensions: Option<(u32, u32)>,
    wait_key: bool,
}
impl Default for FrameGate {
    fn default() -> Self {
        Self {
            sequence: None,
            dimensions: None,
            wait_key: true,
        }
    }
}
impl FrameGate {
    fn accept(&mut self, frame: &EncodedFrame) -> Decision {
        if self.sequence == Some(frame.sequence) {
            return Decision::Skip;
        }
        if self
            .sequence
            .is_some_and(|s| frame.sequence != s.wrapping_add(1))
            || self
                .dimensions
                .is_some_and(|d| d != (frame.width, frame.height))
        {
            self.wait_key = true;
        }
        self.sequence = Some(frame.sequence);
        self.dimensions = Some((frame.width, frame.height));
        if self.wait_key && !frame.key {
            return Decision::Recover;
        }
        self.wait_key = false;
        Decision::Send
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_ice_diagnostics_allowlist_excludes_addresses_credentials_and_identifiers() {
        use webrtc::stats::{ICECandidateStats, RTCStatsType, StatsReport, StatsReportType};
        let candidate = ICECandidateStats {
            timestamp: tokio::time::Instant::now(),
            stats_type: RTCStatsType::LocalCandidate,
            id: "private-candidate-identifier".into(),
            candidate_type: webrtc::ice::candidate::CandidateType::Host,
            deleted: false,
            ip: "192.0.2.25".into(),
            network_type: webrtc::ice::network_type::NetworkType::Udp4,
            port: 23456,
            priority: 1,
            relay_protocol: "udp".into(),
            url: "fixture-url-not-for-logging".into(),
        };
        let stats = StatsReport {
            reports: HashMap::from([(
                "private-report-identifier".into(),
                StatsReportType::LocalCandidate(candidate),
            )]),
        };
        let summary = summarize_native_ice(&stats);
        assert_eq!(summary["localCandidates"], 1);
        assert_eq!(summary["remoteCandidates"], 0);
        assert_eq!(summary["pairCount"], 0);
        assert_eq!(summary["candidateInventory"][0]["family"], "ipv4");
        assert_eq!(summary["candidateInventory"][0]["type"], "host");
        let serialized = summary.to_string();
        for excluded in [
            "192.0.2.25",
            "23456",
            "private-candidate-identifier",
            "private-report-identifier",
            "fixture-url-not-for-logging",
        ] {
            assert!(!serialized.contains(excluded));
        }
    }
    #[test]
    fn native_candidates_require_a_bindable_unicast_address() {
        use std::net::{IpAddr, Ipv4Addr};
        assert!(native_candidate_available(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!native_candidate_available(IpAddr::V4(
            Ipv4Addr::UNSPECIFIED
        )));
        assert!(!native_candidate_available(IpAddr::V4(Ipv4Addr::new(
            224, 0, 0, 1
        ))));
    }
    #[test]
    fn startup_probe_scales_to_encoded_geometry_without_exceeding_user_budget() {
        assert_eq!(initial_rate(15_000_000, 1280, 720, 60), 10_500_000);
        assert_eq!(initial_rate(5_000_000, 1920, 1080, 60), 5_000_000);
        assert_eq!(initial_rate(3_000_000, 1920, 1080, 120), 3_000_000);
        assert_eq!(initial_rate(50_000_000, 3840, 2160, 120), 35_000_000);
        assert_eq!(initial_rate(800_000, 640, 360, 30), 800_000);
        assert_eq!(initial_rate(15_000_000, 0, 0, 60), 10_500_000);
        assert!(packet_pacing_ns(1188, 15_000_000) < 300_000);
    }
    #[test]
    fn recovery_age_allows_key_serialization_then_returns_to_normal_bound() {
        let now = Instant::now();
        let mut age = RecoveryAgeBudget::default();
        assert_eq!(age.limit_us(now), 100_000);
        age.sent_key(now, Duration::from_millis(110));
        assert_eq!(age.limit_us(now), 210_000);
        assert_eq!(age.limit_us(now + Duration::from_millis(250)), 160_000);
        assert_eq!(age.limit_us(now + Duration::from_millis(550)), 100_000);
        age.sent_key(now, Duration::from_secs(1));
        assert_eq!(age.limit_us(now), 220_000);
        assert_eq!(age.limit_us(now + Duration::from_millis(600)), 100_000);
    }
    #[test]
    fn dependency_gate_requires_keys_after_gaps_resize_and_restart() {
        let mut g = FrameGate::default();
        let mut f = EncodedFrame {
            sequence: u32::MAX,
            timestamp: 0,
            key: false,
            width: 180,
            height: 320,
            payload: &[0],
        };
        assert_eq!(g.accept(&f), Decision::Recover);
        f.sequence = 0;
        f.key = true;
        assert_eq!(g.accept(&f), Decision::Send);
        assert_eq!(g.accept(&f), Decision::Skip);
        f.sequence = 1;
        f.key = false;
        assert_eq!(g.accept(&f), Decision::Send);
        f.sequence = 3;
        assert_eq!(g.accept(&f), Decision::Recover);
        f.sequence = 4;
        f.key = true;
        assert_eq!(g.accept(&f), Decision::Send);
        f.sequence = 5;
        f.key = false;
        f.width = 320;
        assert_eq!(g.accept(&f), Decision::Recover);
    }
    #[test]
    fn congestion_rate_obeys_user_budget_and_recovers_gradually() {
        assert_eq!(adjust_rate(2_000_000, 15_000_000, 13), 1_600_000);
        assert_eq!(adjust_rate(2_000_000, 15_000_000, 0), 2_666_666);
        assert_eq!(adjust_rate(2_000_000, 1_000_000, 0), 1_000_000);
        assert_eq!(adjust_rate(100_000, 1_000_000, 100), 100_000);
    }
    #[test]
    fn timestamps_follow_native_capture_time_across_dropped_frames_and_wrap() {
        assert_eq!(rtp_timestamp(100, 1_000_000, 1_033_333), Some(3099));
        assert_eq!(rtp_timestamp(u32::MAX - 89, 0, 1000), Some(0));
        assert_eq!(rtp_timestamp(0, 1000, 999), None);
        assert_eq!(report_rtt(0, 0), None);
    }
    #[test]
    fn invalid_wire_packets_never_reach_rtp() {
        assert!(EncodedFrame::parse(&[0; 29]).is_none());
        let mut p = vec![0; 29];
        p[..5].copy_from_slice(b"P2NV\x01");
        p[8..12].copy_from_slice(&180u32.to_le_bytes());
        p[12..16].copy_from_slice(&320u32.to_le_bytes());
        assert!(EncodedFrame::parse(&p).is_some());
        p[5] = 2;
        assert!(EncodedFrame::parse(&p).is_none());
    }
    #[test]
    fn trim_native_ice_servers_caps_stun_at_two_and_keeps_all_turn() {
        let input = vec![
            IceServer {
                urls: vec![
                    "stun:stun.cloudflare.com:3478".into(),
                    "stun:stun.l.google.com:19302".into(),
                    "stun:stun.l.google.com:19302".into(),
                    "stun:stun1.l.google.com:19302".into(),
                    "stun:stun2.l.google.com:19302".into(),
                ],
                username: String::new(),
                credential: String::new(),
            },
            IceServer {
                urls: vec!["stun:stun3.l.google.com:19302".into()],
                username: String::new(),
                credential: String::new(),
            },
            IceServer {
                urls: vec![
                    "turn:turn.example.invalid:3478?transport=udp".into(),
                    "turns:turn.example.invalid:5349?transport=tcp".into(),
                ],
                username: "user".into(),
                credential: "pass".into(),
            },
        ];
        let trimmed = trim_native_ice_servers(input);
        assert_eq!(trimmed.len(), 2);
        assert_eq!(
            trimmed[0].urls,
            vec![
                "stun:stun.cloudflare.com:3478",
                "stun:stun.l.google.com:19302",
            ]
        );
        assert_eq!(
            trimmed[1].urls,
            vec![
                "turn:turn.example.invalid:3478?transport=udp",
                "turns:turn.example.invalid:5349?transport=tcp",
            ]
        );
        assert_eq!(trimmed[1].username, "user");
        assert_eq!(trimmed[1].credential, "pass");
    }
    #[test]
    fn normalize_answer_sdp_ice_unifies_conflicting_section_credentials() {
        let conflicting = [
            "v=0",
            "m=video 9 UDP/TLS/RTP/SAVPF 102",
            "a=ice-ufrag:firstUfrag",
            "a=ice-pwd:firstPassword1234567890",
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
            "a=ice-ufrag:secondUfrag",
            "a=ice-pwd:secondPassword1234567890",
            "",
        ]
        .join("\r\n");
        let normalized = normalize_answer_sdp_ice(&conflicting);
        assert_eq!(normalized.matches("a=ice-ufrag:firstUfrag").count(), 2);
        assert_eq!(
            normalized
                .matches("a=ice-pwd:firstPassword1234567890")
                .count(),
            2
        );
        assert!(!normalized.contains("secondUfrag"));
        assert!(!normalized.contains("secondPassword1234567890"));
        assert!(normalized.ends_with("\r\n"));

        let clean = [
            "v=0",
            "a=ice-ufrag:sharedUfrag",
            "a=ice-pwd:sharedPassword1234567890",
            "m=video 9 UDP/TLS/RTP/SAVPF 102",
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
            "",
        ]
        .join("\r\n");
        assert_eq!(normalize_answer_sdp_ice(&clean), clean);
    }
}

#[cfg(feature = "media-diagnostics")]
pub(crate) fn diagnostic_snapshot() -> serde_json::Value {
    match ROUTES.try_lock() {
        Ok(routes) => serde_json::json!({ "routes": routes.iter().take(32).map(|(id, route)| {
            serde_json::json!({"route": crate::media_diagnostics::opaque_id(id),
                "session": crate::media_diagnostics::opaque_id(&route.session),
                "active": route.active.load(Ordering::Relaxed),
                "connection_state": route.pc.connection_state().to_string(),
                "budget": route.budget.load(Ordering::Relaxed),
                "cap": route.cap.load(Ordering::Relaxed),
                "encoder_bitrate": route.bitrate.load(Ordering::Relaxed),
                "frames": route.frames.load(Ordering::Relaxed),
                "bytes": route.bytes.load(Ordering::Relaxed),
                "keys": route.keys.load(Ordering::Relaxed),
                "gaps": route.gaps.load(Ordering::Relaxed),
                "track": route.diagnostics.track,
                "rr_fraction_lost_256": route.diagnostics.loss.load(Ordering::Relaxed),
                "rr_rtt_us": route.diagnostics.rtt_us.load(Ordering::Relaxed),
                "rr_baseline_rtt_us": route.diagnostics.baseline_rtt_us.load(Ordering::Relaxed),
                "rr_queued": route.diagnostics.queued.load(Ordering::Relaxed),
                "receiver_reports": route.diagnostics.reports.load(Ordering::Relaxed)})
        }).collect::<Vec<_>>() }),
        Err(_) => serde_json::json!({"route_lock_busy": true}),
    }
}
