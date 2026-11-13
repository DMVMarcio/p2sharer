import React from 'react';
import { Keyboard, MonitorCog, Mouse, UserX } from 'lucide-react';
import { generateUserColor } from '../../p2p/group_room';
import { useLocale } from '../../hooks/useLocale';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { t } from '../../i18n';
import { ModalDialog } from '../common/ModalDialog';
import { Nickname } from '../common/Nickname';
import { ProfileAvatar } from '../common/ProfileAvatar';

export const RemoteControlManagerModal: React.FC = () => {
  useLocale();
  const { closeModal } = useModal();
  const {
    remoteControllers,
    remoteControlHostBusy,
    peers,
    roomSlots,
    setRemoteControllerPermissions,
    revokeRemoteController,
  } = useRoom();

  return (
    <ModalDialog
      closeOnOutside
      title={t('remoteControl.managerTitle')}
      subtitle={t('remoteControl.managerSubtitle')}
      icon={<MonitorCog size={20} strokeWidth={1.8} />}
      className="modal-md remote-control-manager-modal"
      onClose={closeModal}
      footer={(close) => (
        <button type="button" className="btn btn-secondary" onClick={close}>
          {t('remoteControl.closeAction')}
        </button>
      )}
    >
      <div className="remote-control-manager-body">
        {remoteControlHostBusy && (
          <div className="remote-control-manager-banner">
            {t('remoteControl.hostPriorityBanner')}
          </div>
        )}

        {remoteControllers.length === 0 ? (
          <div className="remote-control-manager-empty">
            <MonitorCog size={28} strokeWidth={1.5} aria-hidden="true" />
            <p>{t('remoteControl.noControllers')}</p>
          </div>
        ) : (
          <div className="remote-control-controller-list">
            {remoteControllers.map((ctrl) => {
              const peer = peers.find((item) => item.id === ctrl.peerId);
              const name = peer?.username || ctrl.peerId.slice(0, 6);
              const color = generateUserColor(name);
              const slot = roomSlots.find((item) => item.isLocal && item.mediaId === ctrl.mediaId);
              const screenLabel = slot?.mediaLabel;

              return (
                <div key={`${ctrl.peerId}:${ctrl.mediaId}`} className="remote-control-controller-row">
                  <div className="remote-control-controller-identity">
                    <ProfileAvatar peerId={ctrl.peerId} name={name} color={color} className="participant-item-avatar" />
                    <div className="remote-control-controller-meta">
                      <span className="remote-control-controller-name">
                        <Nickname name={name} peerId={ctrl.peerId} />
                      </span>
                      {screenLabel && (
                        <small className="remote-control-controller-screen">{screenLabel}</small>
                      )}
                    </div>
                  </div>

                  <div className="remote-control-controller-controls">
                    <label className="remote-control-perm-toggle">
                      <Mouse size={14} aria-hidden="true" />
                      <span>{t('remoteControl.mousePermission')}</span>
                      <span className="modern-switch">
                        <input
                          type="checkbox"
                          autoComplete="off"
                          checked={ctrl.mouseEnabled}
                          aria-label={t('remoteControl.mousePermissionAria', { name })}
                          onChange={(event) =>
                            setRemoteControllerPermissions(ctrl.peerId, ctrl.mediaId, {
                              mouseEnabled: event.target.checked,
                            })
                          }
                        />
                        <span className="switch-slider" />
                      </span>
                    </label>

                    <label className="remote-control-perm-toggle">
                      <Keyboard size={14} aria-hidden="true" />
                      <span>{t('remoteControl.keyboardPermission')}</span>
                      <span className="modern-switch">
                        <input
                          type="checkbox"
                          autoComplete="off"
                          checked={ctrl.keyboardEnabled}
                          aria-label={t('remoteControl.keyboardPermissionAria', { name })}
                          onChange={(event) =>
                            setRemoteControllerPermissions(ctrl.peerId, ctrl.mediaId, {
                              keyboardEnabled: event.target.checked,
                            })
                          }
                        />
                        <span className="switch-slider" />
                      </span>
                    </label>

                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => revokeRemoteController(ctrl.peerId, ctrl.mediaId)}
                      aria-label={t('remoteControl.revokeAria', { name })}
                    >
                      <UserX size={14} aria-hidden="true" />
                      <span>{t('remoteControl.revokeAction')}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ModalDialog>
  );
};
