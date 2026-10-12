import { t } from '../i18n/index.ts';
import { colorToHex, contrastingTextColor } from './accent_color.ts';
import { hexToHsv, hsvToHex } from './hsv_color.ts';

// Card backgrounds are independent of the interface accent palette.
export const PROFILE_CARD_COLORS = [
  { color: '#2e6a78', get label() { return t('message.c954e4de2019'); } },
  { color: '#315a81', get label() { return t('message.db6b0018a206'); } },
  { color: '#35508b', get label() { return t('message.b0bf526b23af'); } },
  { color: '#2b4271', get label() { return t('color.navy'); } },
  { color: '#4b4b85', get label() { return t('message.46a5f1fafbac'); } },
  { color: '#614a8b', get label() { return t('message.264f2ba06e85'); } },
  { color: '#7b5186', get label() { return t('message.57a73ede5f6f'); } },
  { color: '#88507b', get label() { return t('message.591dceeb4a25'); } },
  { color: '#8f5774', get label() { return t('message.75f9577a1637'); } },
  { color: '#90505d', get label() { return t('color.rose'); } },
  { color: '#8f4e4b', get label() { return t('message.6741b8b5e1c2'); } },
  { color: '#8f5d36', get label() { return t('message.2b2b4ad00333'); } },
  { color: '#7a5640', get label() { return t('color.brown'); } },
  { color: '#866e3c', get label() { return t('message.a2c334da46a3'); } },
  { color: '#6c7d40', get label() { return t('message.aaf2d054d5f7'); } },
  { color: '#3e765c', get label() { return t('message.f22f3a4a6cd6'); } },
  { color: '#3a786e', get label() { return t('message.f1d0073c7a6b'); } },
  { color: '#5a6272', get label() { return t('message.e7c9cc1ea080'); } },
];

export function automaticCardColor(source: string): string {
  const hsv = hexToHsv(colorToHex(source) ?? '#575c66');
  // Keep the source hue, soften saturation and reserve contrast for white text.
  const tone = { ...hsv, s: Math.min(hsv.s, 0.6), v: Math.min(hsv.v, 0.58) };
  let color = hsvToHex(tone);
  // Let darker hues retain more brightness; trim only when white loses contrast.
  while (contrastingTextColor(color) !== '#ffffff') {
    tone.v *= 0.95;
    color = hsvToHex(tone);
  }
  return color;
}
