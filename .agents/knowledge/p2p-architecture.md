# Deep Dive: P2P Networking, Signaling Failover & WebRTC Mesh

## Overview
P2Sharer operates as a serverless, peer-to-peer screen and audio streaming desktop application. It eliminates centralized media servers (SFUs) by establishing direct WebRTC mesh topologies between participants. Signaling uses public decentralized broker meshes with automatic multi-tier failover.

---

## 1. Multi-Transport Signaling Failover (`src/p2p/signaling_manager.ts`)

WebRTC signaling is handled through Trystero multi-transport adapters in strict prioritized order:
1. **MQTT (`@trystero-p2p/mqtt`)**: Primary transport (~50–150ms connection latency). Uses prioritized high-availability public brokers: `wss://broker.hivemq.com:8884/mqtt`, `wss://broker.emqx.io:8084/mqtt`, and `wss://test.mosquitto.org:8081/mqtt`.
2. **Nostr (`@trystero-p2p/nostr`)**: Secondary transport (~200–500ms connection latency). Relies on decentralized Nostr relay servers (`wss://relay.damus.io`, etc.).
3. **WebTorrent (`@trystero-p2p/torrent`)**: Tertiary fallback (~1–3s latency). Employs public BitTorrent trackers (`wss://tracker.openwebtorrent.com`, etc.).

### Watchdog, Health Probing & Failover Protocol
- **Real MQTT Probe Keep-Alives**: In MQTT.js v5, internal WebSocket stream sockets are encapsulated and invisible to `getMqttRelaySockets()`. Public MQTT brokers (HiveMQ, Mosquitto, EMQX) enforce strict handshake timeouts, dropping idle raw WebSockets after 5.0 seconds (code 1006) if no MQTT `CONNECT` packet is received. `SignalingManager` maintains dedicated lightweight `mqtt.connect` probe clients with 20s keep-alives (`PINGREQ`/`PINGRESP`) to each broker endpoint. This ensures accurate socket status without broker disconnects and prevents false zero-socket stalls.
- **Health Polling & Grace Window**: A watchdog runs every 1.5 seconds checking socket readiness states. During the initial 4.0 seconds after room join, watchdog failover is suppressed to allow WebSocket handshakes and TLS negotiation to complete.
- **Failover Safety with Active Peers**: The watchdog will never trigger transport failover when direct WebRTC peers are actively connected (`directConnectedPeers.size > 0`), protecting running voice and video sessions from unexpected teardown during brief broker hiccups.
- **Failover Reset**: When failover executes (`mqtt -> nostr -> torrent -> mqtt`), the grace timestamp resets to give the new transport an honest connection window. Clean room detachment (`activeRoom.leave()`) is executed before transition to prevent zombie socket leaks.
- **Network Awareness**: Listens to browser `online` and `offline` events. When the network reconnects, watchdog stalls are cleared and sockets are reprobed immediately.
- **Failover History**: Records all transitions (`from`, `to`, `reason`, `timestamp`) for live diagnostics in the UI HUD.

### Room Lifecycle & Teardown Protection
- **Async Teardown Synchronization**: `RoomService.joinRoom` must `await oldManager.leave()` before creating a new `GroupRoomManager`. `GroupRoomManager.leave()` includes a 60ms socket flush delay. Without `await`, a new room's initialization races with the old room's exit, causing the old room's deferred `signalingManager.leaveRoom()` call to wipe `activeRoom` on the new session.
- **Instance-Guarded Signaling Teardown**: `SignalingManager.leaveRoom(targetRoom?)` checks room identity against `this.activeRoom`. If `targetRoom` does not match `this.activeRoom`, it ignores the stale teardown request, protecting the current active session.

---

## 2. Peer Tracking & PEX Mesh Bridging (`src/p2p/peer_tracker.ts`, `src/p2p/group_room.ts`)

In P2P meshes (especially when using WebTorrent/PEX or multi-broker signaling), peer discovery can introduce "ghost peers" or partial mesh splits in 3+ peer sessions.

- **Strict WebRTC Verification**: Only peers that have completed a direct WebRTC handshake (`onPeerJoin`) are treated as verified active peers.
- **PEX Rumor Tracking & Active Bridging**: When an indirect peer is announced via Peer Exchange (PEX) gossip, it is recorded as a pending rumor. Rather than abandoning it in quarantine, connected intermediary peers actively bridge signaling using `meshRelayAction` (`mesh_hello`, `mesh_ack`).
- **In-Mesh Signaling Re-Announcement**: Trystero's `makeAction` broadcasts exclusively across existing WebRTC DataChannels, meaning indirect peers cannot receive actions from peers they are not connected to. To solve this, `SignalingManager.reannounce(topic, targetPeerId)` was introduced. It calculates Trystero's SHA-1 topic strings (`Trystero@appId@topic` and `...topic@targetPeerId`) and directly publishes peer presence onto the active MQTT brokers, forcing Trystero to trigger native SDP offer/answer negotiation between the unmeshed pair.
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
- **ICE Candidate Pre-Gathering**: Configures `iceCandidatePoolSize: 2` on all RTCPeerConfigurations to pre-gather STUN reflexive candidates ahead of SDP offer/answer exchange, drastically cutting WebRTC handshake latency.
- **Custom TURN Support**: Users can supply their own TURN server credentials (`turn:host:port` or `turns:host:port`) via the Settings modal.
- **Sanitization & Schemes**: Normalizes URLs missing the `turn:` or `turns:` prefix.
- **Relay-Only Mode**: Supports `iceTransportPolicy: 'relay'` for restrictive NAT/firewall environments.
- **Accurate Traversal Diagnostics**: WebRTC connection timeouts (`could not connect to peer after exchanging SDP`) are classified honestly as potential NAT/ICE routing timeouts rather than falsely claiming both users have restrictive symmetric NAT routers.
