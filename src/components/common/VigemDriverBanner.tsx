import React from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { CheckCircle2, Download, ExternalLink, RefreshCw } from 'lucide-react';
import { showToast } from '../../hooks/useToast';
import { useLocale } from '../../hooks/useLocale';
import { t } from '../../i18n';

export const VIGEMBUS_RELEASES_URL = 'https://github.com/nefarius/ViGEmBus/releases/latest';

export interface VigemDriverBannerProps {
  driverAvailable: boolean;
  installStage: 'idle' | 'downloading' | 'verifying' | 'installing';
  needsReboot: boolean;
  onInstall: () => Promise<void>;
  onRecheck: () => Promise<void>;
  showReadyState?: boolean;
}

/** Shared status and 1-click installation panel for the Windows ViGEmBus virtual gamepad driver. */
export const VigemDriverBanner: React.FC<VigemDriverBannerProps> = ({
  driverAvailable,
  installStage,
  needsReboot,
  onInstall,
  onRecheck,
  showReadyState = false,
}) => {
  useLocale();
  const [probingDriver, setProbingDriver] = React.useState(false);
  const installingDriver = installStage !== 'idle';

  const installStageLabel =
    installStage === 'downloading'
      ? t('remoteControl.vigemStageDownloading')
      : installStage === 'verifying'
        ? t('remoteControl.vigemStageVerifying')
        : installStage === 'installing'
          ? t('remoteControl.vigemStageInstalling')
          : t('remoteControl.vigemInstallAction');

  const handleRecheck = async () => {
    setProbingDriver(true);
    try {
      await onRecheck();
    } finally {
      setProbingDriver(false);
    }
  };

  const handleOpenExternalPage = () => {
    void openUrl(VIGEMBUS_RELEASES_URL).catch(() =>
      showToast(t('message.3c3c85fd6b50'), 3500, 'error'),
    );
  };

  if (driverAvailable) {
    if (!showReadyState) return null;
    return (
      <div className="remote-control-manager-banner remote-control-manager-banner-driver remote-control-driver-ready">
        <div className="remote-control-driver-ready-row">
          <div className="remote-control-driver-copy">
            <strong className="remote-control-driver-ready-title">
              <CheckCircle2 size={15} aria-hidden="true" />
              <span>{t('remoteControl.vigemReadyTitle')}</span>
            </strong>
            <p>{t('remoteControl.vigemReadyDesc')}</p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={probingDriver}
            onClick={() => {
              void handleRecheck();
            }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>{t('remoteControl.vigemRecheckAction')}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="remote-control-manager-banner remote-control-manager-banner-driver">
      <div className="remote-control-driver-copy">
        <strong>{t('remoteControl.vigemMissingTitle')}</strong>
        <p>{needsReboot ? t('remoteControl.vigemRebootToast') : t('remoteControl.vigemMissingDesc')}</p>
      </div>
      <div className="remote-control-driver-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={installingDriver || probingDriver}
          onClick={() => {
            void onInstall();
          }}
        >
          <Download size={14} aria-hidden="true" />
          <span>{installStageLabel}</span>
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={probingDriver || installingDriver}
          onClick={() => {
            void handleRecheck();
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span>{t('remoteControl.vigemRecheckAction')}</span>
        </button>
        <button
          type="button"
          className="btn btn-outline btn-sm remote-control-driver-external-btn"
          disabled={installingDriver}
          onClick={handleOpenExternalPage}
        >
          <span>{t('remoteControl.vigemExternalLink')}</span>
          <ExternalLink size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
