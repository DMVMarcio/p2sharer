import { ArrowUpRight, HardDrive, Lock, ShieldCheck, UserX } from 'lucide-react';
import { WebsiteLink } from '../../src/components/common/WebsiteLink';
import { useLocale } from '../../src/hooks/useLocale';
import { getLanguage, t } from '../../src/i18n';
import { usePageMetadata } from './pageMetadata';
import { REPOSITORY_URL } from './SiteFooter';

/** Date of the latest substantive policy revision. */
const UPDATED = new Date(2026, 10, 21);

const SUMMARY = [
  { icon: UserX, text: 'privacyPolicy.summary1' },
  { icon: ShieldCheck, text: 'privacyPolicy.summary2' },
  { icon: Lock, text: 'privacyPolicy.summary3' },
  { icon: HardDrive, text: 'privacyPolicy.summary4' },
] as const;

const SECTIONS = [
  { id: 'local', title: 'privacyPolicy.localTitle', text: 'privacyPolicy.localText', items: ['privacyPolicy.local1', 'privacyPolicy.local2', 'privacyPolicy.local3', 'privacyPolicy.local4'] },
  { id: 'participants', title: 'privacyPolicy.peersTitle', text: 'privacyPolicy.peersText' },
  { id: 'servers', title: 'privacyPolicy.serversTitle', text: 'privacyPolicy.serversText' },
  { id: 'third-parties', title: 'privacyPolicy.thirdTitle', text: 'privacyPolicy.thirdText', items: ['privacyPolicy.third1', 'privacyPolicy.third2', 'privacyPolicy.third3', 'privacyPolicy.third4', 'privacyPolicy.third5'] },
  { id: 'windows', title: 'privacyPolicy.desktopTitle', text: 'privacyPolicy.desktopText' },
  { id: 'choices', title: 'privacyPolicy.choicesTitle', text: 'privacyPolicy.choicesText' },
  { id: 'children', title: 'privacyPolicy.childrenTitle', text: 'privacyPolicy.childrenText' },
  { id: 'contact', title: 'privacyPolicy.changesTitle', text: 'privacyPolicy.changesText' },
] as const;

export function PrivacyPage() {
  useLocale();
  usePageMetadata(`${t('privacyPolicy.title')} — P2Sharer`, t('privacyPolicy.intro'), '/privacy');
  const date = new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'long' }).format(UPDATED);
  return (
    <article className="site-policy">
      <header className="site-policy-header">
        <h1>{t('privacyPolicy.title')}</h1>
        <p className="site-policy-updated">{t('privacyPolicy.updated', { date })}</p>
        <p className="site-policy-intro">{t('privacyPolicy.intro')}</p>
      </header>

      <section className="site-policy-summary" aria-labelledby="privacy-summary">
        <h2 id="privacy-summary">{t('privacyPolicy.summaryTitle')}</h2>
        <ul>
          {SUMMARY.map(({ icon: Icon, text }) => (
            <li key={text}><Icon size={18} aria-hidden="true" /><span>{t(text)}</span></li>
          ))}
        </ul>
      </section>

      <div className="site-policy-body">
        <nav className="site-policy-toc" aria-label={t('privacyPolicy.title')}>
          <ol>
            {SECTIONS.map(section => (
              <li key={section.id}><WebsiteLink href={`#${section.id}`}>{t(section.title)}</WebsiteLink></li>
            ))}
          </ol>
        </nav>
        <div className="site-policy-sections">
          {SECTIONS.map(section => (
            <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
              <h2 id={`${section.id}-title`}>{t(section.title)}</h2>
              <p>{t(section.text)}</p>
              {'items' in section && (
                <ul>
                  {section.items.map(item => <li key={item}>{t(item)}</li>)}
                </ul>
              )}
              {section.id === 'contact' && (
                <div className="site-policy-links">
                  <WebsiteLink className="btn btn-secondary" href={`${REPOSITORY_URL}/issues`} target="_blank" rel="noopener noreferrer">
                    {t('web.issues')}<ArrowUpRight size={15} aria-hidden="true" />
                  </WebsiteLink>
                  <WebsiteLink className="btn btn-secondary" href={`${REPOSITORY_URL}/security/advisories/new`} target="_blank" rel="noopener noreferrer">
                    {t('privacyPolicy.securityLink')}<ArrowUpRight size={15} aria-hidden="true" />
                  </WebsiteLink>
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </article>
  );
}

export default PrivacyPage;
