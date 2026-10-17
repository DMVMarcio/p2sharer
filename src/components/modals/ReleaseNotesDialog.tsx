import { useEffect, useSyncExternalStore } from 'react';
import { Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useAppUpdates } from '../../hooks/useAppUpdates';
import { useModal } from '../../hooks/useModal';
import { installedReleaseNotes, releaseNotes } from '../../services/release_notes';
import { AppVersion } from '../common/AppVersion';
import { ModalDialog } from '../common/ModalDialog';

// Keep release notes offline: formatting is supported, embedded content is not.
const noteElements = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h2', 'h3', 'hr'];

export function ReleaseNotesDialog({ blocked = false }: { blocked?: boolean }) {
  const language = useLocale();
  const state = useSyncExternalStore(releaseNotes.subscribe, releaseNotes.getSnapshot);
  const update = useAppUpdates();
  const { activeModal } = useModal();
  useEffect(() => {
    if (!blocked && !activeModal && !update.dialogOpen) releaseNotes.openPending();
  }, [blocked, activeModal, update.dialogOpen, state.pending]);
  if (!state.open) return null;
  return <ModalDialog title={t('releaseNotes.title')} subtitle={t('releaseNotes.subtitle')}
    icon={<Sparkles size={20} aria-hidden="true" />} onClose={releaseNotes.close}
    footer={close => <button type="button" className="btn btn-primary" onClick={close}>{t('releaseNotes.done')}</button>}>
    <p><AppVersion /></p>
    <ul className="release-notes-list">{installedReleaseNotes(language).map((item, index) => <li key={index}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} allowedElements={noteElements} unwrapDisallowed skipHtml>{item}</ReactMarkdown>
    </li>)}</ul>
  </ModalDialog>;
}
