//! Opt-in, bounded media telemetry. Never writes on a capture or IPC thread.
use serde_json::Value;

#[tauri::command]
pub fn media_diagnostics_enabled() -> bool {
    cfg!(feature = "media-diagnostics")
}

// Frontend records contain numeric measurements only. Unknown field names and
// every string are rejected, so SDP, addresses, titles and credentials cannot pass.
const FIELDS: &[&str] = &[
    "renderer",
    "surface",
    "visibility",
    "interval_ms",
    "peers",
    "videos",
    "bridges",
    "session",
    "packets",
    "last_packet_age_ms",
    "pending",
    "queued",
    "waiting_for_key",
    "decode_queue_size",
    "pressure_percent",
    "effective_fps",
    "id",
    "state",
    "ice",
    "signaling",
    "failed",
    "timed_out",
    "type",
    "kind",
    "track",
    "timestamp",
    "ssrc",
    "powerEfficientEncoder",
    "powerEfficientDecoder",
    "bytesSent",
    "bytesReceived",
    "packetsSent",
    "packetsReceived",
    "packetsLost",
    "framesEncoded",
    "framesDecoded",
    "framesReceived",
    "framesSent",
    "framesDropped",
    "framesPerSecond",
    "frameWidth",
    "frameHeight",
    "keyFramesEncoded",
    "keyFramesDecoded",
    "totalEncodeTime",
    "totalDecodeTime",
    "totalPacketSendDelay",
    "jitter",
    "jitterBufferDelay",
    "jitterBufferEmittedCount",
    "jitterBufferTargetDelay",
    "freezeCount",
    "totalFreezesDuration",
    "pauseCount",
    "totalPausesDuration",
    "pliCount",
    "firCount",
    "nackCount",
    "retransmittedPacketsSent",
    "retransmittedBytesSent",
    "roundTripTime",
    "totalRoundTripTime",
    "roundTripTimeMeasurements",
    "fractionLost",
    "currentRoundTripTime",
    "availableOutgoingBitrate",
    "availableIncomingBitrate",
    "concealedSamples",
    "silentConcealedSamples",
    "totalSamplesReceived",
    "totalSamplesDuration",
    "concealmentEvents",
    "audioLevel",
    "totalAudioEnergy",
    "qualityLimitationReason",
    "qualityLimitationResolutionChanges",
    "cpu",
    "bandwidth",
    "other",
    "none",
    "readyState",
    "paused",
    "width",
    "height",
    "currentTime",
    "totalVideoFrames",
    "droppedVideoFrames",
    "muted",
    "ended",
    "enabled",
];

fn valid_record(value: &Value, depth: usize) -> bool {
    if depth > 6 {
        return false;
    }
    match value {
        Value::Number(_) | Value::Bool(_) | Value::Null => true,
        Value::Array(values) => {
            values.len() <= 128 && values.iter().all(|v| valid_record(v, depth + 1))
        }
        Value::Object(values) => {
            values.len() <= 80
                && values
                    .iter()
                    .all(|(key, v)| FIELDS.contains(&key.as_str()) && valid_record(v, depth + 1))
        }
        Value::String(_) => false,
    }
}

#[tauri::command]
pub fn write_media_diagnostics(record: Value) -> Result<(), String> {
    if !media_diagnostics_enabled() {
        return Ok(());
    }
    if !record.is_object() || !valid_record(&record, 0) || record.to_string().len() > 65_536 {
        return Err("Invalid diagnostic measurement".into());
    }
    #[cfg(feature = "media-diagnostics")]
    enabled::enqueue("webview", record);
    Ok(())
}

pub fn init() {
    #[cfg(feature = "media-diagnostics")]
    enabled::init();
}

#[cfg(feature = "media-diagnostics")]
pub(crate) fn elapsed_us() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_micros() as u64
        + 1
}

#[cfg(feature = "media-diagnostics")]
pub(crate) fn opaque_id(id: &str) -> u32 {
    id.bytes().fold(2_166_136_261u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(16_777_619)
    })
}

#[cfg(feature = "media-diagnostics")]
mod enabled {
    use super::*;
    use std::{
        io::Write,
        sync::{
            atomic::{AtomicU64, Ordering},
            mpsc::{sync_channel, SyncSender},
            OnceLock,
        },
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    static WRITER: OnceLock<SyncSender<(&'static str, Value, u64, u64)>> = OnceLock::new();
    static DROPPED: AtomicU64 = AtomicU64::new(0);
    const LIMIT: u64 = 32 * 1024 * 1024;

    pub fn enqueue(kind: &'static str, value: Value) {
        if let Some(writer) = WRITER.get() {
            if writer
                .try_send((kind, value, epoch_ms(), super::elapsed_us() / 1000))
                .is_err()
            {
                DROPPED.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn init() {
        let (tx, rx) = sync_channel(128);
        if WRITER.set(tx).is_err() {
            return;
        }
        let dir = crate::logger::get_log_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let now = epoch_ms();
        let path = dir.join(format!(
            "media-diagnostics-{}-{}.jsonl",
            now,
            std::process::id()
        ));
        let Ok(mut file) = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
        else {
            return;
        };
        std::thread::spawn(move || {
            let mut bytes = 0u64;
            for (kind, data, epoch_ms, uptime_ms) in rx {
                let record = serde_json::json!({"schema": 1, "version": env!("CARGO_PKG_VERSION"),
                    "epoch_ms": epoch_ms, "uptime_ms": uptime_ms,
                    "dropped_records": DROPPED.load(Ordering::Relaxed), "event": kind, "data": data});
                let mut line = record.to_string();
                line.push('\n');
                if bytes + line.len() as u64 > LIMIT {
                    break;
                }
                if file.write_all(line.as_bytes()).is_err() || file.flush().is_err() {
                    break;
                }
                bytes += line.len() as u64;
            }
        });
        enqueue(
            "start",
            serde_json::json!({"interval_ms": 2000, "limit_bytes": LIMIT}),
        );
        std::thread::spawn(|| loop {
            enqueue(
                "native",
                serde_json::json!({
                    "capture": crate::screen_sources::diagnostic_snapshot(),
                    "transport": crate::native_rtc::diagnostic_snapshot(),
                }),
            );
            std::thread::sleep(Duration::from_secs(2));
        });
    }

    fn epoch_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_measurements_and_rejects_identifying_data() {
        assert!(valid_record(
            &serde_json::json!({"peers":[{"id":1,"framesDecoded":120,"jitter":0.01}]}),
            0
        ));
        assert!(!valid_record(
            &serde_json::json!({"track":"private-track"}),
            0
        ));
        assert!(!valid_record(&serde_json::json!({"address":123}), 0));
        assert!(!valid_record(&serde_json::json!({"sdp":"private"}), 0));
        assert!(!valid_record(&serde_json::json!({"videos":vec![0;129]}), 0));
        let mut deep = serde_json::json!(0);
        for _ in 0..8 {
            deep = serde_json::json!({"peers":deep});
        }
        assert!(!valid_record(&deep, 0));
    }
}
