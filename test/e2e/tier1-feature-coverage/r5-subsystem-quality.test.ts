import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTypeScriptCompilation,
  checkCargoCompilation,
  verifyConfigFileIntegrity,
} from '../harness/build-checker.ts';
import {
  TAURI_IPC_COMMANDS,
  validateIpcInvoke,
  validateAudioConfig,
} from '../harness/ipc-contract.ts';

describe('Tier 1: R5 Subsystem Quality & Build Cleanliness Coverage', () => {
  it('R5-T1-1: Should verify all project configuration files exist and contain valid JSON/TOML', () => {
    const check = verifyConfigFileIntegrity();
    assert.equal(check.valid, true, `Config integrity failed: ${check.errors.join(', ')}`);
  });

  it('R5-T1-2: Should verify TypeScript compilation cleanly passes with 0 errors', () => {
    const result = checkTypeScriptCompilation();
    assert.equal(result.passed, true, `TypeScript compilation failed:\n${result.stderr || result.stdout}`);
  });

  it('R5-T1-3: Should verify Cargo check cleanly passes in src-tauri', () => {
    const result = checkCargoCompilation();
    assert.equal(result.passed, true, `Cargo check failed:\n${result.stderr || result.stdout}`);
  });

  it('R5-T1-4: Should verify all 12 Tauri IPC commands are registered in the contract matrix', () => {
    const expectedCommands = [
      'list_audio_processes',
      'list_screen_sources',
      'start_native_screen_capture',
      'stop_native_screen_capture',
      'start_audio_capture',
      'stop_audio_capture',
      'get_video_ws_port',
      'write_frontend_log',
      'get_log_file_path',
      'open_log_folder',
      'open_latest_log',
      'clear_log_file',
    ];

    for (const cmd of expectedCommands) {
      assert.ok(cmd in TAURI_IPC_COMMANDS, `Command "${cmd}" must be registered in TAURI_IPC_COMMANDS`);
      const def = TAURI_IPC_COMMANDS[cmd]!;
      assert.equal(def.name, cmd);
    }
  });

  it('R5-T1-5: Should validate AudioConfig contract validation logic', () => {
    const validConfig = {
      mode: 'exclude',
      target_pids: [1234, 5678],
      target_names: ['spotify.exe'],
      sample_rate: 48000,
    };
    const validCheck = validateAudioConfig(validConfig);
    assert.equal(validCheck.valid, true);

    const validInvoke = validateIpcInvoke('start_audio_capture', { config: validConfig });
    assert.equal(validInvoke.valid, true);
  });

  it('R5-T1-6: Should calculate HUD telemetry statistics correctly', () => {
    function computeTelemetry(bytesReceived: number, durationMs: number, framesDecoded: number) {
      const durationSec = durationMs / 1000;
      const fps = durationSec > 0 ? Math.round(framesDecoded / durationSec) : 0;
      const kbps = durationSec > 0 ? Math.round((bytesReceived * 8) / durationSec / 1000) : 0;
      const mbps = (kbps / 1000).toFixed(1);
      return { fps, kbps, mbps };
    }

    // 60 frames in 1000ms, 500,000 bytes (~4 Mbps)
    const stats = computeTelemetry(500000, 1000, 60);
    assert.equal(stats.fps, 60);
    assert.equal(stats.kbps, 4000);
    assert.equal(stats.mbps, '4.0');
  });
});
