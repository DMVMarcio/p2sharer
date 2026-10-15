import { useRef } from 'react';
import { LogOut } from 'lucide-react';
import { ModalDialog } from '../common/ModalDialog';
import { t } from '../../i18n';

export function UnsavedRoomDialog({ busy, onDecision }: {
  busy: boolean;
  onDecision: (save: boolean | null) => void;
}) {
  const choice = useRef<boolean | null>(null);
  return <ModalDialog title={t('roomExit.title')} icon={<LogOut size={20} />}
    busy={busy} onClose={() => onDecision(choice.current)}
    footer={close => <>
      <button className="btn btn-secondary" disabled={busy} onClick={() => { choice.current = false; close(); }}>{t('roomExit.discard')}</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => { choice.current = true; close(); }}>{t('roomExit.save')}</button>
    </>}>
    <p>{t('roomExit.warning')}</p>
  </ModalDialog>;
}
