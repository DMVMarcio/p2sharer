import React, { useLayoutEffect, useRef } from 'react';
import { EmojiPack } from '../../core/emoji_preferences';
import { EmojiText } from './EmojiText';

type Props = {
  value: string;
  pack: EmojiPack;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
};

export const EmojiComposerInput: React.FC<Props> = ({ value, pack, inputRef, onChange, onKeyDown }) => {
  const previewRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
    if (previewRef.current) previewRef.current.scrollTop = input.scrollTop;
  }, [value, inputRef]);

  return (
    <div className="chat-composer-field">
      <div className="chat-composer-preview" ref={previewRef} aria-hidden="true">
        <EmojiText text={value} pack={pack} size={16} />
        {'\u200b'}
      </div>
      <textarea
        ref={inputRef}
        id="chat-input-field"
        placeholder="Digite uma mensagem..."
        aria-label="Mensagem"
        title="Enter envia; Shift+Enter adiciona uma linha"
        autoComplete="off"
        maxLength={2000}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          if (previewRef.current) previewRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
      />
    </div>
  );
};
