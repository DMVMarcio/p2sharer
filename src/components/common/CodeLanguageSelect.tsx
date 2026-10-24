import { codeLanguage, codeLanguages } from '../../core/code_highlighting';
import { Select } from './Select';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';

export function CodeLanguageSelect({ language, onChange }: { language: string; onChange: (value: string) => void }) {
  useLocale();
  return <Select className="code-language-select" aria-label={t('code.language')}
    value={codeLanguage(language)} options={[{ value: 'plaintext', label: t('code.plainText') }, ...codeLanguages]}
    onValueChange={onChange} />;
}
