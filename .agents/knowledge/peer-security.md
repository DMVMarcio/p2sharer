# P2P Room Authorization and Threat Model

## Authenticated invitations

New desktop rooms use a `p2s3.` invitation that carries a random room identifier and the creator's P-256 public key. The signaling topic depends only on the room identifier. The optional password is entered at join time and is independent of discovery. The invitation key is the authority root; a claimed host flag, display name, or old room slug cannot replace it. Production Tauri joining requires this invitation. The Trystero app ID is `p2sharer-multi-stream-v3`, so older protocol clients cannot enter the same mesh.

Each installation stores its per-room signing identity in a Tauri Rust vault encrypted with Windows DPAPI for the current user. The vault also holds optional remembered passwords, saved invitations, and the verified authority chain. The frontend fallback is an in-memory map used by tests and browser development only. An invitation authenticates the room creator's key, not the human identity behind that key; sharing the invitation gives another person a copy of the trust anchor.

Two Windows processes under the same account share the vault. Opening an owned room from the saved-room list restores the owner key; manually joining that invitation as a participant creates a separate session identity and leaves the stored owner key intact. This supports local two-process testing without granting the second process host authority by default.

## Peer and host authentication

On each direct WebRTC edge, peers exchange fresh nonces and sign the room ID, peer ID, and nonce. The receiver pins the resulting public key to that direct peer ID. `GroupRoomManager` rejects ordinary actions and incoming media until both the local client and sender have a signed host admission. The host key is checked against the invitation or the verified transfer chain. Chat messages and history revisions remain independently signed, including edits, deletions, and system notices; unknown forwarded authors are rejected.

Host authority never moves automatically. The current host signs a transfer that names the successor key and peer ID and increases the authority epoch. The successor countersigns acceptance. Every client verifies the chain from the invitation root, including late joiners. Signed host commands admit or expel peers and update the password. Commands are room and epoch scoped, uniquely numbered, signature checked, and deduplicated. Commands can arrive out of order; newer signed password updates take precedence. Expulsion bans the current signing key, disconnects the edge, and rotates the join password for remaining admitted peers. If the host disconnects without transfer, nobody can admit newcomers or issue privileged commands.

## Action policy

| Channel | Receiver authorization |
| --- | --- |
| `peer_identity` | Fresh challenge and P-256 signature bind a key to the direct `meta.peerId`. |
| `room_authority` | Transfer signatures and full root-anchored chain are verified; only the named successor may accept an offer. |
| `room_admission` | Only signed current-host commands change membership, expulsion, or password; password requests go to the authenticated host. |
| `chat` / `history_sync` | Every revision is signed; author key and sender claims must match pinned identity and room membership. |
| Other room actions / WebRTC streams | Direct verified peer, admitted signing key, and local admission are required; room broadcasts are addressed only to admitted peers. |
| `peer_exchange` / `mesh_relay` | Connectivity hints remain untrusted and cannot confer identity, membership, or host authority. |

## Security limits

The password is submitted to the authenticated host over the direct WebRTC data channel, which is protected by WebRTC DTLS. This is not a password-authenticated key exchange protocol. The host learns the password, and a malicious host can disclose it. The invitation itself is a bearer capability for locating the room. A removed member who retains the invite can attempt a new connection with another identity, but the rotated password blocks admission until a current member discloses it. The protocol does not provide a globally trusted name, server-side moderation, or historical revocation independent of online peers. A host must be online for new admissions. Native two-process behavior still needs live desktop validation; unit tests cover signature and replay checks.
