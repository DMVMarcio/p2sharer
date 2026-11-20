import { useEffect, useSyncExternalStore } from 'react';
import { Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { version as installedVersion } from '../../../package.json';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useAppUpdates } from '../../hooks/useAppUpdates';
import { useModal } from '../../hooks/useModal';
import * as releaseNotesService from '../../services/release_notes';
import type { ReleaseNotesSection } from '../../services/release_notes';
import { AppVersion } from '../common/AppVersion';
import { ModalDialog } from '../common/ModalDialog';

// Keep release notes offline: formatting is supported, embedded content is not.
const noteElements = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h2', 'h3', 'hr'];

export function ReleaseNotesDialog({ blocked = false }: { blocked?: boolean }) {
  const language = useLocale();
  const { releaseNotes, installedReleaseNotes } = releaseNotesService;
  const state = useSyncExternalStore(releaseNotes.subscribe, releaseNotes.getSnapshot);
  const update = useAppUpdates();
  const { activeModal } = useModal();
  useEffect(() => {
    if (!blocked && !activeModal && !update.dialogOpen) releaseNotes.openPending();
  }, [blocked, activeModal, update.dialogOpen, state.pending]);
  if (!state.open) return null;

  const sections: ReleaseNotesSection[] = typeof releaseNotesService.releaseNotesSections === 'function'
    ? releaseNotesService.releaseNotesSections(language, releaseNotes.getVisibleVersions?.())
    : [{ version: installedVersion, items: installedReleaseNotes(language) }];
  const multiple = sections.length > 1;

  return <ModalDialog title={t('releaseNotes.title')}
    subtitle={multiple ? t('releaseNotes.timelineSubtitle') : t('releaseNotes.subtitle')}
    icon={<Sparkles size={20} aria-hidden="true" />} onClose={releaseNotes.close}
    footer={close => <button type="button" className="btn btn-primary" onClick={close}>{t('releaseNotes.done')}</button>}>
    <p><AppVersion /></p>
    <div className={`release-notes-timeline${multiple ? ' is-multi' : ''}`}>
      {sections.map(section => {
        const headingId = `release-notes-version-${section.version.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        const isCurrent = section.version === installedVersion;
        return <section key={section.version} className={`release-notes-section${isCurrent ? ' is-current' : ''}`} aria-labelledby={headingId}>
          <header className="release-notes-section-header">
            <h3 id={headingId} className="release-notes-version">v{section.version}</h3>
            {multiple && isCurrent && <span className="release-notes-current-badge">{t('releaseNotes.currentBadge')}</span>}
          </header>
          <ul className="release-notes-list">{section.items.map((item, index) => <li key={index}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} allowedElements={noteElements} unwrapDisallowed skipHtml>{item}</ReactMarkdown>
          </li>)}</ul>
        </section>;
      })}
    </div>
  </ModalDialog>;
}
