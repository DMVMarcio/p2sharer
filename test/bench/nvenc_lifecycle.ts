import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NativeVideoBridge } from '../../src/video/native_video_bridge';

/** Requires P2SHARER_NATIVE_NVENC=1 in a real packaged Tauri instance. */
export async function runNvencLifecycle() {
  const first = new NativeVideoBridge(crypto.randomUUID()), second = new NativeVideoBridge(crypto.randomUUID());
  const tiny = new NativeVideoBridge(crypto.randomUUID());
  const decoderUnavailable = new NativeVideoBridge(crypto.randomUUID());
  const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=360;
  canvas.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:100000';
  document.body.appendChild(canvas);
  let animation=0, counter=0;
  const draw=()=>{const ctx=canvas.getContext('2d')!;ctx.fillStyle=`hsl(${counter++%360},60%,40%)`;ctx.fillRect(0,0,640,360);animation=requestAnimationFrame(draw);};
  draw();
  const wait=()=>new Promise(resolve=>setTimeout(resolve,1000));
  const metrics=(bridge:NativeVideoBridge)=>invoke<Record<string,number>>('get_capture_metrics',{sessionId:bridge.sessionId});
  const require=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
  try {
    const firstStream=await first.startCapture('screen:0',60,{width:1280,height:720},false,90);
    const secondStream=await second.startCapture('screen:0',30,{width:640,height:360},false,90);
    const firstTrack=firstStream.getVideoTracks()[0], secondTrack=secondStream.getVideoTracks()[0];
    const oldToken=(first as unknown as {encoderFeedbackToken:string}).encoderFeedbackToken;
    await wait(); const before=await metrics(first), independentBefore=await metrics(second);
    require(before.nvenc_images>0 && independentBefore.nvenc_images>0,'Two real NVENC sessions required');
    await first.disableNativeEncoding(); await wait();
    const fallback=await metrics(first), independentAfter=await metrics(second);
    require(fallback.nvenc_fallbacks===1 && fallback.images-before.images>fallback.nvenc_images-before.nvenc_images,'Generic native images did not resume');
    require(firstStream.getVideoTracks()[0]===firstTrack && firstTrack.readyState==='live','Fallback replaced or stopped the track');
    require(independentAfter.nvenc_images>independentBefore.nvenc_images && independentAfter.nvenc_fallbacks===0 && secondTrack.readyState==='live','Fallback affected the second session');
    await first.stopCapture();
    await first.startCapture('screen:0',30,{width:640,height:360},false,90); await wait();
    let staleRejected=false;
    try {await invoke('control_capture_encoder',{sessionId:first.sessionId,feedbackToken:oldToken,disable:true});}
    catch {staleRejected=true;}
    require(staleRejected,'Old encoder feedback token affected restarted capture');
    const restarted=await metrics(first); require(restarted.nvenc_images>0 && restarted.nvenc_fallbacks===0,'NVENC restart failed');
    for (let index=0;index<6;index++) {
      await first.startCapture('screen:0',30,{width:640,height:360},false,90);
      const cycle=await metrics(first);
      require(cycle.nvenc_images>0 && cycle.nvenc_fallbacks===0,'Repeated restart exhausted encoder sessions');
    }
    await tiny.startCapture('screen:0',30,{width:16,height:16},false,90); await wait();
    const unsupported=await metrics(tiny);
    require(unsupported.nvenc_images===0 && unsupported.nvenc_fallbacks===1 && unsupported.images>0,'Unsupported NVENC geometry did not fall back to JPEG');
    const originalDecoder=globalThis.VideoDecoder;
    let decoderFallback:Record<string,number>;
    try {
      Object.assign(globalThis,{VideoDecoder:undefined});
      await decoderUnavailable.startCapture('screen:0',30,{width:640,height:360},false,90); await wait();
      decoderFallback=await metrics(decoderUnavailable);
      require(decoderFallback.nvenc_images>0 && decoderFallback.nvenc_fallbacks===1 && decoderFallback.images>decoderFallback.nvenc_images,'Missing decoder did not resume native JPEG');
    } finally {Object.assign(globalThis,{VideoDecoder:originalDecoder});}
    return {before,fallback,independentBefore,independentAfter,restarted,unsupported,decoderFallback,restartCycles:6,staleRejected,preservedTrack:true};
  } finally {await first.stopCapture();await second.stopCapture();await tiny.stopCapture();await decoderUnavailable.stopCapture();cancelAnimationFrame(animation);canvas.remove();}
}

/** Check RGBA channel order and quadrant orientation through actual encode/decode. */
export async function runNvencVisualCheck() {
  const window=getCurrentWindow(),wasMaximized=await window.isMaximized(),wasAlwaysOnTop=await window.isAlwaysOnTop();
  await window.setAlwaysOnTop(true);
  if(!wasMaximized)await invoke('plugin:window|internal_toggle_maximize',{label:window.label});
  const bridge=new NativeVideoBridge(crypto.randomUUID());
  const canvas=document.createElement('canvas'); canvas.width=640;canvas.height=360;
  canvas.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:100000';
  document.body.appendChild(canvas);
  const ctx=canvas.getContext('2d')!;
  const colors=[[240,30,30],[20,230,30],[20,40,230],[220,170,30]];
  colors.forEach((rgb,index)=>{ctx.fillStyle=`rgb(${rgb.join(',')})`;ctx.fillRect(index%2*320,Math.floor(index/2)*180,320,180);});
  let animation=0,counter=0;
  const animate=()=>{ctx.fillStyle=counter++%2?'#000':'#fff';ctx.fillRect(0,0,4,4);animation=requestAnimationFrame(animate);};animate();
  const wait=()=>new Promise(resolve=>setTimeout(resolve,250));
  const sample=()=>{
    const source=bridge as unknown as {latestEncodedFrame:VideoFrame|null;latestBitmap:ImageBitmap|null};
    const image=source.latestEncodedFrame||source.latestBitmap;if(!image)throw new Error('No captured image');
    const sampleCanvas=document.createElement('canvas');sampleCanvas.width=64;sampleCanvas.height=64;
    const sampleContext=sampleCanvas.getContext('2d',{willReadFrequently:true})!;sampleContext.drawImage(image,0,0,64,64);
    return colors.map((expected,index)=>{
      const actual=[...sampleContext.getImageData(index%2*32+16,Math.floor(index/2)*32+16,1,1).data].slice(0,3);
      if(actual.some((value,channel)=>Math.abs(value-expected[channel])>16))throw new Error(`Color/orientation mismatch: ${actual} vs ${expected}`);
      return actual;
    });
  };
  try {
    await bridge.startCapture('screen:0',30,{width:1280,height:720},false,90);await wait();
    const before=await invoke<Record<string,number>>('get_capture_metrics',{sessionId:bridge.sessionId});
    if(!before.nvenc_images)throw new Error('NVENC required for color validation');
    const nvenc=sample();await bridge.disableNativeEncoding();await wait();const jpeg=sample();
    return {expected:colors,nvenc,jpeg};
  } finally {
    await bridge.stopCapture();cancelAnimationFrame(animation);canvas.remove();
    await window.setAlwaysOnTop(wasAlwaysOnTop);
    if(!wasMaximized&&await window.isMaximized())await invoke('plugin:window|internal_toggle_maximize',{label:window.label});
  }
}
