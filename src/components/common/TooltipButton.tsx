import React from 'react';
import { Tooltip } from './Tooltip';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string;
}

export const TooltipButton: React.FC<Props> = ({ tooltip, children, ...buttonProps }) =>
  <Tooltip content={tooltip}>
    <button type="button" aria-label={buttonProps['aria-label'] || tooltip} {...buttonProps}>{children}</button>
  </Tooltip>;
