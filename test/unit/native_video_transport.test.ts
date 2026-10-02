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
