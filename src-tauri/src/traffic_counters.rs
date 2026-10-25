use serde::Serialize;

#[derive(Clone, Default, Serialize)]
pub struct TrafficTotals {
    pub sent: u64,
    pub received: u64,
}

impl TrafficTotals {
    pub fn add(&mut self, sent: usize, received: usize) {
        self.sent = self.sent.saturating_add(sent as u64);
        self.received = self.received.saturating_add(received as u64);
    }
}

/// Existing participants update in place without allocating a peer ID per packet.
pub fn record_peer_traffic(peers: &mut std::collections::HashMap<String, TrafficTotals>, peer: &str, sent: usize, received: usize) {
    if let Some(totals) = peers.get_mut(peer) {
        totals.add(sent, received);
    } else {
        let mut totals = TrafficTotals::default();
        totals.add(sent, received);
        peers.insert(peer.into(), totals);
    }
}
