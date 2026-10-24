import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react';
import { codeHighlighter, codeLanguage, codeLanguages } from '../../core/code_highlighting';
import { CodeLanguageSelect } from './CodeLanguageSelect';
import { t } from '../../i18n';
import { useLocale } from '../../hooks/useLocale';

function CodeBlockView({ node, editor, updateAttributes }: NodeViewProps) {
  useLocale();
  const editable = useEditorState({ editor, selector: ({ editor: current }) => current.isEditable });
  const language = codeLanguage(node.attrs.language);
  return <NodeViewWrapper className="code-block">
    <div className="code-block-toolbar" contentEditable={false}>
      {editable ? <CodeLanguageSelect language={language} onChange={value => { if (editor.isEditable) updateAttributes({ language: value }); }} />
        : <span>{codeLanguages.find(option => option.value === language)?.label || t('code.plainText')}</span>}
    </div>
    <pre spellCheck={false}><NodeViewContent<'code'> as="code" className={`language-${language}`} /></pre>
  </NodeViewWrapper>;
}

/** One schema, renderer and language attribute for chat drafts and collaborative notes. */
export const CodeBlockExtension = CodeBlockLowlight.extend({
  addNodeView() { return ReactNodeViewRenderer(CodeBlockView); },
}).configure({ lowlight: codeHighlighter, defaultLanguage: 'plaintext' });
