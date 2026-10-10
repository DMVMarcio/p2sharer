import { Nickname } from '../common/Nickname';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { profileAction } from '../common/profile_actions';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Shield, Crown, UserX, Play } from 'lucide-react';
import { useContextMenu, type ContextMenuAction } from '../common/ContextMenu';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';
import { modalManager } from '../../hooks/useModal';

export const ParticipantsPane: React.FC = () => {
  useLocale();
  const { username, peers, roomSlots, isCreator, isRoomHost, isRoomAdmin,
    transferOwnership, setAdministrator, kickPeer, requestStream } = useRoom();
  const openContextMenu = useContextMenu();
  const [pendingAction, setPendingAction] = useState<{
    kind: 'kick' | 'transfer' | 'admin' | 'revoke-admin'; id: string; name: string;
  } | null>(null);

  const confirmAction = async () => {
    if (!pendingAction) return;
    const success = pendingAction.kind === 'kick' ? await kickPeer(pendingAction.id)
      : pendingAction.kind === 'transfer' ? await transferOwnership(pendingAction.id)
      : await setAdministrator(pendingAction.id, pendingAction.kind === 'admin');
    showToast(success
      ? pendingAction.kind === 'kick' ? t("message.3b9975d16b7e")
        : pendingAction.kind === 'transfer' ? t("message.fcd904c2aa7a")
          : pendingAction.kind === 'admin' ? t("message.0e7b483bebf7") : t("message.38a94bc6dc26")
      : t("message.1776fea88e1f"));
    setPendingAction(null);
  };

  const getSlotColor = (peerId: string, isLocal: boolean): string => {
    const slot = roomSlots.find((s) => isLocal ? s.isLocal : s.peerId === peerId);
    return slot?.color || 'var(--accent-color)';
  };

  const localColor = getSlotColor('local', true);

  return (
    <div className="sidebar-tab-content active" id="tab-content-participants">
      <div className="participants-list" id="participants-list">
        {/* Local user */}
        <div className="participant-item" onContextMenu={event => openContextMenu(event,
          [profileAction({ peerId: 'local', name: username, isLocal: true, color: localColor })])}>
          <button type="button" className="participant-item-identity profile-identity-button" aria-label={t('profile.viewName', { name: username })}
            onClick={() => modalManager.openProfile({ peerId: 'local', name: username, isLocal: true, color: localColor })}>
            <ProfileAvatar name={username} isLocal color={localColor} className="participant-item-avatar" />
            <span className="participant-item-text">
              <span className="participant-item-name"><Nickname name={username || t("message.f53bbaa05fae")} isLocal /></span>
              <span className="badge-you">{t("message.a03099f135b1")}</span>
              {isCreator && <span className="badge-host">{t("common.hostBadge")}</span>}
              {isRoomAdmin && !isCreator && <span className="badge-host">{t("common.adminBadge")}</span>}
            </span>
          </button>
          <span className="user-status-dot online"></span>
        </div>

        {/* Remote peers */}
        {peers.map((p) => {
          const color = getSlotColor(p.id, false);
          const slot = roomSlots.find((s) => s.peerId === p.id);
          const isStreaming = slot?.isStreaming;
          const actions: ContextMenuAction[] = [profileAction({ peerId: p.id, name: p.username, color })];
          if (isStreaming) actions.push({ id: 'watch', get label() { return t("message.5a49c69bab6b"); }, icon: <Play size={15} />, onSelect: () => requestStream(p.id) });
          if (isRoomHost && p.connectionState === 'connected' && !p.isCreator) actions.push(
            { id: 'admin', get label() { return p.isAdmin ? t("message.a1073128f2dc") : t("message.1c6f1047e43c"); }, icon: <Shield size={15} />,
              onSelect: () => setPendingAction({ kind: p.isAdmin ? 'revoke-admin' : 'admin', id: p.id, name: p.username }) },
            { id: 'transfer', get label() { return t("message.2ffa385a1bc4"); }, icon: <Crown size={15} />,
              onSelect: () => setPendingAction({ kind: 'transfer', id: p.id, name: p.username }) },
            { id: 'kick', get label() { return t("message.ffb1a9c946e7"); }, icon: <UserX size={15} />, danger: true,
              onSelect: () => setPendingAction({ kind: 'kick', id: p.id, name: p.username }) },
          );

          return (
            <div key={p.id} className="participant-item" onContextMenu={(event) => openContextMenu(event, actions)}>
              <button type="button" className="participant-item-identity profile-identity-button" aria-label={t('profile.viewName', { name: p.username })}
                onClick={() => modalManager.openProfile({ peerId: p.id, name: p.username, color })}>
                <ProfileAvatar peerId={p.id} name={p.username} color={color} className="participant-item-avatar" />
                <span className="participant-item-text">
                  <span className="participant-item-name"><Nickname name={p.username} peerId={p.id} /></span>
                  {p.isCreator && <span className="badge-host">{t("common.hostBadge")}</span>}
                  {p.isAdmin && !p.isCreator && <span className="badge-host">{t("common.adminBadge")}</span>}
                  {isStreaming && <span className="badge-live-stream-mini">{t("message.b7c19868a9a8")}</span>}
                </span>
              </button>
              <div className="participant-end-actions">
                <span className={`user-status-dot ${p.connectionState === 'connected' ? 'online' : 'connecting'}`}></span>
                {actions.length > 0 && <button className="participant-menu-trigger" aria-label={t("message.b52de8210f9a", { v0: p.username })}
                  aria-haspopup="menu" onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openContextMenu({ clientX: rect.right, clientY: rect.bottom, currentTarget: event.currentTarget,
                      preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }, actions);
                  }}><MoreHorizontal size={16} /></button>}
              </div>
            </div>
          );
        })}
      </div>
      {pendingAction && createPortal(<div className="modal-overlay" role="presentation">
        <div className="modal-card participant-confirm-dialog" role="alertdialog" aria-modal="true"
          aria-label={pendingAction.kind === 'kick' ? t("message.c8441cf46109") : t("message.31da2f84aa1c")}>
          <div className="modal-header"><h2>{pendingAction.kind === 'kick' ? t("message.dd71f6a23c60")
            : pendingAction.kind === 'transfer' ? t("message.2ffa385a1bc4") : t("message.159c8a918684")}</h2></div>
          <div className="modal-body"><p>{pendingAction.kind === 'kick'
            ? t("message.6bf827d35784", { v0: pendingAction.name })
            : pendingAction.kind === 'transfer'
              ? t("message.91a5639b2411", { v0: pendingAction.name })
              : pendingAction.kind === 'admin'
                ? t("message.b13c3124bfc2", { v0: pendingAction.name })
                : t("message.7cfbbb1f9566", { v0: pendingAction.name })}</p></div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setPendingAction(null)}>{t("message.bb9dbb406dcb")}</button>
            <button className={pendingAction.kind === 'kick' ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={() => void confirmAction()}>{t("message.717bedea36fc")}</button>
          </div>
        </div>
      </div>, document.body)}
    </div>
  );
};
