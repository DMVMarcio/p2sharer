import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, Plus, X, Globe, Home, Square, Settings, Maximize, Minimize, Lock, Unlock, Puzzle, Trash2, MousePointer2, Volume2, VolumeX } from 'lucide-react';
import { roomAppsService } from './room_apps_service';
import type { BrowserModel } from './browser_model';
import { browserUrl, browserPointerPosition, BROWSER_HOME, BROWSER_HEIGHT, BROWSER_WIDTH, type BrowserCommand } from './browser_protocol';
import { TooltipButton } from '../components/common/TooltipButton';
import { ModalDialog } from '../components/common/ModalDialog';
import { Select } from '../components/common/Select';
import { useLocale } from '../hooks/useLocale';
import { useRoom } from '../hooks/useRoom';
import { t, localizeError } from '../i18n';
import { showToast } from '../hooks/useToast';
import { AudioContextManager } from '../audio/audio_context_manager';
import { FullscreenDialog } from '../components/common/FullscreenDialog';
import { useNativeFullscreen } from '../hooks/useNativeFullscreen';
import { useIdleControls } from '../hooks/useIdleControls';
import type { BrowserContentMode, BrowserVideoQuality } from './browser_quality';

function BrowserSettings({ model, onClose }: { model: BrowserModel; onClose: () => void }) {
  const [mode, setMode] = useState('cache');
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const run = (operation: Promise<void>) => void operation.catch(e => showToast(localizeError(e), 4000, 'error'));
  useEffect(() => { run(model.manageExtensions('list')); }, [model]);
  return <ModalDialog title={t('browser.settings')} icon={<Settings size={20} />} onClose={onClose} busy={model.busy}>
    <div className="browser-settings">
      <p>{t(model.state.temporary ? 'browser.temporaryInfo' : 'browser.persistentInfo')}</p>
      {model.media && <>
        <label>{t('browser.contentMode')}<Select value={model.media.quality.settings.mode}
          onValueChange={value => model.media?.configure({ ...model.media.quality.settings, mode: value as BrowserContentMode })}
          options={['auto', 'reading', 'video'].map(value => ({ value, label: t(`browser.mode.${value}`) }))} /></label>
        <label>{t('browser.videoQuality')}<Select value={model.media.quality.settings.video}
          onValueChange={value => model.media?.configure({ ...model.media.quality.settings, video: value as BrowserVideoQuality })}
          options={['720p30', '1080p30', '1080p60'].map(value => ({ value, label: t(`browser.quality.${value}`) }))} /></label>
        <p>{t('browser.qualityInfo')}</p>
      </>}
      <label>{t('browser.clearData')}<Select value={mode} disabled={model.busy} onValueChange={setMode}
        options={['cache', 'sites', 'history', 'reset'].map(value => ({ value, label: t(`browser.clear.${value}`) }))} /></label>
      <button className="btn btn-secondary" disabled={model.busy} onClick={() => setConfirm(true)}>{t('browser.clearData')}</button>
      <div className="browser-extension-heading"><h3>{t('browser.extensions')}</h3>
        <button className="btn btn-secondary btn-sm" disabled={model.busy} onClick={() => run(model.manageExtensions('install'))}><Plus size={15} />{t('browser.installExtension')}</button></div>
      <p>{t('browser.extensionsInfo')}</p>
      {!model.extensions.length && <p>{t('browser.noExtensions')}</p>}
      {model.extensions.map(extension => <div className="browser-extension" key={extension.id}>
        <Puzzle size={17} /><span>{extension.name}</span>
        <label className="modern-switch"><input type="checkbox" checked={extension.enabled} aria-label={t('browser.enableExtension', { name: extension.name })}
          disabled={model.busy} onChange={() => run(model.manageExtensions(extension.enabled ? 'disable' : 'enable', extension.id))} /><span className="switch-slider" /></label>
        <TooltipButton className="btn btn-secondary btn-sm" tooltip={t('browser.removeExtension')} aria-label={t('browser.removeExtension')}
          disabled={model.busy} onClick={() => setRemoving(extension.id)}><Trash2 size={15} /></TooltipButton>
      </div>)}
    </div>
    {confirm && <ModalDialog title={t(`browser.clear.${mode}`)} onClose={() => setConfirm(false)} busy={model.busy}
      footer={close => <><button className="btn btn-secondary" disabled={model.busy} onClick={close}>{t('browser.cancel')}</button>
        <button className="btn btn-danger" disabled={model.busy} onClick={() => {
          void model.clear(mode as 'cache' | 'sites' | 'history' | 'reset').then(() => { setConfirm(false); if (mode === 'reset') onClose(); })
            .catch(e => showToast(localizeError(e), 4000, 'error'));
        }}>{t('browser.confirm')}</button></>}><p>{t(mode === 'reset' ? 'browser.resetWarning' : 'browser.clearWarning')}</p></ModalDialog>}
    {removing && <ModalDialog title={t('browser.removeExtension')} onClose={() => setRemoving(null)} busy={model.busy}
      footer={close => <><button className="btn btn-secondary" disabled={model.busy} onClick={close}>{t('browser.cancel')}</button>
        <button className="btn btn-danger" disabled={model.busy} onClick={() => {
          void model.manageExtensions('remove', removing).then(() => setRemoving(null)).catch(e => showToast(localizeError(e), 4000, 'error'));
        }}>{t('browser.confirm')}</button></>}><p>{t('browser.removeWarning')}</p></ModalDialog>}
  </ModalDialog>;
}

function BrowserPageDialog({ model }: { model: BrowserModel }) {
  const dialog = model.dialog!;
  const [text, setText] = useState(dialog.defaultText);
  const [, update] = useState(0);
  useEffect(() => { const timer = setInterval(() => update(n => n + 1), 250); return () => clearInterval(timer); }, []);
  return <ModalDialog title={t('browser.pageDialog')} icon={<Globe size={20} />} onClose={() => model.answerDialog(false)}
    busy={!model.canAnswerDialog}
    footer={<>
      {dialog.kind !== 'alert' && <button className="btn btn-secondary" disabled={!model.canAnswerDialog} onClick={() => model.answerDialog(false)}>{t('browser.cancel')}</button>}
      <button className="btn btn-primary" disabled={!model.canAnswerDialog} onClick={() => model.answerDialog(true, text)}>{t('browser.confirm')}</button>
    </>}>
    <p className="browser-page-message">{dialog.message}</p>
    {dialog.kind === 'prompt' && <form autoComplete="off" onSubmit={e => { e.preventDefault(); model.answerDialog(true, text); }}>
      <input className="text-input" autoComplete="off" autoFocus maxLength={4096} aria-label={t('browser.dialogResponse')}
        value={text} onChange={e => setText(e.target.value)} disabled={!model.canAnswerDialog} />
    </form>}
  </ModalDialog>;
}

export function BrowserApp({ instanceId, compact = false }: { instanceId: string; compact?: boolean }) {
  useLocale(); const { peers, username } = useRoom();
  const [, update] = useState(0);
  useEffect(() => roomAppsService.subscribe(() => update(n => n + 1)), []);
  const model = roomAppsService.getModel<BrowserModel>(instanceId);
  const video = useRef<HTMLVideoElement>(null); const surface = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null); const keyboard = useRef<HTMLTextAreaElement>(null);
  const address = useRef<HTMLInputElement>(null); const composing = useRef(false);
  const lastMove = useRef(0);
  const lastClick = useRef({ time: 0, x: 0, y: 0, button: -1, count: 0 });
  const [url, setUrl] = useState(''); const [temporary, setTemporary] = useState(false);
  const [settings, setSettings] = useState(false);
  const { fullscreen, enterFullscreen, exitFullscreen } = useNativeFullscreen();
  const controls = useIdleControls(fullscreen);
  const fullscreenClose = useRef<(() => void) | null>(null);
  const minimized = compact && !fullscreen;
  const [muted, setMuted] = useState(false); const [volume, setVolume] = useState(1);
  useEffect(() => {
    if (!fullscreen) return;
    const frame = requestAnimationFrame(() => keyboard.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [fullscreen]);
  const active = model?.state.tabs.find(tab => tab.id === model.state.active);
  useEffect(() => { setUrl(active?.url === 'about:blank' ? '' : active?.url ?? ''); }, [active?.url, active?.id]);
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    if (video.current && video.current !== element) video.current.srcObject = null;
    video.current = element;
    if (element) { element.srcObject = model?.stream ?? null; if (element.srcObject) void element.play().catch(() => {}); }
  }, [model?.stream]);
  useEffect(() => { if (video.current) video.current.volume = volume; }, [volume]);
  const remoteAudioTrack = model?.isHost ? undefined : model?.stream?.getAudioTracks()[0];
  useEffect(() => {
    if (!remoteAudioTrack || !model?.stream) return;
    const audio = AudioContextManager.getInstance(); const key = `browser:${instanceId}`;
    audio.attachPeerAudio(key, model.stream);
    return () => audio.detachPeerAudio(key);
  }, [instanceId, model?.stream, remoteAudioTrack]);
  useEffect(() => {
    if (remoteAudioTrack) AudioContextManager.getInstance().setPeerVolume(`browser:${instanceId}`, volume * 100, muted);
  }, [instanceId, remoteAudioTrack, volume, muted]);
  useEffect(() => {
    if (minimized) model?.command({ kind: 'release' });
    return () => model?.command({ kind: 'release' });
  }, [model, minimized]);
  if (!model) return null;
  const participantName = (id: string) => id === roomAppsService.getLocalActor() ? username || t('browser.you') : peers.find(peer => peer.id === id)?.username || t('browser.participant');
  const send = (command: BrowserCommand) => model.command(command);
  const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const position = (e: { clientX: number; clientY: number }, clamp = false) =>
    browserPointerPosition(e.clientX, e.clientY, surface.current!.getBoundingClientRect(), clamp);
  const pointer = (e: PointerEvent<HTMLDivElement>, event: 'mouseMoved' | 'mousePressed' | 'mouseReleased') => {
    if (minimized || !model.canControl || e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    if (event === 'mouseMoved' && performance.now() - lastMove.current < 33) return;
    const point = position(e, e.currentTarget.hasPointerCapture(e.pointerId)); if (!point) return;
    lastMove.current = performance.now();
    e.preventDefault();
    if (event === 'mousePressed') {
      const last = lastClick.current;
      const count = performance.now() - last.time < 500 && Math.hypot(point.x - last.x, point.y - last.y) < 6 && last.button === e.button ? last.count % 3 + 1 : 1;
      lastClick.current = { time: performance.now(), ...point, button: e.button, count };
      e.currentTarget.setPointerCapture(e.pointerId); keyboard.current?.focus({ preventScroll: true });
    }
    const button = event === 'mouseMoved' ? 'none' : ['left', 'middle', 'right'][e.button] as 'left' | 'middle' | 'right';
    send({ kind: 'mouse', event, ...point, button: button ?? 'none', buttons: e.buttons & 7,
      delta_x: 0, delta_y: 0, modifiers: modifiers(e), clicks: event === 'mouseMoved' ? 0 : lastClick.current.count });
    if (event === 'mouseReleased' && !e.buttons && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const expand = () => {
    if (fullscreen) fullscreenClose.current?.();
    else void enterFullscreen().catch(e => showToast(localizeError(e), 4000, 'error'));
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>, event: 'keyDown' | 'keyUp') => {
    if (composing.current || e.nativeEvent.isComposing) return;
    // Let the local textarea receive paste; never paste the host's personal clipboard.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
    if (e.key === 'Dead') return;
    if (event === 'keyDown' && e.key === 'F11') { e.preventDefault(); expand(); return; }
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault(); if (event === 'keyUp' || !model.state.tabs.length) return;
      const tabs = model.state.tabs; const index = tabs.findIndex(tab => tab.id === model.state.active);
      send({ kind: 'select-tab', id: tabs[(index + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id }); return;
    }
    if (e.ctrlKey && ['l', 't', 'w'].includes(e.key.toLowerCase())) {
      e.preventDefault(); if (event === 'keyUp') return;
      if (e.key.toLowerCase() === 'l') {
        controls.reveal(); requestAnimationFrame(() => { address.current?.focus(); address.current?.select(); });
      }
      if (e.key.toLowerCase() === 't') send({ kind: 'new-tab', url: BROWSER_HOME });
      if (e.key.toLowerCase() === 'w') send({ kind: 'close-tab', id: model.state.active }); return;
    }
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) e.preventDefault();
    send({ kind: 'key', event, key: e.key, code: e.code, modifiers: modifiers(e), virtual_key: Math.min(255, e.keyCode) });
  };
  const icon = (name: string, content: React.ReactNode, action: () => void, disabled = false) =>
    <TooltipButton className="btn btn-secondary btn-sm" tooltip={t(`browser.${name}`)} aria-label={t(`browser.${name}`)} disabled={disabled} onClick={action}>{content}</TooltipButton>;
  const chromeVisible = controls.visible || settings || Boolean(model.dialog);
  const content = <div className={`room-app-browser${minimized ? ' compact' : ''}${fullscreen ? ' fullscreen' : ''}`} ref={wrapper}
    onPointerMove={() => { if (fullscreen) controls.reveal(); }} onClick={e => e.stopPropagation()}>
    {!minimized && <div className={`browser-chrome${chromeVisible ? ' visible' : ''}`} inert={!chromeVisible} aria-hidden={!chromeVisible}
      onPointerEnter={() => controls.hold('pointer')} onPointerLeave={() => controls.release('pointer')}
      onFocusCapture={() => controls.hold('focus')} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) controls.release('focus'); }}>
      {!fullscreen && <div className="browser-tabs" role="group" aria-label={t('browser.tabs')}>
        {model.state.tabs.map(tab => <div className={`browser-tab${tab.id === model.state.active ? ' selected' : ''}`} key={tab.id}>
          <button aria-pressed={tab.id === model.state.active} className="btn btn-secondary btn-sm browser-tab-label" disabled={!model.canControl}
            onClick={() => send({ kind: 'select-tab', id: tab.id })}><Globe size={13} /><span>{tab.title || t('browser.newTab')}</span></button>
          <TooltipButton className="btn btn-secondary btn-sm browser-tab-close" tooltip={t('browser.closeTab')}
            disabled={!model.canControl} onClick={() => send({ kind: 'close-tab', id: tab.id })}><X size={13} /></TooltipButton>
        </div>)}
        {model.running && icon('newTab', <Plus size={15} />, () => send({ kind: 'new-tab', url: BROWSER_HOME }), !model.canControl || model.state.tabs.length >= 16)}
      </div>}
      <form className="browser-toolbar" autoComplete="off" onSubmit={e => {
        e.preventDefault(); const parsed = browserUrl(url);
        if (parsed) send({ kind: 'navigate', url: parsed }); else showToast(t('browser.invalidUrl'), 3500, 'error');
        keyboard.current?.focus();
      }}>
        {icon('back', <ArrowLeft size={15} />, () => send({ kind: 'back' }), !model.canControl)}
        {icon('forward', <ArrowRight size={15} />, () => send({ kind: 'forward' }), !model.canControl)}
        {icon('reload', <RotateCw size={15} />, () => send({ kind: 'reload' }), !model.canControl)}
        {icon('home', <Home size={15} />, () => send({ kind: 'navigate', url: BROWSER_HOME }), !model.canControl)}
        <input ref={address} className="text-input-sm" autoComplete="off" value={url} maxLength={4096} aria-label={t('browser.address')}
          placeholder={t('browser.address')} disabled={!model.canControl} onChange={e => setUrl(e.target.value)} />
        {model.isHost && icon(model.paused ? 'allowControl' : 'pauseControl', model.paused ? <Lock size={15} /> : <Unlock size={15} />, () => model.togglePause(), !model.running)}
        {model.isHost && icon('settings', <Settings size={15} />, () => setSettings(true), !model.running || model.busy)}
        {model.isHost && model.running && icon('finish', <Square size={15} />, () => {
          setSettings(false); void model.finish().catch(e => showToast(localizeError(e), 4000, 'error'));
        }, model.busy)}
        {fullscreen && model.running && !model.isHost && icon(muted ? 'unmute' : 'mute', muted ? <VolumeX size={15} /> : <Volume2 size={15} />, () => setMuted(!muted))}
        {fullscreen && model.running && !model.isHost && <input className="settings-slider-input browser-volume" autoComplete="off"
          type="range" min="0" max="1" step="0.01" value={volume} aria-label={t('browser.volume')} onChange={e => setVolume(Number(e.target.value))} />}
        {icon(fullscreen ? 'exitFullscreen' : 'fullscreen', fullscreen ? <Minimize size={15} /> : <Maximize size={15} />, expand)}
      </form>
    </div>}
    <div className="browser-surface" ref={surface} onPointerMove={e => pointer(e, 'mouseMoved')}
      onPointerDown={e => pointer(e, 'mousePressed')} onPointerUp={e => pointer(e, 'mouseReleased')}
      onPointerCancel={() => send({ kind: 'release' })} onContextMenu={e => e.preventDefault()}
      onWheel={e => {
        if (minimized || !model.canControl) return;
        const point = position(e); if (!point) return;
        send({ kind: 'mouse', event: 'mouseWheel', ...point, button: 'none', buttons: 0,
          delta_x: Math.max(-5000, Math.min(5000, e.deltaX * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 720 : 1))),
          delta_y: Math.max(-5000, Math.min(5000, e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 720 : 1))), modifiers: modifiers(e), clicks: 0 });
      }}>
      <video ref={attachVideo} autoPlay playsInline muted aria-label={t('browser.title')} />
      {active?.loading && !fullscreen && <div className="browser-loading" role="progressbar" aria-label={t('browser.loading')}><span /></div>}
      {model.pointer && model.controller === model.pointer.actor && <div className="browser-cursor-layer"><div className="browser-cursor"
        style={{ left: `${model.pointer.x / BROWSER_WIDTH * 100}%`, top: `${model.pointer.y / BROWSER_HEIGHT * 100}%` }}>
        <MousePointer2 size={20} fill="var(--accent-color)" /><span>{participantName(model.pointer.actor)}</span>
      </div></div>}
      {!minimized && <textarea ref={keyboard} className="browser-keyboard" data-remote-keyboard autoComplete="off" aria-label={t('browser.keyboard')}
        disabled={!model.canControl} onKeyDown={e => key(e, 'keyDown')} onKeyUp={e => key(e, 'keyUp')}
        onBlur={() => send({ kind: 'release' })} onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={e => { composing.current = false; if (e.currentTarget.value) send({ kind: 'text', text: e.currentTarget.value.slice(0, 4096) }); e.currentTarget.value = ''; }}
        onChange={e => { if (!composing.current && e.currentTarget.value) { send({ kind: 'text', text: e.currentTarget.value.slice(0, 4096) }); e.currentTarget.value = ''; } }}
        onPaste={e => { e.preventDefault(); const text = e.clipboardData.getData('text/plain'); if (text) send({ kind: 'text', text: text.slice(0, 4096) }); }} />}
      {(!model.running || !model.hostOnline) && <div className="browser-empty">
        <Globe size={36} strokeWidth={1.5} />
        {model.isHost && model.hostOnline && !minimized ? <>
          <p>{t('browser.profileInfo')}</p>
          <label className="browser-temporary"><span className="modern-switch"><input type="checkbox" checked={temporary} disabled={model.busy}
            onChange={e => setTemporary(e.target.checked)} /><span className="switch-slider" /></span>{t('browser.temporary')}</label>
          <button className="btn btn-primary" disabled={model.busy} onClick={() => void model.start(temporary)}>{t(model.busy ? 'browser.starting' : 'browser.start')}</button>
        </> : <p>{t(model.hostOnline ? 'browser.waiting' : 'browser.hostOffline')}</p>}
      </div>}
    </div>
    {!minimized && !fullscreen && <div className="browser-status">
      <span>{t('browser.host', { name: participantName(model.host) })}</span>
      {model.running && model.isHost && model.media && <span>{t('browser.captureTarget', {
        resolution: model.media.quality.quality.height, fps: model.media.quality.quality.fps })}</span>}
      <span role="status">{model.controller ? t('browser.controlling', { name: participantName(model.controller) }) : t('browser.controlAvailable')}</span>
      {model.running && !model.isHost && icon(muted ? 'unmute' : 'mute', muted ? <VolumeX size={15} /> : <Volume2 size={15} />, () => setMuted(!muted))}
      {model.running && !model.isHost && <input className="settings-slider-input" autoComplete="off" type="range" min="0" max="1" step="0.01" value={volume} aria-label={t('browser.volume')} onChange={e => setVolume(Number(e.target.value))} />}
    </div>}
    {active?.loading && fullscreen && <div className="browser-loading fullscreen-loading" role="progressbar" aria-label={t('browser.loading')}><span /></div>}
    {model.error && !minimized && <p className="browser-error" role="alert">{localizeError(model.error)}</p>}
    {settings && <BrowserSettings model={model} onClose={() => setSettings(false)} />}
    {!minimized && model.dialog && <BrowserPageDialog model={model} key={model.dialog.id} />}
  </div>;
  return fullscreen ? <FullscreenDialog title={t('browser.title')} closeRef={fullscreenClose}
    onClose={() => { void exitFullscreen().catch(e => showToast(localizeError(e), 4000, 'error')); }}>{content}</FullscreenDialog> : content;
}
