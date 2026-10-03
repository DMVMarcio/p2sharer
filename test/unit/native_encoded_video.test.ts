import test from 'node:test';
import assert from 'node:assert/strict';
import { isNativeEncodedPacket, parseNativeEncodedPacket, NativeEncodedDecoder } from '../../src/video/native_encoded_video.ts';

function packet(sequence = 1, key = true): ArrayBuffer {
  const buffer = new ArrayBuffer(33); const view = new DataView(buffer);
  new Uint8Array(buffer).set([80,50,78,86,1,key ? 1 : 0]);
  view.setUint32(8, 720, true); view.setUint32(12, 1280, true);
  view.setUint32(16, sequence, true); view.setBigUint64(20, BigInt(sequence) * 1_000_000n, true);
  new Uint8Array(buffer, 28).set([0,0,0,1,0x65]); return buffer;
}

test('preview coalesces recovery requests while a replacement key travels through delivery', async () => {
  const previous={VideoDecoder:globalThis.VideoDecoder,EncodedVideoChunk:globalThis.EncodedVideoChunk,
    performance:globalThis.performance,window:globalThis.window};
  let now=0,requests=0;
  class Decoder {
    state='configured';output:(frame:unknown)=>void;
    constructor(callbacks:{output:(frame:unknown)=>void}){this.output=callbacks.output;}
    configure(){}
    decode(chunk:{timestamp:number}){queueMicrotask(()=>this.output({...chunk,close(){}}));}
    close(){this.state='closed';}
  }
  Object.assign(globalThis,{performance:{now:()=>now},window:{__TAURI_INTERNALS__:{invoke:async()=>{requests++;}}},
    VideoDecoder:Decoder,EncodedVideoChunk:class{timestamp:number;constructor(init:{timestamp:number}){this.timestamp=init.timestamp;}}});
  const decoder=new NativeEncodedDecoder('test','token');
  try {
    (await decoder.decode(packet(1)))!.close();
    assert.equal(await decoder.decode(packet(3,false)),null);
    for(let sequence=4;sequence<15;sequence++){now+=16;assert.equal(await decoder.decode(packet(sequence,false)),null);}
    assert.equal(requests,1,'Waiting delta pictures must not each force a new full-picture refresh');
    now=250;assert.equal(await decoder.decode(packet(15,false)),null);assert.equal(requests,2);
    (await decoder.decode(packet(16)))!.close();
    (await decoder.decode(packet(17,false)))!.close();
    assert.equal(requests,2);
  } finally {decoder.close();Object.assign(globalThis,previous);}
});
test('native H264 envelope preserves portrait geometry, sequence, key and microsecond timestamp', () => {
  const buffer = packet(); const decoded = parseNativeEncodedPacket(buffer);
  assert.equal(isNativeEncodedPacket(buffer), true);
  assert.deepEqual({ ...decoded, data: [...decoded.data] }, { key:true, width:720, height:1280,
    sequence:1, timestamp:1_000_000, data:[0,0,0,1,0x65] });
  assert.equal(isNativeEncodedPacket(new Uint8Array([255,216,255]).buffer), false);
});
test('native H264 envelope rejects truncated, unknown-version, invalid geometry and unsafe timestamps', () => {
  assert.throws(() => parseNativeEncodedPacket(new ArrayBuffer(28)));
  for (const [offset, value] of [[4,2],[5,2],[6,1],[8,0],[12,9000]] as const) {
    const buffer = packet(); const view = new DataView(buffer);
    if (offset < 8) view.setUint8(offset,value); else view.setUint32(offset,value,true);
    assert.throws(() => parseNativeEncodedPacket(buffer));
  }
  const buffer = packet(); new DataView(buffer).setBigUint64(20, BigInt(Number.MAX_SAFE_INTEGER)+1n, true);
  assert.throws(() => parseNativeEncodedPacket(buffer));
});
test('decoder caches repeated packets, waits for a key after loss, and closes pending frames on stop', async () => {
  const originalDecoder = globalThis.VideoDecoder, originalChunk = globalThis.EncodedVideoChunk;
  const emitted: Array<{closed:boolean;close:()=>void}> = [];
  let configurations = 0, closedDecoders = 0;
  class Decoder {
    state = 'unconfigured';
    constructor(privateCallbacks: {output:(frame:unknown)=>void}) { this.output = privateCallbacks.output; }
    output: (frame:unknown)=>void;
    configure() { this.state = 'configured'; configurations++; }
    decode(chunk: {timestamp:number}) { const frame = {timestamp:chunk.timestamp,closed:false,close(){this.closed=true;}}; emitted.push(frame); queueMicrotask(()=>this.output(frame)); }
    close() { this.state = 'closed'; closedDecoders++; }
  }
  Object.assign(globalThis, {VideoDecoder:Decoder, EncodedVideoChunk:class {timestamp:number;constructor(init:{timestamp:number}){this.timestamp=init.timestamp;}}});
  try {
    const decoder = new NativeEncodedDecoder('test', 'token');
    const first = await decoder.decode(packet(1)); first!.close();
    assert.equal(await decoder.decode(packet(1)), null);
    assert.equal(await decoder.decode(packet(3,false)), null);
    const recovery = await decoder.decode(packet(4)); recovery!.close();
    assert.equal(configurations,2); assert.equal(closedDecoders,1);
    const pending = decoder.decode(packet(5,false)); decoder.close();
    await assert.rejects(pending, /stopped/);
    await new Promise(resolve=>queueMicrotask(resolve));
    assert.ok(emitted.every(frame=>frame.closed));
    assert.equal(await decoder.decode(packet(6)),null);
  } finally { Object.assign(globalThis,{VideoDecoder:originalDecoder,EncodedVideoChunk:originalChunk}); }
});

test('decoder feeds buffered hardware without awaiting its first output and bounds stalled input', async () => {
  const originalDecoder = globalThis.VideoDecoder, originalChunk = globalThis.EncodedVideoChunk;
  let stalled = false, submitted = 0;
  class Decoder {
    state = 'unconfigured'; output: (frame:unknown)=>void;
    queue: Array<{timestamp:number}> = [];
    constructor(callbacks: {output:(frame:unknown)=>void}) { this.output=callbacks.output; }
    configure() {this.state='configured';}
    decode(chunk:{timestamp:number}) {
      submitted++; this.queue.push(chunk);
      if (!stalled && this.queue.length===3) {
        const frames=this.queue.splice(0);
        queueMicrotask(()=>frames.forEach(frame=>this.output({...frame,close(){}})));
      }
    }
    close() {this.state='closed';}
  }
  Object.assign(globalThis,{VideoDecoder:Decoder,EncodedVideoChunk:class {timestamp:number;constructor(init:{timestamp:number}){this.timestamp=init.timestamp;}}});
  try {
    const decoder=new NativeEncodedDecoder('test','token');
    const frames=await Promise.all([decoder.decode(packet(1)),decoder.decode(packet(2,false)),decoder.decode(packet(3,false))]);
    assert.ok(frames.every(Boolean)); assert.equal(submitted,3);
    frames.forEach(frame=>frame!.close()); stalled=true;
    const dropped=await Promise.all(Array.from({length:17},(_,index)=>decoder.decode(packet(index+4,false))));
    assert.ok(dropped.every(frame=>frame===null)); assert.equal(submitted,11);
    decoder.close();
  } finally {Object.assign(globalThis,{VideoDecoder:originalDecoder,EncodedVideoChunk:originalChunk});}
});

test('decoder preserves all references across a bounded UI input burst without resetting', async () => {
  const previous={VideoDecoder:globalThis.VideoDecoder,EncodedVideoChunk:globalThis.EncodedVideoChunk};
  let instance:Decoder,configurations=0;
  class Decoder {
    state='configured';output:(frame:unknown)=>void;submitted:number[]=[];awaiting:number[]=[];
    constructor(callbacks:{output:(frame:unknown)=>void}){this.output=callbacks.output;instance=this;}
    configure(){configurations++;}
    decode(chunk:{timestamp:number}){this.submitted.push(chunk.timestamp);this.awaiting.push(chunk.timestamp);}
    flushBatch(){const batch=this.awaiting.splice(0);for(const timestamp of batch)this.output({timestamp,close(){}});}
    close(){this.state='closed';}
  }
  Object.assign(globalThis,{VideoDecoder:Decoder,EncodedVideoChunk:class{timestamp:number;constructor(init:{timestamp:number}){this.timestamp=init.timestamp;}}});
  const decoder=new NativeEncodedDecoder('test','token');
  try {
    const burst=Array.from({length:16},(_,index)=>decoder.decode(packet(index+1,index===0)));
    assert.equal(instance!.submitted.length,8);
    assert.equal(await decoder.decode(packet(16,false)),null,'Cached refresh must not occupy backlog capacity');
    instance!.flushBatch();assert.equal(instance!.submitted.length,16);instance!.flushBatch();
    const frames=await Promise.all(burst);assert.ok(frames.every(Boolean));frames.forEach(frame=>frame!.close());
    assert.equal(configurations,1,'An intact input burst must not restart decoder prediction');
    assert.deepEqual(instance!.submitted,Array.from({length:16},(_,index)=>(index+1)*1_000_000));
    const stopping=Array.from({length:10},(_,index)=>decoder.decode(packet(index+17,false)));
    const rejected=Promise.allSettled(stopping);decoder.close();assert.ok((await rejected).every(value=>value.status==='rejected'));
  } finally {decoder.close();Object.assign(globalThis,previous);}
});
