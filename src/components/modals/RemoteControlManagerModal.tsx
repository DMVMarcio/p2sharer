import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Gamepad2,
  GripVertical,
  Keyboard,
  MonitorCog,
  Mouse,
  UserX,
} from 'lucide-react';
import { moveOrderedItem } from '../../core/ordered_items';
import { generateUserColor } from '../../p2p/group_room';
import { useLocale } from '../../hooks/useLocale';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { useSortableGrid } from '../../hooks/useSortableGrid';
import { t } from '../../i18n';
import { ModalDialog } from '../common/ModalDialog';
import { Nickname } from '../common/Nickname';
import { ProfileAvatar } from '../common/ProfileAvatar';
import { Tooltip } from '../common/Tooltip';
import { VigemDriverBanner } from '../common/VigemDriverBanner';

export const RemoteControlManagerModal: React.FC = () => {
  useLocale();
  const { closeModal } = useModal();
  const {
    remoteControllers,
    remoteControlHostBusy,
    remoteControlHostPriorityEnabled,
    remoteControlElevationBlocked,
    remoteControlGamepadDriverAvailable,
    remoteControlGamepadDriverInstallStage,
    remoteControlGamepadDriverNeedsReboot,
    remoteControlVirtualGamepads,
    peers,
    roomSlots,
    setRemoteControllerPermissions,
    revokeRemoteController,
    setRemoteControlHostPriorityEnabled,
    recheckRemoteControlGamepadDriver,
    installRemoteControlGamepadDriver,
    reorderRemoteControlGamepads,
  } = useRoom();

  const [activeTab, setActiveTab] = useState<'controllers' | 'gamepads'>('controllers');

  const sortedGamepadIds = [...remoteControlVirtualGamepads]
    .sort((a, b) => a.order - b.order)
    .map((slot) => slot.id);

  const commitGamepadOrder = (nextIds: string[]) => {
    void reorderRemoteControlGamepads(nextIds);
    return true;
  };

  const sortable = useSortableGrid(sortedGamepadIds, commitGamepadOrder);
  const orderedGamepads = sortable.order
    .map((id) => remoteControlVirtualGamepads.find((slot) => slot.id === id))
    .filter((slot): slot is NonNullable<typeof slot> => Boolean(slot));
  for (const slot of remoteControlVirtualGamepads) {
    if (!sortable.order.includes(slot.id)) orderedGamepads.push(slot);
  }

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
        <div className="sidebar-tabs settings-subtabs remote-control-manager-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'controllers'}
            className={`tab-btn ${activeTab === 'controllers' ? 'active' : ''}`}
            onClick={() => setActiveTab('controllers')}
          >
            <MonitorCog size={14} aria-hidden="true" />
            <span>{t('remoteControl.controllersTab')}</span>
            {remoteControllers.length > 0 && (
              <span className="remote-control-tab-count">{remoteControllers.length}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'gamepads'}
            className={`tab-btn ${activeTab === 'gamepads' ? 'active' : ''}`}
            onClick={() => setActiveTab('gamepads')}
          >
            <Gamepad2 size={14} aria-hidden="true" />
            <span>{t('remoteControl.gamepadsTab')}</span>
            {remoteControlVirtualGamepads.length > 0 && (
              <span className="remote-control-tab-count">{remoteControlVirtualGamepads.length}</span>
            )}
          </button>
        </div>

        {activeTab === 'controllers' ? (
          <>
            {remoteControlElevationBlocked && (
              <div className="remote-control-manager-banner remote-control-manager-banner-danger">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>{t('remoteControl.elevationBlockedBanner')}</span>
              </div>
            )}

            {remoteControlHostBusy && remoteControlHostPriorityEnabled && (
              <div className="remote-control-manager-banner">
                {t('remoteControl.hostPriorityBanner')}
              </div>
            )}

            <label className="remote-control-priority-setting">
              <span className="remote-control-priority-copy">
                <strong>{t('remoteControl.hostPriorityToggle')}</strong>
                <small>{t('remoteControl.hostPriorityToggleHint')}</small>
              </span>
              <span className="modern-switch">
                <input
                  type="checkbox"
                  autoComplete="off"
                  checked={remoteControlHostPriorityEnabled}
                  aria-label={t('remoteControl.hostPriorityToggle')}
                  onChange={(event) => {
                    void setRemoteControlHostPriorityEnabled(event.target.checked);
                  }}
                />
                <span className="switch-slider" />
              </span>
            </label>

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

                        <label className="remote-control-perm-toggle">
                          <Gamepad2 size={14} aria-hidden="true" />
                          <span>{t('remoteControl.gamepadPermission')}</span>
                          <span className="modern-switch">
                            <input
                              type="checkbox"
                              autoComplete="off"
                              checked={ctrl.gamepadEnabled}
                              aria-label={t('remoteControl.gamepadPermissionAria', { name })}
                              onChange={(event) =>
                                setRemoteControllerPermissions(ctrl.peerId, ctrl.mediaId, {
                                  gamepadEnabled: event.target.checked,
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
          </>
        ) : !remoteControlGamepadDriverAvailable ? (
          <VigemDriverBanner
            driverAvailable={remoteControlGamepadDriverAvailable}
            installStage={remoteControlGamepadDriverInstallStage}
            needsReboot={remoteControlGamepadDriverNeedsReboot}
            onInstall={installRemoteControlGamepadDriver}
            onRecheck={recheckRemoteControlGamepadDriver}
          />
        ) : (
          <>
                <p className="remote-control-gamepads-hint">{t('remoteControl.gamepadsHint')}</p>

                {orderedGamepads.length === 0 ? (
                  <div className="remote-control-manager-empty">
                    <Gamepad2 size={28} strokeWidth={1.5} aria-hidden="true" />
                    <p>{t('remoteControl.noGamepads')}</p>
                  </div>
                ) : (
                  <div
                    className={`remote-control-gamepad-list ${sortable.draggingId ? 'is-sorting' : ''}`}
                    ref={sortable.gridRef}
                  >
                {orderedGamepads.map((slot, index) => {
                  const peer = peers.find((item) => item.id === slot.peerId);
                  const name = peer?.username || slot.peerId.slice(0, 6);
                  const color = generateUserColor(name);
                  const playerNumber = (slot.xinputSlot ?? index) + 1;
                  const ids = orderedGamepads.map((entry) => entry.id);

                  return (
                    <div
                      key={slot.id}
                      ref={sortable.cardRef(slot.id)}
                      data-sortable-id={slot.id}
                      className={`remote-control-gamepad-row ${sortable.draggingId === slot.id ? 'is-dragging' : ''}`}
                    >
                      <button
                        type="button"
                        className="btn saved-room-drag-handle remote-control-gamepad-handle"
                        aria-label={t('remoteControl.gamepadDragAria', { name, index: playerNumber })}
                        disabled={orderedGamepads.length < 2}
                        {...sortable.handleProps(slot.id)}
                      >
                        <GripVertical size={16} aria-hidden="true" />
                      </button>

                      <span className="remote-control-player-badge">
                        {t('remoteControl.gamepadPlayerBadge', { num: playerNumber })}
                      </span>

                      <div className="remote-control-controller-identity remote-control-gamepad-owner">
                        <ProfileAvatar peerId={slot.peerId} name={name} color={color} className="participant-item-avatar" />
                        <div className="remote-control-controller-meta">
                          <span className="remote-control-controller-name">
                            <Nickname name={name} peerId={slot.peerId} />
                          </span>
                          <small className="remote-control-controller-screen">
                            {t('remoteControl.gamepadSlotSub', { index: slot.padIndex + 1 })}
                          </small>
                        </div>
                      </div>

                      {orderedGamepads.length > 1 && (
                        <div className="remote-control-gamepad-step-actions">
                          <Tooltip content={t('remoteControl.gamepadMoveUp')}>
                            <button
                              type="button"
                              className="btn-stream-pin"
                              disabled={index === 0}
                              aria-label={t('remoteControl.gamepadMoveUp')}
                              onClick={() => {
                                const nextIds = moveOrderedItem(ids, slot.id, index - 1);
                                void reorderRemoteControlGamepads(nextIds);
                              }}
                            >
                              <ArrowUp size={13} aria-hidden="true" />
                            </button>
                          </Tooltip>
                          <Tooltip content={t('remoteControl.gamepadMoveDown')}>
                            <button
                              type="button"
                              className="btn-stream-pin"
                              disabled={index === orderedGamepads.length - 1}
                              aria-label={t('remoteControl.gamepadMoveDown')}
                              onClick={() => {
                                const nextIds = moveOrderedItem(ids, slot.id, index + 1);
                                void reorderRemoteControlGamepads(nextIds);
                              }}
                            >
                              <ArrowDown size={13} aria-hidden="true" />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </ModalDialog>
  );
};
