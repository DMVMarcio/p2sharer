import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NativeVideoBridge } from '../../src/video/native_video_bridge';
import { NativeVideoTransport } from '../../src/p2p/native_video_transport';
import type { StreamDescriptor } from '../../src/core/media_streams';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve,ms));
function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
/** Actual packaged native RTP sender -> browser H264 receiver; no browser sending video track. */
export async function runNativeRtpLoopback(options: { peers?: number; fps?: number; warmupMs?: number; lifecycle?: boolean } = {}) {
  const desktop = getCurrentWindow(), maximized = await desktop.isMaximized(), top = await desktop.isAlwaysOnTop();
  await desktop.setAlwaysOnTop(true);
  if (!maximized) await invoke('plugin:window|internal_toggle_maximize',{label:desktop.label});
  const canvas=document.createElement('canvas'); canvas.width=1920; canvas.height=1080;
  canvas.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:100000';document.body.appendChild(canvas);
  let animation=0, frame=0; const context=canvas.getContext('2d')!;
  const draw=()=>{ context.fillStyle='#18432c';context.fillRect(0,0,1920,1080);context.fillStyle='#e6873e';
    context.fillRect((frame*12)%1600,150,250,600);context.fillStyle='#fff';context.font='56px sans-serif';
    context.fillText(`Native RTP ${frame++}`,60,100);animation=requestAnimationFrame(draw); }; draw();
  const bridge=new NativeVideoBridge(crypto.randomUUID()), secondary=new NativeVideoBridge(crypto.randomUUID());
  let descriptor:StreamDescriptor; const videos:HTMLVideoElement[]=[]; const receivers:NativeVideoTransport[]=[];
  let fallbackCount=0; let lastSignalError:string|undefined; const workers:Worker[]=[];let diagnosticWorker:Worker|undefined;
  const nativeHashes=new Set<number>(),pendingHashes=new Map<number,number>();let matchedSlices=0,remoteSlices=0;
  const sender=new NativeVideoTransport({rtc:()=>({iceServers:[]}), permitted:()=>true,
    send:(peer,signal)=>{void receivers[Number(peer)].signal('sender',signal).catch(e=>{lastSignalError=String(e);});},
    receive:()=>{throw new Error('Native sender must not receive video');},fallback:()=>{fallbackCount++;}});
  const makeReceiver=(index:number)=>new NativeVideoTransport({rtc:()=>({iceServers:[]}),permitted:()=>true,
    send:(_peer,signal)=>{void sender.signal(String(index),signal).catch(e=>{lastSignalError=String(e);});},fallback:()=>{},
    receive:(_peer,stream,receivedDescriptor)=>{
      if(index===0&&diagnosticWorker&&receivedDescriptor.id===descriptor.id){
        const receiver=receivers[index].receiver('sender',descriptor.id)?.getReceivers().find(r=>r.track===stream.getVideoTracks()[0]);
        if(receiver)(receiver as any).transform=new (globalThis as any).RTCRtpScriptTransform(diagnosticWorker,{});
      }
      const video=document.createElement('video');video.autoplay=true;video.muted=true;
      video.style.cssText='position:fixed;width:240px;opacity:0;bottom:0';video.srcObject=stream;document.body.appendChild(video);
      videos.push(video);void video.play();}});
  try {
    const fps=options.fps??60;
    const stream=await bridge.startCapture('screen:0',fps,{width:1280,height:720},false,90);
    // Match encoded VCL NAL bytes before local decoding and after RTP depacketization.
    const fingerprint=(buffer:ArrayBuffer,offset=0)=>{
      const bytes=new Uint8Array(buffer);const starts:number[]=[];
      for(let i=offset;i<bytes.length-3;i++)if(bytes[i]===0&&bytes[i+1]===0&&(bytes[i+2]===1||bytes[i+2]===0&&bytes[i+3]===1)){
        const skip=bytes[i+2]===1?3:4;starts.push(i+skip);i+=skip-1;
      }
      let hash=2166136261,found=false;
      for(let n=0;n<starts.length;n++){
        const start=starts[n],type=bytes[start]&31;if(type!==1&&type!==5)continue;found=true;
        let end=n+1<starts.length?starts[n+1]:bytes.length;
        if(n+1<starts.length){while(end>start&&bytes[end-1]===0)end--;if(bytes[end-1]===1)end--;while(end>start&&bytes[end-1]===0)end--;}
        for(let i=start;i<end;i++)hash=Math.imul(hash^bytes[i],16777619)>>>0;
      }
      return found?hash:null;
    };
    (bridge as unknown as {ws:WebSocket}).ws.addEventListener('message',({data})=>{
      if(!(data instanceof ArrayBuffer)||data.byteLength<=28||new DataView(data).getUint32(0,true)!==0x564e3250)return;
      const hash=fingerprint(data,28);if(hash!==null){nativeHashes.add(hash);
        matchedSlices+=pendingHashes.get(hash)??0;pendingHashes.delete(hash);
        if(nativeHashes.size>256)nativeHashes.delete(nativeHashes.values().next().value!);}
    });
    descriptor={id:crypto.randomUUID(),videoTrackId:stream.getVideoTracks()[0].id,kind:'screen',label:'Native RTP',fps,bitrate:15000};
    const Transform=(globalThis as any).RTCRtpScriptTransform;
    require(typeof Transform==='function','Encoded receiver inspection unavailable');
    const workerUrl=URL.createObjectURL(new Blob([`const fingerprint=${fingerprint.toString()};let transformer;
      self.onrtctransform=e=>{transformer=e.transformer;const reader=transformer.readable.getReader(),writer=transformer.writable.getWriter();
        void(async()=>{for(;;){const {done,value}=await reader.read();if(done)break;
          const hash=fingerprint(value.data);if(hash!==null)postMessage({hash});await writer.write(value);}})().catch(()=>{});};
      self.onmessage=()=>{void transformer?.sendKeyFrameRequest().catch(()=>{});};`],{type:'text/javascript'}));
    const worker=new Worker(workerUrl);URL.revokeObjectURL(workerUrl);workers.push(worker);
    worker.onmessage=({data})=>{if(data.hash!==undefined){remoteSlices++;
      if(nativeHashes.has(data.hash))matchedSlices++;else pendingHashes.set(data.hash,(pendingHashes.get(data.hash)??0)+1);}};
    diagnosticWorker=worker;

    for(let index=0;index<(options.peers??2);index++) {receivers.push(makeReceiver(index));require(sender.dispatch(String(index),stream,descriptor),'Native track registration required');}
    await wait(options.warmupMs??8000);
    const stats=async()=>Promise.all(receivers.map(async r=>{
      const pc=r.receiver('sender',descriptor.id);require(pc,'Native receiver missing');
      return [...(await pc.getStats()).values()].filter(s=>['inbound-rtp','codec','candidate-pair'].includes(s.type));}));
    const before=await stats();const beforeSender=await sender.senderStats(descriptor.id);const sampleStarted=performance.now();
    await wait(4000);const after=await stats();const afterSender=await sender.senderStats(descriptor.id);
    require(fallbackCount===0,`Unexpected fallback: ${fallbackCount}; ${lastSignalError}`);
    require(afterSender.every(r=>r.frames>0),'Native sender must packetize H264');
    require(matchedSlices>100&&matchedSlices/remoteSlices>0.95,`Encoded slices differ: ${matchedSlices}/${remoteSlices}`);
    require(receivers.every(r=>r.receiver('sender',descriptor.id)?.getSenders().every(s=>!s.track)),'Browser must not encode source video');
    const pixels=videos.map(video=>{const c=document.createElement('canvas');c.width=16;c.height=16;const ctx=c.getContext('2d')!;
      ctx.drawImage(video,0,0,16,16);const data=ctx.getImageData(0,0,16,16).data;let sum=0;for(let i=0;i<data.length;i+=4)sum+=data[i]+data[i+1]+data[i+2];
      require(video.videoWidth===1280&&video.videoHeight===720,'Native receiver geometry differs');require(sum>5000,'Native video is black');
      return {width:video.videoWidth,height:video.videoHeight,pixelSum:sum};});
    let lifecycle:unknown;
    if(options.lifecycle){
      const keysBefore=(await sender.senderStats(descriptor.id))[0].keyframes;
      for(let request=0;request<4;request++){worker.postMessage('key');await wait(350);}
      const requestedKeys=(await sender.senderStats(descriptor.id))[0].keyframes-keysBefore;
      require(requestedKeys>=3,'Actual receiver keyframe requests did not reach native NVENC');
      const secondStream=await secondary.startCapture('screen:0',30,{width:640,height:360},false,90);
      const secondDescriptor={...descriptor,id:crypto.randomUUID(),videoTrackId:secondStream.getVideoTracks()[0].id,fps:30,bitrate:5000};
      require(sender.dispatch('0',secondStream,secondDescriptor),'Independent native source unavailable');await wait(2500);
      const secondBefore=await sender.senderStats(secondDescriptor.id);
      sender.update(descriptor.id,800);await wait(2000);
      const reduced=await sender.senderStats(descriptor.id);require(reduced.every(r=>r.encoderBitrate<=800000),'User bitrate not applied to NVENC');
      sender.stop(descriptor.id);await wait(1000);const secondAfter=await sender.senderStats(secondDescriptor.id);
      require(secondAfter[0].frames>secondBefore[0].frames,'Stopping first native source disturbed second');
      require(secondAfter[0].routeCount===1,'Native routes leaked after targeted stop');
      for(let cycle=0;cycle<4;cycle++){
        require(sender.dispatch('0',stream,descriptor),'Native source restart failed');await wait(1500);
        require((await sender.senderStats(descriptor.id))[0].frames>0,'Restart did not send frames');sender.stop(descriptor.id);
      }
      await bridge.disableNativeEncoding();require(sender.dispatch('0',stream,descriptor),'Fallback route must be attempted');await wait(3000);
      require(fallbackCount===1,'Native encoder failure must request generic publication once');
      require((await sender.senderStats(secondDescriptor.id))[0].frames>secondAfter[0].frames,'Fallback disturbed independent sender');
      lifecycle={fallbackCount,reduced,independent:await sender.senderStats(secondDescriptor.id),restarts:4,requestedKeys};
    }
    return {pipeline:'native_h264_rtp',before,after,beforeSender,afterSender,sampleMs:performance.now()-sampleStarted,pixels,lifecycle,matchedSlices,remoteSlices,
      captureMetrics:await invoke('get_capture_metrics',{sessionId:bridge.sessionId}),signalError:lastSignalError};
  } finally {
    sender.close();for(const receiver of receivers)receiver.close();for(const worker of workers)worker.terminate();
    await bridge.stopCapture();await secondary.stopCapture();cancelAnimationFrame(animation);canvas.remove();for(const video of videos)video.remove();
    await desktop.setAlwaysOnTop(top);if(!maximized)await invoke('plugin:window|internal_toggle_maximize',{label:desktop.label});
  }
}
