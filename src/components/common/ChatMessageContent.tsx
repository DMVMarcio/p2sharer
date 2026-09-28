import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeChatUrl } from '../../core/chat_links';
import { EmojiPack } from '../../core/emoji_preferences';
import { modalManager } from '../../hooks/useModal';
import { EmojiText } from './EmojiText';

const allowedElements = [
  'p', 'br', 'strong', 'em', 'del', 'a', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'hr',
];

export const ChatMessageContent: React.FC<{ text: string; pack: EmojiPack }> = ({ text, pack }) => {
  const withEmoji = (children: React.ReactNode) => React.Children.map(children, (child) =>
    typeof child === 'string' ? <EmojiText text={child} pack={pack} /> : child
  );

  return (
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
  );
};
