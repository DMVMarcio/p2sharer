import type { ChessGameState } from './chess_engine.ts';

export function buildChessPgn(
  game: ChessGameState,
  metadata: { event: string; white: string; black: string; date?: Date },
): string {
  const result = game.winner === 'w' ? '1-0' : game.winner === 'b' ? '0-1' : '1/2-1/2';
  const date = metadata.date ?? new Date();
  const dateTag = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
  const tags: [string, string][] = [
    ['Event', metadata.event || 'P2Sharer Chess'],
    ['Site', 'P2Sharer'],
    ['Date', dateTag],
    ['Round', '1'],
    ['White', metadata.white || 'White'],
    ['Black', metadata.black || 'Black'],
    ['Result', result],
  ];
  const tagLines = tags.map(([key, value]) => `[${key} "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
  const moveText: string[] = [];
  for (let index = 0; index < game.moveHistory.length; index += 1) {
    const move = game.moveHistory[index];
    if (move.color === 'w') moveText.push(`${Math.floor(index / 2) + 1}.`);
    moveText.push(move.san);
  }
  moveText.push(result);
  return `${tagLines.join('\n')}\n\n${moveText.join(' ').trim()}`;
}
