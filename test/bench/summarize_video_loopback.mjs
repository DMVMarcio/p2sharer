import { readFileSync } from 'node:fs';

/** Summarize counter deltas, omitting screenshots and unrelated RTC statistics. */
export function summarizeVideoLoopback(result) {
  const seconds = (result.captureAfter.timestamp - result.captureBefore.timestamp) / 1000;
  const delta = (before, after, key) => Number.isFinite(before?.[key]) && Number.isFinite(after?.[key])
    ? after[key] - before[key] : undefined;
  const images = delta(result.nativeBefore, result.nativeAfter, 'images');
  const native = images === undefined ? undefined : {
    imageFps: images / seconds,
    callbackFps: delta(result.nativeBefore, result.nativeAfter, 'callbacks') / seconds,
    gatedFrames: delta(result.nativeBefore, result.nativeAfter, 'gated'),
    readbackMs: delta(result.nativeBefore, result.nativeAfter, 'readback_us') / images / 1000,
    jpegMs: delta(result.nativeBefore, result.nativeAfter, 'jpeg_us') / images / 1000,
    processingMs: delta(result.nativeBefore, result.nativeAfter, 'processing_us') / images / 1000,
    resizeMs: delta(result.nativeBefore, result.nativeAfter, 'resize_us') === undefined ? undefined
      : delta(result.nativeBefore, result.nativeAfter, 'resize_us') / images / 1000,
    stagingAllocations: delta(result.nativeBefore, result.nativeAfter, 'staging_allocations'),
    readbackErrors: delta(result.nativeBefore, result.nativeAfter, 'readback_errors'),
    gpuScaledImages: delta(result.nativeBefore, result.nativeAfter, 'gpu_scaled_images'),
  };
  const rtp = result.after.flatMap((reports, connection) => reports.filter(report =>
    ['outbound-rtp', 'inbound-rtp'].includes(report.type) && report.kind === 'video').map(report => {
    const before = result.before[connection].find(previous => previous.id === report.id);
    const outbound = report.type === 'outbound-rtp';
    const frames = delta(before, report, outbound ? 'framesEncoded' : 'framesDecoded');
    return {
      connection, direction: outbound ? 'send' : 'receive',
      fps: frames * 1000 / delta(before, report, 'timestamp'),
      width: report.frameWidth, height: report.frameHeight,
      encodeMs: outbound ? delta(before, report, 'totalEncodeTime') * 1000 / frames : undefined,
      codec: reports.find(codec => codec.id === report.codecId)?.mimeType,
      limitation: report.qualityLimitationReason,
      droppedFrames: delta(before, report, 'framesDropped'),
      encoder: report.encoderImplementation, decoder: report.decoderImplementation,
    };
  }));
  return { options: result.options, seconds, native, visualChecks: result.visualChecks,
    websocketImageFps: delta(result.captureBefore, result.captureAfter, 'imageMessages') / seconds,
    jpegBytesPerFrame: delta(result.captureBefore, result.captureAfter, 'jpegBytes') === undefined ? undefined
      : delta(result.captureBefore, result.captureAfter, 'jpegBytes') / delta(result.captureBefore, result.captureAfter, 'imageMessages'),
    heartbeatFps: delta(result.captureBefore, result.captureAfter, 'heartbeatMessages') / seconds, rtp };
}

for (const path of process.argv.slice(2)) {
  console.log(JSON.stringify({ path, ...summarizeVideoLoopback(JSON.parse(readFileSync(path, 'utf8'))) }, null, 2));
}
