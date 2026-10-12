export interface CardPlacement { id: string; left: number; top: number; width: number; height: number }
export interface CardLayout { cards: CardPlacement[]; rows: string[][]; height: number; baseWidth: number }
export type CardResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export function resizeCardScale(initial: number, width: number, height: number, edge: CardResizeEdge, dx: number, dy: number): number {
  const horizontal = edge.includes('e') ? dx / Math.max(1, width) : edge.includes('w') ? -dx / Math.max(1, width) : 0;
  const vertical = edge.includes('s') ? dy / Math.max(1, height) : edge.includes('n') ? -dy / Math.max(1, height) : 0;
  const delta = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
  return Math.max(.4, Math.min(2.5, initial * (1 + delta)));
}

const GAP = 8;
const ASPECT = 16 / 9;

/** Keep pairs side by side; otherwise maximize equal card size. Short rows come first. */
export function automaticCardRows(ids: string[], width: number, height: number): { rows: string[][]; baseWidth: number } {
  if (!ids.length) return { rows: [], baseWidth: 0 };
  let columns = 1;
  let best = 0;
  for (let count = ids.length === 2 ? 2 : 1; count <= ids.length; count++) {
    const rows = Math.ceil(ids.length / count);
    const size = Math.min((width - GAP * (count - 1)) / count, (height - GAP * (rows - 1)) / rows * ASPECT);
    if (size > best) { best = size; columns = count; }
  }
  const rows: string[][] = [];
  let offset = 0;
  const first = ids.length % columns || columns;
  while (offset < ids.length) {
    const count = offset === 0 ? first : columns;
    rows.push(ids.slice(offset, offset + count));
    offset += count;
  }
  return { rows, baseWidth: Math.max(1, best) };
}

/** Manual row membership survives filtering; missing/new entries never duplicate cards. */
export function reconcileCardRows(rows: string[][], ids: string[]): string[][] {
  const remaining = new Set(ids);
  const next = rows.map(row => row.filter(id => remaining.delete(id))).filter(row => row.length);
  if (remaining.size) next.push([...remaining]);
  return next;
}

export function calculateCardLayout(ids: string[], width: number, height: number,
  sizes: Record<string, number> = {}, manualRows: string[][] | null = null): CardLayout {
  width = Math.max(1, width); height = Math.max(1, height);
  const automatic = automaticCardRows(ids, width, height);
  const source = manualRows ? reconcileCardRows(manualRows, ids) : automatic.rows;
  // Row placement alone must not create oversized vertical stacks. Explicit
  // size overrides can still grow individual cards beyond the fitted layout.
  const baseWidth = manualRows && source.length ? Math.min(automatic.baseWidth,
    Math.max(1, (height - GAP * (source.length - 1)) / source.length * ASPECT)) : automatic.baseWidth;
  const rows: string[][] = [];
  // Wrap oversized manual rows on narrow windows without changing the saved arrangement.
  for (const row of source) {
    const rowBaseWidth = manualRows ? Math.max(Math.min(160, width),
      Math.min(baseWidth, (width - GAP * (row.length - 1)) / row.length)) : baseWidth;
    let current: string[] = [];
    let used = 0;
    for (const id of row) {
      const size = Math.min(width, rowBaseWidth * Math.max(.4, Math.min(2.5, sizes[id] ?? 1)));
      if (current.length && used + GAP + size > width + .5) { rows.push(current); current = []; used = 0; }
      used += (current.length ? GAP : 0) + size;
      current.push(id);
    }
    if (current.length) rows.push(current);
  }
  const cards: CardPlacement[] = [];
  let top = 0;
  for (const row of rows) {
    const sourceRow = source.find(group => group.includes(row[0]))!;
    const rowBaseWidth = manualRows ? Math.max(Math.min(160, width),
      Math.min(baseWidth, (width - GAP * (sourceRow.length - 1)) / sourceRow.length)) : baseWidth;
    const widths = row.map(id => Math.min(width, rowBaseWidth * Math.max(.4, Math.min(2.5, sizes[id] ?? 1))));
    const rowHeight = Math.max(...widths) / ASPECT;
    let left = (width - widths.reduce((sum, size) => sum + size, 0) - GAP * (row.length - 1)) / 2;
    row.forEach((id, index) => {
      const cardHeight = widths[index] / ASPECT;
      cards.push({ id, left, top: top + (rowHeight - cardHeight) / 2, width: widths[index], height: cardHeight });
      left += widths[index] + GAP;
    });
    top += rowHeight + GAP;
  }
  const contentHeight = Math.max(0, top - GAP);
  const offset = Math.max(0, (height - contentHeight) / 2);
  cards.forEach(card => { card.top += offset; });
  return { cards, rows, height: Math.max(height, contentHeight), baseWidth };
}

/** The nearest card offers four broad directional drop zones around its center. */
export function placeCardAtPoint(layout: CardLayout, id: string, x: number, y: number): string[][] {
  const rows = layout.rows.map(row => row.filter(key => key !== id));
  let target: CardPlacement | undefined;
  let distance = Infinity;
  let centerDistance = Infinity;
  for (const card of layout.cards) {
    if (card.id === id) continue;
    const dx = Math.max(card.left - x, 0, x - card.left - card.width);
    const dy = Math.max(card.top - y, 0, y - card.top - card.height);
    const next = dx * dx + dy * dy;
    const center = (x - card.left - card.width / 2) ** 2 + (y - card.top - card.height / 2) ** 2;
    if (next < distance || next === distance && center < centerDistance) {
      distance = next; centerDistance = center; target = card;
    }
  }
  if (!target) return [[id]];
  const closest = layout.rows.findIndex(row => row.includes(target.id));
  const dx = (x - target.left - target.width / 2) / Math.max(1, target.width / 2);
  const dy = (y - target.top - target.height / 2) / Math.max(1, target.height / 2);
  if (Math.abs(dy) > Math.abs(dx)) rows.splice(closest + (dy > 0 ? 1 : 0), 0, [id]);
  else {
    const index = rows[closest].findIndex(key => {
      const card = layout.cards.find(card => card.id === key)!;
      return x < card.left + card.width / 2;
    });
    rows[closest].splice(index < 0 ? rows[closest].length : index, 0, id);
  }
  return rows.filter(row => row.length);
}
