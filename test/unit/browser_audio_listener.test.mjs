import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('audio listeners arriving after stop or restart are removed instead of leaking across browser sessions', async () => {
  const registrations = new Map(); const removed = [];
  globalThis.browserAudioListenerFixture = (name) => new Promise(resolve => registrations.set(name, () => resolve(() => removed.push(name))));
  const bundle = await build({stdin:{contents:"export { AudioBridge } from './src/audio/audio_bridge.ts';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node',
    plugins:[{name:'audio-event-fixture',setup(builder){
      builder.onResolve({filter:/^@tauri-apps\/api\/(core|event)$/}, args=>({path:args.path,namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'}, args=>({contents:args.path.endsWith('/event')
        ? 'export const listen = (name) => globalThis.browserAudioListenerFixture(name);'
        : 'export const invoke = async () => undefined;'}));
    }}]});
  const {AudioBridge}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const bridge=new AudioBridge();
  try {
    const first=bridge.startListening('browser-one'); bridge.stop(); registrations.get('browser-one')(); await first;
    assert.deepEqual(removed,['browser-one']);
    const old=bridge.startListening('browser-two'); bridge.stop();
    const current=bridge.startListening('browser-three');
    registrations.get('browser-two')(); await old;
    registrations.get('browser-three')(); await current; bridge.stop();
    assert.deepEqual(removed,['browser-one','browser-two','browser-three']);
  } finally { bridge.stop(); delete globalThis.browserAudioListenerFixture; }
});
