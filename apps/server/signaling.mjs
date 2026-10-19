import { Transform, Duplex } from 'node:stream';
import { isIP } from 'node:net';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';

const MAX_PACKET = 128 * 1024;
const topicAllowed = topic => typeof topic === 'string' && /^[a-z0-9]{20,40}$/.test(topic);
const denied = () => new Error('Signaling policy violation');
const budget = limit => ({ remaining: limit, limit, reset: Date.now() + 1000 });
function consume(bucket, amount) {
  if (Date.now() >= bucket.reset) { bucket.remaining = bucket.limit; bucket.reset = Date.now() + 1000; }
  bucket.remaining -= amount;
  return bucket.remaining >= 0;
}

/** Bound MQTT remaining lengths before Aedes allocates packet buffers, even across WS messages. */
function packetGuard(globalBytes) {
  let header = [], remaining = 0, multiplier = 1, readingLength = false;
  const bytes = budget(1024 * 1024), packets = budget(200);
  return new Transform({ transform(chunk, encoding, done) {
    try {
      if (!consume(bytes, chunk.length) || !consume(globalBytes, chunk.length)) throw denied();
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining > 0 && !readingLength) {
          const count = Math.min(remaining, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + count)); offset += count; remaining -= count;
        } else if (!readingLength) {
          if (!consume(packets, 1)) throw denied();
          header = [chunk[offset++]]; multiplier = 1; remaining = 0; readingLength = true;
        } else {
          const digit = chunk[offset++]; header.push(digit);
          remaining += (digit & 127) * multiplier;
          if (remaining + header.length > MAX_PACKET || (header.length === 5 && digit & 128)) throw denied();
          multiplier *= 128;
          if (!(digit & 128)) { readingLength = false; this.push(Buffer.from(header)); header = []; }
        }
      }
      done();
    } catch (error) { done(error); }
  } });
}

/** An ephemeral, bounded rendezvous broker, with no TCP listener, retained messages or disk persistence. */
export async function attachSignalingBroker(server, { maxConnections = 512, maxPerIp = 64,
  trustProxy = false, allowedOrigins = ['https://p2sharer.com', 'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost', 'http://localhost:1420', 'http://localhost:1422'] } = {}) {
  const sockets = new WeakMap(), limits = new Map(), subscriptions = new WeakMap();
  const globalBytes = budget(8 * 1024 * 1024);
  const broker = await Aedes.createBroker({ connectTimeout: 7000, drainTimeout: 10000, queueLimit: 32,
    maxInflightInbound: 1, maxTopicLevels: 1,
    preConnect(client, packet, done) {
      const allowed = packet.protocolVersion === 4 && packet.clean === true && !packet.will;
      done(allowed ? null : denied(), allowed);
    },
    authorizePublish(client, packet, done) {
      done(client && (!topicAllowed(packet.topic) || packet.qos !== 0 || packet.retain || packet.payload.length > MAX_PACKET - 128) ? denied() : null);
    },
    authorizeSubscribe(client, subscription, done) {
      const topics = subscriptions.get(client) ?? new Set();
      subscriptions.set(client, topics);
      const allowed = topicAllowed(subscription.topic) && subscription.qos === 0 && (topics.has(subscription.topic) || topics.size < 32);
      if (allowed) topics.add(subscription.topic);
      done(null, allowed ? subscription : null);
    },
    authorizeForward(client, packet) {
      const socket = sockets.get(client.req);
      if (socket && socket.bufferedAmount > 512 * 1024) { socket.terminate(); return null; }
      return packet;
    },
  });
  // Connection failures carry no room topics, SDP, IP addresses or client identities into logs.
  broker.on('unsubscribe', (topics, client) => topics.forEach(topic => subscriptions.get(client)?.delete(topic)));
  broker.on('clientError', () => {}); broker.on('connectionError', () => {});
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PACKET, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has('mqtt') ? 'mqtt' : false });
  const upgrade = (request, socket, head) => {
    socket.on('error', () => {});
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    if (request.url !== '/mqtt') return reject('404 Not Found');
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin) && (() => { try { return new URL(origin).host !== request.headers.host; } catch { return true; } })()) return reject('403 Forbidden');
    const forwarded = trustProxy ? request.headers['x-forwarded-for']?.split(',')[0]?.trim() : null;
    const address = forwarded && isIP(forwarded) ? forwarded : request.socket.remoteAddress ?? 'unknown';
    const count = limits.get(address) ?? 0;
    if (wss.clients.size >= maxConnections || count >= maxPerIp) return reject('503 Service Unavailable');
    if (!(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).includes('mqtt')) return reject('400 Bad Request');
    wss.handleUpgrade(request, socket, head, websocket => {
      limits.set(address, count + 1); sockets.set(request, websocket);
      websocket.once('close', () => { const left = (limits.get(address) ?? 1) - 1; if (left) limits.set(address, left); else limits.delete(address); });
      websocket.on('error', () => {});
      const stream = createWebSocketStream(websocket), guard = packetGuard(globalBytes);
      const connection = Duplex.from({ readable: stream.pipe(guard), writable: stream });
      const close = () => { websocket.terminate(); connection.destroy(); };
      stream.on('error', close); guard.on('error', close); connection.on('error', close);
      broker.handle(connection, request);
    });
  };
  server.on('upgrade', upgrade);
  return async () => {
    server.removeListener('upgrade', upgrade);
    for (const websocket of wss.clients) websocket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => broker.close(resolve));
    limits.clear();
  };
}
