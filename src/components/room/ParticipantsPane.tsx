import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Shield, Crown, UserX, Play } from 'lucide-react';
import { useContextMenu, type ContextMenuAction } from '../common/ContextMenu';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';

export const ParticipantsPane: React.FC = () => {
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
      ? pendingAction.kind === 'kick' ? 'Participante removido.'
        : pendingAction.kind === 'transfer' ? 'Transferência de propriedade enviada.'
          : pendingAction.kind === 'admin' ? 'Administrador adicionado.' : 'Administrador removido.'
      : 'Não foi possível concluir esta ação.');
    setPendingAction(null);
  };

  const getSlotColor = (peerId: string, isLocal: boolean): string => {
    const slot = roomSlots.find((s) => s.isLocal === isLocal || s.peerId === peerId);
    return slot?.color || 'var(--accent-color)';
  };

  const getInitial = (name: string): string => {
    return (name || 'U').trim().charAt(0).toUpperCase();
  };

  const localColor = getSlotColor('local', true);

  return (
    <div className="sidebar-tab-content active" id="tab-content-participants">
      <div className="participants-list" id="participants-list">
        {/* Local user */}
        <div className="participant-item">
          <div className="participant-item-identity">
            <div
              className="participant-item-avatar"
              style={{ backgroundColor: localColor }}
            >
              <span className="participant-item-avatar-letter">{getInitial(username)}</span>
            </div>
            <div className="participant-item-text">
              <span className="participant-item-name">{username || 'Usuário'}</span>
              <span className="badge-you">VOCÊ</span>
              {isCreator && <span className="badge-host">HOST</span>}
              {isRoomAdmin && !isCreator && <span className="badge-host">ADMIN</span>}
            </div>
          </div>
          <span className="user-status-dot online"></span>
        </div>

        {/* Remote peers */}
        {peers.map((p) => {
          const color = getSlotColor(p.id, false);
          const slot = roomSlots.find((s) => s.peerId === p.id);
          const isStreaming = slot?.isStreaming;
          const actions: ContextMenuAction[] = [];
          if (isStreaming) actions.push({ id: 'watch', label: 'Assistir transmissão', icon: <Play size={15} />, onSelect: () => requestStream(p.id) });
          if (isRoomHost && p.connectionState === 'connected' && !p.isCreator) actions.push(
            { id: 'admin', label: p.isAdmin ? 'Remover administrador' : 'Tornar administrador', icon: <Shield size={15} />,
              onSelect: () => setPendingAction({ kind: p.isAdmin ? 'revoke-admin' : 'admin', id: p.id, name: p.username }) },
            { id: 'transfer', label: 'Transferir propriedade', icon: <Crown size={15} />,
              onSelect: () => setPendingAction({ kind: 'transfer', id: p.id, name: p.username }) },
            { id: 'kick', label: 'Expulsar', icon: <UserX size={15} />, danger: true,
              onSelect: () => setPendingAction({ kind: 'kick', id: p.id, name: p.username }) },
          );

          return (
            <div key={p.id} className="participant-item" onContextMenu={(event) => openContextMenu(event, actions)}>
              <div className="participant-item-identity">
                <div
                  className="participant-item-avatar"
                  style={{ backgroundColor: color }}
                >
                  <span className="participant-item-avatar-letter">{getInitial(p.username)}</span>
                </div>
                <div className="participant-item-text">
                  <span className="participant-item-name">{p.username}</span>
                  {p.isCreator && <span className="badge-host">HOST</span>}
                  {p.isAdmin && !p.isCreator && <span className="badge-host">ADMIN</span>}
                  {isStreaming && <span className="badge-live-stream-mini">AO VIVO</span>}
                </div>
              </div>
              <div className="participant-end-actions">
                <span className={`user-status-dot ${p.connectionState === 'connected' ? 'online' : 'connecting'}`}></span>
                {actions.length > 0 && <button className="participant-menu-trigger" aria-label={`Ações para ${p.username}`}
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
          aria-label={pendingAction.kind === 'kick' ? 'Confirmar expulsão' : 'Confirmar alteração de função'}>
          <div className="modal-header"><h2>{pendingAction.kind === 'kick' ? 'Expulsar participante'
            : pendingAction.kind === 'transfer' ? 'Transferir propriedade' : 'Alterar administrador'}</h2></div>
          <div className="modal-body"><p>{pendingAction.kind === 'kick'
            ? `Remover ${pendingAction.name} da sala e renovar a senha de entrada?`
            : pendingAction.kind === 'transfer'
              ? `Tornar ${pendingAction.name} o único host da sala? Você perderá as permissões de host.`
              : pendingAction.kind === 'admin'
                ? `Permitir que ${pendingAction.name} entre e admita participantes mesmo quando você estiver ausente?`
                : `Remover as permissões de administrador de ${pendingAction.name}?`}</p></div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setPendingAction(null)}>Cancelar</button>
            <button className={pendingAction.kind === 'kick' ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={() => void confirmAction()}>Confirmar</button>
          </div>
        </div>
      </div>, document.body)}
    </div>
  );
};
