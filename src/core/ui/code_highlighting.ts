import { common, createLowlight } from 'lowlight';

const grammars = createLowlight(common);
const aliases: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  html: 'xml', svg: 'xml', sh: 'bash', py: 'python', rs: 'rust', cs: 'csharp', 'c#': 'csharp',
  'c++': 'cpp', yml: 'yaml', md: 'markdown', text: 'plaintext', txt: 'plaintext' };

export function codeLanguage(value: unknown): string {
  const name = typeof value === 'string' ? value.toLowerCase() : 'plaintext';
  const resolved = Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;
  return grammars.registered(resolved) ? resolved : 'plaintext';
}

/** Keep unknown languages and oversized remote snippets cheap and readable. */
export function highlightCode(language: string, text: string) {
  return grammars.highlight(text.length <= 50_000 ? codeLanguage(language) : 'plaintext', text);
}

export const codeHighlighter = {
  highlight: highlightCode,
  highlightAuto: (text: string) => highlightCode('plaintext', text),
  listLanguages: () => grammars.listLanguages(),
  registered: (language: string) => grammars.registered(language),
};

const names: Record<string, string> = { javascript: 'JavaScript / JSX', typescript: 'TypeScript / TSX',
  xml: 'HTML / XML', cpp: 'C++', csharp: 'C#', objectivec: 'Objective-C', vbnet: 'Visual Basic',
  graphql: 'GraphQL', json: 'JSON', css: 'CSS', scss: 'SCSS', sql: 'SQL', yaml: 'YAML',
  php: 'PHP', wasm: 'WebAssembly', ini: 'INI' };
export const codeLanguages = grammars.listLanguages().filter(name => !['plaintext', 'php-template', 'python-repl'].includes(name))
  .map(value => ({ value, label: names[value] || value[0].toUpperCase() + value.slice(1) }))
  .sort((left, right) => left.label.localeCompare(right.label));
