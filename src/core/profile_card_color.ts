import { t } from '../i18n/index.ts';
import { colorToHex } from './accent_color.ts';
import { hexToHsv, hsvToHex } from './hsv_color.ts';

// Card backgrounds are independent of the interface accent palette.
export const PROFILE_CARD_COLORS = [
  { color: '#3b626b', get label() { return t('message.c954e4de2019'); } },
  { color: '#405a73', get label() { return t('message.db6b0018a206'); } },
  { color: '#46577c', get label() { return t('message.b0bf526b23af'); } },
  { color: '#354565', get label() { return t('color.navy'); } },
  { color: '#535377', get label() { return t('message.46a5f1fafbac'); } },
  { color: '#62547c', get label() { return t('message.264f2ba06e85'); } },
  { color: '#715778', get label() { return t('message.57a73ede5f6f'); } },
  { color: '#795771', get label() { return t('message.591dceeb4a25'); } },
  { color: '#805d6f', get label() { return t('message.75f9577a1637'); } },
  { color: '#815961', get label() { return t('color.rose'); } },
  { color: '#805856', get label() { return t('message.6741b8b5e1c2'); } },
  { color: '#806149', get label() { return t('message.2b2b4ad00333'); } },
  { color: '#6d5749', get label() { return t('color.brown'); } },
  { color: '#78694a', get label() { return t('message.a2c334da46a3'); } },
  { color: '#65704a', get label() { return t('message.aaf2d054d5f7'); } },
  { color: '#476959', get label() { return t('message.f22f3a4a6cd6'); } },
  { color: '#456b65', get label() { return t('message.f1d0073c7a6b'); } },
  { color: '#575c66', get label() { return t('message.e7c9cc1ea080'); } },
];

export function automaticCardColor(source: string): string {
  const hsv = hexToHsv(colorToHex(source) ?? '#575c66');
  // Keep the source hue, soften saturation and reserve contrast for white text.
  // Even a neutral at this brightness exceeds a 4.5:1 white contrast ratio.
  return hsvToHex({ ...hsv, s: Math.min(hsv.s, 0.42), v: Math.min(hsv.v, 0.44) });
}
