/** Only registry identifiers and hexadecimal colors cross the presence boundary. */
export const NICKNAME_FONTS = { default: 'inherit' } as const;
export const NICKNAME_EFFECTS = ['none', 'solid', 'gradient', 'letters', 'rainbow', 'glow', 'shine'] as const;
export const NICKNAME_ANIMATIONS = ['none', 'float', 'pulse', 'wave'] as const;
export interface NicknameStyle {
  font: keyof typeof NICKNAME_FONTS;
  effect: typeof NICKNAME_EFFECTS[number];
  animation: typeof NICKNAME_ANIMATIONS[number];
  color: string;
  secondaryColor: string;
}
export const DEFAULT_NICKNAME_STYLE: NicknameStyle = {
  font: 'default', effect: 'none', animation: 'none', color: '#38bdf8', secondaryColor: '#c084fc',
};
export function normalizeNicknameStyle(value: unknown): NicknameStyle {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase() : fallback;
  return {
    font: typeof source.font === 'string' && Object.prototype.hasOwnProperty.call(NICKNAME_FONTS, source.font)
      ? source.font as NicknameStyle['font'] : 'default',
    effect: NICKNAME_EFFECTS.includes(source.effect as NicknameStyle['effect'])
      ? source.effect as NicknameStyle['effect'] : 'none',
    animation: NICKNAME_ANIMATIONS.includes(source.animation as NicknameStyle['animation'])
      ? source.animation as NicknameStyle['animation'] : 'none',
    color: color(source.color, DEFAULT_NICKNAME_STYLE.color),
    secondaryColor: color(source.secondaryColor, DEFAULT_NICKNAME_STYLE.secondaryColor),
  };
}
export const NICKNAME_STYLE_KEY = 'p2sharer_nickname_style_v1';
export function readNicknameStyle(): NicknameStyle {
  try { return normalizeNicknameStyle(JSON.parse(localStorage.getItem(NICKNAME_STYLE_KEY) ?? 'null')); }
  catch { return { ...DEFAULT_NICKNAME_STYLE }; }
}
