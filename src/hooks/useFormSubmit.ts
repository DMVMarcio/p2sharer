import { useRef, useState, type FormEvent } from 'react';
import { showToast } from './useToast';

/** Use the same guarded action for implicit Enter submission and the submit button. */
export function useFormSubmit(action: () => void | Promise<void>, disabled = false) {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || running.current) return;
    running.current = true;
    setPending(true);
    try {
      await action();
    } catch (error) {
      console.error('[Form] Submission failed:', error);
      showToast('Não foi possível concluir a operação. Tente novamente.');
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return { submit, pending };
}
