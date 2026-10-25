import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validNativeSignal, NativeVideoTransport } from '../../src/p2p/native_video_transport.ts';
import { registerNativeSenderSource, nativeSenderSource } from '../../src/video/native_sender_source.ts';

test('native signaling bounds SDP/candidates and ties offer to advertised media identity',()=>{
  const offer={id:'route',mediaId:'screen',kind:'offer',sdp:'v=0',descriptor:{id:'screen',kind:'screen',label:'Screen',videoTrackId:'track',fps:60,bitrate:15000}};
  assert.equal(validNativeSignal(offer),true);
  assert.equal(validNativeSignal({...offer,mediaId:'other'}),false);
  assert.equal(validNativeSignal({...offer,sdp:'a'.repeat(128*1024+1)}),false);
  assert.equal(validNativeSignal({id:'route',mediaId:'screen',kind:'ice',candidate:{candidate:'a'.repeat(4097)}}),false);
  assert.equal(validNativeSignal({id:'../route',mediaId:'screen',kind:'stop'}),false);
});
test('native source registration is track-specific and ended tracks cannot authorize a sender',()=>{
  const track={id:'track',readyState:'live'} as MediaStreamTrack;
  const other={id:'track',readyState:'live'} as MediaStreamTrack;
  registerNativeSenderSource(track,{sessionId:'capture',feedbackToken:'generation'});
  assert.equal(nativeSenderSource(track)?.sessionId,'capture');assert.equal(nativeSenderSource(other),undefined);
  Object.assign(track,{readyState:'ended'});assert.equal(nativeSenderSource(track),undefined);
});
test('generic tracks retain normal publication without native commands or timers',()=>{
  const native=new NativeVideoTransport({rtc:()=>({}),send:()=>assert.fail(),permitted:()=>true,receive:()=>assert.fail(),fallback:()=>assert.fail()});
  const stream={getVideoTracks:()=>[{readyState:'live'}]} as unknown as MediaStream;
  assert.equal(native.dispatch('peer',stream,{id:'camera',kind:'camera',label:'Camera',videoTrackId:'track',fps:30,bitrate:5000}),false);native.close();
});
test('stopping a local source never closes a remote source with the same media ID',()=>{
  const native=new NativeVideoTransport({rtc:()=>({}),send:()=>{},permitted:()=>true,receive:()=>{},fallback:()=>{}});
  const internal=native as any;let closedRemote=0;
  internal.outgoing.set('peer/screen',{id:'local-route',peer:'peer',descriptor:{id:'screen'},source:{feedbackToken:'local-token'},
    offered:false,timer:setTimeout(()=>{},1000)});
  internal.incoming.set('peer/screen',{id:'remote-route',peer:'peer',descriptor:{id:'screen'},
    pc:{close:()=>closedRemote++},timer:setInterval(()=>{},1000)});
  native.stop('screen');assert.equal(internal.outgoing.size,0);assert.equal(internal.incoming.size,1);assert.equal(closedRemote,0);
  native.stop('screen','peer');assert.equal(internal.incoming.size,0);assert.equal(closedRemote,1);native.close();
});

function receiverFixture(context: any) {
  let now = 0;
  context.mock.method(performance, 'now', () => now);
  const messages: any[] = [];
  const native = new NativeVideoTransport({ rtc: () => ({}), send: (_peer, signal) => messages.push(signal),
    permitted: () => true, receive: () => {}, fallback: () => {} });
  const pc = { connectionState: 'connecting', iceConnectionState: 'connected',
    getStats: async () => new Map(), close() { this.connectionState = 'closed'; } };
  const route = { id: 'remote-route', peer: 'peer', descriptor: { id: 'screen' }, pc,
    started: 0, timer: setInterval(() => {}, 60_000) };
  const internal = native as any;
  internal.incoming.set('peer/screen', route);
  context.after(() => native.close());
  return { native, pc, route, messages, internal, at: (time: number) => { now = time; } };
}

test('native receiver gives negotiation its own deadline and checks first video after connection', async context => {
  const f = receiverFixture(context);
  f.at(4000); await f.internal.checkReceiver(f.route);
  assert.equal(f.messages.length, 0, 'ICE connected does not mean DTLS and media are ready');
  f.at(12000); f.pc.connectionState = 'connected'; await f.internal.checkReceiver(f.route);
  f.at(15000); await f.internal.checkReceiver(f.route);
  assert.equal(f.messages.length, 0, 'First-video grace starts at the completed connection');
  f.at(15500); await f.internal.checkReceiver(f.route);
  assert.equal(f.messages[0]?.kind, 'reject');
  assert.equal(f.pc.connectionState, 'closed');
});

test('native receiver still falls back when setup never completes', async context => {
  const f = receiverFixture(context);
  f.at(15000); await f.internal.checkReceiver(f.route);
  assert.equal(f.messages[0]?.kind, 'reject');
  assert.equal(f.pc.connectionState, 'closed');
});

test('a completed native frame check cannot resurrect a closed receiver', async context => {
  const f = receiverFixture(context);
  let resolve!: (stats: Map<string, unknown>) => void;
  f.pc.getStats = () => new Promise(r => { resolve = r; });
  const pending = f.internal.checkReceiver(f.route);
  f.native.stop('screen', 'peer');
  resolve(new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: 1 }]]));
  await pending;
  assert.equal(f.messages.length, 0);
  assert.equal(f.internal.incoming.size, 0);
});

test('native statistics skip pending creation and ignore samples retired during IPC', async context => {
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const calls: string[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: (command: string) => { calls.push(command); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
  } } });
  context.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete (globalThis as any).window; });
  const native = new NativeVideoTransport({ rtc: () => ({}), send: () => {}, permitted: () => true,
    receive: () => {}, fallback: () => {} });
  const internal = native as any;
  const route = { id: 'route', peer: 'peer', descriptor: { id: 'screen' }, source: { feedbackToken: 'token' }, answered: false };
  internal.outgoing.set('peer/screen', route);
  assert.deepEqual(await native.senderStats('screen'), []);
  assert.deepEqual(calls, []);
  route.answered = true;
  const sampling = native.senderStats('screen');
  assert.deepEqual(calls, ['get_native_video_stats']);
  internal.outgoing.clear();
  pending[0].reject('Native route no longer exists');
  assert.deepEqual(await sampling, []);
  internal.outgoing.set('peer/screen', route);
  const invalid = native.senderStats('screen');
  pending[1].reject('Native route token mismatch');
  await assert.rejects(invalid, error => error === 'Native route token mismatch');
  internal.outgoing.clear(); native.close();
});
