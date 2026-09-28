import { useState } from 'react';
import { Tooltip } from '../common/Tooltip';
import { formatEditedElapsed } from '../../core/chat_time';

export function EditedMessageMarker({ editedAt }: { editedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  return <Tooltip content={formatEditedElapsed(editedAt, now)} onOpenChange={(open) => { if (open) setNow(Date.now()); }}>
    <span className="chat-msg-edited" tabIndex={0}>editada</span>
  </Tooltip>;
}
