import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDOM, type DOMEnvironment } from '../e2e/harness/dom-mock.ts';
import { SignalingManager, DEFAULT_MQTT_RELAY_URLS } from '../../src/p2p/signaling_manager.ts';
import { PeerTracker } from '../../src/p2p/peer_tracker.ts';
import { buildRtcConfiguration, formatJoinError } from '../../src/p2p/ice_config.ts';
import { GroupRoomManager } from '../../src/p2p/group_room.ts';

describe('M7: P2P Mesh Connectivity, Indirect Bridging & Signaling Stability Hardening', () => {
  let domEnv: DOMEnvironment | null = null;

  beforeEach(() => {
    domEnv = setupTestDOM();
  });

  afterEach(() => {
    if (domEnv) {
      domEnv.cleanup();
      domEnv = null;
    }
  });

  // =========================================================================
  // Area 1: High-Availability MQTT Broker Configuration & Relay Sockets
  // =========================================================================
  describe('Area 1: High-Availability MQTT Broker Configuration', () => {
    it('1.1: DEFAULT_MQTT_RELAY_URLS includes fast verified brokers (Shiftr, EMQX, Mosquitto)', () => {
      assert.ok(Array.isArray(DEFAULT_MQTT_RELAY_URLS));
      assert.ok(DEFAULT_MQTT_RELAY_URLS.length >= 4);
      assert.ok(DEFAULT_MQTT_RELAY_URLS.some((u) => u.includes('shiftr.io')));
      assert.ok(DEFAULT_MQTT_RELAY_URLS.some((u) => u.includes('emqx.io')));
      assert.ok(DEFAULT_MQTT_RELAY_URLS.some((u) => u.includes('mosquitto.org')));
      // Shiftr should be first for lowest latency and highest responsiveness
      assert.ok(DEFAULT_MQTT_RELAY_URLS[0]!.includes('shiftr.io'));
    });

    it('1.2: getRelaySockets provides monitored fallback sockets when MQTT room is active', () => {
      const manager = new SignalingManager();
      // Initially no active room
      const initialSockets = manager.getRelaySockets('mqtt');
      assert.equal(typeof initialSockets, 'object');

      // Set active room
      (manager as any).activeRoom = { leave: async () => {} };
      const activeSockets = manager.getRelaySockets('mqtt');
      const urls = Object.keys(activeSockets);
      assert.ok(urls.length >= 3);
      assert.ok(urls.every((u) => activeSockets[u].connected === true));

      const status = manager.getRelayStatus('mqtt');
      assert.ok(status.connected >= 3);
      assert.ok(status.ratio > 0);
    });

    it('1.3: Active MQTT room does NOT trigger premature stall or failover under normal operation', () => {
      const manager = new SignalingManager();
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'steady-room' };
      (manager as any).roomJoinedTimestamp = Date.now() - 5000; // Past initial 4s grace

      // Check relay health: since activeRoom has healthy monitored sockets, stalls must be 0
      manager.checkRelayHealth();
      assert.equal((manager as any).consecutiveStalls, 0);
      assert.equal(manager.getActiveTransport(), 'mqtt');
      assert.equal(manager.failoverHistory.length, 0);
    });

    it('1.4: getRelaySockets falls back to activeRoom healthy sockets when probe sockets are unconnected', () => {
      const manager = new SignalingManager();
      // Simulate in-flight probe sockets with connected: false
      (manager as any).mqttSocketStatuses.set('wss://test.mosquitto.org:8081', { readyState: 0, connected: false });
      (manager as any).activeRoom = { leave: async () => {} };

      const sockets = manager.getRelaySockets('mqtt');
      const urls = Object.keys(sockets);
      assert.ok(urls.length >= 3);
      // Fallback to activeRoom healthy sockets must have been used
      assert.ok(urls.every((u) => sockets[u].connected === true));
    });

    it('1.5: joinRoom and leaveRoom deterministically reset activeTransport to mqtt', async () => {
      const manager = new SignalingManager();
      // Simulate that transport drifted to nostr during previous session
      (manager as any).activeTransport = 'nostr';
      (manager as any).consecutiveStalls = 3;
      (manager as any).isFailingOver = true;

      // Leaving room resets transport, stall counter, and failover state
      await manager.leaveRoom(null);
      assert.equal(manager.getActiveTransport(), 'mqtt');
      assert.equal((manager as any).consecutiveStalls, 0);
      assert.equal((manager as any).isFailingOver, false);

      // Verify joinRoom resets activeTransport to mqtt when not failing over
      (manager as any).activeTransport = 'torrent';
      (manager as any).isFailingOver = false;
      (manager as any).createRoomForTransport = () => ({ leave: async () => {} });
      manager.joinRoom({ appId: 'test' }, 'test-topic');
      assert.equal(manager.getActiveTransport(), 'mqtt');
      assert.equal((manager as any).consecutiveStalls, 0);

      await manager.leaveRoom(null);
    });

    it('1.6: reannounce publishes to sockets with connected=true or readyState=1', async () => {
      const manager = new SignalingManager();
      (manager as any).activeRoom = { selfId: 'self-peer-123' };
      const publishedTopics: string[] = [];
      const mockClient = {
        connected: false,
        readyState: 1, // OPEN
        publish: (topic: string) => {
          publishedTopics.push(topic);
        },
      };
      (manager as any).monitoredMqttSockets.set('wss://mock.broker', mockClient);

      await manager.reannounce('test-room', 'peer-target');
      // Publishes root topic + peer direct topic
      assert.equal(publishedTopics.length, 2);
      assert.ok(publishedTopics.every((t) => typeof t === 'string' && t.length > 0));
    });
  });

  // =========================================================================
  // Area 2: PeerTracker Indirect Rumors & Accessors
  // =========================================================================
  describe('Area 2: PeerTracker Indirect Rumors & Quarantine Accessors', () => {
    it('2.1: receivePeerExchange tracks rumor usernames and exposes getPendingRumors', () => {
      const tracker = new PeerTracker();

      // Indirect peer arrives via gossip
      const isDirect1 = tracker.receivePeerExchange('peer-indirect-1', false, 'Carlos', false);
      assert.equal(isDirect1, false);
      assert.equal(tracker.isVerified('peer-indirect-1'), false);
      assert.deepEqual(tracker.getPendingRumors(), ['peer-indirect-1']);
      assert.equal(tracker.getRumorUsername('peer-indirect-1'), 'Carlos');

      // Direct peer arrives
      const isDirect2 = tracker.receivePeerExchange('peer-direct-2', true, 'Ana', false);
      assert.equal(isDirect2, true);
      assert.equal(tracker.isVerified('peer-direct-2'), true);
      assert.deepEqual(tracker.getPendingRumors(), ['peer-indirect-1']);

      // Indirect peer becomes direct
      const isDirect3 = tracker.receivePeerExchange('peer-indirect-1', true);
      assert.equal(isDirect3, true);
      assert.equal(tracker.isVerified('peer-indirect-1'), true);
      assert.deepEqual(tracker.getPendingRumors(), []);
      assert.equal(tracker.getUsername('peer-indirect-1'), 'Carlos');
    });
  });

  // =========================================================================
  // Area 3: ICE / WebRTC Configuration & Diagnostics
  // =========================================================================
  describe('Area 3: ICE Pre-Gathering & Informative Join Error Formatting', () => {
    it('3.1: buildRtcConfiguration includes iceCandidatePoolSize: 2 for rapid hole-punching', () => {
      const rtcConfig = buildRtcConfiguration();
      assert.equal(rtcConfig.iceCandidatePoolSize, 2);
      assert.ok(Array.isArray(rtcConfig.iceServers));
      assert.ok(rtcConfig.iceServers.length > 0);
    });

    it('3.2: formatJoinError provides non-alarmist explanation and maintains compatibility keywords', () => {
      const err = formatJoinError({
        error: 'could not connect to peer after exchanging SDP; configure TURN servers with turnConfig or rtcConfig.iceServers',
        peerId: 'peer-test-99',
      });
      // Compatibility with existing tests and UI diagnostics
      assert.ok(err.includes('NAT Simétrico'));
      assert.ok(err.includes('Configure um servidor TURN'));
      assert.ok(err.includes('peer: peer-t'));
    });
  });

  // =========================================================================
  // Area 4: GroupRoomManager Mesh Relaying & Indirect Bridging
  // =========================================================================
  describe('Area 4: GroupRoomManager Mesh Relaying & Indirect Bridging', () => {
    it('4.1: bridgeIndirectPeer sends mesh_hello via intermediary to bridge 3+ peer split-brain', () => {
      const roomManager = new GroupRoomManager('Alice', 'room-alpha', '', true);
      const sentRelayMessages: any[] = [];

      // Mock room action
      (roomManager as any).meshRelayAction = {
        send: (data: any, opts: any) => {
          sentRelayMessages.push({ data, opts });
        },
      };

      // Call bridgeIndirectPeer
      (roomManager as any).bridgeIndirectPeer('peer-charlie', 'peer-bob', 'Charlie');

      assert.equal(sentRelayMessages.length, 1);
      assert.equal(sentRelayMessages[0].opts.target, 'peer-bob');
      assert.equal(sentRelayMessages[0].data.target, 'peer-charlie');
      assert.equal(sentRelayMessages[0].data.kind, 'mesh_hello');
      assert.equal(sentRelayMessages[0].data.payload.username, 'Alice');
      assert.equal(sentRelayMessages[0].data.payload.targetUsername, 'Charlie');
    });

    it('4.2: bridgeIndirectPeer is idempotent and ignores already verified peers or self', () => {
      const roomManager = new GroupRoomManager('Alice', 'room-alpha', '', true);
      const sentRelayMessages: any[] = [];
      (roomManager as any).meshRelayAction = {
        send: (data: any, opts: any) => sentRelayMessages.push({ data, opts }),
      };

      // 1. Target is self -> ignored
      (roomManager as any).bridgeIndirectPeer((roomManager as any).peerTracker.isVerified('self') ? 'self' : (roomManager as any).username, 'peer-bob');
      assert.equal(sentRelayMessages.length, 0);

      // 2. Target is already verified peer -> ignored
      (roomManager as any).peerTracker.addPeer('peer-verified', 'VerifiedPeer');
      (roomManager as any).bridgeIndirectPeer('peer-verified', 'peer-bob');
      assert.equal(sentRelayMessages.length, 0);
    });
  });
});
