import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupTestDOM, type DOMEnvironment } from '../e2e/harness/dom-mock.ts';
import { RoomService } from '../../src/services/room_service.ts';
import type { ChatMessage, PeerInfo } from '../../src/core/types.ts';

describe('Chat System Notifications Architecture', () => {
  let domEnv: DOMEnvironment | null = null;
  let roomService: RoomService;

  beforeEach(() => {
    domEnv = setupTestDOM();
    roomService = RoomService.getInstance();
    roomService.chatMessages = [];
  });

  afterEach(() => {
    if (domEnv) {
      domEnv.cleanup();
      domEnv = null;
    }
  });

  describe('addSystemChatMessage Helper', () => {
    it('appends a system message with isSystem=true and proper defaults', () => {
      roomService.addSystemChatMessage('Test system message');

      assert.strictEqual(roomService.chatMessages.length, 1);
      const msg = roomService.chatMessages[0];
      assert.strictEqual(msg.sender, 'Sistema');
      assert.strictEqual(msg.text, 'Test system message');
      assert.strictEqual(msg.isSystem, true);
      assert.strictEqual(msg.systemType, 'generic');
      assert.ok(msg.id.startsWith('sys_'));
      assert.ok(typeof msg.timestamp === 'number');
    });

    it('correctly sets systemType for join and leave events', () => {
      roomService.addSystemChatMessage('Alice entrou na chamada.', 'join');
      roomService.addSystemChatMessage('Bob saiu da chamada.', 'leave');
      roomService.addSystemChatMessage('Informação da sala', 'info');

      assert.strictEqual(roomService.chatMessages.length, 3);
      assert.strictEqual(roomService.chatMessages[0].systemType, 'join');
      assert.strictEqual(roomService.chatMessages[1].systemType, 'leave');
      assert.strictEqual(roomService.chatMessages[2].systemType, 'info');
    });
  });

  describe('Peer Join and Leave Event Notifications', () => {
    it('formats peer join notification with peer username', () => {
      const peer: PeerInfo = {
        id: 'peer-abc-1234',
        username: 'Carlos Dev',
        connectionState: 'connected',
        joinedAt: Date.now(),
      };

      const name = peer.username || `Participante (${peer.id.slice(0, 4)})`;
      roomService.addSystemChatMessage(`${name} entrou na chamada.`, 'join');

      assert.strictEqual(roomService.chatMessages.length, 1);
      assert.strictEqual(roomService.chatMessages[0].text, 'Carlos Dev entrou na chamada.');
      assert.strictEqual(roomService.chatMessages[0].systemType, 'join');
      assert.strictEqual(roomService.chatMessages[0].isSystem, true);
    });

    it('formats peer leave notification with fallback when username is absent', () => {
      const peerId = 'peer-xyz-9876';
      const username = '';
      const displayName = username || `Participante (${peerId.slice(0, 4)})`;
      roomService.addSystemChatMessage(`${displayName} saiu da chamada.`, 'leave');

      assert.strictEqual(roomService.chatMessages.length, 1);
      assert.strictEqual(roomService.chatMessages[0].text, 'Participante (peer) saiu da chamada.');
      assert.strictEqual(roomService.chatMessages[0].systemType, 'leave');
    });

    it('preserves regular chat messages alongside system messages', () => {
      roomService.addSystemChatMessage('Lucas entrou na chamada.', 'join');

      const regularMsg: ChatMessage = {
        id: 'user_msg_1',
        sender: 'Lucas',
        text: 'Olá a todos!',
        timestamp: Date.now(),
      };
      roomService.chatMessages.push(regularMsg);

      roomService.addSystemChatMessage('Lucas saiu da chamada.', 'leave');

      assert.strictEqual(roomService.chatMessages.length, 3);
      assert.strictEqual(roomService.chatMessages[0].isSystem, true);
      assert.strictEqual(roomService.chatMessages[1].isSystem, undefined);
      assert.strictEqual(roomService.chatMessages[2].isSystem, true);
    });
  });

  describe('CSS Token and Class Verification', () => {
    it('defines .chat-system-msg and variant classes in style.css', () => {
      const cssPath = resolve(process.cwd(), 'src/style.css');
      const css = readFileSync(cssPath, 'utf-8');

      assert.ok(css.includes('.chat-system-msg'), 'style.css must define .chat-system-msg');
      assert.ok(css.includes('.chat-system-content'), 'style.css must define .chat-system-content');
      assert.ok(css.includes('.chat-sys-icon.join'), 'style.css must define .chat-sys-icon.join');
      assert.ok(css.includes('.chat-sys-icon.leave'), 'style.css must define .chat-sys-icon.leave');
      assert.ok(css.includes('.chat-sys-icon.info'), 'style.css must define .chat-sys-icon.info');
      assert.ok(css.includes('.chat-system-join'), 'style.css must define .chat-system-join');
      assert.ok(css.includes('.chat-system-leave'), 'style.css must define .chat-system-leave');
    });
  });
});
