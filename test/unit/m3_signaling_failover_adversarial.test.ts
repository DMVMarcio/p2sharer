import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignalingManager } from '../../src/p2p/signaling_manager.ts';
import { setupTestDOM, type DOMEnvironment } from '../helpers/browser_mocks.ts';
import type { SignalingTransport, SignalingFailoverEvent } from '../../src/core/types.ts';

describe('M3 Adversarial Challenge: Multi-Transport Signaling Failover & Watchdog Stress', () => {
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
  // Challenge 1: Cyclical Transport Failover State Machine Stress
  // =========================================================================
  describe('Challenge 1: Cyclical Failover Transitions & Integrity', () => {
    it('Empirical-1.1: 30 consecutive failover transitions cycle cleanly (MQTT -> Nostr -> Torrent -> MQTT)', () => {
      const manager = new SignalingManager();
      const expectedCycle: SignalingTransport[] = ['mqtt', 'nostr', 'torrent'];
      const recordedEvents: SignalingFailoverEvent[] = [];

      manager.onFailover((ev) => recordedEvents.push(ev));

      const NUM_TRANSITIONS = 30;
      for (let i = 0; i < NUM_TRANSITIONS; i++) {
        const currentExpected = expectedCycle[i % 3]!;
        const nextExpected = expectedCycle[(i + 1) % 3]!;

        assert.equal(
          manager.getActiveTransport(),
          currentExpected,
          `Step ${i}: activeTransport must be ${currentExpected}`
        );

        const reason = `stress_failure_step_${i}`;
        const result = manager.recordWatchdogFailure(reason);

        assert.equal(
          result,
          nextExpected,
          `Step ${i}: recordWatchdogFailure must return next transport ${nextExpected}`
        );
        assert.equal(
          manager.getActiveTransport(),
          nextExpected,
          `Step ${i}: getActiveTransport must be updated to ${nextExpected}`
        );
      }

      // Verify history integrity
      assert.equal(manager.failoverHistory.length, NUM_TRANSITIONS);
      assert.equal(recordedEvents.length, NUM_TRANSITIONS);

      for (let i = 0; i < NUM_TRANSITIONS; i++) {
        const fromExp = expectedCycle[i % 3]!;
        const toExp = expectedCycle[(i + 1) % 3]!;
        const hist = manager.failoverHistory[i]!;
        const ev = recordedEvents[i]!;

        assert.equal(hist.from, fromExp);
        assert.equal(hist.to, toExp);
        assert.equal(ev.from, fromExp);
        assert.equal(ev.to, toExp);
        assert.equal(ev.reason, `stress_failure_step_${i}`);
        assert.ok(hist.timestamp > 0);
      }
    });

    it('Empirical-1.2: getAvailableTransports returns an immutable defensive copy', () => {
      const manager = new SignalingManager();
      const list1 = manager.getAvailableTransports();
      assert.deepEqual(list1, ['mqtt', 'nostr', 'torrent']);

      // Mutate returned array
      list1.push('custom_transport' as any);
      list1.shift();

      // Ensure internal state was not corrupted
      const list2 = manager.getAvailableTransports();
      assert.deepEqual(list2, ['mqtt', 'nostr', 'torrent']);
    });

    it('Empirical-1.3: Manual transport switching with switchTransport truth table', async () => {
      const manager = new SignalingManager();
      assert.equal(manager.getActiveTransport(), 'mqtt');

      // 1. Switch to nostr -> valid
      const s1 = await manager.switchTransport('nostr');
      assert.equal(s1, true);
      assert.equal(manager.getActiveTransport(), 'nostr');

      // 2. Switch to nostr again -> no-op, returns false
      const s2 = await manager.switchTransport('nostr');
      assert.equal(s2, false);
      assert.equal(manager.getActiveTransport(), 'nostr');

      // 3. Switch to torrent -> valid
      const s3 = await manager.switchTransport('torrent');
      assert.equal(s3, true);
      assert.equal(manager.getActiveTransport(), 'torrent');

      // 4. Switch to invalid / unknown transport -> rejected
      const s4 = await manager.switchTransport('non_existent' as any);
      assert.equal(s4, false);
      assert.equal(manager.getActiveTransport(), 'torrent');

      // 5. Switch back to mqtt -> valid
      const s5 = await manager.switchTransport('mqtt');
      assert.equal(s5, true);
      assert.equal(manager.getActiveTransport(), 'mqtt');
    });

    it('Empirical-1.4: Listener exception isolation during failover broadcast', () => {
      const manager = new SignalingManager();
      const callLog: string[] = [];

      // Listener 1 throws
      manager.onFailover(() => {
        callLog.push('listener-1-throws');
        throw new Error('Listener 1 exploded');
      });

      // Listener 2 succeeds
      manager.onFailover(() => {
        callLog.push('listener-2-succeeds');
      });

      // Listener 3 throws
      manager.onFailover(() => {
        callLog.push('listener-3-throws');
        throw new Error('Listener 3 exploded');
      });

      // Listener 4 succeeds
      manager.onFailover(() => {
        callLog.push('listener-4-succeeds');
      });

      // Trigger failover; must NOT throw despite listener errors
      assert.doesNotThrow(() => {
        manager.recordWatchdogFailure('listener_isolation_test');
      });

      assert.deepEqual(callLog, [
        'listener-1-throws',
        'listener-2-succeeds',
        'listener-3-throws',
        'listener-4-succeeds',
      ]);
    });
  });

  // =========================================================================
  // Challenge 2: Watchdog Timeout & Health Check Behavior
  // =========================================================================
  describe('Challenge 2: Watchdog Timeout & Health Check Behavior', () => {
    it('Empirical-2.1: Grace period prevents premature failover during initial 4 seconds', () => {
      const manager = new SignalingManager();

      // Mock an active room
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'test-topic' };

      // Room joined at now
      (manager as any).roomJoinedTimestamp = Date.now();
      // Force 0 connected relays
      manager.getRelaySockets = () => ({});

      // 10 rapid health checks within grace period (<4000ms)
      for (let i = 0; i < 10; i++) {
        manager.checkRelayHealth();
      }

      // Consecutive stalls must remain 0 due to grace period
      assert.equal((manager as any).consecutiveStalls, 0);
      assert.equal(manager.getActiveTransport(), 'mqtt');
    });

    it('Empirical-2.2: Stall progression triggers failover after maxConsecutiveStalls (2 intervals)', () => {
      const manager = new SignalingManager();
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'test-topic' };

      // Artificially age roomJoinedTimestamp past the 4000ms grace period
      (manager as any).roomJoinedTimestamp = Date.now() - 5000;
      // Force 0 connected relays
      manager.getRelaySockets = () => ({});

      assert.equal((manager as any).consecutiveStalls, 0);
      assert.equal(manager.getActiveTransport(), 'mqtt');

      // Check 1: consecutiveStalls should increment to 1, no failover yet
      manager.checkRelayHealth();
      assert.equal((manager as any).consecutiveStalls, 1);
      assert.equal(manager.getActiveTransport(), 'mqtt');

      // Check 2: consecutiveStalls reaches 2 (maxConsecutiveStalls) -> triggers failover to nostr!
      manager.checkRelayHealth();
      // After failover, consecutiveStalls is reset to 0
      assert.equal((manager as any).consecutiveStalls, 0);
      assert.equal(manager.getActiveTransport(), 'nostr');
      assert.equal(manager.failoverHistory.length, 1);
      assert.equal(manager.failoverHistory[0]!.from, 'mqtt');
      assert.equal(manager.failoverHistory[0]!.to, 'nostr');
    });

    it('Empirical-2.3: Transient relay outage recovery debounces stall counter', () => {
      const manager = new SignalingManager();
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'test-topic' };
      (manager as any).roomJoinedTimestamp = Date.now() - 5000;

      // 1. First check: 0 relays connected -> stall becomes 1
      manager.getRelaySockets = () => ({});
      manager.checkRelayHealth();
      assert.equal((manager as any).consecutiveStalls, 1);
      assert.equal(manager.getActiveTransport(), 'mqtt');

      // 2. Relay reconnects before 2nd check!
      manager.getRelaySockets = () => ({
        'wss://relay1.com': { readyState: 1 }, // OPEN
      });
      manager.checkRelayHealth();

      // Consecutive stalls MUST reset to 0; NO failover occurs
      assert.equal((manager as any).consecutiveStalls, 0);
      assert.equal(manager.getActiveTransport(), 'mqtt');
      assert.equal(manager.failoverHistory.length, 0);
    });

    it('Empirical-2.4: Connected direct peers stay on their current mesh if relays die', () => {
      const manager = new SignalingManager();
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'test-topic' };
      (manager as any).roomJoinedTimestamp = Date.now() - 5000;

      // Direct WebRTC peers are connected
      manager.setPeerConnected('peer-1');
      manager.setPeerConnected('peer-2');

      // Case A: 1 relay connected -> stall count remains 0
      manager.getRelaySockets = () => ({
        'wss://relay1.com': { connected: true },
      });
      manager.checkRelayHealth();
      assert.equal((manager as any).consecutiveStalls, 0);

      // Case B: 0 relays connected -> preserve live WebRTC channels rather than
      // migrating only this client to an isolated signaling transport.
      manager.getRelaySockets = () => ({});
      manager.checkRelayHealth();
      assert.equal((manager as any).consecutiveStalls, 0);

      manager.checkRelayHealth();
      assert.equal(manager.getActiveTransport(), 'mqtt');
      assert.equal(manager.failoverHistory.length, 0);
    });

    it('Empirical-2.5: Relay socket status parser accurately handles various WebSocket readyState values', () => {
      const manager = new SignalingManager();

      // Mock various socket states
      manager.getRelaySockets = () => ({
        'wss://open-ws.com': { readyState: 1 }, // OPEN (1) -> connected
        'wss://connecting-ws.com': { readyState: 0 }, // CONNECTING (0) -> not connected
        'wss://closing-ws.com': { readyState: 2 }, // CLOSING (2) -> not connected
        'wss://closed-ws.com': { readyState: 3 }, // CLOSED (3) -> not connected
        'wss://client-connected.com': { connected: true }, // MQTT connected client -> connected
        'wss://client-disconnected.com': { connected: false }, // MQTT disconnected client -> not connected
        'wss://null-socket.com': null,
        'wss://empty-socket.com': {},
      });

      const status = manager.getRelayStatus('mqtt');
      // Total should be max(socket count, defaultMqttUrls count)
      assert.ok(status.total >= 8);
      // Exactly 2 sockets qualify as connected (readyState 1 and connected true)
      assert.equal(status.connected, 2);
      assert.equal(status.ratio, 2 / status.total);

      // Latency mapping: >0 connected -> 25ms
      const generalStatus = manager.getStatus();
      assert.equal(generalStatus.latencyMs, 25);

      // When 0 connected -> 999ms
      manager.getRelaySockets = () => ({});
      const disconnectedStatus = manager.getStatus();
      assert.equal(disconnectedStatus.latencyMs, 999);
    });
  });

  // =========================================================================
  // Challenge 3: Network Drop & Sleep Recovery (Online / Offline Events)
  // =========================================================================
  describe('Challenge 3: Network Drop & Sleep Recovery', () => {
    it('Empirical-3.1: window online event resets stalls and invokes checkRelayHealth', () => {
      let onlineHandler: (() => void) | null = null;
      let offlineHandler: (() => void) | null = null;

      // Mock window with event listeners
      const mockWindow = {
        addEventListener: (event: string, handler: () => void) => {
          if (event === 'online') onlineHandler = handler;
          if (event === 'offline') offlineHandler = handler;
        },
      };

      (globalThis as any).window = mockWindow;

      const manager = new SignalingManager();
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'test-topic' };
      (manager as any).roomJoinedTimestamp = Date.now() - 5000;
      (manager as any).consecutiveStalls = 1;

      assert.ok(onlineHandler !== null, 'Online listener must be registered');
      assert.ok(offlineHandler !== null, 'Offline listener must be registered');

      // Sockets currently healthy
      manager.getRelaySockets = () => ({
        'wss://healthy-relay.com': { readyState: 1 },
      });

      // Simulate online event firing
      onlineHandler!();

      // consecutiveStalls must be reset to 0
      assert.equal((manager as any).consecutiveStalls, 0);

      // Simulate offline event firing (should not throw)
      assert.doesNotThrow(() => {
        offlineHandler!();
      });
    });

    it('Empirical-3.2: Rapid network flapping does not cause unhandled rejections or crashes', () => {
      let onlineHandler: (() => void) | null = null;
      let offlineHandler: (() => void) | null = null;

      (globalThis as any).window = {
        addEventListener: (event: string, handler: () => void) => {
          if (event === 'online') onlineHandler = handler;
          if (event === 'offline') offlineHandler = handler;
        },
      };

      const manager = new SignalingManager();
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'test-topic' };

      assert.doesNotThrow(() => {
        for (let i = 0; i < 50; i++) {
          if (i % 2 === 0) {
            onlineHandler?.();
          } else {
            offlineHandler?.();
          }
        }
      });
    });

    it('Empirical-3.3: Headless / SSR environment without window initializes safely', () => {
      const originalWindow = (globalThis as any).window;
      delete (globalThis as any).window;

      try {
        let manager: SignalingManager | null = null;
        assert.doesNotThrow(() => {
          manager = new SignalingManager();
        });
        assert.ok(manager !== null);
        assert.equal(manager.getActiveTransport(), 'mqtt');
      } finally {
        (globalThis as any).window = originalWindow;
      }
    });
  });

  // =========================================================================
  // Challenge 4: Concurrent Failover & Asynchronous Reconnection Safety
  // =========================================================================
  describe('Challenge 4: Concurrent Failover & Reconnection Resilience', () => {
    it('Empirical-4.1: isFailingOver guard prevents overlapping reconnection handler executions', async () => {
      const manager = new SignalingManager();
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'test-topic' };

      let inFlightExecutions = 0;
      let maxConcurrentExecutions = 0;
      let totalExecutions = 0;

      manager.setRoomReconnectionHandler(async () => {
        inFlightExecutions++;
        maxConcurrentExecutions = Math.max(maxConcurrentExecutions, inFlightExecutions);
        // Simulate async delay
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlightExecutions--;
        totalExecutions++;
      });

      // Trigger failover 1
      manager.recordWatchdogFailure('stall-1');
      assert.equal((manager as any).isFailingOver, true);

      // Trigger failover 2 while failover 1 is still in-flight
      manager.recordWatchdogFailure('stall-2');

      // Wait for in-flight handler to resolve
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Assert that concurrent executions never exceeded 1
      assert.equal(maxConcurrentExecutions, 1);
      assert.equal(totalExecutions, 1);
      assert.equal((manager as any).isFailingOver, false);
      assert.equal(manager.getDetailedStatus().isFailingOver, false);
    });

    it('Empirical-4.2: Reconnection handler rejection does not deadlock isFailingOver flag', async () => {
      const manager = new SignalingManager();
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = { config: {}, topic: 'test-topic' };

      // Handler throws error
      manager.setRoomReconnectionHandler(async () => {
        throw new Error('Connection failed catastrophically');
      });

      // Trigger failover
      manager.recordWatchdogFailure('critical-stall');

      // Allow microtask queue to process rejection
      await new Promise((resolve) => setTimeout(resolve, 10));

      // isFailingOver must be reset to false despite the throw!
      assert.equal((manager as any).isFailingOver, false);
      assert.equal(manager.getDetailedStatus().isFailingOver, false);

      // Subsequent failover must be capable of executing
      let secondHandlerCalled = false;
      manager.setRoomReconnectionHandler(async () => {
        secondHandlerCalled = true;
      });

      manager.recordWatchdogFailure('recovery-stall');
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(secondHandlerCalled, true);
    });
  });

  // =========================================================================
  // Challenge 5: Lifecycle Cleanup & Resource Leak Prevention
  // =========================================================================
  describe('Challenge 5: Lifecycle Cleanup & Resource Leak Prevention', () => {
    it('Empirical-5.1: Watchdog timer stops cleanly and does not accumulate multiple intervals', () => {
      const manager = new SignalingManager();

      // Start watchdog multiple times
      manager.startWatchdog(100);
      const timer1 = (manager as any).watchdogTimer;
      assert.ok(timer1 !== null);

      manager.startWatchdog(100);
      const timer2 = (manager as any).watchdogTimer;
      assert.ok(timer2 !== null);
      // Timer 1 must have been cleared
      assert.notEqual(timer1, timer2);

      // Stop watchdog
      manager.stopWatchdog();
      assert.equal((manager as any).watchdogTimer, null);

      // Calling stopWatchdog again is safe
      assert.doesNotThrow(() => manager.stopWatchdog());
      assert.equal((manager as any).watchdogTimer, null);
    });

    it('Empirical-5.2: leaveRoom terminates watchdog, leaves active room, and cleans state', async () => {
      const manager = new SignalingManager();
      let roomLeft = false;

      (manager as any).activeRoom = {
        leave: async () => {
          roomLeft = true;
        },
      };
      (manager as any).lastRoomParams = { config: {}, topic: 'test-topic' };
      (manager as any).consecutiveStalls = 1;
      manager.setPeerConnected('peer-1');
      manager.setPeerConnected('peer-2');
      manager.startWatchdog(500);

      assert.equal((manager as any).directConnectedPeers.size, 2);
      assert.ok((manager as any).watchdogTimer !== null);

      await manager.leaveRoom();

      assert.equal(roomLeft, true, 'activeRoom.leave() must be awaited');
      assert.equal((manager as any).activeRoom, null);
      assert.equal((manager as any).lastRoomParams, null);
      assert.equal((manager as any).watchdogTimer, null);
      assert.equal((manager as any).directConnectedPeers.size, 0);
      assert.equal((manager as any).consecutiveStalls, 0);
    });

    it('Empirical-5.3: leaveRoom gracefully handles room.leave rejection', async () => {
      const manager = new SignalingManager();
      (manager as any).activeRoom = {
        leave: async () => {
          throw new Error('WebRTC socket close failed');
        },
      };

      // Must not throw unhandled rejection
      await assert.doesNotReject(async () => {
        await manager.leaveRoom();
      });

      assert.equal((manager as any).activeRoom, null);
    });

    it('Empirical-5.4: Unsubscribing listeners prevents memory leaks and stale callbacks', () => {
      const manager = new SignalingManager();
      let statusCallbackCount = 0;
      let failoverCallbackCount = 0;

      const unsubStatus1 = manager.onStatusChange(() => statusCallbackCount++);
      const unsubStatus2 = manager.onStatusChange(() => statusCallbackCount++);
      const unsubFailover1 = manager.onFailover(() => failoverCallbackCount++);
      const unsubFailover2 = manager.onFailover(() => failoverCallbackCount++);

      manager.notifyStatusChange();
      assert.equal(statusCallbackCount, 2);

      manager.recordWatchdogFailure('test');
      assert.equal(failoverCallbackCount, 2);
      // recordWatchdogFailure also notifies status listeners
      assert.equal(statusCallbackCount, 4);

      // Unsubscribe all
      unsubStatus1();
      unsubStatus2();
      unsubFailover1();
      unsubFailover2();

      // Trigger events again
      manager.notifyStatusChange();
      manager.recordWatchdogFailure('test-after-unsub');

      // Callback counts must not have incremented after unsubscribe
      assert.equal(statusCallbackCount, 4);
      assert.equal(failoverCallbackCount, 2);
    });
  });

  // =========================================================================
  // Challenge 6: Room Reconnection Workflow & Session Handshake
  // =========================================================================
  describe('Challenge 6: Room Reconnection Workflow & Session Handshake', () => {
    it('Empirical-6.1: SignalingManager executes room failover handler and restores session state', async () => {
      const manager = new SignalingManager();
      const reconnectLog: Array<{ from: SignalingTransport; to: SignalingTransport }> = [];

      manager.setRoomReconnectionHandler(async (to, from) => {
        reconnectLog.push({ to, from });
      });

      // Simulate an active room session
      (manager as any).activeRoom = { leave: async () => {} };
      (manager as any).lastRoomParams = {
        config: { appId: 'p2sharer-test' },
        topic: 'test-topic-123',
      };

      assert.equal(manager.getActiveTransport(), 'mqtt');

      // Trigger failover via switchTransport
      const switched = await manager.switchTransport('nostr');
      assert.equal(switched, true);
      assert.equal(manager.getActiveTransport(), 'nostr');

      assert.equal(reconnectLog.length, 1);
      assert.equal(reconnectLog[0]!.from, 'mqtt');
      assert.equal(reconnectLog[0]!.to, 'nostr');

      // Trigger watchdog failure (nostr -> torrent)
      manager.recordWatchdogFailure('all_relays_unreachable');
      // Allow microtask to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(reconnectLog.length, 2);
      assert.equal(reconnectLog[1]!.from, 'nostr');
      assert.equal(reconnectLog[1]!.to, 'torrent');

      // Clean up
      await manager.leaveRoom();
      assert.equal((manager as any).activeRoom, null);
    });
  });
});
