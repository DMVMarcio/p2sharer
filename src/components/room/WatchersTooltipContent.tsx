import React from 'react';
import { StreamWatcher } from '../../core/types';

interface WatchersTooltipContentProps {
  watchers: StreamWatcher[];
}

export const WatchersTooltipContent: React.FC<WatchersTooltipContentProps> = ({
  watchers,
}) => {
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
            ? 'Ninguém assistindo'
            : watchersCount === 1
            ? '1 pessoa assistindo:'
            : `${watchersCount} pessoas assistindo:`}
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
                {isSelf && <span className="badge-you">VOCÊ</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="watchers-tooltip-empty">Nenhum espectador no momento</div>
      )}
    </>
  );
};
