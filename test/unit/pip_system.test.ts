import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupTestDOM, type DOMEnvironment } from '../e2e/harness/dom-mock.ts';
import { StateStore } from '../../src/core/state_store.ts';
import { PipService } from '../../src/services/pip_service.ts';

describe('Picture-in-Picture (PiP) Multi-Window System', () => {
  let domEnv: DOMEnvironment | null = null;
  let store: StateStore;
  let pipService: PipService;

  beforeEach(() => {
    domEnv = setupTestDOM();
    store = StateStore.getInstance();
    store.activePipPeers.clear();
    pipService = PipService.getInstance();
  });

  afterEach(() => {
    if (domEnv) {
      domEnv.cleanup();
      domEnv = null;
    }
  });

  describe('StateStore PiP Tracking & Concurrency', () => {
    it('initializes with an empty activePipPeers set', () => {
      assert.strictEqual(store.activePipPeers.size, 0);
      assert.strictEqual(store.isPeerInPip('peer-1'), false);
      assert.strictEqual(store.isPeerInPip('local'), false);
    });

    it('toggles peer PiP state via setPeerPipActive', () => {
      store.setPeerPipActive('peer-1', true);
      assert.strictEqual(store.isPeerInPip('peer-1'), true);
      assert.strictEqual(store.activePipPeers.has('peer-1'), true);

      store.setPeerPipActive('peer-1', false);
      assert.strictEqual(store.isPeerInPip('peer-1'), false);
      assert.strictEqual(store.activePipPeers.has('peer-1'), false);
    });

    it('supports multiple concurrent PiP sessions simultaneously', () => {
      store.setPeerPipActive('local', true);
      store.setPeerPipActive('peer-alpha', true);
      store.setPeerPipActive('peer-beta', true);

      assert.strictEqual(store.activePipPeers.size, 3);
      assert.strictEqual(store.isPeerInPip('local'), true);
      assert.strictEqual(store.isPeerInPip('peer-alpha'), true);
      assert.strictEqual(store.isPeerInPip('peer-beta'), true);
      assert.strictEqual(store.isPeerInPip('peer-gamma'), false);

      store.setPeerPipActive('peer-alpha', false);
      assert.strictEqual(store.activePipPeers.size, 2);
      assert.strictEqual(store.isPeerInPip('peer-alpha'), false);
      assert.strictEqual(store.isPeerInPip('peer-beta'), true);
    });
  });

  describe('PipService Session Management', () => {
    it('marks peer active in state store when openPip is invoked', async () => {
      await pipService.openPip('peer-x', 'Streamer X', null);
      assert.strictEqual(store.isPeerInPip('peer-x'), true);

      await pipService.restoreFromPip('peer-x');
      assert.strictEqual(store.isPeerInPip('peer-x'), false);
    });

    it('closeAllPipWindows clears all active PiP sessions', async () => {
      await pipService.openPip('peer-1', 'Streamer 1', null);
      await pipService.openPip('peer-2', 'Streamer 2', null);
      assert.strictEqual(store.isPeerInPip('peer-1'), true);
      assert.strictEqual(store.isPeerInPip('peer-2'), true);

      await pipService.closeAllPipWindows();
      assert.strictEqual(store.isPeerInPip('peer-1'), false);
      assert.strictEqual(store.isPeerInPip('peer-2'), false);
      assert.strictEqual(store.activePipPeers.size, 0);
    });
  });

  describe('CSS Token and Class Verification for PiP', () => {
    it('defines .pip-window-root, .pip-header, and internal control classes in style.css', () => {
      const cssPath = resolve(process.cwd(), 'src/style.css');
      const css = readFileSync(cssPath, 'utf-8');

      assert.ok(css.includes('.pip-window-root'), 'style.css must define .pip-window-root');
      assert.ok(css.includes('.pip-header'), 'style.css must define .pip-header');
      assert.ok(css.includes('.pip-header-left'), 'style.css must define .pip-header-left');
      assert.ok(css.includes('.pip-header-right'), 'style.css must define .pip-header-right');
      assert.ok(css.includes('.pip-close-btn'), 'style.css must define .pip-close-btn');
      assert.ok(css.includes('.pip-video-body'), 'style.css must define .pip-video-body');
      assert.ok(css.includes('.pip-video-element'), 'style.css must define .pip-video-element');
      assert.ok(css.includes('.btn-stream-pip'), 'style.css must define .btn-stream-pip');
      assert.ok(css.includes('.btn-restore-from-pip'), 'style.css must define .btn-restore-from-pip');
      assert.ok(css.includes('.pip-broadcaster-placeholder'), 'style.css must define .pip-broadcaster-placeholder');
    });

    it('ensures .btn-stream-pip adheres to standardized 28x28 circular control dimensions', () => {
      const cssPath = resolve(process.cwd(), 'src/style.css');
      const css = readFileSync(cssPath, 'utf-8');

      assert.ok(
        css.includes('.btn-stream-pip'),
        '.btn-stream-pip must be included in control buttons list'
      );
      assert.ok(
        css.includes('.btn-stream-fullscreen,\n.btn-stream-pin,\n.btn-stream-pip') ||
        css.includes('.btn-stream-pip:hover'),
        '.btn-stream-pip must be styled alongside fullscreen and pin buttons'
      );
    });
  });
});
