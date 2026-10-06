export function customAccentTokens(color: string): Record<string, string> | null {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  const linear = rgb.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return {
    '--custom-accent-color': color,
    '--custom-accent-hover': `color-mix(in srgb, ${color} 85%, ${luminance > 0.179 ? 'black' : 'white'})`,
    '--custom-accent-subtle': `rgba(${rgb.join(', ')}, 0.12)`,
    '--custom-accent-border': `rgba(${rgb.join(', ')}, 0.3)`,
    '--custom-accent-text': luminance > 0.179 ? '#000000' : '#ffffff',
  };
}
