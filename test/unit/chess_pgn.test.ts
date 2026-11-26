import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChessMove, createInitialChessState, indexOf } from '../../src/apps/chess_engine.ts';
import { buildChessPgn } from '../../src/apps/chess_pgn.ts';

test('completed chess games export PGN tags, escaped names, numbered SAN moves and result', () => {
  let game = createInitialChessState();
  for (const [from, to] of [
    [indexOf(6, 5), indexOf(5, 5)],
    [indexOf(1, 4), indexOf(3, 4)],
    [indexOf(6, 6), indexOf(4, 6)],
    [indexOf(0, 3), indexOf(4, 7)],
  ]) {
    const next = applyChessMove(game, from, to);
    assert.ok(next);
    game = next;
  }

  assert.equal(game.status, 'checkmate');
  assert.equal(buildChessPgn(game, {
    event: 'A "quoted" match',
    white: 'Alice',
    black: 'Bob',
    date: new Date(2026, 10, 24),
  }), [
    '[Event "A \\"quoted\\" match"]',
    '[Site "P2Sharer"]',
    '[Date "2026.11.24"]',
    '[Round "1"]',
    '[White "Alice"]',
    '[Black "Bob"]',
    '[Result "0-1"]',
    '',
    '1. f3 e5 2. g4 Qh4# 0-1',
  ].join('\n'));
});
