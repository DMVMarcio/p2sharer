import assert from 'node:assert/strict';
import test from 'node:test';
import { RoomAppsService } from '../../src/apps/room_apps_service.ts';
import type { TicTacToeModel, ChessModel, CheckersModel } from '../../src/apps/board_game_model.ts';
import { indexOf } from '../../src/apps/chess_engine.ts';

test('board game lobbies support multiple independent rooms and free role switching between players and spectators', () => {
  const alice = new RoomAppsService();
  const bob = new RoomAppsService();
  const carol = new RoomAppsService();

  const broadcastFrom = (sender: string, event: unknown) => {
    if (sender !== 'alice') alice.receive(event, sender);
    if (sender !== 'bob') bob.receive(event, sender);
    if (sender !== 'carol') carol.receive(event, sender);
  };

  alice.attach((e) => broadcastFrom('alice', e), 'alice');
  bob.attach((e) => broadcastFrom('bob', e), 'bob');
  carol.attach((e) => broadcastFrom('carol', e), 'carol');

  try {
    const instanceId = alice.start('tictactoe');
    alice.join(instanceId);
    bob.join(instanceId);
    carol.join(instanceId);

    const aliceModel = alice.getModel<TicTacToeModel>(instanceId)!;
    const bobModel = bob.getModel<TicTacToeModel>(instanceId)!;
    const carolModel = carol.getModel<TicTacToeModel>(instanceId)!;

    // Create two rooms inside the same app instance
    const room1 = aliceModel.createRoom('Garden Table 1', 'seat1')!;
    const room2 = bobModel.createRoom('Garden Table 2', 'seat1')!;
    assert.ok(room1);
    assert.ok(room2);
    assert.equal(carolModel.rooms.length, 2);

    // Bob joins room 1 as Player 2 (O), Carol joins room 1 as Spectator
    assert.equal(bobModel.joinRole(room1, 'seat2'), true);
    assert.equal(carolModel.joinRole(room1, 'spectator'), true);

    assert.deepEqual(aliceModel.getRoom(room1)?.players, { seat1: 'alice', seat2: 'bob' });
    assert.deepEqual(aliceModel.getRoom(room1)?.spectators, ['carol']);

    // Carol cannot steal an occupied seat
    assert.equal(carolModel.joinRole(room1, 'seat1'), false);

    // Alice switches to spectator at any time, freeing seat 1
    assert.equal(aliceModel.joinRole(room1, 'spectator'), true);
    assert.equal(aliceModel.getRoom(room1)?.players.seat1, null);
    assert.ok(aliceModel.getRoom(room1)?.spectators.includes('alice'));

    // Carol can now switch from spectator to seat 1
    assert.equal(carolModel.joinRole(room1, 'seat1'), true);
    assert.equal(aliceModel.getRoom(room1)?.players.seat1, 'carol');
    assert.ok(!aliceModel.getRoom(room1)?.spectators.includes('carol'));

    // Play a full Tic-Tac-Toe game in room 1 while room 2 remains untouched
    assert.equal(carolModel.makeMove(room1, 0), true); // X at 0
    assert.equal(carolModel.makeMove(room1, 1), false); // Not X's turn
    assert.equal(bobModel.makeMove(room1, 3), true); // O at 3
    assert.equal(carolModel.makeMove(room1, 1), true); // X at 1
    assert.equal(bobModel.makeMove(room1, 4), true); // O at 4
    assert.equal(carolModel.makeMove(room1, 2), true); // X at 2 -> X wins!

    const finishedRoom1 = aliceModel.getRoom(room1)!;
    assert.equal(finishedRoom1.game.winner, 'X');
    assert.deepEqual(finishedRoom1.game.winningLine, [0, 1, 2]);
    assert.equal(finishedRoom1.game.scores.X, 1);
    assert.equal(aliceModel.getRoom(room2)?.game.moveCount, 0);
  } finally {
    alice.reset();
    bob.reset();
    carol.reset();
  }
});

test('chess model enforces legal moves, turn order, and checkmate across rooms', () => {
  const whitePeer = new RoomAppsService();
  const blackPeer = new RoomAppsService();
  whitePeer.attach((e) => blackPeer.receive(e, 'white'), 'white');
  blackPeer.attach((e) => whitePeer.receive(e, 'black'), 'black');

  try {
    const id = whitePeer.start('chess');
    const wModel = whitePeer.getModel<ChessModel>(id)!;
    const bModel = blackPeer.getModel<ChessModel>(id)!;

    const roomId = wModel.createRoom('Chess Match', 'seat1')!;
    bModel.joinRole(roomId, 'seat2');

    // Fool's mate sequence: 1. f3 e5 2. g4 Qh4#
    assert.equal(wModel.makeMove(roomId, indexOf(6, 5), indexOf(5, 5)), true); // f2->f3
    assert.equal(wModel.getRoom(roomId)?.lockedBy, undefined);
    assert.equal(bModel.makeMove(roomId, indexOf(1, 4), indexOf(3, 4)), true); // e7->e5
    assert.equal(wModel.makeMove(roomId, indexOf(6, 6), indexOf(4, 6)), true); // g2->g4
    assert.equal(bModel.makeMove(roomId, indexOf(0, 3), indexOf(4, 7)), true); // d8->h4#

    const room = wModel.getRoom(roomId)!;
    assert.equal(room.game.status, 'checkmate');
    assert.equal(room.game.winner, 'b');
    assert.equal(room.game.scores.b, 1);
  } finally {
    whitePeer.reset();
    blackPeer.reset();
  }
});

test('a chess room locks for its lone first mover and lets them play both sides', () => {
  const solo = new RoomAppsService();
  const guest = new RoomAppsService();
  solo.attach((event) => guest.receive(event, 'solo'), 'solo');
  guest.attach((event) => solo.receive(event, 'guest'), 'guest');

  try {
    const instanceId = solo.start('chess');
    const soloModel = solo.getModel<ChessModel>(instanceId)!;
    const guestModel = guest.getModel<ChessModel>(instanceId)!;
    const roomId = soloModel.createRoom('Solo chess', 'seat1')!;

    assert.equal(soloModel.setTimeLimit(roomId, 60_000), true);
    assert.equal(soloModel.makeMove(roomId, indexOf(6, 4), indexOf(4, 4)), true);
    assert.equal(soloModel.getRoom(roomId)?.lockedBy, 'solo');
    assert.equal(guestModel.getRoom(roomId)?.lockedBy, 'solo');
    assert.equal(soloModel.getRoom(roomId)?.game.clock, null);
    assert.equal(guestModel.joinRole(roomId, 'seat2'), false);
    assert.equal(guestModel.joinRole(roomId, 'spectator'), false);

    assert.equal(soloModel.makeMove(roomId, indexOf(1, 4), indexOf(3, 4)), true);
    assert.equal(soloModel.getRoom(roomId)?.game.moveHistory.length, 2);
    assert.equal(soloModel.getRoom(roomId)?.game.turn, 'w');

    const sharedRoomId = soloModel.createRoom('Spectated chess', 'seat1')!;
    assert.equal(guestModel.joinRole(sharedRoomId, 'spectator'), true);
    assert.equal(soloModel.makeMove(sharedRoomId, indexOf(6, 4), indexOf(4, 4)), true);
    assert.equal(soloModel.getRoom(sharedRoomId)?.lockedBy, undefined);
    assert.equal(guestModel.joinRole(sharedRoomId, 'seat2'), true);

    const abandonedRoomId = soloModel.createRoom('Abandoned solo chess', 'seat1')!;
    assert.equal(soloModel.makeMove(abandonedRoomId, indexOf(6, 4), indexOf(4, 4)), true);
    assert.equal(soloModel.getRoom(abandonedRoomId)?.lockedBy, 'solo');
    assert.equal(soloModel.deleteRoom(abandonedRoomId), true);
    assert.equal(guestModel.getRoom(abandonedRoomId), undefined);

    const reopenedRoomId = soloModel.createRoom('Reset solo chess', 'seat1')!;
    assert.equal(soloModel.makeMove(reopenedRoomId, indexOf(6, 4), indexOf(4, 4)), true);
    assert.equal(soloModel.newGame(reopenedRoomId, true), true);
    assert.equal(soloModel.getRoom(reopenedRoomId)?.lockedBy, undefined);
    assert.equal(guestModel.joinRole(reopenedRoomId, 'seat2'), true);
  } finally {
    solo.reset();
    guest.reset();
  }
});

test('checkers model enforces mandatory captures and multi-jump chains', () => {
  const p1 = new RoomAppsService();
  const p2 = new RoomAppsService();
  p1.attach((e) => p2.receive(e, 'p1'), 'p1');
  p2.attach((e) => p1.receive(e, 'p2'), 'p2');

  try {
    const id = p1.start('checkers');
    const m1 = p1.getModel<CheckersModel>(id)!;
    const m2 = p2.getModel<CheckersModel>(id)!;

    const roomId = m1.createRoom('Checkers Table', 'seat1')!;
    m2.joinRole(roomId, 'seat2');

    // White moves 1. c3-d4 (row 5 col 2 -> row 4 col 3)
    assert.equal(m1.makeMove(roomId, 5 * 8 + 2, 4 * 8 + 3), true);
    // Black moves 1... b6-c5 (row 2 col 1 -> row 3 col 2)
    assert.equal(m2.makeMove(roomId, 2 * 8 + 1, 3 * 8 + 2), true);

    // White now has a mandatory capture from d4 (row 4 col 3) over c5 (row 3 col 2) to b6 (row 2 col 1)
    // Attempting a non-capture move from g3-f4 must be rejected
    assert.equal(m1.makeMove(roomId, 5 * 8 + 6, 4 * 8 + 5), false);
    // Executing the capture succeeds
    assert.equal(m1.makeMove(roomId, 4 * 8 + 3, 2 * 8 + 1), true);
    assert.equal(m2.getRoom(roomId)?.game.capturedByWhite, 1);
  } finally {
    p1.reset();
    p2.reset();
  }
});

test('chess and checkers support pre-match per-player timers, synchronization, and timeout victory', () => {
  const whitePeer = new RoomAppsService();
  const blackPeer = new RoomAppsService();
  whitePeer.attach((e) => blackPeer.receive(e, 'white'), 'white');
  blackPeer.attach((e) => whitePeer.receive(e, 'black'), 'black');

  try {
    const id = whitePeer.start('chess');
    const wModel = whitePeer.getModel<ChessModel>(id)!;
    const bModel = blackPeer.getModel<ChessModel>(id)!;

    const roomId = wModel.createRoom('Timed Chess', 'seat1')!;
    bModel.joinRole(roomId, 'seat2');

    // Configure 10 minutes per player before the match starts
    assert.equal(wModel.setTimeLimit(roomId, 600_000), true);
    assert.equal(bModel.getRoom(roomId)?.game.clock?.limitMs, 600_000);
    assert.deepEqual(bModel.getRoom(roomId)?.game.clock?.remainingMs, { w: 600_000, b: 600_000 });
    assert.equal(bModel.getRoom(roomId)?.game.clock?.turnStartedAt, null);

    // Move 1 by White starts Black's clock without deducting White's pre-start time
    const t0 = Date.now();
    assert.equal(wModel.makeMove(roomId, indexOf(6, 4), indexOf(4, 4), undefined, t0), true); // e2->e4
    assert.equal(bModel.getRoom(roomId)?.game.clock?.remainingMs.w, 600_000);
    assert.notEqual(bModel.getRoom(roomId)?.game.clock?.turnStartedAt, null);

    // Time limit cannot be changed once moves have been played
    assert.equal(wModel.setTimeLimit(roomId, 300_000), false);

    // Black thinks and plays move 1 after 2.5s -> Black's clock decreases, White's clock starts
    assert.equal(bModel.makeMove(roomId, indexOf(1, 4), indexOf(3, 4), undefined, t0 + 2500), true);
    const afterBlack = wModel.getRoom(roomId)!.game.clock!;
    assert.ok(afterBlack.remainingMs.b <= 597_600 && afterBlack.remainingMs.b >= 596_500);
    assert.equal(afterBlack.remainingMs.w, 600_000);

    // Periodic clock sync updates remaining time mid-turn
    const beforeSyncW = wModel.getRoom(roomId)!.game.clock!.remainingMs.w;
    assert.equal(wModel.syncClock(roomId, t0 + 12_500), true);
    assert.ok(bModel.getRoom(roomId)!.game.clock!.remainingMs.w < beforeSyncW);

    // Cannot claim timeout prematurely
    assert.equal(bModel.claimTimeout(roomId, t0 + 12_500), false);

    // Once active turn's remaining time hits 0, opponent can claim timeout victory
    assert.equal(bModel.claimTimeout(roomId, t0 + 700_000), true);
    const timedOut = wModel.getRoom(roomId)!;
    assert.equal(timedOut.game.status, 'timeout');
    assert.equal(timedOut.game.winner, 'b');
    assert.equal(timedOut.game.scores.b, 1);
    assert.equal(timedOut.game.clock?.remainingMs.w, 0);

    // Starting a new match preserves the configured 10-minute timer and resets both clocks
    assert.equal(wModel.newGame(roomId, false), true);
    const fresh = bModel.getRoom(roomId)!;
    assert.equal(fresh.game.status, 'playing');
    assert.equal(fresh.game.clock?.limitMs, 600_000);
    assert.deepEqual(fresh.game.clock?.remainingMs, { w: 600_000, b: 600_000 });
    assert.equal(fresh.game.clock?.turnStartedAt, null);
  } finally {
    whitePeer.reset();
    blackPeer.reset();
  }
});

test('undo move requests require opponent consent and accurately revert chess and checkers moves', () => {
  const p1 = new RoomAppsService();
  const p2 = new RoomAppsService();
  p1.attach((e) => p2.receive(e, 'p1'), 'p1');
  p2.attach((e) => p1.receive(e, 'p2'), 'p2');

  try {
    // Chess undo consent flow (accept & decline)
    const chessId = p1.start('chess');
    const c1 = p1.getModel<ChessModel>(chessId)!;
    const c2 = p2.getModel<ChessModel>(chessId)!;
    const chessRoom = c1.createRoom('Undo Chess', 'seat1')!;
    c2.joinRole(chessRoom, 'seat2');
    c1.setTimeLimit(chessRoom, 300_000);

    assert.equal(c1.makeMove(chessRoom, indexOf(6, 4), indexOf(4, 4)), true); // e2->e4
    // Only the mover (White) can request undo; opponent cannot request for White, and White cannot accept own request
    assert.equal(c2.requestUndo(chessRoom), false);
    assert.equal(c1.requestUndo(chessRoom), true);
    assert.equal(c1.respondUndo(chessRoom, true), false);

    // Opponent declines -> request clears, board unchanged, still Black's turn
    assert.equal(c2.respondUndo(chessRoom, false), true);
    assert.equal(c1.getRoom(chessRoom)?.game.undoRequest, null);
    assert.equal(c1.getRoom(chessRoom)?.game.turn, 'b');
    assert.equal(c1.getRoom(chessRoom)?.game.moveHistory.length, 1);

    // White requests again, Black accepts -> board reverts and turn returns to White
    assert.equal(c1.requestUndo(chessRoom), true);
    assert.equal(c2.respondUndo(chessRoom, true), true);
    const revertedChess = c1.getRoom(chessRoom)!;
    assert.equal(revertedChess.game.turn, 'w');
    assert.equal(revertedChess.game.moveHistory.length, 0);
    assert.equal(revertedChess.game.board[indexOf(6, 4)]?.type, 'p');
    assert.equal(revertedChess.game.board[indexOf(4, 4)], null);
    assert.equal(revertedChess.game.clock?.turnStartedAt, null);

    // Checkers undo consent flow (reverts capture and restores captured piece)
    const checkersId = p1.start('checkers');
    const d1 = p1.getModel<CheckersModel>(checkersId)!;
    const d2 = p2.getModel<CheckersModel>(checkersId)!;
    const checkersRoom = d1.createRoom('Undo Checkers', 'seat1')!;
    d2.joinRole(checkersRoom, 'seat2');

    assert.equal(d1.makeMove(checkersRoom, 5 * 8 + 2, 4 * 8 + 3), true); // c3-d4
    assert.equal(d2.makeMove(checkersRoom, 2 * 8 + 1, 3 * 8 + 2), true); // b6-c5
    assert.equal(d1.makeMove(checkersRoom, 4 * 8 + 3, 2 * 8 + 1), true); // d4xb6 capture
    assert.equal(d2.getRoom(checkersRoom)?.game.capturedByWhite, 1);

    assert.equal(d1.requestUndo(checkersRoom), true);
    assert.equal(d2.respondUndo(checkersRoom, true), true);
    const revertedCheckers = d2.getRoom(checkersRoom)!;
    assert.equal(revertedCheckers.game.turn, 'w');
    assert.equal(revertedCheckers.game.capturedByWhite, 0);
    assert.equal(revertedCheckers.game.board[4 * 8 + 3]?.color, 'w');
    assert.equal(revertedCheckers.game.board[3 * 8 + 2]?.color, 'b');
    assert.equal(revertedCheckers.game.board[2 * 8 + 1], null);
  } finally {
    p1.reset();
    p2.reset();
  }
});
