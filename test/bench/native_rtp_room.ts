import { GroupRoomManager } from '../../src/p2p/group_room';
import { NativeVideoBridge } from '../../src/video/native_video_bridge';

let manager: GroupRoomManager | undefined;
const bridges: NativeVideoBridge[]=[];
const videos=new Map<string,HTMLVideoElement>();
let canvas: HTMLCanvasElement | undefined, animation=0, audio: AudioContext | undefined;
/** Run in two separate desktop processes with an isolated password-protected QA room. */
export async function joinNativeRtpRoom(roomId:string,password:string,name:string) {
  manager=new GroupRoomManager(name,roomId,password,false);
  await manager.join({onStreamsUpdate:()=>{},onPeersUpdate:()=>{},onStatusChange:()=>{},onChat:()=>{},onChatHistory:()=>{},
    onSlotsUpdate:slots=>{
      for(const slot of slots){if(slot.isLocal||!slot.stream?.getVideoTracks().length)continue;
        let video=videos.get(slot.peerId);if(!video){video=document.createElement('video');video.muted=true;video.autoplay=true;
          video.style.cssText='position:fixed;bottom:0;width:160px;opacity:0';videos.set(slot.peerId,video);document.body.appendChild(video);}
        if(video.srcObject!==slot.stream){video.srcObject=slot.stream;void video.play();}
      }
    }});
  return {peerId:manager.getLocalPeerId(),roomId};
}
export async function publishNativeRtpRoom() {
  if(!manager)throw new Error('QA room not joined');
  canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
  canvas.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:100000';document.body.appendChild(canvas);
  let frame=0;const draw=()=>{const ctx=canvas!.getContext('2d')!;ctx.fillStyle=`hsl(${frame++%360},60%,40%)`;
    ctx.fillRect(0,0,1280,720);ctx.fillStyle='#fff';ctx.font='50px sans-serif';ctx.fillText(`Native room ${frame}`,50,100);animation=requestAnimationFrame(draw);};draw();
  audio=new AudioContext();const destination=audio.createMediaStreamDestination();
  for(const [width,height,fps] of [[1280,720,60],[640,360,30]]){
    const bridge=new NativeVideoBridge(crypto.randomUUID());bridges.push(bridge);
    const stream=await bridge.startCapture('screen:0',fps,{width,height},false,90);
    if(bridges.length===1)stream.addTrack(destination.stream.getAudioTracks()[0]);
    manager.shareStream(stream,8_000_000,fps,{id:bridge.sessionId,kind:'screen',label:`Native ${width}`,videoTrackId:stream.getVideoTracks()[0].id,fps,bitrate:8000});
  }
  return {streams:bridges.map(b=>b.sessionId)};
}
export async function nativeRtpRoomStats() {
  if(!manager)throw new Error('QA room not joined');
  const internal=manager as any;
  const slots=manager.getAllRoomSlots();
  return {peerId:manager.getLocalPeerId(),peers:[...internal.peerTracker.directConnectedPeers],
    slots:await Promise.all(slots.map(async slot=>({id:slot.mediaId,isLocal:slot.isLocal,owner:slot.ownerPeerId,
      video:slot.stream?.getVideoTracks().map(t=>({id:t.id,state:t.readyState})),audio:slot.stream?.getAudioTracks().length,
      width:videos.get(slot.peerId)?.videoWidth,height:videos.get(slot.peerId)?.videoHeight,
      stats:slot.stream?await manager.getPeerStats(slot.peerId):undefined,
      native:slot.isLocal&&slot.mediaId?await internal.nativeVideo?.senderStats(slot.mediaId):undefined}))),
    browserVideoSenders:Object.values(internal.room?.getPeers?.()??{}).reduce((sum:number,pc:any)=>sum+pc.getSenders().filter((s:RTCRtpSender)=>s.track?.kind==='video').length,0)};
}
export async function stopNativeRtpRoomStream(index:number) {
  if(!manager||!bridges[index])throw new Error('QA stream missing');
  manager.stopStream(bridges[index].sessionId);await bridges[index].stopCapture();
}
export async function disableNativeRtpRoomEncoder(index:number) {
  if(!bridges[index])throw new Error('QA stream missing');await bridges[index].disableNativeEncoding();
}
export async function closeNativeRtpRoom() {
  await manager?.leave();manager=undefined;for(const bridge of bridges)await bridge.stopCapture();bridges.length=0;
  cancelAnimationFrame(animation);canvas?.remove();for(const video of videos.values())video.remove();videos.clear();
  if(audio&&audio.state!=='closed')await audio.close();audio=undefined;
}
