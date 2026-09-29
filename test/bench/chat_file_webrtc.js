import { createActionWireManager } from '../../node_modules/@trystero-p2p/core/dist/action-wire.mjs';
import { CHAT_FILE_CHUNK_BYTES, CHAT_FILE_IN_FLIGHT_CHUNKS } from '../../src/core/chat_file_limits.ts';
import { decodeFileBase64, decodeSignedFileChunk, encodeFileBase64, encodeSignedFileChunk,
  fileChunkSignatureData, hashFileChunk } from '../../src/core/chat_file_wire.ts';
import { selectedIceRoute } from '../../src/core/ice_route.ts';

const output = document.querySelector('#result');
const benchmarkMiB = Number(new URLSearchParams(location.search).get('mib') || 16);
const totalBytes = benchmarkMiB * 1024 * 1024;
const source = new Uint8Array(totalBytes);
for (let index = 0; index < source.length; index++) source[index] = index % 251;
const timings = { senderPrepareMs: 0, senderTransportMs: 0, receiverVerifyMs: 0,
  receiverWriteMs: 0, ackMs: 0 };
let pcA;
let pcB;

function now() { return performance.now(); }
function show(value) { output.textContent = JSON.stringify(value, null, 2); window.__benchResult = value; }
async function waitIce(pc) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ICE gathering timeout')), 15000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); }
    });
  });
}
async function connect() {
  pcA = new RTCPeerConnection({ iceServers: [] });
  pcB = new RTCPeerConnection({ iceServers: [] });
  const outgoing = pcA.createDataChannel('chat-file', { ordered: true });
  const incomingPromise = new Promise((resolve) => { pcB.ondatachannel = (event) => resolve(event.channel); });
  await pcA.setLocalDescription(await pcA.createOffer());
  await waitIce(pcA);
  await pcB.setRemoteDescription(pcA.localDescription);
  await pcB.setLocalDescription(await pcB.createAnswer());
  await waitIce(pcB);
  await pcA.setRemoteDescription(pcB.localDescription);
  const incoming = await incomingPromise;
  await Promise.all([outgoing, incoming].map((channel) => channel.readyState === 'open' ? undefined :
    new Promise((resolve, reject) => { channel.onopen = resolve; channel.onerror = reject; })));
  for (const channel of [outgoing, incoming]) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 65535;
  }
  return { outgoing, incoming };
}
async function drain(channel, highWater) {
  if (channel.bufferedAmount <= highWater) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Data channel backpressure timeout')), 15000);
    channel.addEventListener('bufferedamountlow', () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
}
async function baseline(outgoing, incoming, highWater, lowWater) {
  outgoing.bufferedAmountLowThreshold = lowWater;
  let received = 0;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  incoming.onmessage = (event) => {
    received += event.data.byteLength;
    if (received === totalBytes) finish();
  };
  const frame = source.subarray(0, 16 * 1024 - 36);
  const start = now();
  for (let offset = 0; offset < totalBytes; offset += frame.length) {
    await drain(outgoing, highWater);
    outgoing.send(source.subarray(offset, Math.min(offset + frame.length, totalBytes)));
  }
  await done;
  return { seconds: (now() - start) / 1000, receivedBytes: received,
    highWaterBytes: highWater, lowWaterBytes: lowWater };
}
function wire(channel, peerId) {
  const peer = { channel, sendData: (bytes) => channel.send(bytes) };
  const manager = createActionWireManager({
    getPeer: (id) => id === peerId ? peer : null,
    getPeerIds: () => [peerId],
    canReceiveFromPeer: () => true,
    throwIfAborted: () => {},
  });
  channel.onmessage = (event) => manager.handleData(peerId, event.data);
  return manager.makeInternalAction('chat_file_v2');
}
async function signedChunk(keys, offset, bytes) {
  const start = now();
  const fromNative = decodeFileBase64(encodeFileBase64(bytes));
  const unsigned = { requestId: 'request', messageId: 'message', offset, hash: await hashFileChunk(fromNative) };
  const data = new TextEncoder().encode(JSON.stringify(['p2sharer-control-v1', 'room',
    'chat-file-chunk-v2', fileChunkSignatureData(unsigned)]));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data);
  const hex = Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, '0')).join('');
  const packet = encodeSignedFileChunk({ ...unsigned, signature: hex }, fromNative);
  timings.senderPrepareMs += now() - start;
  return packet;
}
async function fullTransfer(outgoing, incoming) {
  const sender = wire(outgoing, 'b');
  const receiver = wire(incoming, 'a');
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const destination = new Uint8Array(totalBytes);
  let acknowledged = 0;
  let written = 0;
  let waiting;
  let receivedError;
  const pending = new Map();
  let processing = false;
  const processPending = async () => {
    if (processing) return;
    processing = true;
    try {
      while (pending.has(written)) {
        const bytes = pending.get(written);
        pending.delete(written);
        const startWrite = now();
        const nativeBytes = decodeFileBase64(encodeFileBase64(bytes));
        destination.set(nativeBytes, written);
        written += nativeBytes.length;
        timings.receiverWriteMs += now() - startWrite;
        const startAck = now();
        await receiver.send({ kind: 'ack', offset: written }, 'a');
        timings.ackMs += now() - startAck;
      }
    } catch (error) { receivedError = String(error); waiting?.(); }
    finally { processing = false; }
  };
  receiver.onMessage(async (packet) => {
    try {
      const start = now();
      const decoded = decodeSignedFileChunk(packet);
      if (!decoded || decoded.header.hash !== await hashFileChunk(decoded.bytes)) throw new Error('Chunk digest mismatch');
      const signed = new TextEncoder().encode(JSON.stringify(['p2sharer-control-v1', 'room',
        'chat-file-chunk-v2', fileChunkSignatureData(decoded.header)]));
      const sig = Uint8Array.from(decoded.header.signature.match(/../g), (part) => parseInt(part, 16));
      if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, sig, signed)) {
        throw new Error('Chunk signature mismatch');
      }
      timings.receiverVerifyMs += now() - start;
      pending.set(decoded.header.offset, decoded.bytes);
      await processPending();
    } catch (error) { receivedError = String(error); waiting?.(); }
  });
  sender.onMessage((packet) => {
    if (packet.kind !== 'ack') return;
    acknowledged = Math.max(acknowledged, packet.offset);
    waiting?.();
  });
  const start = now();
  let sent = 0;
  while (sent < totalBytes) {
    if (receivedError) throw new Error(receivedError);
    if (sent - acknowledged >= CHAT_FILE_IN_FLIGHT_CHUNKS * CHAT_FILE_CHUNK_BYTES) {
      await new Promise((resolve) => { waiting = resolve; });
      waiting = undefined;
      continue;
    }
    const bytes = source.subarray(sent, Math.min(sent + CHAT_FILE_CHUNK_BYTES, totalBytes));
    const packet = await signedChunk(keys, sent, bytes);
    sent += bytes.length;
    const startSend = now();
    await sender.send(packet, 'b');
    timings.senderTransportMs += now() - startSend;
  }
  while (acknowledged < totalBytes) {
    if (receivedError) throw new Error(receivedError);
    await new Promise((resolve) => { waiting = resolve; });
    waiting = undefined;
  }
  const seconds = (now() - start) / 1000;
  const sourceHash = await hashFileChunk(source);
  const destinationHash = await hashFileChunk(destination);
  if (sourceHash !== destinationHash) throw new Error('Final file digest mismatch');
  return { seconds, verifiedBytes: written, finalDigestMatched: true };
}

try {
  show({ status: 'connecting', benchmarkMiB });
  const { outgoing, incoming } = await connect();
  show({ status: 'baseline', benchmarkMiB });
  const raw = await baseline(outgoing, incoming, 65535, 65535);
  show({ status: 'high buffer baseline', benchmarkMiB, raw });
  const rawHighBuffer = await baseline(outgoing, incoming, 4 * 1024 * 1024, 2 * 1024 * 1024);
  outgoing.bufferedAmountLowThreshold = 65535;
  show({ status: 'full transfer', benchmarkMiB, raw, rawHighBuffer });
  const full = await fullTransfer(outgoing, incoming);
  const stats = await pcA.getStats();
  const reports = [];
  stats.forEach((report) => reports.push(report));
  show({ status: 'complete', benchmarkMiB, raw: { ...raw, mbps: totalBytes / raw.seconds / 1e6 },
    rawHighBuffer: { ...rawHighBuffer, mbps: totalBytes / rawHighBuffer.seconds / 1e6 },
    full: { ...full, mbps: totalBytes / full.seconds / 1e6 }, timings,
    route: selectedIceRoute(reports) });
} catch (error) {
  show({ status: 'error', benchmarkMiB, error: String(error), stack: error?.stack });
} finally {
  pcA?.close();
  pcB?.close();
}
