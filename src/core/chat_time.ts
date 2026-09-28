export function formatEditedElapsed(editedAt: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - editedAt) / 1000));
  const units = [
    { seconds: 86400, singular: 'dia', plural: 'dias' },
    { seconds: 3600, singular: 'hora', plural: 'horas' },
    { seconds: 60, singular: 'minuto', plural: 'minutos' },
    { seconds: 1, singular: 'segundo', plural: 'segundos' },
  ];

  if (elapsedSeconds >= 30 * 86400) {
    return new Date(editedAt).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  for (const unit of units) {
    if (elapsedSeconds >= unit.seconds || unit.seconds === 1) {
      const count = Math.floor(elapsedSeconds / unit.seconds);
      return `${count} ${count === 1 ? unit.singular : unit.plural} atrás`;
    }
  }
  return '0 segundos atrás';
}
