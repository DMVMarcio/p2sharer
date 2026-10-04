import { getLanguage } from '../i18n/index.ts';
export type TransferSpeedUnit = 'MB' | 'Mb';

const STORAGE_KEY = 'p2sharer_transfer_speed_unit';
const CHANGE_EVENT = 'p2sharer-transfer-speed-unit-change';

export function getTransferSpeedUnit(): TransferSpeedUnit {
  if (typeof localStorage === 'undefined') return 'MB';
  return localStorage.getItem(STORAGE_KEY) === 'Mb' ? 'Mb' : 'MB';
}

export function saveTransferSpeedUnit(unit: TransferSpeedUnit): void {
  localStorage.setItem(STORAGE_KEY, unit);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeTransferSpeedUnit(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

export function formatTransferSpeed(bytesPerSecond: number, unit: TransferSpeedUnit): string {
  const value = Math.max(0, Number.isFinite(bytesPerSecond) ? bytesPerSecond : 0) *
    (unit === 'Mb' ? 8 : 1) / 1_000_000;
  return `${new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: value < 1 ? 2 : 1,
    minimumFractionDigits: 1 }).format(value)} ${unit}/s`;
}
