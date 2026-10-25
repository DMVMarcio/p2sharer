import { getLanguage } from '../i18n/index.ts';
const units = ['B', 'KB', 'MB', 'GB'] as const;

export function formatFileSize(bytes: number, options?: { binary?: boolean; fractionDigits?: number }): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unit = 0;
  const labels = options?.binary ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] : units;
  while (value >= 1024 && unit < labels.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = options?.fractionDigits ?? (unit === 0 ? 0 : value < 10 ? 1 : 0);
  return `${new Intl.NumberFormat(getLanguage(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)} ${labels[unit]}`;
}
