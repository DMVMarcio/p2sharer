import React, { useEffect, useState } from 'react';
import { AppWindow, Plus } from 'lucide-react';
import { listRoomApps, onRoomAppRegistryChange } from '../../apps/registry';
import { roomAppsService } from '../../apps/room_apps_service';
import { useModal } from '../../hooks/useModal';
import { showToast } from '../../hooks/useToast';

export const AppsModal: React.FC = () => {
  const { closeModal, isClosing } = useModal();
  const [, setRegistryTick] = useState(0);

  useEffect(() => onRoomAppRegistryChange(() => setRegistryTick((tick) => tick + 1)), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeModal]);

  const start = (kind: string) => {
    try { roomAppsService.start(kind); closeModal(); }
    catch (error) { showToast(String(error)); }
  };

  return <div className={`modal-overlay ${isClosing ? 'closing' : ''}`} onMouseDown={(event) => {
    if (event.target === event.currentTarget) closeModal();
  }}>
    <div className="modal-card modal-lg apps-library-modal" role="dialog" aria-modal="true"
      aria-labelledby="apps-library-title">
      <div className="modal-header">
        <div className="modal-header-icon"><AppWindow size={20} strokeWidth={1.8} /></div>
        <div>
          <h2 id="apps-library-title">Apps da sala</h2>
          <p className="modal-subtitle">Abra um App compartilhado. Você pode iniciar várias instâncias.</p>
        </div>
        <button className="btn-close" aria-label="Fechar Apps" onClick={closeModal}>&times;</button>
      </div>
      <div className="modal-body apps-library-body">
        <div className="apps-library-grid">
          {listRoomApps().map((app) => {
            const Icon = app.icon || AppWindow;
            return <div className="apps-library-card" key={app.kind}>
              <div className={`apps-library-banner ${app.bannerClass || ''} ${app.bannerImage ? 'has-image' : ''}`}
                style={app.bannerImage ? { backgroundImage: `url("${app.bannerImage}")` } : undefined}
                aria-hidden="true">
                {!app.bannerImage && <div className="apps-library-banner-glow" />}
                <Icon size={34} strokeWidth={1.7} />
              </div>
              <div className="apps-library-card-content">
                <h3>{app.label}</h3>
                <p>{app.description || 'Experiência compartilhada para a sala.'}</p>
                <button className="btn btn-sm btn-outline apps-library-start" onClick={() => start(app.kind)}>
                  <Plus size={15} strokeWidth={2} /> Iniciar App
                </button>
              </div>
            </div>;
          })}
        </div>
      </div>
    </div>
  </div>;
};
