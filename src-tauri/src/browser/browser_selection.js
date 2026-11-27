(() => {
  let element = document.activeElement;
  for (let depth = 0; element?.shadowRoot?.activeElement && depth < 8; depth++) element = element.shadowRoot.activeElement;
  if (element?.matches('iframe,frame')) return { frame: true, text: '' };
  if (element?.matches('input[type="password"]')) return { frame: false, text: '' };
  if (element?.matches('input,textarea') && typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
    return { frame: false, text: element.value.slice(element.selectionStart, element.selectionEnd).slice(0, 65536) };
  }
  const root = element?.getRootNode();
  const selection = root?.getSelection?.() ?? document.getSelection();
  return { frame: false, text: (selection?.toString() ?? '').slice(0, 65536) };
})()
