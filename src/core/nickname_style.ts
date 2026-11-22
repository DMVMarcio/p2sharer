/** Only registry identifiers and hexadecimal colors cross the presence boundary. */
export const NICKNAME_FONTS = {
  default: 'inherit',
  boogaloo: "'Boogaloo', sans-serif",
  'jacquard-24': "'Jacquard 24', serif",
  honk: "'Honk', sans-serif",
  'faster-one': "'Faster One', sans-serif",
  exile: "'Exile', sans-serif",
  nunito: "'Nunito', sans-serif",
  pacifico: "'Pacifico', cursive",
  syne: "'Syne', sans-serif",
  'permanent-marker': "'Permanent Marker', cursive",
  bangers: "'Bangers', cursive",
  silkscreen: "'Silkscreen', monospace",
  cinzel: "'Cinzel', serif",
} as const;
export const NICKNAME_FONT_LABELS: Record<Exclude<keyof typeof NICKNAME_FONTS, 'default'>, string> = {
  boogaloo: 'Boogaloo',
  'jacquard-24': 'Jacquard 24',
  honk: 'Honk',
  'faster-one': 'Faster One',
  exile: 'Exile',
  nunito: 'Nunito',
  pacifico: 'Pacifico',
  syne: 'Syne',
  'permanent-marker': 'Permanent Marker',
  bangers: 'Bangers',
  silkscreen: 'Silkscreen',
  cinzel: 'Cinzel',
};
export const NICKNAME_EFFECTS = ['none', 'solid', 'gradient', 'letters', 'rainbow', 'glow', 'shine'] as const;
export const NICKNAME_ANIMATIONS = ['none', 'float', 'pulse', 'wave'] as const;
export interface NicknameStyle {
  font: keyof typeof NICKNAME_FONTS;
  effect: typeof NICKNAME_EFFECTS[number];
  animation: typeof NICKNAME_ANIMATIONS[number];
  color: string;
  secondaryColor: string;
  shineColor: string;
}
export const DEFAULT_NICKNAME_STYLE: NicknameStyle = {
  font: 'default', effect: 'none', animation: 'none', color: '#38bdf8', secondaryColor: '#c084fc', shineColor: '#ffffff',
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
    shineColor: color(source.shineColor, DEFAULT_NICKNAME_STYLE.shineColor),
  };
}
export const NICKNAME_STYLE_KEY = 'p2sharer_nickname_style_v1';
export function readNicknameStyle(): NicknameStyle {
  try { return normalizeNicknameStyle(JSON.parse(localStorage.getItem(NICKNAME_STYLE_KEY) ?? 'null')); }
  catch { return { ...DEFAULT_NICKNAME_STYLE }; }
}
