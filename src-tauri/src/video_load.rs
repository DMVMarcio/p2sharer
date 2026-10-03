//! Per-session capture load control. No adapter-brand or monitor-rate assumptions.
use serde::Serialize;
use std::sync::{atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering}, Mutex};
use std::time::Instant;

const SCALES: [u32; 6] = [100, 85, 70, 55, 55, 55];

pub struct CaptureLoad {
    requested_fps: u32,
    requested_width: u32,
    requested_height: u32,
    feedback_token: Option<String>,
    started: Instant,
    feedback: Mutex<Option<(u32, u64)>>,
    level: AtomicU8,
    effective_fps: AtomicU32,
    output_width: AtomicU32,
    output_height: AtomicU32,
    adjustments: AtomicU64,
    reason: AtomicU8,
}

#[derive(Serialize)]
pub struct LoadSnapshot {
    pub requested_fps: u32,
    pub effective_fps: u32,
    pub resolution_scale_percent: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub adjustments: u64,
    pub reason: &'static str,
}

impl CaptureLoad {
    pub fn new(fps: u32, width: u32, height: u32, feedback_token: Option<String>) -> Self {
        let fps = fps.clamp(15, 120);
        Self { requested_fps: fps, requested_width: width, requested_height: height,
            feedback_token, started: Instant::now(), feedback: Mutex::new(None),
            level: AtomicU8::new(0), effective_fps: AtomicU32::new(fps),
            output_width: AtomicU32::new(0), output_height: AtomicU32::new(0),
            adjustments: AtomicU64::new(0), reason: AtomicU8::new(0) }
    }

    pub fn elapsed_ms(&self) -> u64 { self.started.elapsed().as_millis() as u64 }
    pub fn fps(&self) -> u32 { self.effective_fps.load(Ordering::Relaxed) }

    pub fn bounds(&self, source_width: u32, source_height: u32) -> (u32, u32) {
        let (width, height) = crate::screen_sources::fit_capture_dimensions(
            source_width, source_height, self.requested_width, self.requested_height);
        let scale = SCALES[self.level.load(Ordering::Relaxed) as usize];
        ((width as u64 * scale as u64 / 100).max(1) as u32,
         (height as u64 * scale as u64 / 100).max(1) as u32)
    }

    pub fn output(&self, width: u32, height: u32) {
        self.output_width.store(width, Ordering::Relaxed);
        self.output_height.store(height, Ordering::Relaxed);
    }

    pub fn report_bridge(&self, token: &str, pressure_percent: u32) -> Result<(), String> {
        self.validate_token(token)?;
        *self.feedback.lock().map_err(|_| "Capture feedback lock poisoned")? =
            Some((pressure_percent.min(200), self.elapsed_ms()));
        Ok(())
    }

    pub fn validate_token(&self, token: &str) -> Result<(), String> {
        if self.feedback_token.as_deref() != Some(token) {
            return Err("Capture feedback belongs to a different session generation".into());
        }
        Ok(())
    }

    fn bridge_pressure(&self, now_ms: u64) -> Option<u32> {
        self.feedback.lock().ok().and_then(|feedback| *feedback)
            .filter(|(_, at)| now_ms.saturating_sub(*at) <= 5_000).map(|(value, _)| value)
    }

    fn level_fps(&self, level: u8) -> u32 {
        match level { 4 => self.requested_fps * 3 / 4,
            5 => self.requested_fps / 2, _ => self.requested_fps }.max(15)
    }

    fn max_level(&self) -> u8 {
        if self.level_fps(5) < self.level_fps(4) { 5 }
        else if self.level_fps(4) < self.requested_fps { 4 } else { 3 }
    }

    fn apply(&self, level: u8, reason: u8) {
        self.level.store(level, Ordering::Relaxed);
        self.effective_fps.store(self.level_fps(level), Ordering::Relaxed);
        self.reason.store(reason, Ordering::Relaxed);
        self.adjustments.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> LoadSnapshot {
        LoadSnapshot { requested_fps: self.requested_fps, effective_fps: self.fps(),
            resolution_scale_percent: SCALES[self.level.load(Ordering::Relaxed) as usize],
            output_width: self.output_width.load(Ordering::Relaxed),
            output_height: self.output_height.load(Ordering::Relaxed),
            adjustments: self.adjustments.load(Ordering::Relaxed),
            reason: match self.reason.load(Ordering::Relaxed) {
                1 => "native_processing", 2 => "video_bridge", 3 => "recovering", _ => "none" } }
    }
}

#[derive(Default)]
pub struct LoadController {
    window_start_ms: u64,
    cost_us: u64,
    frames: u32,
    overloaded_windows: u8,
    healthy_windows: u8,
    last_change_ms: u64,
    level: u8,
}

impl LoadController {
    pub fn observe(&mut self, load: &CaptureLoad, now_ms: u64, cost_us: u64) {
        self.cost_us = self.cost_us.saturating_add(cost_us);
        self.frames = self.frames.saturating_add(1);
        if now_ms.saturating_sub(self.window_start_ms) < 2_000 { return; }
        let frames = self.frames;
        let mean_us = self.cost_us / u64::from(frames.max(1));
        self.cost_us = 0;
        self.frames = 0;
        self.window_start_ms = now_ms;
        // Sparse/static sources and long pauses do not provide enough load evidence.
        if frames < 3 {
            self.overloaded_windows = 0;
            self.healthy_windows = 0;
            return;
        }
        let budget_us = 1_000_000 / u64::from(load.fps());
        let bridge = load.bridge_pressure(now_ms);
        let native_overload = mean_us * 100 >= budget_us * 80;
        let bridge_overload = bridge.is_some_and(|value| value >= 80);
        if native_overload || bridge_overload {
            self.healthy_windows = 0;
            self.overloaded_windows = self.overloaded_windows.saturating_add(1);
            if self.overloaded_windows >= 2 && self.level < load.max_level()
                && now_ms.saturating_sub(self.last_change_ms) >= 4_000 {
                self.level += 1;
                load.apply(self.level, if bridge_overload { 2 } else { 1 });
                self.last_change_ms = now_ms;
                self.overloaded_windows = 0;
            }
        } else if frames >= 15 && mean_us * 100 <= budget_us * 45 && bridge.is_none_or(|value| value <= 45) {
            self.overloaded_windows = 0;
            self.healthy_windows = self.healthy_windows.saturating_add(1);
            if self.healthy_windows >= 5 && self.level > 0
                && now_ms.saturating_sub(self.last_change_ms) >= 10_000 {
                self.level -= 1;
                load.apply(self.level, if self.level == 0 { 0 } else { 3 });
                self.last_change_ms = now_ms;
                self.healthy_windows = 0;
            }
        } else {
            self.overloaded_windows = 0;
            self.healthy_windows = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window(controller: &mut LoadController, load: &CaptureLoad, at: u64, cost: u64) {
        for _ in 0..60 { controller.observe(load, at - 1, cost); }
        controller.observe(load, at, cost);
    }
    #[test]
    fn sustained_load_reduces_pixels_before_fps_and_recovers_slowly() {
        let load = CaptureLoad::new(60, 1920, 1080, None);
        let mut controller = LoadController::default();
        window(&mut controller, &load, 2000, 20_000);
        assert_eq!(load.snapshot().resolution_scale_percent, 100);
        window(&mut controller, &load, 4000, 20_000);
        assert_eq!(load.bounds(1920, 1080), (1632, 918));
        assert_eq!(load.fps(), 60);
        for at in (6000..=20_000).step_by(2000) { window(&mut controller, &load, at, 50_000); }
        assert_eq!(load.fps(), 30);
        assert_eq!(load.snapshot().resolution_scale_percent, 55);
        window(&mut controller, &load, 22_000, 1000);
        assert_eq!(load.fps(), 30);
        for at in (24_000..=70_000).step_by(2000) { window(&mut controller, &load, at, 1000); }
        assert_eq!(load.fps(), 60);
        assert_eq!(load.snapshot().resolution_scale_percent, 100);
        assert_eq!(load.snapshot().reason, "none");
    }
    #[test]
    fn static_source_and_single_spikes_do_not_degrade() {
        let load = CaptureLoad::new(120, 0, 0, None);
        let mut controller = LoadController::default();
        for at in (2000..=60_000).step_by(2000) { controller.observe(&load, at, 200_000); }
        window(&mut controller, &load, 62_000, 50_000);
        window(&mut controller, &load, 64_000, 1000);
        assert_eq!(load.snapshot().adjustments, 0);
        assert_eq!(load.bounds(2160, 3840), (2160, 3840));
    }
    #[test]
    fn bridge_feedback_expires_and_requires_current_generation() {
        let load = CaptureLoad::new(60, 1080, 1920, Some("current".into()));
        assert!(load.report_bridge("previous", 100).is_err());
        load.report_bridge("current", 100).unwrap();
        let mut controller = LoadController::default();
        window(&mut controller, &load, 2000, 1000);
        window(&mut controller, &load, 4000, 1000);
        assert_eq!(load.snapshot().reason, "video_bridge");
        assert_eq!(load.bounds(1080, 1920), (918, 1632));
        assert_eq!(load.bridge_pressure(6000), None);
        for at in (6000..=14_000).step_by(2000) { window(&mut controller, &load, at, 1000); }
        assert_eq!(load.snapshot().resolution_scale_percent, 100);
    }
    #[test]
    fn sessions_are_independent_and_settings_remain_ceilings() {
        for fps in [15, 30, 60, 120] {
            let first = CaptureLoad::new(fps, 640, 360, None);
            let second = CaptureLoad::new(fps, 640, 360, None);
            let mut controller = LoadController::default();
            for at in (2000..=40_000).step_by(2000) { window(&mut controller, &first, at, 100_000); }
            assert!(first.fps() >= 15 && first.fps() <= fps);
            assert_eq!(second.snapshot().adjustments, 0);
            assert_eq!(second.bounds(3840, 2160), (640, 360));
            assert_eq!(first.snapshot().requested_fps, fps);
        }
    }

    #[test]
    fn severely_slow_active_processing_still_provides_overload_evidence() {
        let load = CaptureLoad::new(60, 1920, 1080, None);
        let mut controller = LoadController::default();
        for at in [2000, 4000] {
            for offset in [1500, 1000, 500, 0] {
                controller.observe(&load, at - offset, 500_000);
            }
        }
        assert_eq!(load.snapshot().resolution_scale_percent, 85);
        assert_eq!(load.snapshot().reason, "native_processing");
    }

    #[test]
    fn fps_floor_does_not_add_ineffective_steps_or_delay_quality_recovery() {
        for (fps, max_level) in [(15, 3), (20, 4), (60, 5)] {
            let load = CaptureLoad::new(fps, 1920, 1080, None);
            let mut controller = LoadController::default();
            for at in (2000..=40_000).step_by(2000) { window(&mut controller, &load, at, 100_000); }
            assert_eq!(controller.level, max_level);
            assert_eq!(load.snapshot().adjustments, u64::from(max_level));
        }
    }
}
