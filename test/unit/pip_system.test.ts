import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDOM, type DOMEnvironment } from '../helpers/browser_mocks.ts';
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

  describe('PiP WebRTC & STUN Configuration', () => {
    it('integrates buildIceServers STUN pool to prevent mDNS loopback failures', async () => {
      const { buildIceServers } = await import('../../src/p2p/ice_config.ts');
      const servers = buildIceServers();
      assert.ok(servers.length > 0, 'Must have ICE servers configured');
      const urls = servers.flatMap((s: any) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
      assert.ok(
        urls.some((u: string) => u.includes('stun')),
        'Must include STUN servers to resolve host/reflexive candidates'
      );
    });
  });

});
