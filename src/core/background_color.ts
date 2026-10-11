export const BACKGROUND_PRESETS = [
  { id: 'graphite', dark: '#24262b', light: '#e9eaed' },
  { id: 'slate', dark: '#173951', light: '#bfdcf1' },
  { id: 'forest', dark: '#1b4234', light: '#bcdcc9' },
  { id: 'sand', dark: '#493020', light: '#f2d5a7' },
  { id: 'plum', dark: '#39224b', light: '#d9c4ef' },
  { id: 'rose', dark: '#4c2536', light: '#efc2cf' },
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
  const base = light ? seed : mix(seed, '#000000', luminance(seed) > 0.179 ? 0.72 : 0.45);
  const ink = light ? '#161616' : '#ffffff';
  const surface = (amount: number) => light
    ? mix(base, '#ffffff', amount)
    : mix(mix(base, seed, amount), '#ffffff', amount * 0.35);
  const surfaces = {
    '--bg-app': base,
    '--bg-surface': surface(light ? 0.28 : 0.07),
    '--bg-elevated': surface(light ? 0.55 : 0.14),
    '--bg-card': surface(light ? 0.36 : 0.1),
    '--bg-card-hover': surface(light ? 0.65 : 0.18),
    '--bg-input': surface(light ? 0.1 : 0.12),
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
