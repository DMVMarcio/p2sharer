import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeChatUrl } from '../../core/chat_links';
import { EmojiPack } from '../../core/emoji_preferences';
import { modalManager } from '../../hooks/useModal';
import { EmojiText } from './EmojiText';
import { getEmojiIndex } from '../../core/emoji_catalog';
import { stateStore } from '../../core/state_store';
import { roomService } from '../../services/room_service';
import { profileImages } from '../../core/profile_image';
import { selfId } from '@trystero-p2p/core';

const allowedElements = [
  'p', 'br', 'strong', 'em', 'del', 'a', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'hr',
];

function getEmojiOnlyCount(rawText: string): number {
  const trimmed = rawText.trim();
  if (!trimmed) return 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const { segment } of segmenter.segment(trimmed)) {
    if (/\s/.test(segment)) continue;
    if (getEmojiIndex(segment) !== undefined) {
      count++;
    } else {
      return 0;
    }
  }
  return count;
}

function renderMentionsAndEmoji(content: string, pack: EmojiPack, emojiSize: number): React.ReactNode {
  const mentionRegex = /(^|[\s([{\]])@([a-zA-Z0-9_\-.\u00C0-\u024F]+)/g;
  const elements: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(content)) !== null) {
    const fullMatch = match[0];
    const prefix = match[1];
    const mentionName = match[2];
    const matchIndex = match.index;
    const prefixLen = prefix.length;
    const mentionStart = matchIndex + prefixLen;

    if (matchIndex > lastIndex) {
      const preceding = content.slice(lastIndex, matchIndex);
      elements.push(<EmojiText key={`text-${lastIndex}`} text={preceding} pack={pack} size={emojiSize} />);
    }
    if (prefixLen > 0) {
      elements.push(prefix);
    }

    const isSelf = mentionName.toLowerCase() === stateStore.username.toLowerCase();
    let targetPeerId = '';
    let targetColor: string | undefined;

    if (isSelf) {
      targetPeerId = selfId;
      targetColor = stateStore.roomSlots.find((s) => s.isLocal)?.color ?? profileImages.color('local', true);
    } else {
      const peer = roomService.peers.find((p) => p.username.toLowerCase() === mentionName.toLowerCase());
      if (peer) {
        targetPeerId = peer.id;
        targetColor = stateStore.roomSlots.find((s) => s.peerId === peer.id)?.color ?? profileImages.color(peer.id);
      } else {
        const pastMsg = roomService.chatMessages.find((m) => m.sender.toLowerCase() === mentionName.toLowerCase());
        if (pastMsg?.authorId) {
          targetPeerId = pastMsg.authorId;
          targetColor = profileImages.color(targetPeerId);
        }
      }
    }

    elements.push(
      <button
        key={`mention-${mentionStart}`}
        type="button"
        className={`chat-msg-mention ${isSelf ? 'is-self' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          modalManager.openProfile({
            peerId: targetPeerId,
            name: mentionName,
            isLocal: isSelf,
            color: targetColor,
          });
        }}
      >
        @{mentionName}
      </button>
    );

    lastIndex = matchIndex + fullMatch.length;
  }

  if (lastIndex < content.length) {
    elements.push(<EmojiText key={`text-${lastIndex}`} text={content.slice(lastIndex)} pack={pack} size={emojiSize} />);
  }

  return elements.length > 0 ? elements : <EmojiText text={content} pack={pack} size={emojiSize} />;
}

export const ChatMessageContent: React.FC<{ text: string; pack: EmojiPack }> = ({ text, pack }) => {
  const emojiCount = getEmojiOnlyCount(text);
  const isJumbo = emojiCount >= 1 && emojiCount <= 3;
  const emojiSize = isJumbo ? 36 : 21;

  const withEmoji = (children: React.ReactNode) => React.Children.map(children, (child) =>
    typeof child === 'string' ? renderMentionsAndEmoji(child, pack, emojiSize) : child
  );

  return (
    <div className={isJumbo ? 'chat-msg-jumbo' : undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={allowedElements}
        unwrapDisallowed
        urlTransform={safeChatUrl}
        components={{
          p: ({ children }) => <p>{withEmoji(children)}</p>,
          strong: ({ children }) => <strong>{withEmoji(children)}</strong>,
          em: ({ children }) => <em>{withEmoji(children)}</em>,
          del: ({ children }) => <del>{withEmoji(children)}</del>,
          li: ({ children }) => <li>{withEmoji(children)}</li>,
          h1: ({ children }) => <h1>{withEmoji(children)}</h1>,
          h2: ({ children }) => <h2>{withEmoji(children)}</h2>,
          h3: ({ children }) => <h3>{withEmoji(children)}</h3>,
          code: ({ children, className }) => <code className={className}>{withEmoji(children)}</code>,
          a: ({ href, children }) => href ? (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                modalManager.openExternalLink(href);
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                modalManager.openExternalLink(href);
              }}
            >
              {withEmoji(children)}
            </a>
          ) : <>{withEmoji(children)}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};
