import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';
import React from 'react';
import { StreamWatcher } from '../../core/types';

interface WatchersTooltipContentProps {
  watchers: StreamWatcher[];
}

export const WatchersTooltipContent: React.FC<WatchersTooltipContentProps> = ({
  watchers,
}) => {
  useLocale();
  const watchersCount = watchers.length;

  return (
    <>
      <div className="watchers-tooltip-header">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>
          {watchersCount === 0
            ? t("message.a891f208b6c2")
            : watchersCount === 1
            ? t("message.565fd57b393f")
            : t("message.8d6d315d59d7", { v0: watchersCount })}
        </span>
      </div>
      {watchersCount > 0 ? (
        <div className="watchers-tooltip-list">
          {watchers.map((w) => {
            const isSelf = w.isSelf === true;
            return (
              <div key={w.peerId} className="watchers-tooltip-item">
                <span className="watchers-tooltip-dot"></span>
                <span className="watchers-tooltip-name">{w.username}</span>
                {isSelf && <span className="badge-you">{t("message.a03099f135b1")}</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="watchers-tooltip-empty">{t("message.27162bde7bda")}</div>
      )}
    </>
  );
};
