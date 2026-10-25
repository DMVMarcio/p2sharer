import React from 'react';
import { Monitor, Globe, Smartphone } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { t } from '../../i18n';
import type { AppPlatform } from '../../core/types';

export interface PlatformBadgeProps {
  platform?: AppPlatform;
  size?: number;
  className?: string;
}

export const PlatformBadge: React.FC<PlatformBadgeProps> = ({
  platform = 'desktop',
  size = 12,
  className = '',
}) => {
  const label = t(`platform.${platform}`);

  const renderIcon = () => {
    switch (platform) {
      case 'web':
        return <Globe size={size} aria-hidden="true" />;
      case 'mobile':
        return <Smartphone size={size} aria-hidden="true" />;
      case 'desktop':
      default:
        return <Monitor size={size} aria-hidden="true" />;
    }
  };

  return (
    <Tooltip content={label} compact>
      <span
        className={`platform-badge ${className}`.trim()}
        role="img"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {renderIcon()}
      </span>
    </Tooltip>
  );
};
