// Existing regressions use Brazilian Portuguese. Language-specific tests switch
// the real translator explicitly; production continues to detect the OS locale.
Object.defineProperty(globalThis, 'navigator', { configurable: true,
  value: { languages: ['pt-BR'], language: 'pt-BR', userAgent: 'Node.js' } });
