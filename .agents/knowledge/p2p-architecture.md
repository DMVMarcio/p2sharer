# Deep Dive: P2P Networking, Signaling Failover & WebRTC Mesh

## Overview
P2Sharer operates as a serverless, peer-to-peer screen and audio streaming desktop application. It eliminates centralized media servers (SFUs) by establishing direct WebRTC mesh topologies between participants. Signaling uses public decentralized broker meshes with automatic multi-tier failover.

---

## 1. Multi-Transport Signaling Failover (`src/p2p/signaling_manager.ts`)

WebRTC signaling is handled through Trystero multi-transport adapters in strict prioritized order:
1. **MQTT (`@trystero-p2p/mqtt`)**: Primary transport (~50–150ms connection latency). Uses public HiveMQ/Eclipse MQTT brokers.
2. **Nostr (`@trystero-p2p/nostr`)**: Secondary transport (~200–500ms connection latency). Relies on decentralized Nostr relay servers (`wss://relay.damus.io`, etc.).
3. **WebTorrent (`@trystero-p2p/torrent`)**: Tertiary fallback (~1–3s latency). Employs public BitTorrent trackers (`wss://tracker.openwebtorrent.com`, etc.).

### Watchdog & Failover Protocol
- **Health Polling**: A watchdog runs every 1.5 seconds checking socket readiness states.
- **Stall Threshold**: 2 consecutive stalled health checks (3.0s) trigger an automatic failover to the next transport in the sequence (`mqtt -> nostr -> torrent -> mqtt`).
- **Network Awareness**: Listens to browser `online` and `offline` events. When the network reconnects, watchdog stalls are cleared and sockets are reprobed immediately.
- **Failover History**: Records all transitions (`from`, `to`, `reason`, `timestamp`) for live diagnostics in the UI HUD.

---

## 2. Peer Tracking & Ghost Peer Quarantine (`src/p2p/peer_tracker.ts`)

In P2P meshes (especially when using WebTorrent/PEX), peer discovery can introduce "ghost peers" (stale entries or untrusted gossip rumors).

- **Strict WebRTC Verification**: Only peers that have completed a direct WebRTC handshake (`onPeerJoin`) are treated as verified active peers.
- **PEX Rumor Quarantine**: Peers discovered via gossip/PEX rumors are quarantined in an untrusted pool. Quarantined peers cannot receive media streams until direct connection is confirmed.
- **Heartbeat & Pruning**: Peers send periodic heartbeats. Any peer without a heartbeat for `> 6000ms` is pruned from room slots and viewer lists.
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
- **Custom TURN Support**: Users can supply their own TURN server credentials (`turn:host:port` or `turns:host:port`) via the Settings modal.
- **Sanitization & Schemes**: Normalizes URLs missing the `turn:` or `turns:` prefix.
- **Relay-Only Mode**: Supports `iceTransportPolicy: 'relay'` for restrictive NAT/firewall environments.
