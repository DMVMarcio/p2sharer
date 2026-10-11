export const BACKGROUND_PRESETS = [
  { id: 'graphite', dark: '#24262b', light: '#e9eaed' },
  { id: 'slate', dark: '#202b38', light: '#e3eaf1' },
  { id: 'forest', dark: '#25312c', light: '#e5ece5' },
  { id: 'sand', dark: '#342d27', light: '#eee7dc' },
  { id: 'plum', dark: '#302837', light: '#ede5f0' },
  { id: 'rose', dark: '#372a2d', light: '#f0e4e5' },
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
  const base = preset ? preset[mode] : value;
  const light = luminance(base) > 0.179;
  const ink = light ? '#161616' : '#ffffff';
  const tint = light ? '#ffffff' : luminance(base) > 0.09 ? '#000000' : '#ffffff';
  const surfaces = {
    '--bg-app': base,
    '--bg-surface': mix(base, tint, light ? 0.28 : 0.04),
    '--bg-elevated': mix(base, tint, light ? 0.55 : 0.09),
    '--bg-card': mix(base, tint, light ? 0.36 : 0.06),
    '--bg-card-hover': mix(base, tint, light ? 0.65 : 0.14),
    '--bg-input': mix(base, tint, light ? 0.1 : 0.12),
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
    '--text-primary': readable(0.96),
    '--text-secondary': readable(0.76),
    '--text-muted': readable(0.65),
    '--text-disabled': mix(base, ink, 0.4),
    '--border-subtle': `color-mix(in srgb, ${ink} 5%, transparent)`,
    '--border-default': `color-mix(in srgb, ${ink} 9%, transparent)`,
    '--border-focus': `color-mix(in srgb, ${ink} 30%, transparent)`,
  } };
}
