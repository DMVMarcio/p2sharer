import { Download } from 'lucide-react';
import { ModalDialog } from '../common/ModalDialog';
import { useAppUpdates } from '../../hooks/useAppUpdates';
import { appUpdates } from '../../services/app_updates';

export function AppUpdateDialog() {
  const update = useAppUpdates();
  if (!update.dialogOpen) return null;
  const busy = ['checking', 'downloading', 'installing'].includes(update.status);
  return <ModalDialog title={update.returnToStable ? 'Voltar à versão estável' : 'Atualizações do P2Sharer'} icon={<Download size={20} />}
    busy={busy} onClose={appUpdates.close} footer={close => <>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>Mais tarde</button>
      {update.status === 'ready'
        ? <button type="button" className="btn btn-primary" onClick={() => void appUpdates.install()}>Instalar e reiniciar</button>
        : update.version && update.status !== 'checking'
          ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void appUpdates.download()}>{update.returnToStable ? 'Baixar versão estável' : 'Baixar atualização'}</button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void appUpdates.check(true)}>Procurar novamente</button>}
    </>}>
    <div className="app-update-content" aria-live="polite">
      {update.version && <p>Versão {update.version} disponível.</p>}
      {update.returnToStable && <p>Instalar esta versão estável substituirá a versão beta atual.</p>}
      {update.status === 'checking' && <p>Procurando atualizações...</p>}
      {update.status === 'current' && <p>Você está usando a versão mais recente.</p>}
      {update.status === 'downloading' && <>
        <p>Baixando atualização{update.progress === null ? '...' : `: ${update.progress}%`}</p>
        <progress className="app-update-progress" max={100} value={update.progress ?? undefined} aria-label="Download da atualização" />
      </>}
      {update.status === 'ready' && <p>A atualização está pronta. Instalar irá sair da sala, encerrar transmissões e reiniciar o aplicativo.</p>}
      {update.status === 'installing' && <p>Encerrando a sessão e instalando a atualização...</p>}
      {update.error && <p role="alert">{update.error}</p>}
      {update.notes && <div className="app-update-notes" tabIndex={0} role="region" aria-label="Novidades da versão">{update.notes}</div>}
    </div>
  </ModalDialog>;
}
