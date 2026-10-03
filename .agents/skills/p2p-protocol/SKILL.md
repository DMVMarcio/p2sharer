---
name: p2p-protocol
description: Governs decentralized WebRTC mesh signaling, multi-transport failover (MQTT, Nostr, Torrent), peer tracking, ghost peer quarantine, SDP codec mangling, and stream recovery in P2Sharer.
---

# Skill: P2P Protocol & Decentralized Signaling

## Scope
Applies to all modifications, diagnostics, and extensions of P2P networking in `src/p2p/*` (`SignalingManager`, `GroupRoomManager`, `MediaCoordinator`, `PeerTracker`, `IceConfig`).

## Dependency Patch Maintenance
- Use pnpm native patches registered in `pnpm-workspace.yaml` for Trystero core changes. Run `pnpm patch @trystero-p2p/core@0.25.3`, edit the returned directory, then run `pnpm patch-commit <directory>` and commit the patch plus `pnpm-lock.yaml`.
- Keep the version-specific patch aligned with Trystero upgrades and run `pnpm exec node --experimental-strip-types --test test/unit/turn_offer_pool.test.ts test/unit/trystero_media_identity.test.mjs`. Finish application changes with `pnpm run tauri:build`.

## Directives
1. **Multi-Transport Order**: Always maintain prioritized failover order: MQTT (primary) -> Nostr (secondary) -> WebTorrent (tertiary).
2. **Watchdog Health**: Any health probe logic must respect the stall counter (2 stalls @ 1.5s = 3.0s threshold) and trigger graceful failovers without crashing active WebRTC peer connections.
3. **PEX Rumor Quarantine**: Never trust gossip/PEX peer rumors for stream dispatch until a verified direct WebRTC handshake occurs.
4. **Targeted Stream Dispatch**: Always dispatch streams per peer using `{ target: peerId }`. Avoid uncontrolled media floods across the mesh.
5. **SDP Mangling**: Prioritize hardware-accelerated codecs (H.264 High/Baseline, AV1, VP9) over software codecs (VP8).
6. **Recovery Protocol**: Trigger bidirectional stream recovery on track degradation, streamId mismatch, or zero-frame stalls.
