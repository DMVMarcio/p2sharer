//! Bounded playout queue with phase-preserving deadlines and no catch-up bursts.
use std::collections::VecDeque;

pub enum PacedFrame<T> {
    Fresh { frame: T, age_us: u64 },
    Refresh(T),
    Repeat,
}

pub struct FramePacer<T> {
    queue: VecDeque<(T, u64)>,
    latest: Option<T>,
    interval_ns: u64,
    next_tick_ns: Option<u64>,
    last_tick_us: Option<u64>,
    last_image_us: u64,
    pub dropped: u64,
    pub missed: u64,
}

impl<T: Clone> FramePacer<T> {
    pub fn new(fps: u32) -> Self {
        Self { queue: VecDeque::with_capacity(2), latest: None,
            interval_ns: 1_000_000_000 / u64::from(fps.clamp(15, 120)), next_tick_ns: None,
            last_tick_us: None, last_image_us: 0, dropped: 0, missed: 0 }
    }

    pub fn enqueue(&mut self, frame: T, ready_us: u64) {
        if self.queue.len() == 2 {
            self.queue.pop_front();
            self.dropped += 1;
        }
        self.queue.push_back((frame, ready_us));
        // One frame of initial headroom absorbs capture/processing jitter.
        if self.next_tick_ns.is_none() { self.next_tick_ns = Some(ready_us * 1000 + self.interval_ns); }
    }

    /// Diagnostic passthrough retains static repetition without double delivery.
    pub fn record_immediate(&mut self, frame: T, ready_us: u64) {
        self.latest = Some(frame);
        self.last_image_us = ready_us;
        self.next_tick_ns = Some(ready_us * 1000 + self.interval_ns * 4);
    }

    pub fn set_fps(&mut self, fps: u32, now_us: u64) {
        let interval_ns = 1_000_000_000 / u64::from(fps.clamp(15, 120));
        if interval_ns == self.interval_ns { return; }
        self.interval_ns = interval_ns;
        if self.next_tick_ns.is_some() {
            self.next_tick_ns = Some(self.last_tick_us.unwrap_or(now_us) * 1000 + interval_ns);
        }
    }

    pub fn next_tick_us(&self) -> Option<u64> { self.next_tick_ns.map(|deadline| deadline.div_ceil(1000)) }

    pub fn tick(&mut self, now_us: u64) -> Option<PacedFrame<T>> {
        let now_ns = now_us * 1000;
        let deadline = self.next_tick_ns?;
        if now_ns < deadline { return None; }
        let missed = now_ns.saturating_sub(deadline) / self.interval_ns;
        self.missed += missed;
        let mut next = deadline + (missed + 1) * self.interval_ns;
        if next.saturating_sub(now_ns) < self.interval_ns / 2 {
            next += self.interval_ns;
            self.missed += 1;
        }
        self.next_tick_ns = Some(next);
        self.last_tick_us = Some(now_us);
        // Prefer the newest image after a long stall, not an obsolete backlog.
        while self.queue.len() > 1
            && now_us.saturating_sub(self.queue.front().unwrap().1) > self.interval_ns * 2 / 1000 {
            self.queue.pop_front();
            self.dropped += 1;
        }
        if let Some((frame, ready_us)) = self.queue.pop_front() {
            self.latest = Some(frame.clone());
            self.last_image_us = now_us;
            return Some(PacedFrame::Fresh { frame, age_us: now_us.saturating_sub(ready_us) });
        }
        if now_us.saturating_sub(self.last_image_us) >= 500_000 {
            if let Some(frame) = self.latest.clone() {
                self.last_image_us = now_us;
                return Some(PacedFrame::Refresh(frame));
            }
        }
        self.latest.as_ref().map(|_| PacedFrame::Repeat)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_queue_preserves_short_jitter_and_discards_obsolete_frames() {
        let mut pacer = FramePacer::new(60);
        pacer.enqueue(1, 0);
        assert!(pacer.tick(16_000).is_none());
        assert!(matches!(pacer.tick(16_667), Some(PacedFrame::Fresh { frame: 1, .. })));
        pacer.enqueue(2, 26_666);
        pacer.enqueue(3, 40_000);
        assert!(matches!(pacer.tick(40_000), Some(PacedFrame::Fresh { frame: 2, .. })));
        assert!(matches!(pacer.tick(50_000), Some(PacedFrame::Fresh { frame: 3, .. })));
        for frame in 4..=10 { pacer.enqueue(frame, 60_000); }
        assert_eq!(pacer.queue.len(), 2);
        assert!(matches!(pacer.tick(300_000), Some(PacedFrame::Fresh { frame: 10, .. })));
        assert!(pacer.tick(300_000).is_none());
        assert!(pacer.next_tick_us().unwrap() > 300_000);
        assert!(pacer.dropped > 0 && pacer.missed > 0);
    }
    #[test]
    fn static_repeats_do_not_invent_fresh_frames_and_refreshes_follow_time_not_fps() {
        for fps in [15, 60, 120] {
            let mut pacer = FramePacer::new(fps);
            pacer.enqueue(7, 0);
            let first = pacer.next_tick_us().unwrap();
            assert!(matches!(pacer.tick(first), Some(PacedFrame::Fresh { frame: 7, .. })));
            assert!(matches!(pacer.tick(first + pacer.interval_ns.div_ceil(1000)), Some(PacedFrame::Repeat)));
            assert!(matches!(pacer.tick(first + 510_000), Some(PacedFrame::Refresh(7))));
            assert!(pacer.tick(first + 510_000).is_none());
        }
    }
    #[test]
    fn fps_changes_skip_missed_deadlines_without_resetting_on_every_frame() {
        let mut pacer = FramePacer::new(60);
        pacer.enqueue(1, 0);
        pacer.tick(16_667);
        pacer.set_fps(30, 20_000);
        assert_eq!(pacer.next_tick_us(), Some(50_001));
        assert!(pacer.tick(49_000).is_none());
        assert!(pacer.tick(60_000).is_some());
        pacer.set_fps(60, 61_000);
        assert_eq!(pacer.next_tick_us(), Some(76_667));
        assert!(pacer.tick(200_000).is_some());
        assert!(pacer.tick(200_000).is_none());
    }

    #[test]
    fn near_deadline_stalls_do_not_create_a_second_immediate_output() {
        let mut pacer = FramePacer::new(60);
        pacer.enqueue(1, 0);
        pacer.enqueue(2, 10_000);
        assert!(pacer.tick(33_332).is_some());
        assert!(pacer.tick(33_333).is_none());
        assert!(pacer.next_tick_us().unwrap() >= 49_999);
    }

    #[test]
    fn diagnostic_passthrough_only_repeats_after_the_static_timeout() {
        let mut pacer = FramePacer::new(60);
        pacer.record_immediate(1, 0);
        assert!(pacer.tick(50_000).is_none());
        assert!(matches!(pacer.tick(66_667), Some(PacedFrame::Repeat)));
        pacer.record_immediate(2, 70_000);
        assert!(pacer.tick(100_000).is_none());
    }
    #[test]
    fn synthetic_refresh_rates_deliver_regular_intervals_with_bounded_fresh_frame_age() {
        for hz in [60u64, 75, 120, 144, 165, 240] {
            for fps in [60u32, 120] {
                for jitter in [0u64, 1000] {
                    let interval = 1_000_000 / u64::from(fps);
                    let mut pacer = FramePacer::new(fps);
                    let mut capture_deadline = 0u64;
                    let mut callback = 0u64;
                    let mut produced = VecDeque::new();
                    let mut last_output: Option<u64> = None;
                    let mut outputs = 0u32;
                    let mut fresh = 0u32;
                    for now in (0u64..60_000_000).step_by(500) {
                        while callback * 1_000_000 / hz + (callback % 2) * jitter <= now {
                            let arrival = callback * 1_000_000 / hz + (callback % 2) * jitter;
                            if arrival >= capture_deadline {
                                produced.push_back((callback, arrival + 3000));
                                capture_deadline += interval;
                                if arrival.saturating_sub(capture_deadline) >= interval {
                                    capture_deadline = arrival + interval;
                                }
                            }
                            callback += 1;
                        }
                        while produced.front().is_some_and(|(_, ready)| *ready <= now) {
                            let (frame, ready) = produced.pop_front().unwrap();
                            pacer.enqueue(frame, ready);
                        }
                        if let Some(output) = pacer.tick(now) {
                            if let Some(previous) = last_output {
                                assert!((now - previous).abs_diff(interval) <= 500,
                                    "Unexpected output gap at {hz} Hz/{fps} FPS/{jitter} us jitter");
                            }
                            if let PacedFrame::Fresh { age_us, .. } = output {
                                fresh += 1;
                                assert!(age_us <= interval * 2 + 1500);
                            }
                            outputs += 1;
                            last_output = Some(now);
                        }
                        assert!(pacer.queue.len() <= 2);
                    }
                    assert!(outputs.abs_diff(fps * 60) <= 3,
                        "Output cadence mismatch at {hz} Hz/{fps} FPS/{jitter} us jitter: {outputs}");
                    assert!(fresh.abs_diff(fps.min(hz as u32) * 60) <= 5,
                        "Fresh frame loss at {hz} Hz/{fps} FPS/{jitter} us jitter: {fresh}");
                }
            }
        }
    }
}
