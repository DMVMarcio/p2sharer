import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeChatUrl } from '../../src/core/chat_links.ts';

describe('chat link safety', () => {
  it('allows external HTTP links', () => {
    assert.equal(safeChatUrl('https://example.com/path'), 'https://example.com/path');
    assert.equal(safeChatUrl('http://example.com'), 'http://example.com/');
  });

  it('rejects scripts, local files, and relative paths', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,<script></script>', 'file:///secret', '/local/path', 'not-a-url']) {
      assert.equal(safeChatUrl(value), '');
    }
  });
});
