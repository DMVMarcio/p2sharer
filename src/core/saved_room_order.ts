const STORAGE_KEY = 'p2sharer_saved_room_order_v1';
let memoryOrder: string[] = [];

export function readSavedRoomOrder(): string[] {
  if (typeof localStorage === 'undefined') return [...memoryOrder];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) && value.every((id) => typeof id === 'string')
      ? [...new Set(value)] : [];
  } catch { return []; }
}

export function saveSavedRoomOrder(ids: string[]): void {
  const order = [...new Set(ids)];
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  memoryOrder = order;
}

export function orderSavedRooms<T extends { roomId: string; name: string; customName?: string }>(
  rooms: T[], order = readSavedRoomOrder(),
): T[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...rooms].sort((a, b) => {
    const delta = (positions.get(a.roomId) ?? Infinity) - (positions.get(b.roomId) ?? Infinity);
    return Number.isNaN(delta) || delta === 0
      ? (a.customName ?? a.name).localeCompare(b.customName ?? b.name) : delta;
  });
}
