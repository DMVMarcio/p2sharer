import React, { useMemo, useState } from 'react';
import { EMOJI_CATALOG, EMOJI_CATEGORIES, EMOJI_SEARCH_ALIASES, EmojiCategory } from '../../core/emoji_catalog';
import { EmojiPack } from '../../core/emoji_preferences';
import { EmojiGlyph } from './EmojiGlyph';

type Props = { pack: EmojiPack; onSelect: (emoji: string) => void };

export const EmojiPicker: React.FC<Props> = ({ pack, onSelect }) => {
  const [category, setCategory] = useState<EmojiCategory>(EMOJI_CATEGORIES[0].id);
  const [query, setQuery] = useState('');
  const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normalizedQuery = normalize(query.trim());
  const emojis = useMemo(() => EMOJI_CATALOG.filter((entry) =>
    normalizedQuery
      ? normalize(`${entry.name} ${EMOJI_SEARCH_ALIASES[entry.emoji] ?? ''}`).includes(normalizedQuery) || entry.emoji.includes(normalizedQuery)
      : entry.category === category
  ), [category, normalizedQuery]);

  return (
    <div className="emoji-picker" role="dialog" aria-label="Selecionar emoji">
      <div className="emoji-picker-header">
        <strong>Emojis</strong>
        <span>{emojis.length}</span>
      </div>
      <input
        className="emoji-picker-search"
        type="search"
        placeholder="Buscar emoji..."
        aria-label="Buscar emoji"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="emoji-picker-categories" aria-label="Categorias de emojis">
        {EMOJI_CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={category === item.id && !normalizedQuery ? 'active' : ''}
            aria-label={item.label}
            aria-pressed={category === item.id && !normalizedQuery}
            title={item.label}
            onClick={() => { setCategory(item.id); setQuery(''); }}
          >
            {item.icon}
          </button>
        ))}
      </div>
      <div className="emoji-picker-section-label">
        {normalizedQuery ? 'Resultados' : EMOJI_CATEGORIES.find((item) => item.id === category)?.label}
      </div>
      <div className="emoji-picker-grid">
        {emojis.length ? emojis.map((entry) => (
          <button
            key={entry.emoji}
            type="button"
            title={entry.name}
            aria-label={entry.name}
            onClick={() => onSelect(entry.emoji)}
          >
            <EmojiGlyph emoji={entry.emoji} pack={pack} size={25} />
          </button>
        )) : <p className="emoji-picker-empty">Nenhum emoji encontrado.</p>}
      </div>
    </div>
  );
};
