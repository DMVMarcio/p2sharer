export const BACKGROUND_PRESETS = [
  { id: 'graphite', dark: '#303b50', light: '#e3e8f2' },
  { id: 'slate', dark: '#105bd0', light: '#bed7ff' },
  { id: 'forest', dark: '#087b54', light: '#b3efd4' },
  { id: 'sand', dark: '#b65a18', light: '#ffe1af' },
  { id: 'plum', dark: '#752bce', light: '#dfc5ff' },
  { id: 'rose', dark: '#ba285a', light: '#ffc0d4' },
  { id: 'oled', dark: '#000000', light: '#000000' },
] as const;

export function normalizeBackground(value: string): string {
  return BACKGROUND_PRESETS.some(preset => preset.id === value) || /^#[0-9a-f]{6}$/i.test(value)
    ? value : 'graphite';
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map(offset => {
    const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function mix(base: string, tint: string, amount: number): string {
  return '#' + [1, 3, 5].map(offset => Math.round(
    parseInt(base.slice(offset, offset + 2), 16) * (1 - amount)
    + parseInt(tint.slice(offset, offset + 2), 16) * amount,
  ).toString(16).padStart(2, '0')).join('');
}

/** Derive opaque, hue-related surfaces and readable text for any saved color. */
export function backgroundTokens(value: string, mode: 'dark' | 'light') {
  value = normalizeBackground(value);
  const preset = BACKGROUND_PRESETS.find(item => item.id === value);
  const seed = preset ? preset[mode] : value;
  const light = mode === 'light' && luminance(seed) > 0.179;
  const black = seed.toLowerCase() === '#000000';
  const vivid = luminance(seed) < 0.179;
  const base = light ? seed : mix(seed, '#000000', 0.82);
  const ink = light ? '#161616' : '#ffffff';
  const surface = (amount: number, lift = 0.02) => light
    ? mix(base, '#ffffff', amount)
    : mix(mix(base, seed, amount), '#ffffff', lift);
  const surfaces = {
    '--bg-app': base,
    '--bg-surface': surface(light ? 0.28 : 0.035),
    '--bg-elevated': surface(light ? 0.55 : 0.09, 0.03),
    '--bg-card': surface(light ? 0.36 : 0.065, 0.03),
    '--bg-card-hover': surface(light ? 0.65 : 0.09, 0.035),
    '--bg-input': surface(light ? 0.03 : vivid ? 0.2 : 0.1, black ? 0.1 : 0.065),
    '--bg-control': surface(light ? 0.08 : vivid ? 0.32 : 0.18, black ? 0.1 : 0.05),
    '--bg-control-hover': surface(light ? 0.16 : vivid ? 0.46 : 0.29, black ? 0.18 : 0.06),
  };
  const readable = (amount: number) => {
    for (; amount < 1; amount += 0.025) {
      const text = mix(base, ink, amount);
      if (Object.values(surfaces).every(surface => {
        const a = luminance(text), b = luminance(surface);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5;
      })) return text;
    }
    return light ? '#000000' : '#ffffff';
  };
  return { light, tokens: {
    ...surfaces,
    '--bg-surface-elevated': surfaces['--bg-elevated'],
    '--bg-surface-hover': surfaces['--bg-card-hover'],
    '--hero-background': black ? surfaces['--bg-card'] : '#000000',
    '--hero-control': black ? surfaces['--bg-control'] : mix(seed, '#000000', 0.72),
    '--hero-control-hover': black ? surfaces['--bg-control-hover'] : mix(mix(seed, '#000000', 0.58), '#ffffff', 0.035),
    '--ambient-glow': mix(seed, '#000000', light ? 0 : 0.35),
    '--text-primary': readable(0.96),
    '--text-secondary': readable(0.76),
    '--text-muted': readable(0.65),
    '--text-disabled': mix(base, ink, 0.4),
    '--border-subtle': `color-mix(in srgb, ${ink} 5%, transparent)`,
    '--border-default': `color-mix(in srgb, ${ink} 9%, transparent)`,
    '--border-focus': `color-mix(in srgb, ${ink} 30%, transparent)`,
  } };
}
