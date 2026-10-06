# LAN / Virtual LAN WebRTC Mesh

## Scope and topology

Room creation offers Internet (P2P) and Local network / VPN. Internet rooms keep MQTT -> Nostr -> Torrent failover and optional TURN. LAN rooms reuse Trystero peer identity, authenticated admission, signed actions, subscriptions, file channels, and native video. Every participant establishes direct WebRTC edges; the creator's LAN service transports only discovery and Trystero SDP/ICE signaling, never media, chat, files, or app state.

The creator must keep the app open for new joins and reconnecting edges. Losing rendezvous does not intentionally close existing edges between remaining peers. Leaving the room stops the creator's service. Ownership transfer preserves the original endpoint; it does not migrate the network service to a successor. Saved LAN rooms can reopen on their original computer/interface and port. DHCP/interface changes require a new invitation/room in this initial implementation. Dedicated hosting and signaling-host migration are deferred.

## Invitations and adapters

`core/lan_room.ts` validates numeric unicast IPv4/IPv6 endpoints and random 256-bit rendezvous capabilities. Scoped/link-local IPv6, DNS names, URL credentials, extra paths, queries, multicast, loopback and unspecified addresses are rejected. Runtime discovery uses sysinfo. Prefer Radmin/Hamachi IPv4 by adapter name, with explicit user selection of other adapters. Never retain personal addresses in source or fixtures.

LAN uses signed `p2s5` snapshots containing `{ mode, endpoint, token }`. The token is a shareable discovery capability, not the room password or a private key. Old `p2s3`/`p2s4` invitations remain supported; internet creation still emits `p2s4`. Name/role/ownership updates preserve the descriptor and cannot silently retarget an active room. The frontend saved-room store and native encrypted vault preserve v5 revision ordering.

## Native rendezvous and recovery

`src-tauri/src/lan_signaling.rs` binds TCP port 49154 only on the selected assigned address. It authenticates sockets with room ID/capability, limits message size, connections, subscription count and publish rate, and uses bounded queues. Slow consumers cannot block other subscribers. Teardown closes the listener and its client tasks. Main-window-only commands connect the frontend through IPC events; the WebView CSP needs no broad insecure WebSocket exceptions.

`p2p/lan_signaling.ts` adapts native routing to the public `createTopicStrategy` API. `LanRelay` serializes writes, reconnects rendezvous independently, restores subscriptions and cleans up pending joins/listeners. LAN never falls back to public brokers. Signaling status reports LAN in the existing stream diagnostics tag.

Rendezvous WebSocket is unencrypted on an ordinary physical LAN; its capability does not replace TLS. VPN encryption depends on the VPN. WebRTC media/data retains encrypted transport and existing admission/authorization. LAN gathers host candidates with empty STUN/TURN lists in WebView2 and the native RTP sender. ICE may select any reachable local interface, not exclusively the interface selected for rendezvous. A VPN may itself use a relay; a host candidate does not prove a direct physical internet path.

Virtual LANs may not forward mDNS. Startup disables Chromium's `WebRtcHideLocalIpsWithMdns` feature while preserving GPU and preexisting browser flags. Numeric local ICE addresses become visible to signaling peers in both connection modes; private keys remain private and transport encryption remains enabled. Browser flags are runtime-dependent and need real remote WebView2 validation.

## Validation and manual experiment

A paired remote LAN reproduction showed both joiners reaching the creator promptly while their mutual edge retried three times. Both pending snapshots remained ICE `new` with zero candidate stats despite descriptions being present. Account for clock offsets by correlating repeated events and measuring durations within each process. ICE diagnostics include process-local connection IDs, monotonic attempt ages, sanitized media-section structure, SDP candidate counts and generated-candidate counters on pending and successful connections. No full SDP, candidate addresses or ICE credentials are recorded by these summaries. LAN timeout messages avoid internet TURN recommendations.

The next reproduction identified an empty remote offer and empty local answer: no media sections, ICE credentials, fingerprints or generated candidates. The next offer contained an active application section and connected promptly. This explains that attempt without attributing it to NAT or VPN routing. The native pnpm core patch now validates initial offers in `peer.getOffer`: an active application section is required. The existing offer-pool checkout discards invalid peers and retries once with a fresh peer before encryption/publication; invalid recycled offers are destroyed rather than returned to the pool. Real peer-adapter/pool tests cover empty/rejected offers, valid replacement, rollback recycling and bounded retry. The precise browser/recycling trigger remains unconfirmed, and remote testing with the patched build on all participants is still required. Presence and roster publication remain gated by authenticated room admission; a successful edge alone does not guarantee that names or roster synchronization can proceed while an authority edge is pending.

- `pnpm test`: signed endpoint/token tampering, old invitations, saved LAN snapshots, reconnection/in-flight teardown, and the real creation dialog with synthetic adapters.
- `pnpm run test:native --release`: real authenticated WebSocket routing, rejected capabilities, subscription isolation, listener shutdown, endpoint validation and browser-flag preservation. Hardware checks remain ignored by default.
- Explicit Radmin check: `pnpm run test:native --release lan_signaling::tests::radmin_adapter_hosts_authenticated_signaling -- --ignored`. Requires running Radmin VPN. Binds an ephemeral port on that adapter and exercises real local socket routing without recording addresses. This does not test a remote VPN peer or WebView2 media.
- Final packaging: `pnpm run tauri:build`, default target directory only.

For a real mesh experiment, use the same updated app on at least three computers on the same VPN. Allow P2Sharer through each firewall for that network, including the creator's TCP rendezvous port and WebRTC traffic. Create a Local network / VPN room, select the virtual adapter and share its signed invite. Confirm all edges connect, share audio/video from each participant, send files/app actions, and verify B <-> C continues after A leaves. New participants cannot join while A's rendezvous is offline. A local adapter/socket check cannot establish remote VPN media compatibility.
