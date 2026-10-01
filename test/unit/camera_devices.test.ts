import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listCameras, cameraResolutions, cameraFrameRates, configureCamera, preferredCameraFrameRate } from '../../src/video/camera_devices.ts';
import { formatFrameRate } from '../../src/core/media_streams.ts';

test('camera enumeration unlocks identities with one temporary device and always releases it', async () => {
  let enumerations = 0, opened = 0, stopped = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    enumerateDevices: async () => ++enumerations === 1 ? [{ kind: 'videoinput', deviceId: '', label: '' }] :
      [{ kind: 'videoinput', deviceId: 'usb', label: 'USB Camera' }, { kind: 'videoinput', deviceId: 'virtual', label: 'OBS' }],
    getUserMedia: async () => { opened++; return { getTracks: () => [{ stop: () => stopped++ }] }; },
  } } });
  assert.equal((await listCameras()).length, 2);
  assert.equal(opened, 1); assert.equal(stopped, 1);
  await listCameras(); assert.equal(opened, 1);
});

test('camera mode probing rejects unsupported combinations inside broad capability ranges', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getSupportedConstraints: () => ({ resizeMode: true }) } } });
  let settings = { width: 640, height: 480, frameRate: 30 };
  const track = {
    getCapabilities: () => ({ width: { min: 320, max: 1920 }, height: { min: 240, max: 1080 }, frameRate: { min: 15, max: 60 } }),
    getSettings: () => ({ ...settings }),
    applyConstraints: async (constraints: MediaTrackConstraints & { resizeMode?: string }) => {
      assert.equal(constraints.resizeMode, 'none');
      const width = (constraints.width as ConstrainULongRange).exact!;
      const height = (constraints.height as ConstrainULongRange).exact!;
      const fps = (constraints.frameRate as ConstrainDoubleRange)?.exact || 30;
      if (!((width === 640 && height === 480) || (width === 1280 && height === 720)) || (width === 1280 && fps > 30)) throw new Error('unsupported');
      settings = { width, height, frameRate: fps };
    },
  } as unknown as MediaStreamTrack;
  const modes = await cameraResolutions(track, () => false);
  assert.deepEqual(modes.map((mode) => mode.value), ['1280x720', '640x480']);
  const rates = await cameraFrameRates(track, modes[0], () => false);
  assert.deepEqual(rates, [30, 24, 15]);
  assert.deepEqual(await configureCamera(track, modes[0], 30), { width: 1280, height: 720, frameRate: 30 });
  assert.deepEqual(await cameraFrameRates(track, modes[1], () => false), [60, 30, 24, 15]);
});

test('cancelled probing does not configure another camera mode', async () => {
  let applied = 0;
  const track = { getCapabilities: () => ({}), getSettings: () => ({}), applyConstraints: async () => { applied++; } } as unknown as MediaStreamTrack;
  assert.deepEqual(await cameraResolutions(track, () => true), []);
  assert.equal(applied, 0);
});

test('camera floating-point noise is hidden without rounding the selected constraints', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getSupportedConstraints: () => ({}) } } });
  const maximum = 30.000030517;
  let actual = maximum;
  const track = { getCapabilities: () => ({ frameRate: { min: 15, max: maximum } }),
    getSettings: () => ({ width: 640, height: 480, frameRate: actual }),
    applyConstraints: async (constraints: MediaTrackConstraints) => { actual = (constraints.frameRate as ConstrainDoubleRange).exact!; },
  } as unknown as MediaStreamTrack;
  const rates = await cameraFrameRates(track, { value: '', label: '', width: 640, height: 480 }, () => false);
  assert.equal(rates[0], maximum);
  assert.equal(preferredCameraFrameRate(rates, 30), maximum);
  assert.deepEqual(rates.map(formatFrameRate), ['30', '24', '15']);
  assert.equal(formatFrameRate(29.96999), '29,97');
  assert.equal((await configureCamera(track, { value: '', label: '', width: 640, height: 480 }, rates[0])).frameRate, maximum);
});

test('high-speed camera choices stay within the stream protocol limit', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getSupportedConstraints: () => ({}) } } });
  let fps = 240;
  const track = { getCapabilities: () => ({ frameRate: { min: 1, max: 240 } }),
    getSettings: () => ({ width: 640, height: 480, frameRate: fps }),
    applyConstraints: async (constraints: MediaTrackConstraints) => { fps = (constraints.frameRate as ConstrainDoubleRange).exact!; },
  } as unknown as MediaStreamTrack;
  const rates = await cameraFrameRates(track, { value: '640x480', label: '', width: 640, height: 480 }, () => false);
  assert.equal(rates[0], 120); assert.ok(rates.every((rate) => rate <= 120));
});
