import { useMemo, useState, type ReactNode } from 'react';
import { highlightCode } from '../../core/code_highlighting';
import { CodeLanguageSelect } from './CodeLanguageSelect';

type HighlightNode = ReturnType<typeof highlightCode>['children'][number];
function renderToken(node: HighlightNode, key: number): ReactNode {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return null;
  return <span key={key} className={Array.isArray(node.properties.className) ? node.properties.className.join(' ') : undefined}>
    {node.children.map(renderToken)}</span>;
}

export function HighlightedCodeBlock({ text, language }: { text: string; language: string }) {
  const [override, setOverride] = useState<string>();
  const selected = override ?? language;
  const tokens = useMemo(() => highlightCode(selected, text).children.map(renderToken), [selected, text]);
  return <div className="code-block">
    <div className="code-block-toolbar"><CodeLanguageSelect language={selected} onChange={setOverride} /></div>
    <pre><code>{tokens}</code></pre>
  </div>;
}
