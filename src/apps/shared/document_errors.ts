import { localizeError, t } from '../../i18n';

export function documentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('whiteboard.') || message === 'documents.nameExists' ? t(message) : localizeError(error);
}
