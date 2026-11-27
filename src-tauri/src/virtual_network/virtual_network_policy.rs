//! IPv4 admission independent of the driver, IPC and WebView.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::Ipv4Addr,
    time::{Duration, Instant},
};

pub const MTU: usize = 1280;
pub fn virtual_ip(ip: Ipv4Addr) -> bool {
    let b = ip.octets();
    ((b[0] == 10 && (160..192).contains(&b[1]))
        || (b[0] == 172 && (16..32).contains(&b[1]))
        || (b[0] == 192 && b[1] == 168))
        && b[3] != 0
        && b[3] != 255
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub id: String,
    pub port: u16,
    pub protocol: String,
    pub generation: String,
}
impl Grant {
    pub fn valid(&self) -> bool {
        [&self.id, &self.generation]
            .iter()
            .all(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
            && ((self.protocol == "any" && self.port == 0)
                || (matches!(self.protocol.as_str(), "tcp" | "udp") && self.port != 0))
    }
    fn permits(&self, protocol: u8, port: u16) -> bool {
        self.protocol == "any"
            || ((protocol == 6 && self.protocol == "tcp"
                || protocol == 17 && self.protocol == "udp")
                && self.port == port)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Peer {
    pub id: String,
    pub ip: Ipv4Addr,
    pub grants: Vec<Grant>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub own: Vec<Grant>,
    pub peers: Vec<Peer>,
}
impl Scope {
    pub fn valid(&self, local: Ipv4Addr) -> bool {
        self.own.len() <= 32
            && self.own.iter().all(Grant::valid)
            && self.peers.len() <= 128
            && self.peers.iter().all(|p| {
                !p.id.is_empty()
                    && p.id.len() <= 100
                    && p.ip != local
                    && virtual_ip(p.ip)
                    && p.grants.len() <= 32
                    && p.grants.iter().all(Grant::valid)
            })
            && self.peers.iter().enumerate().all(|(i, p)| {
                self.peers[..i]
                    .iter()
                    .all(|old| old.ip != p.ip && old.id != p.id)
            })
    }
    pub fn active(&self) -> bool {
        !self.own.is_empty() || self.peers.iter().any(|p| !p.grants.is_empty())
    }
}
#[derive(Clone)]
struct Flow {
    grant: Grant,
    incoming: bool,
    scope: String,
    rule: String,
    protocol: u8,
    peer: String,
    time: Instant,
}
#[derive(Clone)]
struct Fragments {
    route: Route,
    ranges: Vec<(usize, usize)>,
    time: Instant,
}
#[derive(Clone, Debug)]
pub struct Route {
    pub scope: String,
    pub peer: String,
    pub rule: String,
}
#[derive(Default)]
pub struct Policy {
    pub scopes: HashMap<String, Scope>,
    flows: HashMap<(String, String, u8, u16, u16), Flow>,
    fragments: HashMap<(Ipv4Addr, Ipv4Addr, u16, u8), Fragments>,
}
impl Policy {
    pub fn configure(&mut self, id: &str, scope: Scope, local: Ipv4Addr) -> Result<(), String> {
        if !scope.active() {
            self.remove(id);
            return Ok(());
        }
        if !scope.valid(local)
            || id.len() != 36
            || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            || (!self.scopes.contains_key(id) && self.scopes.len() >= 24)
        {
            return Err("Invalid virtual network permissions".into());
        }
        for (other_id, other) in &self.scopes {
            if other_id == id {
                continue;
            }
            if scope.peers.iter().any(|p| {
                other
                    .peers
                    .iter()
                    .any(|old| p.ip == old.ip && p.id != old.id || p.id == old.id && p.ip != old.ip)
            }) {
                return Err("Virtual IP conflict; regenerate an address before connecting".into());
            }
        }
        if self.scopes.get(id) != Some(&scope) {
            self.flows.retain(|_, f| {
                f.scope != id
                    || self.scopes.get(id).is_some_and(|old| {
                        let previous = old.peers.iter().find(|p| p.id == f.peer);
                        let next = scope.peers.iter().find(|p| p.id == f.peer);
                        match (previous, next) {
                            (Some(previous), Some(next)) if previous.ip == next.ip => {
                                let grants = if f.incoming { &scope.own } else { &next.grants };
                                grants.contains(&f.grant)
                            }
                            _ => false,
                        }
                    })
            });
            self.fragments.retain(|_, f| f.route.scope != id);
        }
        if scope.active() {
            self.scopes.insert(id.into(), scope);
        } else {
            self.remove(id);
        }
        Ok(())
    }
    pub fn remove(&mut self, id: &str) {
        self.scopes.remove(id);
        self.flows.retain(|_, f| f.scope != id);
        self.fragments.retain(|_, f| f.route.scope != id);
    }
    pub fn clear(&mut self) {
        self.scopes.clear();
        self.flows.clear();
        self.fragments.clear();
    }
    pub fn peers(&self) -> Vec<Ipv4Addr> {
        let mut result: Vec<_> = self
            .scopes
            .values()
            .flat_map(|s| s.peers.iter().map(|p| p.ip))
            .collect();
        result.sort();
        result.dedup();
        result
    }
    pub fn packet(
        &mut self,
        data: &[u8],
        local: Ipv4Addr,
        source: Option<(&str, &str)>,
    ) -> Option<Route> {
        // Validate before parsing ports. IP options and overlapping fragments are not admitted.
        if data.len() < 20
            || data.len() > MTU
            || data[0] != 0x45
            || u16::from_be_bytes([data[2], data[3]]) as usize != data.len()
            || checksum(&data[..20]) != 0
        {
            return None;
        }
        let src = Ipv4Addr::new(data[12], data[13], data[14], data[15]);
        let dst = Ipv4Addr::new(data[16], data[17], data[18], data[19]);
        let incoming = source.is_some();
        if (incoming && dst != local)
            || (!incoming && src != local)
            || !virtual_ip(src)
            || !virtual_ip(dst)
            || src == dst
        {
            return None;
        }
        let remote = if incoming { src } else { dst };
        let bits = u16::from_be_bytes([data[6], data[7]]);
        if bits & 0x8000 != 0 {
            return None;
        }
        let offset = (bits & 0x1fff) as usize * 8;
        let more = bits & 0x2000 != 0;
        let length = data.len() - 20;
        if (more && (length == 0 || length % 8 != 0)) || offset + length > 65_515 {
            return None;
        }
        let protocol = data[9];
        let fragment_key = (src, dst, u16::from_be_bytes([data[4], data[5]]), protocol);
        self.fragments
            .retain(|_, f| f.time.elapsed() < Duration::from_secs(10));
        self.flows.retain(|_, f| {
            f.time.elapsed() < Duration::from_secs(if f.protocol == 6 { 3600 } else { 60 })
        });
        if offset != 0 {
            let fragments = self.fragments.get_mut(&fragment_key)?;
            if source.is_some_and(|(scope, peer)| {
                fragments.route.scope != scope || fragments.route.peer != peer
            }) || fragments.ranges.len() >= 128
                || fragments
                    .ranges
                    .iter()
                    .any(|&(a, b)| offset < b && offset + length > a)
            {
                return None;
            }
            fragments.ranges.push((offset, offset + length));
            return Some(fragments.route.clone());
        }
        let (local_port, remote_port) = match protocol {
            6 | 17 => {
                if data.len() < if protocol == 6 { 40 } else { 28 } {
                    return None;
                }
                let a = u16::from_be_bytes([data[20], data[21]]);
                let b = u16::from_be_bytes([data[22], data[23]]);
                if incoming {
                    (b, a)
                } else {
                    (a, b)
                }
            }
            // All-access grants include echo ping; unsupported protocols fail closed.
            1 if data.len() >= 28 && matches!(data[20], 0 | 8) => {
                (u16::from_be_bytes([data[24], data[25]]), 0)
            }
            _ => return None,
        };
        let mut candidates: Vec<_> = self.scopes.iter().collect();
        candidates.sort_by_key(|(id, _)| *id);
        let mut route = None;
        for (id, scope) in candidates {
            if source.is_some_and(|(scope, _)| scope != id) {
                continue;
            }
            let Some(peer) = scope
                .peers
                .iter()
                .find(|p| p.ip == remote && source.is_none_or(|(_, actor)| actor == p.id))
            else {
                continue;
            };
            let key = (
                id.clone(),
                peer.id.clone(),
                protocol,
                local_port,
                remote_port,
            );
            if let Some(flow) = self.flows.get_mut(&key) {
                flow.time = Instant::now();
                route = Some(Route {
                    scope: flow.scope.clone(),
                    peer: flow.peer.clone(),
                    rule: flow.rule.clone(),
                });
                break;
            }
            let grants = if incoming { &scope.own } else { &peer.grants };
            let port = if incoming { local_port } else { remote_port };
            let Some(grant) = grants.iter().find(|g| g.permits(protocol, port)) else {
                continue;
            };
            if self.flows.len() >= 4096 {
                return None;
            }
            let flow = Flow {
                grant: grant.clone(),
                incoming,
                scope: id.clone(),
                peer: peer.id.clone(),
                rule: grant.id.clone(),
                protocol,
                time: Instant::now(),
            };
            route = Some(Route {
                scope: id.clone(),
                peer: peer.id.clone(),
                rule: grant.id.clone(),
            });
            self.flows.insert(key, flow);
            break;
        }
        let route = route?;
        if more {
            if self.fragments.len() >= 512 || self.fragments.contains_key(&fragment_key) {
                return None;
            }
            self.fragments.insert(
                fragment_key,
                Fragments {
                    route: route.clone(),
                    ranges: vec![(0, length)],
                    time: Instant::now(),
                },
            );
        }
        Some(route)
    }
}
pub fn checksum(bytes: &[u8]) -> u16 {
    let mut sum = 0u32;
    for chunk in bytes.chunks(2) {
        sum += u16::from_be_bytes([chunk[0], *chunk.get(1).unwrap_or(&0)]) as u32;
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    const SCOPE: &str = "11111111-1111-4111-8111-111111111111";
    fn local() -> Ipv4Addr {
        Ipv4Addr::new(10, 160, 1, 1)
    }
    fn remote() -> Ipv4Addr {
        Ipv4Addr::new(10, 160, 1, 2)
    }
    fn grant(protocol: &str, port: u16) -> Grant {
        Grant {
            id: "22222222-2222-4222-8222-222222222222".into(),
            generation: "33333333-3333-4333-8333-333333333333".into(),
            protocol: protocol.into(),
            port,
        }
    }
    fn policy(own: Vec<Grant>, outgoing: Vec<Grant>) -> Policy {
        let mut policy = Policy::default();
        policy
            .configure(
                SCOPE,
                Scope {
                    own,
                    peers: vec![Peer {
                        id: "peer".into(),
                        ip: remote(),
                        grants: outgoing,
                    }],
                },
                local(),
            )
            .unwrap();
        policy
    }
    fn packet(src: Ipv4Addr, dst: Ipv4Addr, protocol: u8, source: u16, target: u16) -> Vec<u8> {
        let mut bytes = vec![0; if protocol == 6 { 40 } else { 28 }];
        bytes[0] = 0x45;
        let len = bytes.len() as u16;
        bytes[2..4].copy_from_slice(&len.to_be_bytes());
        bytes[8] = 64;
        bytes[9] = protocol;
        bytes[12..16].copy_from_slice(&src.octets());
        bytes[16..20].copy_from_slice(&dst.octets());
        bytes[20..22].copy_from_slice(&source.to_be_bytes());
        bytes[22..24].copy_from_slice(&target.to_be_bytes());
        checksum_header(&mut bytes);
        bytes
    }
    fn checksum_header(bytes: &mut [u8]) {
        bytes[10..12].fill(0);
        let sum = checksum(&bytes[..20]);
        bytes[10..12].copy_from_slice(&sum.to_be_bytes());
    }
    #[test]
    fn ports_sender_binding_and_return_flows_are_enforced() {
        let mut policy = policy(vec![grant("tcp", 12345)], vec![]);
        let request = packet(remote(), local(), 6, 50000, 12345);
        assert!(policy
            .packet(&request, local(), Some((SCOPE, "intruder")))
            .is_none());
        assert!(policy
            .packet(
                &packet(remote(), local(), 6, 50000, 12346),
                local(),
                Some((SCOPE, "peer"))
            )
            .is_none());
        assert!(policy
            .packet(&request, local(), Some((SCOPE, "peer")))
            .is_some());
        assert!(policy
            .packet(&packet(local(), remote(), 6, 12345, 50000), local(), None)
            .is_some());
        assert!(policy
            .packet(&packet(local(), remote(), 6, 55555, 12345), local(), None)
            .is_none());
        policy.remove(SCOPE);
        assert!(policy
            .packet(&request, local(), Some((SCOPE, "peer")))
            .is_none());
        assert!(policy
            .packet(&packet(local(), remote(), 6, 12345, 50000), local(), None)
            .is_none());
    }
    #[test]
    fn selected_remote_ports_allow_replies_without_opening_other_local_ports() {
        let mut policy = policy(vec![], vec![grant("udp", 23456)]);
        assert!(policy
            .packet(
                &packet(remote(), local(), 17, 23456, 50000),
                local(),
                Some((SCOPE, "peer"))
            )
            .is_none());
        assert!(policy
            .packet(&packet(local(), remote(), 17, 50000, 23456), local(), None)
            .is_some());
        assert!(policy
            .packet(
                &packet(remote(), local(), 17, 23456, 50000),
                local(),
                Some((SCOPE, "peer"))
            )
            .is_some());
        assert!(policy
            .packet(
                &packet(remote(), local(), 17, 23456, 50001),
                local(),
                Some((SCOPE, "peer"))
            )
            .is_none());
    }
    #[test]
    fn all_access_remains_scoped_to_the_virtual_peer_and_ip() {
        let mut policy = policy(vec![grant("any", 0)], vec![]);
        for protocol in [6, 17] {
            assert!(policy
                .packet(
                    &packet(remote(), local(), protocol, 40000, 65535),
                    local(),
                    Some((SCOPE, "peer"))
                )
                .is_some());
        }
        assert!(policy
            .packet(
                &packet(remote(), Ipv4Addr::LOCALHOST, 6, 40000, 65535),
                local(),
                Some((SCOPE, "peer"))
            )
            .is_none());
        assert!(policy
            .packet(
                &packet(Ipv4Addr::new(10, 160, 1, 3), local(), 6, 40000, 65535),
                local(),
                Some((SCOPE, "peer"))
            )
            .is_none());
        let mut ping = packet(remote(), local(), 1, 0, 0);
        ping[20] = 8;
        assert!(policy
            .packet(&ping, local(), Some((SCOPE, "peer")))
            .is_some());
        ping[20] = 3;
        assert!(policy
            .packet(&ping, local(), Some((SCOPE, "peer")))
            .is_none());
    }
    #[test]
    fn fragments_require_authorized_first_fragment_and_cannot_overlap() {
        let mut policy = policy(vec![grant("tcp", 12345)], vec![]);
        let mut first = packet(remote(), local(), 6, 50000, 12345);
        first.resize(52, 0);
        first[2..4].copy_from_slice(&52u16.to_be_bytes());
        first[4..6].copy_from_slice(&7u16.to_be_bytes());
        first[6..8].copy_from_slice(&0x2000u16.to_be_bytes());
        checksum_header(&mut first);
        let mut next = first.clone();
        next.resize(36, 0);
        next[2..4].copy_from_slice(&36u16.to_be_bytes());
        next[6..8].copy_from_slice(&4u16.to_be_bytes());
        checksum_header(&mut next);
        assert!(policy
            .packet(&next, local(), Some((SCOPE, "peer")))
            .is_none());
        assert!(policy
            .packet(&first, local(), Some((SCOPE, "peer")))
            .is_some());
        assert!(policy
            .packet(&next, local(), Some((SCOPE, "peer")))
            .is_some());
        assert!(policy
            .packet(&next, local(), Some((SCOPE, "peer")))
            .is_none());
        policy.remove(SCOPE);
        assert!(policy
            .packet(&next, local(), Some((SCOPE, "peer")))
            .is_none());
    }
    #[test]
    fn duplicate_ips_bad_checksums_and_unbounded_flow_creation_are_rejected() {
        let mut policy = policy(vec![grant("any", 0)], vec![]);
        let bad = Scope {
            own: vec![grant("tcp", 12345)],
            peers: vec![Peer {
                id: "other".into(),
                ip: remote(),
                grants: vec![],
            }],
        };
        assert!(policy
            .configure("44444444-4444-4444-8444-444444444444", bad, local())
            .is_err());
        let mut data = packet(remote(), local(), 6, 50000, 12345);
        data[10] ^= 1;
        assert!(policy
            .packet(&data, local(), Some((SCOPE, "peer")))
            .is_none());
        for port in 1..=4096 {
            assert!(policy
                .packet(
                    &packet(remote(), local(), 6, port, 12345),
                    local(),
                    Some((SCOPE, "peer"))
                )
                .is_some());
        }
        assert!(policy
            .packet(
                &packet(remote(), local(), 6, 4097, 12345),
                local(),
                Some((SCOPE, "peer"))
            )
            .is_none());
    }
    #[test]
    fn unrelated_membership_changes_preserve_existing_flows_but_revoke_changes() {
        let mut policy = policy(vec![grant("tcp", 12345)], vec![]);
        policy
            .packet(
                &packet(remote(), local(), 6, 50000, 12345),
                local(),
                Some((SCOPE, "peer")),
            )
            .unwrap();
        let mut scope = policy.scopes[SCOPE].clone();
        scope.peers.push(Peer {
            id: "other".into(),
            ip: Ipv4Addr::new(10, 160, 1, 3),
            grants: vec![],
        });
        policy.configure(SCOPE, scope.clone(), local()).unwrap();
        assert!(policy
            .packet(&packet(local(), remote(), 6, 12345, 50000), local(), None)
            .is_some());
        scope.own.clear();
        policy.configure(SCOPE, scope, local()).unwrap();
        assert!(policy
            .packet(&packet(local(), remote(), 6, 12345, 50000), local(), None)
            .is_none());
    }
    #[test]
    fn revoking_one_rule_preserves_connections_authorized_by_another() {
        let first = grant("tcp", 12345);
        let mut second = grant("tcp", 12346);
        second.id = "55555555-5555-4555-8555-555555555555".into();
        let mut policy = policy(vec![first.clone(), second.clone()], vec![]);
        for (client, port) in [(50000, 12345), (50001, 12346)] {
            policy
                .packet(
                    &packet(remote(), local(), 6, client, port),
                    local(),
                    Some((SCOPE, "peer")),
                )
                .unwrap();
        }
        let mut scope = policy.scopes[SCOPE].clone();
        scope.own = vec![second];
        policy.configure(SCOPE, scope, local()).unwrap();
        assert!(policy
            .packet(&packet(local(), remote(), 6, 12346, 50001), local(), None)
            .is_some());
        assert!(policy
            .packet(&packet(local(), remote(), 6, 12345, 50000), local(), None)
            .is_none());
    }
}
