import { setLanguage, t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useAppUpdates } from '../../hooks/useAppUpdates';
import { appUpdates } from '../../services/app_updates';
import { Select } from '../common/Select';

interface Props {
  automatic: boolean;
  includePrereleases: boolean;
  onAutomaticChange: (enabled: boolean) => void;
  onPrereleasesChange: (enabled: boolean) => void;
}

export function ApplicationSettings({ automatic, includePrereleases, onAutomaticChange, onPrereleasesChange }: Props) {
  const language = useLocale();
  const update = useAppUpdates();
  const busy = ['downloading', 'installing'].includes(update.status);
  const channelChanged = includePrereleases !== update.includePrereleases;
  return <div className="settings-tab-pane active" id="settings-pane-application">
    <div className="settings-pane-header">
      <h3 className="settings-pane-title">{t("message.82929ebe1446")}</h3>
      <p className="settings-pane-desc">{t("message.b1ed22acfd16")}</p>
    </div>
    <div className="form-group">
      <label className="form-label" htmlFor="settings-language">{t('language.label')}</label>
      <Select id="settings-language" value={language} aria-label={t('language.label')}
        options={[{ value: 'en', label: 'English' }, { value: 'pt-BR', label: 'Português Brasil' }]}
        onValueChange={(value) => setLanguage(value === 'pt-BR' ? 'pt-BR' : 'en')} />
      <p className="field-info-text">{t('language.description')}</p>
    </div>
    <label className="settings-switch-row" htmlFor="settings-auto-updates">
      <div className="settings-switch-label-group">
        <span className="settings-switch-title">{t("message.d8a908a0e8ab")}</span>
      </div>
      <div className="modern-switch">
        <input autoComplete="off" type="checkbox" id="settings-auto-updates" disabled={busy}
          checked={automatic} onChange={event => onAutomaticChange(event.target.checked)} />
        <span className="switch-slider" />
      </div>
    </label>
    <label className="settings-switch-row" htmlFor="settings-beta-updates">
      <div className="settings-switch-label-group">
        <span className="settings-switch-title">{t("message.b634126b8065")}</span>
        <span className="settings-switch-subtitle">{t("message.07ba94307e00")}</span>
        <span className="settings-switch-subtitle">{t("message.c642291c9d62")}</span>
      </div>
      <div className="modern-switch">
        <input autoComplete="off" type="checkbox" id="settings-beta-updates" disabled={busy}
          checked={includePrereleases} onChange={event => onPrereleasesChange(event.target.checked)} />
        <span className="switch-slider" />
      </div>
    </label>
    {channelChanged && <p className="field-info-text">{t("message.013d77e5aa5d")}</p>}
    <button type="button" className="btn btn-secondary btn-sm"
      disabled={busy || channelChanged || update.status === 'checking'} onClick={() => void appUpdates.check(true)}>
      {t("message.5f59554ade76")}</button>
  </div>;
}
