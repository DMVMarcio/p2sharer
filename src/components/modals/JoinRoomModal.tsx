import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useEffect, useRef, useState } from 'react';
import { LogIn, Eye, EyeOff } from 'lucide-react';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { ModalDialog } from '../common/ModalDialog';
import { ProfileAvatar } from '../common/ProfileAvatar';
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
  const [phase, setPhase] = useState<'code' | 'searching' | 'preview' | 'joining'>('code');
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [roomName, setRoomName] = useState('');
  const [error, setError] = useState('');
  const owner = useRef(roomService.pendingJoinAsOwner);
  const session = useRef<{ manager: GroupRoomManager; ready: Promise<void>; release?: Promise<void> } | null>(null);
  const mounted = useRef(true);
  const joining = useRef(false);
  const release = async () => {
    const current = session.current;
    if (!current) return;
    current.release ??= current.ready.catch(() => {}).then(() => current.manager.leave());
    await current.release;
    if (session.current === current) session.current = null;
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void release(); };
  }, []);
  useEffect(() => {
    if (!joining.current) return;
    if (joinOutcome === 'admitted') {
      joining.current = false;
      roomService.pendingJoinInvite = '';
      roomService.pendingJoinPassword = '';
      roomService.pendingJoinAsOwner = false;
      closeModal();
    } else if (joinOutcome === 'error' && phase === 'joining') {
      setError(localizeText(joinError));
      setPhase('preview');
    }
  }, [phase, joinOutcome, joinError, closeModal]);
  useEffect(() => {
    if (phase !== 'searching' && phase !== 'preview') return;
    const interval = setInterval(() => session.current?.manager.requestPreview(), 2500);
    const timeout = setTimeout(() => {
      if (mounted.current) setPhase(current => current === 'searching' ? 'preview' : current);
    }, 12000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [phase]);

  const discover = async () => {
    if (phase !== 'code') return;
    setError(''); setPhase('searching');
    try {
      const invite = await verifyRoomInvite(code.trim());
      if (!invite) throw new Error(t('message.5348364ca0b6'));
      if (!mounted.current) return;
      setRoomName(invite.version === 3 ? invite.roomId.slice(0, 8) : invite.name);
      roomService.pendingJoinInvite = code.trim();
      const manager = new GroupRoomManager(stateStore.username, code.trim(), '', owner.current, stateStore.getTurnConfig());
      const current = { manager, ready: Promise.resolve() };
      session.current = current;
      current.ready = manager.join({
        onPreview: summary => {
          if (!mounted.current || joining.current || session.current !== current) return;
          setPreview(summary); setPhase('preview');
        },
        onStreamsUpdate: () => {}, onSlotsUpdate: () => {}, onChat: () => {},
        onChatHistory: () => {}, onPeersUpdate: () => {},
        onStatusChange: status => {
          if (mounted.current && session.current === current && (status.startsWith('Erro') || status === t('lan.connectFailed'))) {
            setError(localizeText(status)); setPhase('preview');
          }
        },
      }, true);
      await current.ready;
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : t('error.unknown')); setPhase('code'); }
    }
  };
  useEffect(() => { if (roomService.pendingJoinInvite) void discover(); }, []);

  const enter = async () => {
    if (joining.current && phase === 'joining') return;
    roomService.joinOutcome = 'connecting';
    roomService.joinError = '';
    joining.current = true; setError(''); setPhase('joining');
    try {
      await release();
      if (!mounted.current) return;
      await roomService.joinRoom(code.trim(), password.trim(), owner.current);
    } catch {
      if (mounted.current) { setError(t('error.unknown')); setPhase('preview'); }
    }
  };
  const cancel = () => {
    mounted.current = false;
    void release();
    if (joining.current) void roomService.leaveRoom();
    roomService.pendingJoinInvite = ''; roomService.pendingJoinPassword = ''; roomService.pendingJoinAsOwner = false;
    closeModal();
  };
  const busy = phase === 'searching' || phase === 'joining';
  return <ModalDialog title={preview?.name || roomName || t('message.3b24015dc709')} icon={<LogIn size={20} />}
    onClose={cancel} footer={close => <>
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
        <p className="modal-subtitle" role="status" aria-live="polite">
          {phase === 'joining' ? localizeText(roomStatusText) : phase === 'searching' ? t('join.searching') :
            preview ? t('join.online', { count: preview.participants.length }) : t('join.noResponse')}
        </p>
        {busy && <div className="join-room-loading"><div className="connecting-spinner" /></div>}
        {preview && <ul className="join-room-participants" aria-label={t('join.participants')}>
          {preview.participants.map(person => <li key={person.id}>
            <ProfileAvatar peerId={person.id} name={person.name} color={person.color} imageUrl={person.avatar} />
            <span>{person.name}</span>
          </li>)}
        </ul>}
        {(preview?.protected || !preview || password) && <div className="form-group">
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
