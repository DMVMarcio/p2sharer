import { useAppUpdates } from '../../hooks/useAppUpdates';
import { appUpdates } from '../../services/app_updates';

interface Props {
  automatic: boolean;
  includePrereleases: boolean;
  onAutomaticChange: (enabled: boolean) => void;
  onPrereleasesChange: (enabled: boolean) => void;
}

export function ApplicationSettings({ automatic, includePrereleases, onAutomaticChange, onPrereleasesChange }: Props) {
  const update = useAppUpdates();
  const busy = ['downloading', 'installing'].includes(update.status);
  const channelChanged = includePrereleases !== update.includePrereleases;
  return <div className="settings-tab-pane active" id="settings-pane-application">
    <div className="settings-pane-header">
      <h3 className="settings-pane-title">Aplicação</h3>
      <p className="settings-pane-desc">Gerencie as atualizações do P2Sharer.</p>
    </div>
    <label className="settings-switch-row" htmlFor="settings-auto-updates">
      <div className="settings-switch-label-group">
        <span className="settings-switch-title">Procurar automaticamente por atualizações</span>
      </div>
      <div className="modern-switch">
        <input autoComplete="off" type="checkbox" id="settings-auto-updates" disabled={busy}
          checked={automatic} onChange={event => onAutomaticChange(event.target.checked)} />
        <span className="switch-slider" />
      </div>
    </label>
    <label className="settings-switch-row" htmlFor="settings-beta-updates">
      <div className="settings-switch-label-group">
        <span className="settings-switch-title">Receber versões beta</span>
        <span className="settings-switch-subtitle">Inclui versões de teste, que podem apresentar falhas. Versões estáveis continuam disponíveis.</span>
        <span className="settings-switch-subtitle">Ao desativar e salvar, você poderá voltar à última versão estável.</span>
      </div>
      <div className="modern-switch">
        <input autoComplete="off" type="checkbox" id="settings-beta-updates" disabled={busy}
          checked={includePrereleases} onChange={event => onPrereleasesChange(event.target.checked)} />
        <span className="switch-slider" />
      </div>
    </label>
    {channelChanged && <p className="field-info-text">Salve as configurações para procurar atualizações no canal escolhido.</p>}
    <button type="button" className="btn btn-secondary btn-sm"
      disabled={busy || channelChanged || update.status === 'checking'} onClick={() => void appUpdates.check(true)}>
      Procurar atualizações agora
    </button>
  </div>;
}
