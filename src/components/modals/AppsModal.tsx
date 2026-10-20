import { isTauri } from '@tauri-apps/api/core';
import { localizeError, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useState } from 'react';
import { AppWindow, Play, Monitor } from 'lucide-react';
import { getRoomApp, listRoomApps, onRoomAppRegistryChange } from '../../apps/registry';
import { RoomAppIcon } from '../../apps/RoomAppIcon';
import { roomAppsService } from '../../apps/room_apps_service';
import { ModalDialog } from '../common/ModalDialog';
import { useModal } from '../../hooks/useModal';
import { showToast } from '../../hooks/useToast';

export const AppsModal: React.FC = () => {
  useLocale();
  const { closeModal } = useModal();
  const [, setRegistryTick] = useState(0);
  const [selectedKind, setSelectedKind] = useState('');
  const [personal, setPersonal] = useState(false);

  useEffect(() => onRoomAppRegistryChange(() => setRegistryTick((tick) => tick + 1)), []);

  const start = (close: () => void) => {
    const app = getRoomApp(selectedKind);
    if (!isTauri() && (app?.desktopOnly || ['tunnels', 'browser'].includes(selectedKind))) return;
    try { roomAppsService.start(selectedKind, personal); close(); }
    catch (error) { showToast(localizeError(error), 3500, 'error'); }
  };

  return <ModalDialog closeOnOutside title={t("message.791e1b0c7eaf")} subtitle={t("message.beb35c20f071")}
    icon={<AppWindow size={20} strokeWidth={1.8} />} className="modal-lg apps-library-modal"
    onClose={closeModal} footer={(close) => <div className="apps-library-footer">
      <label className="apps-library-personal">
        <span className="modern-switch">
          <input autoComplete="off" type="checkbox" checked={personal} onChange={(event) => setPersonal(event.target.checked)}
            aria-describedby="apps-personal-description" />
          <span className="switch-slider" />
        </span>
        <span><strong>{t("message.049f38e1d4e9")}</strong>
          <span id="apps-personal-description">{t("message.fbd796b44845")}</span>
        </span>
      </label>
      <button type="button" className="btn btn-primary apps-library-start" disabled={!selectedKind || (!isTauri() && Boolean(getRoomApp(selectedKind)?.desktopOnly || ['tunnels', 'browser'].includes(selectedKind)))}
        onClick={() => start(close)}><Play size={15} strokeWidth={2} aria-hidden="true" />  {t("message.99bae897c2a6")}</button>
    </div>}>
    <div className="apps-library-grid">
      {listRoomApps().map((app) => {
        const isDesktopOnly = !isTauri() && Boolean(app.desktopOnly || ['tunnels', 'browser'].includes(app.kind));
        return (
          <button type="button"
            className={`apps-library-card ${selectedKind === app.kind ? 'selected' : ''} ${isDesktopOnly ? 'is-disabled' : ''}`}
            key={app.kind}
            disabled={isDesktopOnly}
            aria-disabled={isDesktopOnly}
            aria-pressed={selectedKind === app.kind}
            onClick={() => { if (!isDesktopOnly) setSelectedKind(app.kind); }}
            title={isDesktopOnly ? t('apps.desktopOnlyNotice') : undefined}>
            <div className={`apps-library-banner ${app.bannerClass || ''} ${app.bannerImage ? 'has-image' : ''}`}
              style={app.bannerImage ? { backgroundImage: `url("${app.bannerImage}")` } : undefined}
              aria-hidden="true">
              <span className="apps-library-banner-glow" />
              <RoomAppIcon kind={app.kind} size={34} strokeWidth={1.7} />
            </div>
            <div className="apps-library-card-content">
              <h3>{app.label}</h3>
              <p>{app.description || t("message.3ede798ddd3d")}</p>
              {isDesktopOnly && (
                <div className="apps-library-card-notice" role="status">
                  <Monitor size={12} strokeWidth={2} aria-hidden="true" />
                  <span>{t('apps.desktopOnlyNotice')}</span>
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  </ModalDialog>;
};
