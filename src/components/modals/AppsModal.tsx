import { localizeError, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React, { useEffect, useState } from 'react';
import { AppWindow, Plus } from 'lucide-react';
import { listRoomApps, onRoomAppRegistryChange } from '../../apps/registry';
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
    try { roomAppsService.start(selectedKind, personal); close(); }
    catch (error) { showToast(localizeError(error)); }
  };

  return <ModalDialog title={t("message.791e1b0c7eaf")} subtitle={t("message.beb35c20f071")}
    icon={<AppWindow size={20} strokeWidth={1.8} />} className="modal-lg apps-library-modal"
    onClose={closeModal} footer={(close) => <div className="apps-library-footer">
      <label className="apps-library-personal">
        <span className="modern-switch">
          <input type="checkbox" checked={personal} onChange={(event) => setPersonal(event.target.checked)}
            aria-describedby="apps-personal-description" />
          <span className="switch-slider" />
        </span>
        <span><strong>{t("message.049f38e1d4e9")}</strong>
          <span id="apps-personal-description">{t("message.fbd796b44845")}</span>
        </span>
      </label>
      <button type="button" className="btn btn-primary apps-library-start" disabled={!selectedKind}
        onClick={() => start(close)}><Plus size={15} strokeWidth={2} />  {t("message.99bae897c2a6")}</button>
    </div>}>
    <div className="apps-library-grid">
      {listRoomApps().map((app) => <button type="button"
        className={`apps-library-card ${selectedKind === app.kind ? 'selected' : ''}`} key={app.kind}
        aria-pressed={selectedKind === app.kind} onClick={() => setSelectedKind(app.kind)}>
        <div className={`apps-library-banner ${app.bannerClass || ''} ${app.bannerImage ? 'has-image' : ''}`}
          style={app.bannerImage ? { backgroundImage: `url("${app.bannerImage}")` } : undefined}
          aria-hidden="true">
          {!app.bannerImage && <div className="apps-library-banner-glow" />}
          <RoomAppIcon kind={app.kind} size={34} strokeWidth={1.7} />
        </div>
        <div className="apps-library-card-content">
          <h3>{app.label}</h3>
          <p>{app.description || t("message.3ede798ddd3d")}</p>
        </div>
      </button>)}
    </div>
  </ModalDialog>;
};
