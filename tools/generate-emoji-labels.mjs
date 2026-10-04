import { readFileSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// Keep source data reproducible and bundle only names used by the offline picker.
const revision = '5b159148f1390735049e296723f6b847229b23ef';
const catalog = JSON.parse(readFileSync(new URL('../src/core/emoji_catalog.json', import.meta.url)));
const normalize = (emoji) => emoji.replaceAll('\uFE0F', '');
for (const [language, sourceLanguage] of [['en', 'en'], ['pt-BR', 'pt']]) {
  const labels = new Map();
  for (const directory of ['annotations', 'annotationsDerived']) {
    const url = `https://raw.githubusercontent.com/unicode-org/cldr/${revision}/common/${directory}/${sourceLanguage}.xml`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`CLDR download failed: ${response.status}`);
    const dom = new JSDOM(await response.text(), { contentType: 'text/xml' });
    for (const annotation of dom.window.document.querySelectorAll('annotation[type="tts"]')) {
      const label = annotation.textContent.trim();
      if (label && label !== '↑↑↑') labels.set(normalize(annotation.getAttribute('cp')), label);
    }
    dom.window.close();
  }
  const resource = {};
  for (const entry of catalog) {
    const label = labels.get(normalize(entry.emoji));
    if (!label) throw new Error(`Missing ${language} emoji label: ${entry.name}`);
    resource[`emoji.${entry.emoji}`] = label;
  }
  writeFileSync(new URL(`../src/i18n/locales/emoji-${language}.json`, import.meta.url), JSON.stringify(resource, null, 2) + '\n');
  console.log(`${language}: ${Object.keys(resource).length} localized emoji labels`);
}
const license = await fetch(`https://raw.githubusercontent.com/unicode-org/cldr/${revision}/LICENSE`, { signal: AbortSignal.timeout(30000) });
if (!license.ok) throw new Error('CLDR license download failed');
writeFileSync(new URL('../public/emojis/UNICODE_LICENSE.txt', import.meta.url), await license.text());
