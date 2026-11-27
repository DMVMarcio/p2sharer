import React, { useEffect, useRef, useState } from 'react';
import { ListFilter } from 'lucide-react';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import { useDropdownPresence } from '../../hooks/presence/useDropdownPresence';
import { Tooltip } from '../common/Tooltip';
import {
  countHiddenChatCategories,
  resetChatFilters,
  setChatFilter,
  type ChatFilterCategory,
  type ChatFilterPreferences,
} from '../../core/chat/chat_filters';

const FILTER_OPTIONS: ReadonlyArray<{ key: ChatFilterCategory; labelKey: string }> = [
  { key: 'messages', labelKey: 'chat.filter.messages' },
  { key: 'streams', labelKey: 'chat.filter.streams' },
  { key: 'apps', labelKey: 'chat.filter.apps' },
  { key: 'presence', labelKey: 'chat.filter.presence' },
  { key: 'events', labelKey: 'chat.filter.events' },
];

interface ChatFilterMenuProps {
  filters: ChatFilterPreferences;
}

export const ChatFilterMenu: React.FC<ChatFilterMenuProps> = ({ filters }) => {
  useLocale();
  const [open, setOpen] = useState(false);
  const presence = useDropdownPresence(open ? true : null);
  const rootRef = useRef<HTMLDivElement>(null);
  const hiddenCount = countHiddenChatCategories(filters);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="chat-filter-control" ref={rootRef}>
      <Tooltip content={t('chat.filter.label')}>
        <button
          type="button"
          className={`btn-chat-emoji btn-chat-filter ${open ? 'active' : ''} ${hiddenCount > 0 ? 'has-active-filters' : ''}`}
          aria-label={t('chat.filter.label')}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((current) => !current)}
        >
          <ListFilter size={18} aria-hidden="true" />
          {hiddenCount > 0 && <span className="chat-filter-dot" aria-hidden="true" />}
        </button>
      </Tooltip>
      {presence.value && (
        <div
          className={`chat-filter-menu ${presence.closing ? 'dropdown-closing' : ''}`}
          inert={presence.closing || undefined}
          aria-hidden={presence.closing}
          role="dialog"
          aria-label={t('chat.filter.label')}
        >
          <div className="chat-filter-header">
            <strong className="chat-filter-title">{t('chat.filter.label')}</strong>
            {hiddenCount > 0 && (
              <button
                type="button"
                className="chat-filter-reset"
                onClick={() => resetChatFilters()}
              >
                {t('chat.filter.showAll')}
              </button>
            )}
          </div>
          <div className="chat-filter-options">
            {FILTER_OPTIONS.map((option) => (
              <label key={option.key} className="chat-filter-option">
                <input
                  autoComplete="off"
                  type="checkbox"
                  checked={filters[option.key]}
                  onChange={(event) => setChatFilter(option.key, event.target.checked)}
                />
                <span>{t(option.labelKey)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
