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

/** Choose the largest equal cards that fit both viewport dimensions. Short rows come first. */
export function automaticCardRows(ids: string[], width: number, height: number): { rows: string[][]; baseWidth: number } {
  if (!ids.length) return { rows: [], baseWidth: 0 };
  let columns = 1;
  let best = 0;
  for (let count = 1; count <= ids.length; count++) {
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
  const baseWidth = automatic.baseWidth;
  const source = manualRows ? reconcileCardRows(manualRows, ids) : automatic.rows;
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

/** Drop into a row, or create a row above/below it when the pointer crosses its edge. */
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
  const top = target.top;
  const bottom = target.top + target.height;
  if (y < top + (bottom - top) * .18) rows.splice(closest, 0, [id]);
  else if (y > bottom - (bottom - top) * .18) rows.splice(closest + 1, 0, [id]);
  else {
    const index = rows[closest].findIndex(key => {
      const card = layout.cards.find(card => card.id === key)!;
      return x < card.left + card.width / 2;
    });
    rows[closest].splice(index < 0 ? rows[closest].length : index, 0, id);
  }
  return rows.filter(row => row.length);
}
