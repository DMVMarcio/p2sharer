# P2P Message Authorization and Threat Model

## Trust boundary

`GroupRoomManager` is the only peer action receiver. Trystero supplies `meta.peerId` from the direct WebRTC channel; payload identity fields are untrusted. The room action wrapper rejects senders without a verified direct edge. The app ID `p2sharer-multi-stream-v2` prevents mixed rooms with clients that do not enforce this protocol.

Every chat message, including system notices, is signed with a non-exportable per-room ECDSA P-256 key. The canonical signed data includes the room ID, author peer ID, sender label, message ID, text, timestamp, revision, edit/deletion timestamps, reply reference, and system fields. A receiver pins a key to an author only when the message arrives directly from that author's peer ID. Forwarded chat and history require a previously pinned key; otherwise they are rejected. `mergeChatHistory` also requires matching author ID and key and will not revive a deleted revision.

## Action policy

| Channel | Receiver authorization |
| --- | --- |
| `chat` | Valid signed author; direct key binding or known forwarded key; consistent actor claim; monotonic revision merge. |
| `history_sync` | Direct verified sender; each item independently signed and verified; unknown forwarded authors rejected; 1,000-item cap. |
| `room_password_sync` | Direct verified elected host; the actor label comes from tracked presence, not the payload. Local UI and service also enforce host-only updates. |
| `presence` | Applies only to `meta.peerId`; schema checked, duplicate active names rejected, creator role pinned on first direct presence. |
| `stream_status`, `watch_status`, `stream_req` | Status and watcher identity come from `meta.peerId`; stream requests must target the local broadcaster and identify the actual requester. |
| `peer_leave` | Can remove only `meta.peerId`; a payload cannot name another peer. Relayed leave commands do not remove peers. |
| `peer_exchange`, `mesh_relay` | Remain unverified hints for connectivity only. PEX cannot change an already verified peer's identity or role. Batches and rumor counts are capped. |
| `peer_ping`, `peer_pong` | Direct verified sender and bounded timestamp. |

## Limits that require a stronger invite protocol

Peer IDs and creator status are ephemeral and self-declared at room entry. A signature proves continuity of the key observed on a direct channel, not the human behind a display name. A malicious participant can still claim to be the room creator before the genuine creator is observed by a new joiner. Preventing that requires an out-of-band creator public-key fingerprint in the room invite (or another trusted identity service). The current room code has no such trust anchor, so host authority cannot be described as cryptographically proven. Active peers cannot reuse another known author's signing key; however historical messages from authors never directly observed by this client are rejected rather than attributed from an untrusted relay.

All participants need the v2 client. An older client cannot join the same Trystero room, and unsigned legacy chat is rejected. The ordinary WebRTC media channel relies on Trystero's direct peer metadata and DTLS session; this layer does not authenticate real-world identities or encrypt against an already admitted room participant.
