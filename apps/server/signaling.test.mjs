import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import mqtt from 'mqtt';
import { WebSocket } from 'ws';
import { createWebServer } from './server.mjs';

const topicFor = text => [...createHash('sha1').update(text).digest()].map(byte => byte.toString(36)).join('');
async function setup(signaling) {
  const server = await createWebServer({ signaling });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `ws://127.0.0.1:${server.address().port}/mqtt` };
}
const connect = async url => {
  const client = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 2000 });
  client.on('error', () => {});
  await once(client, 'connect');
  return client;
};
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('first-party broker exchanges real Trystero-format discovery and SDP topics without retained data', { timeout: 10000 }, async () => {
  const { server, url } = await setup();
  const clients = [];
  try {
    const [sender, receiver] = await Promise.all([connect(url), connect(url)]); clients.push(sender, receiver);
    const topic = topicFor('Trystero@fixture-app@fixture-room');
    await receiver.subscribeAsync(topic);
    const received = once(receiver, 'message');
    await sender.publishAsync(topic, JSON.stringify({ peerId: 'fixture-peer', offer: 'fixture-sdp' }));
    const [actualTopic, payload] = await received;
    assert.equal(actualTopic, topic); assert.equal(JSON.parse(payload).offer, 'fixture-sdp');
    await assert.rejects(receiver.subscribeAsync('#'), /Subscribe error/);
    const perPeer = topicFor('Trystero@fixture-app@fixture-room@fixture-peer');
    await receiver.subscribeAsync(perPeer);
    const direct = once(receiver, 'message'); await sender.publishAsync(perPeer, 'direct-signal');
    assert.equal((await direct)[1].toString(), 'direct-signal');
    // Retained publications must disconnect, rather than persist discovery metadata.
    const disconnected = once(sender, 'close'); sender.publish(topic, 'do-not-retain', { retain: true }); await disconnected;
    const newcomer = await connect(url); clients.push(newcomer);
    let replayed = false; newcomer.on('message', () => { replayed = true; });
    await newcomer.subscribeAsync(topic); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(replayed, false);
  } finally { clients.forEach(client => client.end(true)); await close(server); }
});

test('broker rejects unknown paths, disallowed origins, oversized MQTT lengths and excess connections', { timeout: 10000 }, async () => {
  const { server, url } = await setup({ maxPerIp: 1 });
  const openSocket = async (address, options) => {
    const ws = new WebSocket(address, 'mqtt', options); ws.on('error', () => {});
    await once(ws, 'open'); return ws;
  };
  const rejected = (address, options) => new Promise(resolve => {
    const ws = new WebSocket(address, 'mqtt', options); ws.on('error', () => {});
    ws.on('unexpected-response', (request, response) => { const code = response.statusCode; response.resume(); ws.terminate(); resolve(code); });
  });
  let socket;
  try {
    assert.equal(await rejected(url + '/unknown'), 404);
    assert.equal(await rejected(url, { origin: 'https://untrusted.example' }), 403);
    socket = await openSocket(url);
    assert.equal(await rejected(url), 503);
    const closed = once(socket, 'close');
    // A declared 268435455-byte payload must be rejected before allocating/buffering it.
    socket.send(Buffer.from([0x30, 0xff]));
    socket.send(Buffer.from([0xff, 0xff, 0x7f])); await closed;
    socket = await openSocket(url); assert.equal(socket.readyState, WebSocket.OPEN);
  } finally { socket?.terminate(); await close(server); }
});
