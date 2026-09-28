import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';

export const ParticipantsPane: React.FC = () => {
  const { username, peers, roomSlots, isCreator, isRoomHost, transferOwnership, kickPeer } = useRoom();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ kind: 'kick' | 'transfer'; id: string; name: string } | null>(null);

  const confirmAction = async () => {
    if (!pendingAction) return;
    const success = pendingAction.kind === 'kick'
      ? await kickPeer(pendingAction.id) : await transferOwnership(pendingAction.id);
    showToast(success
      ? pendingAction.kind === 'kick' ? 'Participante removido.' : 'Transferência de propriedade enviada.'
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
            </div>
          </div>
          <span className="user-status-dot online"></span>
        </div>

        {/* Remote peers */}
        {peers.map((p) => {
          const color = getSlotColor(p.id, false);
          const slot = roomSlots.find((s) => s.peerId === p.id);
          const isStreaming = slot?.isStreaming;

          return (
            <div key={p.id} className="participant-item">
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
                  {isStreaming && <span className="badge-live-stream-mini">AO VIVO</span>}
                </div>
              </div>
              <div className="participant-end-actions">
                <span className={`user-status-dot ${p.connectionState === 'connected' ? 'online' : 'connecting'}`}></span>
                {isRoomHost && p.connectionState === 'connected' && !p.isCreator && (
                  <div className="participant-menu-wrap">
                    <button className="participant-menu-trigger" aria-label={`Ações para ${p.username}`}
                      onClick={() => setOpenMenu(openMenu === p.id ? null : p.id)}><MoreHorizontal size={16} /></button>
                    {openMenu === p.id && <div className="participant-menu" role="menu">
                      <button role="menuitem" onClick={() => { setOpenMenu(null); setPendingAction({ kind: 'transfer', id: p.id, name: p.username }); }}>
                        Transferir propriedade
                      </button>
                      <button role="menuitem" className="participant-menu-danger"
                        onClick={() => { setOpenMenu(null); setPendingAction({ kind: 'kick', id: p.id, name: p.username }); }}>
                        Expulsar
                      </button>
                    </div>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {pendingAction && createPortal(<div className="modal-overlay" role="presentation">
        <div className="modal-card participant-confirm-dialog" role="alertdialog" aria-modal="true"
          aria-label={pendingAction.kind === 'kick' ? 'Confirmar expulsão' : 'Confirmar transferência'}>
          <div className="modal-header"><h2>{pendingAction.kind === 'kick' ? 'Expulsar participante' : 'Transferir propriedade'}</h2></div>
          <div className="modal-body"><p>{pendingAction.kind === 'kick'
            ? `Remover ${pendingAction.name} da sala e renovar a senha de entrada?`
            : `Tornar ${pendingAction.name} o único host da sala? Você perderá as permissões de host.`}</p></div>
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
