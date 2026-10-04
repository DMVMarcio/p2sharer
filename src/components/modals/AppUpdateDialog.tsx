import { localizeText, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { Download } from 'lucide-react';
import { ModalDialog } from '../common/ModalDialog';
import { AppVersion } from '../common/AppVersion';
import { useAppUpdates } from '../../hooks/useAppUpdates';
import { appUpdates } from '../../services/app_updates';

export function AppUpdateDialog() {
  useLocale();
  const update = useAppUpdates();
  if (!update.dialogOpen) return null;
  const busy = ['checking', 'downloading', 'installing'].includes(update.status);
  return <ModalDialog title={update.returnToStable ? t("message.55f24df7223f") : t("message.ed282e7267b5")} icon={<Download size={20} />}
    busy={busy} onClose={appUpdates.close} footer={close => <>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>{t("message.16a52694ff71")}</button>
      {update.status === 'ready'
        ? <button type="button" className="btn btn-primary" onClick={() => void appUpdates.install()}>{t("message.ec490900a893")}</button>
        : update.version && update.status !== 'checking'
          ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void appUpdates.download()}>{update.returnToStable ? t("message.76925cc45de1") : t("message.848220ce1440")}</button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void appUpdates.check(true)}>{t("message.e7b977ec2564")}</button>}
    </>}>
    <div className="app-update-content" aria-live="polite">
      <p><AppVersion targetVersion={update.version} /></p>
      {update.returnToStable && <p>{t("message.9c8c050186f0")}</p>}
      {update.status === 'checking' && <p>{t("message.5e86113605ec")}</p>}
      {update.status === 'current' && <p>{t("message.87c1d00ca14d")}</p>}
      {update.status === 'downloading' && <>
        <p>{t("message.d2dfc5b719fb")}{update.progress === null ? '...' : `: ${update.progress}%`}</p>
        <progress className="app-update-progress" max={100} value={update.progress ?? undefined} aria-label={t("message.26ee3b16bdc7")} />
      </>}
      {update.status === 'ready' && <p>{t("message.b3315e50fd5b")}</p>}
      {update.status === 'installing' && <p>{t("message.79c9e09f9a89")}</p>}
      {update.error && <p role="alert">{localizeText(update.error)}</p>}
      {update.notes && <div className="app-update-notes" tabIndex={0} role="region" aria-label={t("message.cea1d9fbdfc6")}>{update.notes}</div>}
    </div>
  </ModalDialog>;
}
