import { getLanguage, t } from '../i18n/index.ts';
export function formatEditedElapsed(editedAt: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - editedAt) / 1000));
  const units = [
    { seconds: 86400, singular: t("message.0addcc1de26e"), plural: t("message.d470eac94870") },
    { seconds: 3600, singular: t("message.ddb5eb1d15e0"), plural: t("message.a3d475370d35") },
    { seconds: 60, singular: t("message.27da2b9dffd7"), plural: t("message.aeb6183e322c") },
    { seconds: 1, singular: t("message.138f885fe5e8"), plural: t("message.324ea98f7cd8") },
  ];

  if (elapsedSeconds >= 30 * 86400) {
    return new Date(editedAt).toLocaleString(getLanguage(), {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  for (const unit of units) {
    if (elapsedSeconds >= unit.seconds || unit.seconds === 1) {
      const count = Math.floor(elapsedSeconds / unit.seconds);
      return t("message.d405ba08b2df", { v0: count, v1: count === 1 ? unit.singular : unit.plural });
    }
  }
  return t("message.64b64fda2140");
}
