import { useId } from 'react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { DEFAULT_NICKNAME_STYLE, NICKNAME_ANIMATIONS, NICKNAME_EFFECTS, NICKNAME_FONTS, NICKNAME_FONT_LABELS, normalizeNicknameStyle, type NicknameStyle } from '../../core/nickname_style';
import { Nickname } from './Nickname';
import { ColorPicker } from './ColorPicker';
import { Select } from './Select';

export function NicknameStyleEditor({ name, value, onChange, disabled = false }: {
  name: string; value: NicknameStyle; onChange: (style: NicknameStyle) => void; disabled?: boolean;
}) {
  useLocale();
  const id = useId();
  const change = (patch: Partial<NicknameStyle>) => onChange(normalizeNicknameStyle({ ...value, ...patch }));
  return <div className="nickname-editor">
    <div className="nickname-preview" aria-label={t('nickname.preview')}>
      <Nickname name={name.trim() || t('common.participant')} appearance={value} />
    </div>
    <div className="nickname-editor-fields">
      <label className="settings-label" htmlFor={`${id}-font`}>{t('nickname.font')}</label>
      <Select id={`${id}-font`} value={value.font} disabled={disabled}
        options={(Object.keys(NICKNAME_FONTS) as Array<NicknameStyle['font']>).map(font => ({
          value: font,
          label: font === 'default' ? t('nickname.font.default') : NICKNAME_FONT_LABELS[font],
          labelStyle: font === 'default' ? undefined : { fontFamily: NICKNAME_FONTS[font], fontSize: '1rem', lineHeight: 1.25 },
        }))}
        onValueChange={font => change({ font: font as NicknameStyle['font'] })} />
      <label className="settings-label" htmlFor={`${id}-effect`}>{t('nickname.effect')}</label>
      <Select id={`${id}-effect`} value={value.effect} disabled={disabled}
        options={NICKNAME_EFFECTS.map(effect => ({ value: effect, label: t(`nickname.effect.${effect}`) }))}
        onValueChange={effect => change({ effect: effect as NicknameStyle['effect'] })} />
      {['solid', 'gradient', 'glow', 'shine'].includes(value.effect) && <div className="nickname-colors">
        <span className="settings-label">{t('nickname.color')}</span>
        <ColorPicker label={t('nickname.color')} value={value.color} onChange={color => change({ color })} disabled={disabled} />
        {value.effect === 'gradient' && <ColorPicker label={t('nickname.secondaryColor')} value={value.secondaryColor}
          onChange={secondaryColor => change({ secondaryColor })} disabled={disabled} />}
        {value.effect === 'shine' && <ColorPicker label={t('nickname.shineColor')} value={value.shineColor}
          onChange={shineColor => change({ shineColor })} disabled={disabled} />}
      </div>}
      <label className="settings-label" htmlFor={`${id}-animation`}>{t('nickname.animation')}</label>
      <Select id={`${id}-animation`} value={value.animation} disabled={disabled}
        options={NICKNAME_ANIMATIONS.map(animation => ({ value: animation, label: t(`nickname.animation.${animation}`) }))}
        onValueChange={animation => change({ animation: animation as NicknameStyle['animation'] })} />
    </div>
    <button type="button" className="btn btn-secondary btn-sm" disabled={disabled}
      onClick={() => onChange({ ...DEFAULT_NICKNAME_STYLE })}>{t('nickname.reset')}</button>
  </div>;
}
