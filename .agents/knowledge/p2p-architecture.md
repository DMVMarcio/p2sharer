# Deep Dive: P2P Networking, Signaling Failover & WebRTC Mesh

## Overview
P2Sharer operates as a serverless, peer-to-peer screen and audio streaming desktop application. It eliminates centralized media servers (SFUs) by establishing direct WebRTC mesh topologies between participants. Signaling uses public decentralized broker meshes with automatic multi-tier failover.

---

## 1. Multi-Transport Signaling Failover (`src/p2p/signaling_manager.ts`)

### User-managed rendezvous servers

`src/p2p/relay_preferences.ts` stores separate MQTT, Nostr, and WebTorrent server lists in local storage. Each entry has a secure WebSocket URL and an enabled flag. The network settings editor can add, remove, and toggle entries. At room join, `SignalingManager` loads the saved lists, passes only enabled URLs to Trystero's `relayConfig`, and starts MQTT probe clients only for enabled brokers. Transports with no enabled servers are omitted from the failover chain. At least one enabled server across all transports is required. Changes made while a room is active apply on the next join to preserve existing peer channels.

WebRTC signaling is handled through Trystero multi-transport adapters in strict prioritized order:
1. **MQTT (`@trystero-p2p/mqtt`)**: Primary transport (~50–150ms connection latency). Uses prioritized high-availability public brokers: `wss://public.cloud.shiftr.io`, `wss://broker.emqx.io:8084/mqtt`, `wss://broker-cn.emqx.io:8084/mqtt`, and `wss://test.mosquitto.org:8081/mqtt` (unresponsive endpoints like `broker.hivemq.com:8884` are strictly excluded).
2. **Nostr (`@trystero-p2p/nostr`)**: Secondary transport (~200–500ms connection latency). Relies on decentralized Nostr relay servers (`wss://relay.damus.io`, etc.).
3. **WebTorrent (`@trystero-p2p/torrent`)**: Tertiary fallback (~1–3s latency). Employs public BitTorrent trackers (`wss://tracker.openwebtorrent.com`, etc.).

### Watchdog, Health Probing & Failover Protocol


- **Current MQTT rendezvous topics**: Broker beacons must hash `Trystero@${appId}@${roomTopic}` and its per-peer variant using the actual `appId` passed to the active Trystero room. A stale hard-coded `v1` app ID silently publishes to the wrong topic when the active room uses `v5`, breaking rapid rediscovery and mesh bridging. Ignore delayed beacons from a previous room.
- **Identity handshake recovery**: An authenticated room retries a stable per-peer identity challenge while a direct WebRTC peer has no pinned public key. This covers an initial action sent before the receiving peer finished binding its handlers. Presence names are not required to be unique; cryptographic peer keys, rather than display names, anchor admission.
- **ICE diagnosis**: Trystero's `after exchanging SDP` error with a TURN hint reports a failed ICE route, not proof that the configured TURN endpoint is unreachable. Describe the failure without assigning an unverified cause. Remote-network testing is necessary to confirm candidate gathering and reachability.
- **Real MQTT Probe Keep-Alives**: In MQTT.js v5, internal WebSocket stream sockets are encapsulated and invisible to `getMqttRelaySockets()`. Public MQTT brokers (Shiftr, Mosquitto, EMQX) enforce strict handshake timeouts, dropping idle raw WebSockets after 5.0 seconds (code 1006) if no MQTT `CONNECT` packet is received. `SignalingManager` maintains dedicated lightweight `mqtt.connect` probe clients with 20s keep-alives (`PINGREQ`/`PINGRESP`) to each broker endpoint. This ensures accurate socket status without broker disconnects and prevents false zero-socket stalls.
- **Health Polling & Grace Window**: A watchdog runs every 1.5 seconds checking socket readiness states. During the initial 4.0 seconds after room join, watchdog failover is suppressed to allow WebSocket handshakes and TLS negotiation to complete.
- **Failover Safety with Active Peers**: The watchdog will never trigger transport failover when direct WebRTC peers are actively connected (`directConnectedPeers.size > 0`), protecting running voice and video sessions from unexpected teardown during brief broker hiccups.
- **Failover Reset**: When failover executes (`mqtt -> nostr -> torrent -> mqtt`), the grace timestamp resets to give the new transport an honest connection window. Clean room detachment (`activeRoom.leave()`) is executed before transition to prevent zombie socket leaks.
- **Network Awareness**: Listens to browser `online` and `offline` events. When the network reconnects, watchdog stalls are cleared and sockets are reprobed immediately.
- **Failover History**: Records all transitions (`from`, `to`, `reason`, `timestamp`) for live diagnostics in the UI HUD.

- **Primary Transport Reset on Room Join & Drift Prevention**: In `SignalingManager`, `joinRoom` and `leaveRoom` deterministically reset `activeTransport = 'mqtt'`, `consecutiveStalls = 0`, and `isFailingOver = false`. This guarantees that if transport failover ever triggered during a previous session or network blip, the application never remains trapped in an alternate signaling realm (Nostr or Torrent) where other peers in the room (who are on MQTT) are invisible, eliminating the bug where users were forced to restart the desktop app repeatedly to connect.
- **ActiveRoom Fallback Priority in Relay Sockets**: In `signalingManager.getRelaySockets('mqtt')`, probe sockets (`mqttSocketStatuses`) are only returned if at least one socket is actively connected (`connectedCount > 0`). If probe sockets are still in-flight or connecting (`connectedCount === 0`), `getRelaySockets` falls back to `this.activeRoom` healthy sockets without merging unconnected probe entries. This prevents the relay health watchdog from diagnosing false-positive "0 connected relays" and triggering premature failover to Nostr/Torrent within the first 6 seconds of entering a room.
- **Reconnection Handler Registration**: When transport failover occurs, `GroupRoomManager.reconnectOnNewTransport` is registered via `signalingManager.setRoomReconnectionHandler`, ensuring room actions, listeners, and presence loops are properly rebound to the new transport.

### Room Lifecycle & Teardown Protection
- **Async Teardown Synchronization**: `RoomService.joinRoom` must `await oldManager.leave()` before creating a new `GroupRoomManager`. `GroupRoomManager.leave()` includes a 60ms socket flush delay. Without `await`, a new room's initialization races with the old room's exit, causing the old room's deferred `signalingManager.leaveRoom()` call to wipe `activeRoom` on the new session.
- **Instance-Guarded Signaling Teardown**: `SignalingManager.leaveRoom(targetRoom?)` checks room identity against `this.activeRoom`. If `targetRoom` does not match `this.activeRoom`, it ignores the stale teardown request, protecting the current active session.
- **Proactive Room Join Rendezvous & Continuous Broker Beaconing**: Trystero discovers peers by listening on SHA-1 room and peer MQTT topics. To prevent offer starvation or timing races when a user enters a room that is already occupied: (1) `GroupRoomManager.setupRoomInstance` immediately dispatches 4 rapid presence beacons (at 100ms, 400ms, 1000ms, and 2200ms) via `signalingManager.reannounce(signalingTopic)` to announce presence across all connected MQTT brokers without waiting for 5.3s Trystero ticks; (2) `onPeerJoin` immediately acknowledges the incoming peer on the broker; and (3) `startHeartbeatLoop` continuously re-announces on the broker every 2.0s whenever the local user is alone in the room (`directConnectedPeers.size === 0`) or pending rumors exist, preventing pre-gathered STUN ICE candidate expiration from deadlocking discovery.

---

## 2. Peer Tracking & PEX Mesh Bridging (`src/p2p/peer_tracker.ts`, `src/p2p/group_room.ts`)

In P2P meshes (especially when using WebTorrent/PEX or multi-broker signaling), peer discovery can introduce "ghost peers" or partial mesh splits in 3+ peer sessions.

- **Instant PEX Rumor UI Visibility (`getAllRoomPeers()`)**: In multi-peer meshes (3+ participants), when peer A and B are connected, and peer B and C are connected, B gossips C to A via PEX. To eliminate the invisible participant bug where C is hidden from A until direct WebRTC finishes, `peer_tracker.ts` tracks `peerLastSeen` and `peerJoinedAt` for rumors. `getAllRoomPeers()` returns verified peers as `'connected'` and active PEX rumors as `'connecting'`. `GroupRoomManager` triggers `notifyPeersUpdate()` immediately upon receiving PEX rumors, rendering all room occupants in the UI without delay.
- **In-Mesh Signaling Re-Announcement**: Trystero's `makeAction` broadcasts exclusively across existing WebRTC DataChannels, meaning indirect peers cannot receive actions from peers they are not connected to. To solve this, `SignalingManager.reannounce(topic, targetPeerId)` was introduced. It calculates Trystero's SHA-1 topic strings (`Trystero@appId@topic` and `...topic@targetPeerId`) and directly publishes peer presence onto the active MQTT brokers, forcing Trystero to trigger native SDP offer/answer negotiation between the unmeshed pair.
- **STUN Pool**: Google and Cloudflare STUN servers are configured in `ice_config.ts` for direct candidate gathering. Mozilla STUN was removed after repeatable host lookup errors in live Windows tests.
- **Existing Room Stream Requesting**: When a peer enters an existing room where broadcasters are already active, presence announcements immediately trigger targeted `requestStreamFromPeer` actions to discover and pull remote streams without requiring broadcaster restarts.
- **WebRTC Connection State-Guarded Pruning**: Peers send periodic heartbeats. Stale peer pruning runs on a 25.0s threshold (extended from 6.0s to prevent false drops during high-bitrate screen sharing). Crucially, before removing any peer, `GroupRoomManager` inspects `RTCPeerConnection.connectionState`. If the WebRTC connection is `connected`, the peer is physically alive and its touch timestamp is refreshed, preventing accidental UI removal.
- **Deterministic Host Election**: When host responsibilities (e.g. room moderation, relay coordinator) are needed, the active peer with the lexicographically lowest peer ID is deterministically elected as host.

---

## 3. Media Coordination & Recovery Protocol (`src/p2p/media_coordinator.ts`)

### Targeted Stream Dispatch
Streams are routed explicitly per peer using `{ target: peerId }`. This prevents accidental broadcast storms and ensures viewers only receive streams they subscribe to.

### Hardware Codec Prioritization (SDP Mangling)
When negotiating WebRTC peer connections, `MediaCoordinator` reorders SDP `m=video` codec definitions to prioritize hardware-accelerated codecs:
1. **H.264** (Constrained Baseline / High profile with packetization-mode=1)
2. **AV1**
3. **VP9**
4. **VP8** (software fallback)

### Bidirectional Stream Recovery
When a remote track enters `ended` state, produces zero frames, or reports a stream ID mismatch during renegotiation:
1. The subscriber sends a targeted `stream-recovery-request` action to the broadcaster.
2. The broadcaster receives the request, re-acquires the sender track, and re-adds the stream via `targetedAddStream`.
3. If renegotiation fails, the subscriber drops the dead card and gracefully falls back to idle card state.

### Dynamic Bitrate & FPS Control
- Uses `RTCRtpSender.setParameters` to adjust `maxBitrate` (up to 50 Mbps) and `maxFramerate` (up to 120 FPS) without tearing down peer connections.

---

## 4. ICE, STUN & TURN Configuration (`src/p2p/ice_config.ts`)

- **Default STUN**: Uses Google and Cloudflare public STUN servers (`stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`, `stun:stun.cloudflare.com:3478`).
- **No valid bundled TURN service**: The hard-coded public OpenRelay credentials failed with Allocate 400 and TLS 701 during the occupied-room reproduction. The app no longer advertises that route as a working fallback. A public relay requires an operator and valid credentials; direct ICE cannot guarantee a route through every NAT pairing.
- **Optional TURN diagnosis**: Users can supply multiple UDP/TCP TURN URLs with one credential set through network settings for an isolated relay-only comparison. Self-hosted relay infrastructure is external to this repository and is not a default dependency.
- **ICE Candidate Pre-Gathering**: `iceCandidatePoolSize` is zero. Trystero 0.25.3 normally prewarms 20 offer connections; a tracked native pnpm patch reduces the idle pool to four while preserving on-demand offer creation. This lowers potential TURN allocation bursts on every join. Keep the patch and `test/unit/turn_offer_pool.test.ts` synchronized with Trystero upgrades.
- **Coturn listener binding**: Listener and relay interfaces must be selected explicitly when diagnosing an externally operated relay. Check that the configured address is assigned to that server; Docker/private interfaces can otherwise introduce ambiguity. Correlate client attempts with actual allocation records before assigning a cause. Do not record deployment addresses, regions, or personal test timestamps in shared memory.
- **Sanitization & Schemes**: Normalizes URLs missing the `turn:` or `turns:` prefix and validates each configured route.
- **Relay-Only Mode**: Supports `iceTransportPolicy: 'relay'` for restrictive NAT/firewall environments.
- **Accurate Traversal Diagnostics**: WebRTC connection timeouts (`could not connect to peer after exchanging SDP`) are classified honestly as potential NAT/ICE routing timeouts rather than falsely claiming both users have restrictive symmetric NAT routers.

## Diagnostic interpretation

Signaling reachability, SDP exchange, a relay candidate, and a connected MQTT probe do not establish a complete peer mesh. Inspect actual Trystero subscriptions and each ICE edge. Partial meshes can occur with or without TURN; a smaller offer pool or a configured relay alone is not proof of recovery. Warnings from an unused prewarmed connection do not prove an active route failed. Rate-limit duplicate errors from prewarmed connections and correlate sanitized process-local timing with relay logs when needed. Relay-only configuration omits unnecessary STUN lookups.

Ordinary ICE summaries sample pending negotiations at five and twelve seconds and include allowlisted candidate-pair checks, selected route metadata and DTLS state. Counts include peer-reflexive candidates; browser-unavailable measurements remain explicit. Reuse `selectedIcePair` for route selection and the shared opaque identifier function; never log raw ICE reports. See [diagnostic collection](../../docs/media-diagnostics.md) for comparing failed and successful admission on unchanged networks.
