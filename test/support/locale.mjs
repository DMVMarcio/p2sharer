// Existing regressions use Brazilian Portuguese. Language-specific tests switch
// the real translator explicitly; production continues to detect the OS locale.
Object.defineProperty(globalThis, 'navigator', { configurable: true,
  value: { languages: ['pt-BR'], language: 'pt-BR', userAgent: 'Node.js' } });

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
}
if (typeof globalThis.cancelAnimationFrame !== 'function') {
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
