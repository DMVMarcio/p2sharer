import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useEffect, useRef, useState } from 'react';
import { LogIn, Eye, EyeOff } from 'lucide-react';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { ModalDialog } from '../common/ModalDialog';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { StatusNotice } from '../common/StatusNotice';
import { verifyRoomInvite } from '../../core/room_invite_validation';
import type { RoomPreview } from '../../core/room_preview';
import { GroupRoomManager } from '../../p2p/group_room';
import { stateStore } from '../../core/state_store';
import { roomService } from '../../services/room_service';

export function JoinRoomModal() {
  useLocale();
  const { closeModal } = useModal();
  const { joinOutcome, joinError, roomStatusText } = useRoom();
  const [code, setCode] = useState(() => roomService.pendingJoinInvite);
  const [password, setPassword] = useState(() => roomService.pendingJoinPassword);
  const [showPassword, setShowPassword] = useState(false);
  const retryError = useRef(roomService.pendingJoinError);
  const [requiresPassword, setRequiresPassword] = useState(() => retryError.current.startsWith('Senha incorreta'));
  const [phase, setPhase] = useState<'code' | 'searching' | 'preview' | 'joining'>(() => retryError.current ? 'preview' : 'code');
  const [canEnter, setCanEnter] = useState(() => Boolean(retryError.current));
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [roomName, setRoomName] = useState(() => retryError.current ? stateStore.currentRoomName : '');
  const [error, setError] = useState(() => localizeText(retryError.current));
  const owner = useRef(roomService.pendingJoinAsOwner);
  const session = useRef<{ manager: GroupRoomManager; ready: Promise<void>; release?: Promise<void> } | null>(null);
  const mounted = useRef(true);
  const joining = useRef(Boolean(retryError.current));
  const attempt = useRef(new AbortController());
  const release = async () => {
    const current = session.current;
    if (!current) return;
    current.release ??= roomService.stopRoomPreview(current.manager);
    await current.release;
    if (session.current === current) session.current = null;
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void release(); };
  }, []);
  useEffect(() => {
    if (!joining.current) return;
    if (joinOutcome === 'admitted' || joinOutcome === 'waiting') {
      joining.current = false;
      roomService.pendingJoinInvite = '';
      roomService.pendingJoinPassword = '';
      roomService.pendingJoinAsOwner = false;
      roomService.pendingJoinError = '';
      closeModal();
    } else if (joinOutcome === 'error' && phase === 'joining') {
      if (joinError.startsWith('Senha incorreta')) setRequiresPassword(true);
      setError(localizeText(joinError));
      setPhase('preview');
    }
  }, [phase, joinOutcome, joinError, closeModal]);
  useEffect(() => {
    if (!canEnter || (phase !== 'searching' && phase !== 'preview')) return;
    const interval = setInterval(() => session.current?.manager.requestPreview(), 2500);
    const timeout = setTimeout(() => {
      if (mounted.current) setPhase(current => current === 'searching' ? 'preview' : current);
    }, 1500);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [phase, canEnter]);

  const discover = async () => {
    if (phase !== 'code') return;
    setError(''); setPhase('searching');
    try {
      const invite = await verifyRoomInvite(code.trim());
      if (!invite) throw new Error(t('message.5348364ca0b6'));
      if (!mounted.current) return;
      setRoomName(invite.version === 3 ? invite.roomId.slice(0, 8) : invite.name);
      setCanEnter(true);
      roomService.pendingJoinInvite = code.trim();
      const manager = new GroupRoomManager(stateStore.username, code.trim(), '', owner.current, stateStore.getTurnConfig());
      const current = { manager, ready: Promise.resolve() };
      session.current = current;
      current.ready = roomService.startRoomPreview(manager, {
        onPreview: summary => {
          if (!mounted.current || joining.current || session.current !== current) return;
          setPreview(summary); setRequiresPassword(summary.protected); setPhase('preview');
        },
        onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
        onChatHistory: () => {}, onPeersUpdate: () => {},
        onStatusChange: status => {
          if (mounted.current && session.current === current && (status.startsWith('Erro') || status === t('lan.connectFailed'))) {
            setError(localizeText(status)); setPhase('preview');
          }
        },
      }, attempt.current.signal);
      await current.ready;
    } catch (cause) {
      if (mounted.current) { setCanEnter(false); setError(cause instanceof Error ? cause.message : t('error.unknown')); setPhase('code'); }
    }
  };
  useEffect(() => { if (roomService.pendingJoinInvite && !retryError.current) void discover(); }, []);

  const enter = async () => {
    if (joining.current && phase === 'joining') return;
    const waitForAdmission = Boolean(preview || error || retryError.current);
    roomService.joinOutcome = 'connecting';
    roomService.joinError = '';
    joining.current = true; setError(''); setPhase('joining');
    try {
      const current = session.current;
      await current?.ready;
      if (!mounted.current) return;
      session.current = null;
      await roomService.joinRoom(code.trim(), password.trim(), owner.current,
        { waitForAdmission, preview: current?.manager, signal: attempt.current.signal });
    } catch {
      if (mounted.current) { setError(t('error.unknown')); setPhase('preview'); }
    }
  };
  const cancelConnection = () => {
    mounted.current = false;
    attempt.current.abort();
    void release();
    if (joining.current) void roomService.leaveRoom();
  };
  const cancel = () => {
    roomService.pendingJoinInvite = ''; roomService.pendingJoinPassword = ''; roomService.pendingJoinAsOwner = false;
    roomService.pendingJoinError = '';
    closeModal();
  };
  const busy = (phase === 'searching' && !canEnter) || phase === 'joining';
  return <ModalDialog title={preview?.name || roomName || t('message.3b24015dc709')} icon={<LogIn size={20} />}
    onCloseStart={cancelConnection} onClose={cancel} footer={close => <>
      <button type="button" className="btn btn-secondary" onClick={close}>{t('message.bb9dbb406dcb')}</button>
      <button type="submit" form="join-room-form" className="btn btn-primary" disabled={busy}>
        {t(phase === 'code' ? 'join.inspect' : 'message.ad207d12bdc1')}
      </button>
    </>}>
    <form id="join-room-form" autoComplete="off" aria-busy={busy}
      onSubmit={event => { event.preventDefault(); if (!busy) void (phase === 'code' ? discover() : enter()); }}>
      {phase === 'code' ? <div className="form-group">
        <label className="form-label" htmlFor="join-room-code">{t('message.68737d8e5d2e')}</label>
        <input autoComplete="off" data-autofocus id="join-room-code" className="text-input" value={code}
          onChange={event => setCode(event.target.value)} />
      </div> : <>
        {phase === 'preview' && !preview ? <StatusNotice>{t('join.noResponse')}</StatusNotice> :
        <p className="modal-subtitle" role="status" aria-live="polite">
          {phase === 'joining' ? localizeText(roomStatusText) : phase === 'searching' ? t('join.searching') :
            preview ? t('join.online', { count: preview.participants.length }) : t('join.noResponse')}
        </p>}
        {(phase === 'searching' || phase === 'joining') && <div className="join-room-loading"><div className="connecting-spinner" /></div>}
        {preview && <ul className="join-room-participants" aria-label={t('join.participants')}>
          {preview.participants.map(person => <li key={person.id}>
            <ProfileAvatar peerId={person.id} name={person.name} color={person.color} imageUrl={person.avatar} />
            <span>{person.name}</span>
          </li>)}
        </ul>}
        {requiresPassword && <div className="form-group">
          <label className="form-label" htmlFor="join-room-password">{t('message.4c92bf162674')}</label>
          <div className="input-with-action">
            <input autoComplete="off" id="join-room-password" className="text-input" type={showPassword ? 'text' : 'password'}
              maxLength={128} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} />
            <button type="button" className="btn btn-sm btn-outline btn-inline-action" disabled={busy}
              aria-label={t('message.d7d229c67924')} onClick={() => setShowPassword(value => !value)}>
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>}
      </>}
      {error && <p className="join-room-error" role="alert">{error}</p>}
    </form>
  </ModalDialog>;
}
