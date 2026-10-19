import { useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { ModalDialog } from './ModalDialog';
import { DownloadPanel } from './DownloadPanel';
import { useLocale } from '../../hooks/useLocale';
import { t } from '../../i18n';

export function DownloadButton() {
  useLocale();
  const [open, setOpen] = useState(false);
  return <>
    <button className="btn btn-secondary" onClick={() => setOpen(true)} aria-haspopup="dialog">
      <Download size={18} aria-hidden="true" />{t('web.download')}<ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <ModalDialog title={t('downloads.title')} className="modal-xl" onClose={() => setOpen(false)}><DownloadPanel /></ModalDialog>}
  </>;
}
