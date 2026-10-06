import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Select } from '../common/Select';
import { createLanConnection, type LanInterface } from '../../core/lan_room';
import { useFormSubmit } from '../../hooks/useFormSubmit';
import { useModal } from '../../hooks/useModal';
import { useRoom } from '../../hooks/useRoom';
import { showToast } from '../../hooks/useToast';
import { createAuthenticatedInvite, parseRoomInvite } from '../../core/room_invite';
import { savedRooms } from '../../core/saved_rooms';

export const CreateRoomModal: React.FC = () => {
  useLocale();
  const { closeModal, isClosing } = useModal();
  const { joinRoom } = useRoom();

  const [name, setName] = useState(t("message.659cf77f64fc"));
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mode, setMode] = useState('p2p');
  const [interfaces, setInterfaces] = useState<LanInterface[]>([]);
  const [address, setAddress] = useState('');
  const [loadingInterfaces, setLoadingInterfaces] = useState(false);
  const [networkError, setNetworkError] = useState('');

  useEffect(() => {
    if (mode !== 'lan') return;
    let active = true;
    setLoadingInterfaces(true);
    setNetworkError('');
    void invoke<LanInterface[]>('list_lan_interfaces').then((available) => {
      if (!active) return;
      setInterfaces(available);
      // Prefer a virtual adapter by its name, never by a hard-coded VPN address range.
      const preferred = available.find((item) => /radmin|hamachi/i.test(item.name) && !item.address.includes(':')) ??
        available.find((item) => !item.address.includes(':')) ?? available[0];
      setAddress(preferred?.address ?? '');
      if (!available.length) setNetworkError(t('lan.noInterfaces'));
    }).catch(() => { if (active) setNetworkError(t('lan.interfacesFailed')); })
      .finally(() => { if (active) setLoadingInterfaces(false); });
    return () => { active = false; };
  }, [mode]);

  const handleConfirm = async () => {
    if (mode === 'lan' && (!address || loadingInterfaces)) return;
    const finalPass = password.trim();
    try {
      const roomName = name.trim() || t("message.659cf77f64fc");
      const { invite, identity } = await createAuthenticatedInvite(roomName,
        mode === 'lan' ? createLanConnection(address) : undefined);
      const roomId = parseRoomInvite(invite)!.roomId;
      await savedRooms.put({ roomId, invite, name: roomName,
        saved: true, owned: true, protected: Boolean(finalPass), password: finalPass || undefined, identity });
      closeModal();
      joinRoom(invite, finalPass, true);
      showToast(t("message.71421eda382c"));
    } catch (error) {
      console.error('[Rooms] Failed to create room:', error);
      showToast(t("message.6504d77e15a6"));
    }
  };

  const { submit, pending } = useFormSubmit(handleConfirm, isClosing);

  return (
    <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} id="modal-create-room-dialog">
      <form autoComplete="off" onSubmit={submit} aria-busy={pending} className="modal-card">
        <div className="modal-header">
          <div className="modal-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div>
            <h2>{t("message.05c0432bf1ae")}</h2>
            <p className="modal-subtitle">{t("message.0624b2a64c6f")}</p>
          </div>
          <button type="button" className="btn-close" id="btn-close-create-dialog" onClick={closeModal}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="create-room-connection">{t('lan.connectionMode')}</label>
            <Select id="create-room-connection" value={mode} disabled={pending}
              onValueChange={setMode} options={[
                { value: 'p2p', label: t('lan.internetP2p') },
                { value: 'lan', label: t('lan.localVpn') },
              ]} />
          </div>
          {mode === 'lan' && <div className="form-group">
            <label className="form-label" htmlFor="create-room-network">{t('lan.networkInterface')}</label>
            <Select id="create-room-network" value={address} onValueChange={setAddress}
              disabled={pending || loadingInterfaces} placeholder={t('lan.selectNetwork')}
              options={interfaces.map((item) => ({ value: item.address, label: `${item.name} · ${item.address}` }))} />
            <p className="modal-subtitle">{t('lan.createHint')}</p>
            {networkError && <p role="alert" className="modal-subtitle">{networkError}</p>}
          </div>}
          <div className="form-group">
            <label className="form-label" htmlFor="input-create-room-name-dialog">{t("message.711b2b76f603")}</label>
            <input autoComplete="off" id="input-create-room-name-dialog" className="text-input" maxLength={80}
              autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="form-group" style={{ marginTop: '14px' }}>
            <label className="form-label" htmlFor="input-create-room-password-dialog">
              <span>{t("message.6a29a826f73e")}</span>
            </label>
            <div className="input-with-action">
              <input autoComplete="off"
                type={showPassword ? 'text' : 'password'}
                id="input-create-room-password-dialog"
                className="text-input"
                placeholder={t("message.27af4369497f")}
                maxLength={40}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm btn-outline btn-inline-action btn-inline-action-icon"
                id="btn-toggle-create-password-visibility"
                aria-label={t("message.d7d229c67924")}
                onClick={() => setShowPassword(!showPassword)}
              >
                <span id="icon-create-pass-toggle">
                  {showPassword ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </span>
              </button>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" id="btn-cancel-create-dialog" onClick={closeModal}>
            {t("message.bb9dbb406dcb")}</button>
          <button className="btn btn-primary" id="btn-confirm-create-dialog" type="submit"
            disabled={pending || isClosing || (mode === 'lan' && (loadingInterfaces || !address || Boolean(networkError)))}>
            <span>{t("message.bb0f3686fc7e")}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="5" x2="19" y1="12" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
};
