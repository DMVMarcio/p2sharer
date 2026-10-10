import { useState } from 'react';
import { Palette } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import type { NicknameStyle } from '../../core/nickname_style';
import { ModalDialog } from './ModalDialog';
import { TooltipButton } from './TooltipButton';
import { Nickname } from './Nickname';
import { NicknameStyleEditor } from './NicknameStyleEditor';

function NicknameStyleDialog({ name, value, onApply, onClose }: {
  name: string; value: NicknameStyle; onApply: (style: NicknameStyle) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  return <ModalDialog title={t('nickname.customize')} icon={<Palette size={20} aria-hidden="true" />}
    className="nickname-style-dialog" onClose={onClose} footer={close => <>
      <button type="button" className="btn btn-secondary" onClick={close}>{t('message.bb9dbb406dcb')}</button>
      <button type="button" className="btn btn-primary" onClick={() => { onApply(draft); close(); }}>{t('message.3a04898a6b8b')}</button>
    </>}>
    <NicknameStyleEditor name={name} value={draft} onChange={setDraft} />
  </ModalDialog>;
}

/** Shared nickname input and draft-only customization dialog. */
export function NicknameField({ id, name, onNameChange, appearance, onAppearanceChange, placeholder, disabled = false, autoFocus = false }: {
  id: string; name: string; onNameChange: (name: string) => void; appearance: NicknameStyle;
  onAppearanceChange: (style: NicknameStyle) => void; placeholder?: string; disabled?: boolean; autoFocus?: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  return <div className="nickname-field">
    <input autoComplete="off" id={id} type="text" className="text-input" maxLength={25} value={name}
      placeholder={placeholder} disabled={disabled} autoFocus={autoFocus} onChange={event => onNameChange(event.target.value)} />
    <span className="nickname-field-preview" role="group" aria-label={t('nickname.preview')}>
      <Nickname name={name.trim() || t('common.participant')} appearance={appearance} />
    </span>
    <TooltipButton tooltip={t('nickname.customize')} className="btn btn-secondary nickname-customize-button" disabled={disabled}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Palette size={18} aria-hidden="true" /></TooltipButton>
    {open && <NicknameStyleDialog name={name} value={appearance} onApply={onAppearanceChange} onClose={() => setOpen(false)} />}
  </div>;
}
