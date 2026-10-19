/**
 * Detects whether hardware graphics acceleration is enabled and available in the browser.
 * When hardware acceleration is disabled in browser settings, browsers fall back to
 * software rasterizers (such as Google SwiftShader, Mesa llvmpipe, or Windows WARP),
 * or fail WebGL initialization when major performance caveats are disallowed.
 */
export function detectHardwareAcceleration(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return true;
  }
  try {
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') {
      return true;
    }

    // 1. failIfMajorPerformanceCaveat: true asks the browser to return null if
    // rendering would fall back to a slow CPU software rasterizer.
    const gl = (canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true }) ||
      canvas.getContext('experimental-webgl', { failIfMajorPerformanceCaveat: true })) as WebGLRenderingContext | null;

    if (!gl) {
      return false;
    }

    // 2. Query unmasked renderer string if available to double-check for software rasterizers.
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
      const softwareKeywords = [
        'swiftshader',
        'llvmpipe',
        'softpipe',
        'software',
        'basic render driver',
        'warp',
        'mesa software',
      ];
      if (softwareKeywords.some((keyword) => renderer.includes(keyword))) {
        const lose = gl.getExtension('WEBGL_lose_context');
        lose?.loseContext();
        return false;
      }
    }

    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}
