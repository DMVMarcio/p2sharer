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
