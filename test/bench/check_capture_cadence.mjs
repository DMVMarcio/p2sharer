import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Exercise the production deadline arithmetic with synthetic callback timestamps.
// This does not emulate WGC, a GPU driver, processing cost, VRR or WebRTC delivery.
const source = readFileSync('src-tauri/src/screen_sources.rs', 'utf8');
const gate = source.match(/        if arrival_time < self.next_frame_time \{[\s\S]*?\n        \}/)?.[0];
const advance = source.match(/        self.next_frame_time \+= self.frame_interval;[\s\S]*?\n        \}/)?.[0];
if (!gate || !advance) throw new Error('Production capture gate changed; review the diagnostic harness.');
const outputDirectory = resolve('src-tauri/target');
mkdirSync(outputDirectory, { recursive: true });
const rustPath = resolve(outputDirectory, 'refresh-cadence-validation.rs');
const executable = resolve(outputDirectory, `refresh-cadence-validation${process.platform === 'win32' ? '.exe' : ''}`);
writeFileSync(rustPath, `
use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicU64, Ordering};
struct Metrics { gated: AtomicU64 }
struct Handler {
    base: Instant, next_frame_time: Instant, frame_interval: Duration,
    metrics: Metrics, accepted: Vec<f64>,
}
impl Handler {
    fn arrive(&mut self, arrival_time: Instant) -> Result<(), ()> {
${gate}
${advance}
        self.accepted.push(arrival_time.duration_since(self.base).as_secs_f64());
        Ok(())
    }
}
fn main() {
    println!("hz,target,jitter_ms,actual_fps,min_gap_ms,max_gap_ms");
    for hz in [60.0, 75.0, 120.0, 144.0, 165.0, 240.0] {
        for fps in [60u64, 120] {
            for jitter in [0.0, 0.001] {
                let base = Instant::now();
                let mut h = Handler {
                    base, next_frame_time: base,
                    frame_interval: Duration::from_nanos(1_000_000_000 / fps),
                    metrics: Metrics { gated: AtomicU64::new(0) }, accepted: vec![],
                };
                let mut n = 0u64;
                loop {
                    let t = n as f64 / hz + if n % 2 == 0 { 0.0 } else { jitter };
                    if t >= 60.0 { break; }
                    h.arrive(base + Duration::from_secs_f64(t)).unwrap();
                    n += 1;
                }
                let gaps: Vec<f64> = h.accepted.windows(2).map(|w| (w[1]-w[0])*1000.0).collect();
                let actual_fps = h.accepted.len() as f64 / 60.0;
                assert!((actual_fps - (fps as f64).min(hz)).abs() < 0.05);
                println!("{},{},{:.1},{:.3},{:.3},{:.3}", hz, fps, jitter*1000.0, actual_fps,
                    gaps.iter().copied().fold(f64::INFINITY, f64::min),
                    gaps.iter().copied().fold(0.0, f64::max));
            }
        }
    }
}
`);
for (const [command, args] of [['rustc', [rustPath, '-O', '-o', executable]], [executable, []]]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
