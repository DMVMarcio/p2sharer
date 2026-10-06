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
    ice_transport::{ice_candidate::RTCIceCandidateInit, ice_server::RTCIceServer},
    interceptor::registry::Registry,
    peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy,
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
    rtp::{codecs::h264::H264Payloader, header::Header, packet::Packet, packetizer::Payloader},
    rtp_transceiver::{
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
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
    #[cfg(feature = "media-diagnostics")]
    diagnostics: RouteDiagnostics,
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
    // Keep the existing 720p/60 probe but scale its starting allowance to the
    // actual encoded picture. A fixed 2 Mbps can make 1080p recovery pictures
    // exceed the bounded send deadline before useful receiver feedback arrives.
    let rate = 2_000_000u64 * u64::from(width) * u64::from(height) * u64::from(fps.clamp(15, 120))
        / (1280 * 720 * 60);
    (rate.clamp(2_000_000, 8_000_000) as u32).min(budget)
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

#[tauri::command]
pub async fn create_native_video_offer(
    app: tauri::AppHandle,
    id: String,
    session_id: String,
    feedback_token: String,
    stream_id: String,
    track_id: String,
    bitrate: u32,
    ice_servers: Vec<IceServer>,
    relay_only: bool,
) -> Result<String, String> {
    if !valid_id(&id)
        || !valid_id(&stream_id)
        || !valid_id(&track_id)
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
    let codec = RTCRtpCodecCapability {
        mime_type: "video/H264".into(),
        clock_rate: 90_000,
        sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=420033"
            .into(),
        rtcp_feedback: vec![RTCPFeedback {
            typ: "ccm".into(),
            parameter: "fir".into(),
        }],
        ..Default::default()
    };
    engine
        .register_codec(
            RTCRtpCodecParameters {
                capability: codec.clone(),
                payload_type: 102,
                ..Default::default()
            },
            RTPCodecType::Video,
        )
        .map_err(|e| e.to_string())?;
    let registry =
        register_default_interceptors(Registry::new(), &mut engine).map_err(|e| e.to_string())?;
    let api = APIBuilder::new()
        .with_media_engine(engine)
        .with_interceptor_registry(registry)
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
    let live = Arc::new(AtomicBool::new(true));
    let geometry = capture.load.snapshot();
    let value = Arc::new(Route {
        pc: pc.clone(),
        session: session_id.clone(),
        token: feedback_token,
        active: live.clone(),
        budget: AtomicU32::new(bitrate),
        cap: AtomicU32::new(initial_rate(bitrate, geometry.output_width, geometry.output_height, geometry.effective_fps)),
        bitrate: capture.bitrate.clone(),
        frames: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        keys: AtomicU64::new(0),
        gaps: AtomicU64::new(0),
        #[cfg(feature = "media-diagnostics")]
        diagnostics: RouteDiagnostics { track: crate::media_diagnostics::opaque_id(&track_id),
            loss: AtomicU32::new(0), rtt_us: AtomicU64::new(0), baseline_rtt_us: AtomicU64::new(0),
            queued: AtomicBool::new(false), reports: AtomicU64::new(0) },
    });
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
    let ice_app = app.clone();
    let ice_id = id.clone();
    pc.on_ice_candidate(Box::new(move |candidate| {
        let app = ice_app.clone();
        let id = ice_id.clone();
        Box::pin(async move {
            if let Some(candidate) = candidate {
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
    let state_id = id.clone();
    let state_key = capture.keyframe.clone();
    pc.on_peer_connection_state_change(Box::new(move |state| {
        let app = state_app.clone();
        let id = state_id.clone();
        let key = state_key.clone();
        Box::pin(async move {
            if state == RTCPeerConnectionState::Connected {
                key.store(true, Ordering::Relaxed);
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
                    rtcp_key.store(true, Ordering::Relaxed);
                    last_key = Instant::now();
                }
                if let Some(rr) = p.as_any().downcast_ref::<ReceiverReport>() {
                    #[cfg(feature = "media-diagnostics")]
                    rtcp_value.diagnostics.reports.fetch_add(1, Ordering::Relaxed);
                    if last_adjust.elapsed() >= Duration::from_secs(2) {
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
                            rtt > baseline_rtt + 0.100 && rtt > baseline_rtt * 1.5
                        });
                        #[cfg(feature = "media-diagnostics")]
                        {
                            let d = &rtcp_value.diagnostics;
                            d.loss.store(u32::from(loss), Ordering::Relaxed);
                            d.rtt_us.store((rtt.unwrap_or(0.0) * 1_000_000.0) as u64, Ordering::Relaxed);
                            d.baseline_rtt_us.store((if baseline_rtt.is_finite() { baseline_rtt * 1_000_000.0 } else { 0.0 }) as u64, Ordering::Relaxed);
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
                    capture.keyframe.store(true, Ordering::Relaxed);
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
            if capture
                .load
                .elapsed_ms()
                .saturating_mul(1000)
                .saturating_sub(frame.timestamp)
                > recovery_age.limit_us(Instant::now())
            {
                gate.wait_key = true;
                value.gaps.fetch_add(1, Ordering::Relaxed);
                if last_key.elapsed() >= Duration::from_millis(250) {
                    capture.keyframe.store(true, Ordering::Relaxed);
                    last_key = Instant::now();
                }
                continue;
            }
            let decision = gate.accept(&frame);
            if decision == Decision::Recover {
                value.gaps.fetch_add(1, Ordering::Relaxed);
                if last_key.elapsed() >= Duration::from_millis(250) {
                    capture.keyframe.store(true, Ordering::Relaxed);
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
            let deadline = tokio::time::Instant::now() + Duration::from_millis(120);
            let mut complete = true;
            for (index, payload) in payloads.into_iter().enumerate() {
                // Preserve the pacing phase across timer jitter, allowing at most 2 ms of credit.
                next_packet =
                    next_packet.max(tokio::time::Instant::now() - Duration::from_millis(2));
                if next_packet > deadline {
                    complete = false;
                    break;
                }
                tokio::time::sleep_until(next_packet).await;
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
                if !matches!(
                    tokio::time::timeout_at(deadline, track.write_rtp(&packet)).await,
                    Ok(Ok(_))
                ) {
                    complete = false;
                    break;
                }
                value.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
                next_packet += Duration::from_secs_f64(
                    (bytes + 64) as f64 * 8.0
                        / value.bitrate.load(Ordering::Relaxed).max(100_000) as f64,
                );
            }
            if !complete {
                gate.wait_key = true;
                capture.keyframe.store(true, Ordering::Relaxed);
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

#[tauri::command]
pub async fn answer_native_video(
    id: String,
    feedback_token: String,
    sdp: String,
) -> Result<(), String> {
    if sdp.len() > 128 * 1024 {
        return Err("Answer too large".into());
    }
    route(&id, &feedback_token)
        .await?
        .pc
        .set_remote_description(RTCSessionDescription::answer(sdp).map_err(|e| e.to_string())?)
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
    route(&id, &feedback_token)
        .await?
        .pc
        .add_ice_candidate(candidate)
        .await
        .map_err(|e| e.to_string())
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
        cap.saturating_add((cap / 5).max(50_000))
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
            (now.saturating_duration_since(completed).as_micros() / 5)
                .min(u64::MAX as u128) as u64
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
    fn startup_probe_scales_to_encoded_geometry_without_exceeding_user_budget() {
        assert_eq!(initial_rate(15_000_000, 1280, 720, 60), 2_000_000);
        assert_eq!(initial_rate(15_000_000, 1920, 1080, 60), 4_500_000);
        assert_eq!(initial_rate(15_000_000, 1080, 1920, 60), 4_500_000);
        assert_eq!(initial_rate(3_000_000, 1920, 1080, 120), 3_000_000);
        assert_eq!(initial_rate(50_000_000, 3840, 2160, 120), 8_000_000);
        assert_eq!(initial_rate(800_000, 640, 360, 30), 800_000);
        assert_eq!(initial_rate(15_000_000, 0, 0, 60), 2_000_000);
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
        assert_eq!(adjust_rate(2_000_000, 15_000_000, 0), 2_400_000);
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
