export interface TrafficCount { sent: number; received: number }
export interface TrafficSnapshot extends TrafficCount { peers?: Record<string, TrafficCount> }
interface Sample extends TrafficCount { time: number }

/** Estimates payload bytes/second from cumulative counters over a two-second window. */
export class TrafficRateSampler {
  private samples = new Map<string, Sample[]>();

  update(counters: Record<string, TrafficSnapshot>, time = performance.now()): Record<string, TrafficSnapshot> {
    const rates: Record<string, TrafficSnapshot> = {};
    const active = new Set<string>();
    const sample = (key: string, count: TrafficCount): TrafficCount => {
      active.add(key);
      let history = this.samples.get(key) ?? [];
      const last = history[history.length - 1];
      if (last && (time < last.time || count.sent < last.sent || count.received < last.received)) history = [];
      // Retain the sample just before the window boundary for irregular polling.
      while (history.length > 1 && history[1].time <= time - 2000) history.shift();
      const first = history[0];
      const seconds = first ? (time - first.time) / 1000 : 0;
      const rate = seconds > 0 ? {
        sent: (count.sent - first.sent) / seconds,
        received: (count.received - first.received) / seconds,
      } : { sent: 0, received: 0 };
      if (!history.length || time > history[history.length - 1].time) history.push({ sent: count.sent, received: count.received, time });
      this.samples.set(key, history);
      return rate;
    };
    for (const [key, count] of Object.entries(counters)) {
      const rate: TrafficSnapshot = sample(JSON.stringify([key]), count);
      if (count.peers) rate.peers = Object.fromEntries(Object.entries(count.peers)
        .map(([peer, value]) => [peer, sample(JSON.stringify([key, peer]), value)]));
      rates[key] = rate;
    }
    for (const key of this.samples.keys()) if (!active.has(key)) this.samples.delete(key);
    return rates;
  }

  clear(): void { this.samples.clear(); }
}
