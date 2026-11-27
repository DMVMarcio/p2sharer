import type { BoardBlendMode, BoardLayer, BoardShape } from './whiteboard_scene';
import type { BoardBox, BoardViewport } from '../shared/whiteboard_interaction';
import { parseHexRgb } from './whiteboard_raster';
import {
  WhiteboardCanvas2DRenderer,
  type LayerCompositeItem,
} from './whiteboard_canvas2d';

const BLEND_MODE_INDEX: Record<BoardBlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  difference: 7,
};

const QUAD_VERTICES = new Float32Array([
  0, 0,
  1, 0,
  0, 1,
  1, 1,
]);

const COMPOSITE_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_boardUv;
void main() {
  v_boardUv = a_pos;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, a_pos.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 v_boardUv;
uniform sampler2D u_dstTex;
uniform sampler2D u_srcTex;
uniform sampler2D u_clipTex;
uniform vec2 u_boardSize;
uniform vec2 u_srcOffset;
uniform int u_srcResizing;
uniform vec4 u_srcFrom;
uniform vec4 u_srcTo;
uniform int u_hasClip;
uniform vec2 u_clipOffset;
uniform int u_clipResizing;
uniform vec4 u_clipFrom;
uniform vec4 u_clipTo;
uniform float u_opacity;
uniform int u_blendMode;
out vec4 fragColor;

float dodgeCh(float cb, float cs) {
  if (cb <= 0.0) return 0.0;
  if (cs >= 1.0) return 1.0;
  return min(1.0, cb / max(1e-5, 1.0 - cs));
}

vec3 applyBlend(vec3 cb, vec3 cs, int mode) {
  if (mode == 1) return cb * cs;
  if (mode == 2) return cb + cs - cb * cs;
  if (mode == 3) {
    return mix(2.0 * cb * cs, 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs), step(0.5, cb));
  }
  if (mode == 4) return min(cb, cs);
  if (mode == 5) return max(cb, cs);
  if (mode == 6) return vec3(dodgeCh(cb.r, cs.r), dodgeCh(cb.g, cs.g), dodgeCh(cb.b, cs.b));
  if (mode == 7) return abs(cb - cs);
  return cs;
}

vec4 sampleLayerTex(sampler2D tex, vec2 boardPx, vec2 offset, int resizing, vec4 fromRect, vec4 toRect) {
  vec2 uv;
  if (resizing == 1) {
    vec2 norm = (boardPx - toRect.xy) / max(vec2(1.0), toRect.zw);
    if (norm.x < 0.0 || norm.x > 1.0 || norm.y < 0.0 || norm.y > 1.0) return vec4(0.0);
    vec2 srcPx = (fromRect.xy - offset) + norm * fromRect.zw;
    uv = srcPx / u_boardSize;
  } else {
    uv = (boardPx - offset) / u_boardSize;
  }
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture(tex, uv);
}

void main() {
  vec4 dst = texture(u_dstTex, v_boardUv);
  vec2 boardPx = v_boardUv * u_boardSize;
  vec4 src = sampleLayerTex(u_srcTex, boardPx, u_srcOffset, u_srcResizing, u_srcFrom, u_srcTo);
  float clipAlpha = 1.0;
  if (u_hasClip == 1) {
    vec4 baseSample = sampleLayerTex(u_clipTex, boardPx, u_clipOffset, u_clipResizing, u_clipFrom, u_clipTo);
    clipAlpha = baseSample.a;
  }
  float srcA = src.a * u_opacity * clipAlpha;
  if (srcA <= 1e-5) {
    fragColor = dst;
    return;
  }
  float dstA = dst.a;
  vec3 srcC = src.a > 1e-5 ? src.rgb / src.a : vec3(0.0);
  vec3 dstC = dstA > 1e-5 ? dst.rgb / dstA : vec3(0.0);
  vec3 blended = applyBlend(dstC, srcC, u_blendMode);
  vec3 outRGB = srcA * (1.0 - dstA) * srcC + dstA * (1.0 - srcA) * dstC + srcA * dstA * blended;
  float outA = srcA + dstA * (1.0 - srcA);
  fragColor = vec4(outRGB, outA);
}
`;

const PRESENT_VERT = `#version 300 es
in vec2 a_pos;
uniform vec2 u_viewSize;
out vec2 v_screenCss;
void main() {
  v_screenCss = a_pos * u_viewSize;
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, 0.0, 1.0);
}
`;

const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_screenCss;
uniform sampler2D u_compositeTex;
uniform vec2 u_viewSize;
uniform vec2 u_boardSize;
uniform vec3 u_viewport;
uniform vec3 u_bgColor;
uniform float u_transparent;
uniform float u_mirror;
out vec4 fragColor;

void main() {
  vec2 screenPos = v_screenCss;
  if (u_mirror > 0.5) {
    screenPos.x = u_viewSize.x - screenPos.x;
  }
  vec2 boardPx = (screenPos - u_viewport.xy) / u_viewport.z;
  vec2 boardUv = boardPx / u_boardSize;

  if (boardUv.x >= 0.0 && boardUv.x <= 1.0 && boardUv.y >= 0.0 && boardUv.y <= 1.0) {
    vec3 bg;
    if (u_transparent > 0.5) {
      vec2 cell = floor(screenPos / 10.0);
      float checker = mod(cell.x + cell.y, 2.0);
      vec3 light = vec3(0.9725, 0.9804, 0.9882);
      vec3 dark = vec3(0.8863, 0.9098, 0.9412);
      bg = mix(light, dark, checker);
    } else {
      bg = u_bgColor;
    }
    vec4 comp = texture(u_compositeTex, boardUv);
    vec3 rgb = comp.rgb + bg * (1.0 - comp.a);

    vec2 screenMin = u_viewport.xy;
    vec2 screenMax = u_viewport.xy + u_boardSize * u_viewport.z;
    float edgeDist = min(
      min(screenPos.x - screenMin.x, screenMax.x - screenPos.x),
      min(screenPos.y - screenMin.y, screenMax.y - screenPos.y)
    );
    if (edgeDist < 1.0) {
      rgb = mix(rgb, vec3(0.8196, 0.8353, 0.8588), 0.75);
    }
    fragColor = vec4(rgb, 1.0);
    return;
  }

  // Soft board drop shadow on transparent viewport background
  vec2 sMin = u_viewport.xy + vec2(0.0, 4.0);
  vec2 sMax = u_viewport.xy + u_boardSize * u_viewport.z + vec2(0.0, 4.0);
  vec2 outside = max(max(sMin - screenPos, screenPos - sMax), 0.0);
  float dist = length(outside);
  if (dist < 22.0) {
    float alpha = 0.26 * exp(-(dist * dist) / (2.0 * 7.5 * 7.5));
    fragColor = vec4(0.0, 0.0, 0.0, alpha);
    return;
  }
  fragColor = vec4(0.0);
}
`;

interface GlLayerTexture {
  tex: WebGLTexture;
  version: number;
  width: number;
  height: number;
}

interface GlState {
  gl: WebGL2RenderingContext;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  compProg: WebGLProgram;
  presProg: WebGLProgram;
  fboA: WebGLFramebuffer;
  texA: WebGLTexture;
  fboB: WebGLFramebuffer;
  texB: WebGLTexture;
  boardW: number;
  boardH: number;
  outputTex: WebGLTexture;
  layerTextures: Map<string, GlLayerTexture>;
  compLocs: Record<string, WebGLUniformLocation | null>;
  presLocs: Record<string, WebGLUniformLocation | null>;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function createRgbaTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return tex;
}

/**
 * Dual-stage GPU studio compositor for the Whiteboard.
 * Stage A composites offscreen layer bitmaps into a board-resolution texture only when dirty.
 * Stage B presents the composited board onto the screen viewport in a single draw call at 60-144 FPS.
 * Automatically falls back to a 2D offscreen composite + viewport present if WebGL2 is unavailable,
 * and returns inactive (`false`) in headless DOM environments.
 */
export class WhiteboardStudioCompositor {
  readonly rasterizer = new WhiteboardCanvas2DRenderer();
  private canvas: HTMLCanvasElement | null = null;
  private mode: 'none' | 'webgl2' | 'canvas2d' = 'none';
  private glState: GlState | null = null;
  private view2dCtx: CanvasRenderingContext2D | null = null;
  private composite2dCanvas: HTMLCanvasElement | null = null;
  private composite2dCtx: CanvasRenderingContext2D | null = null;
  private scratch2dCanvas: HTMLCanvasElement | null = null;
  private scratch2dCtx: CanvasRenderingContext2D | null = null;
  private checkerPattern: CanvasPattern | null = null;
  private uploadCanvas: HTMLCanvasElement | null = null;
  private uploadCtx: CanvasRenderingContext2D | null = null;

  private cssWidth = 800;
  private cssHeight = 500;
  private dpr = 1;
  private boardW = 1920;
  private boardH = 1080;
  private bgColor = '#ffffff';
  private transparent = false;
  private lastViewport: BoardViewport = { x: 60, y: 60, zoom: 1 };
  private lastMirror = false;
  private contextLostHandler: ((e: Event) => void) | null = null;
  private contextRestoredHandler: (() => void) | null = null;

  isActive(): boolean {
    return this.mode !== 'none';
  }

  getMode(): 'none' | 'webgl2' | 'canvas2d' {
    return this.mode;
  }

  attachCanvas(canvas: HTMLCanvasElement): boolean {
    if (this.canvas === canvas && this.mode !== 'none') return true;
    this.detachListeners();
    this.disposeGl();
    this.canvas = canvas;
    this.mode = 'none';
    this.view2dCtx = null;

    if (typeof document === 'undefined') return false;

    const gl = this.tryInitWebGL2(canvas);
    if (gl) {
      this.mode = 'webgl2';
      this.contextLostHandler = (e: Event) => {
        e.preventDefault();
        this.disposeGl();
      };
      this.contextRestoredHandler = () => {
        if (this.canvas) {
          this.tryInitWebGL2(this.canvas);
          this.rasterizer.invalidateComposite();
          this.resizeViewport(this.cssWidth, this.cssHeight, this.dpr);
        }
      };
      canvas.addEventListener('webglcontextlost', this.contextLostHandler);
      canvas.addEventListener('webglcontextrestored', this.contextRestoredHandler);
      return true;
    }

    const ctx = canvas.getContext('2d');
    if (ctx && typeof ctx.clearRect === 'function' && typeof ctx.drawImage === 'function' && typeof ctx.setTransform === 'function') {
      this.view2dCtx = ctx;
      this.mode = 'canvas2d';
      return true;
    }

    return false;
  }

  private tryInitWebGL2(canvas: HTMLCanvasElement): GlState | null {
    try {
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
      if (!gl) return null;
      const compProg = linkProgram(gl, COMPOSITE_VERT, COMPOSITE_FRAG);
      const presProg = linkProgram(gl, PRESENT_VERT, PRESENT_FRAG);
      if (!compProg || !presProg) {
        if (compProg) gl.deleteProgram(compProg);
        if (presProg) gl.deleteProgram(presProg);
        return null;
      }
      const vao = gl.createVertexArray();
      const vbo = gl.createBuffer();
      if (!vao || !vbo) return null;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);

      const compPos = gl.getAttribLocation(compProg, 'a_pos');
      if (compPos >= 0) {
        gl.enableVertexAttribArray(compPos);
        gl.vertexAttribPointer(compPos, 2, gl.FLOAT, false, 0, 0);
      }
      const presPos = gl.getAttribLocation(presProg, 'a_pos');
      if (presPos >= 0 && presPos !== compPos) {
        gl.enableVertexAttribArray(presPos);
        gl.vertexAttribPointer(presPos, 2, gl.FLOAT, false, 0, 0);
      }

      const fboA = gl.createFramebuffer();
      const fboB = gl.createFramebuffer();
      const texA = createRgbaTexture(gl, 1, 1);
      const texB = createRgbaTexture(gl, 1, 1);
      if (!fboA || !fboB || !texA || !texB) return null;

      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texA, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texB, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const compLocs: Record<string, WebGLUniformLocation | null> = {};
      for (const name of [
        'u_dstTex', 'u_srcTex', 'u_clipTex', 'u_boardSize',
        'u_srcOffset', 'u_srcResizing', 'u_srcFrom', 'u_srcTo',
        'u_hasClip', 'u_clipOffset', 'u_clipResizing', 'u_clipFrom', 'u_clipTo',
        'u_opacity', 'u_blendMode',
      ]) {
        compLocs[name] = gl.getUniformLocation(compProg, name);
      }
      const presLocs: Record<string, WebGLUniformLocation | null> = {};
      for (const name of [
        'u_compositeTex', 'u_viewSize', 'u_boardSize', 'u_viewport',
        'u_bgColor', 'u_transparent', 'u_mirror',
      ]) {
        presLocs[name] = gl.getUniformLocation(presProg, name);
      }

      const state: GlState = {
        gl,
        vao,
        vbo,
        compProg,
        presProg,
        fboA,
        texA,
        fboB,
        texB,
        boardW: 1,
        boardH: 1,
        outputTex: texA,
        layerTextures: new Map(),
        compLocs,
        presLocs,
      };
      this.glState = state;
      return state;
    } catch {
      return null;
    }
  }

  resizeViewport(cssWidth: number, cssHeight: number, dpr = 1): void {
    const w = Math.max(1, Math.round(cssWidth));
    const h = Math.max(1, Math.round(cssHeight));
    const scale = Math.max(1, dpr);
    this.cssWidth = w;
    this.cssHeight = h;
    this.dpr = scale;
    if (this.canvas) {
      const targetW = Math.max(1, Math.round(w * scale));
      const targetH = Math.max(1, Math.round(h * scale));
      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
      }
    }
  }

  registerImage(hash: string, img: HTMLImageElement): void {
    this.rasterizer.registerImage(hash, img);
  }

  /**
   * Stage A: Synchronizes offscreen layer canvases and updates the board-resolution composite texture
   * only when layers or strokes have changed. Never touches the GPU on pan/zoom/cursor moves.
   */
  syncScene(
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    draftsByLayer: ReadonlyMap<string, BoardShape[]>,
    movingLayer: BoardLayer | null,
    resizingPreview: { id: string; layer: BoardLayer; shapes: BoardShape[]; fromBounds: BoardBox; bounds: BoardBox } | null,
    boardWidth: number,
    boardHeight: number,
    backgroundColor: string,
    transparent: boolean,
  ): boolean {
    if (this.mode === 'none') return false;
    this.boardW = boardWidth;
    this.boardH = boardHeight;
    this.bgColor = backgroundColor;
    this.transparent = transparent;

    const sync = this.rasterizer.syncLayers(
      null,
      layers,
      shapes,
      draftsByLayer,
      movingLayer,
      resizingPreview,
      boardWidth,
      boardHeight,
      backgroundColor,
      transparent,
    );
    if (!sync) return false;
    if (!sync.changed) return true;

    if (this.mode === 'webgl2' && this.glState) {
      this.compositeWebGL2(this.glState, sync.layers, boardWidth, boardHeight);
    } else if (this.mode === 'canvas2d') {
      this.compositeCanvas2D(sync.layers, boardWidth, boardHeight);
    }
    return true;
  }

  private ensureGlBoardSize(state: GlState, w: number, h: number): void {
    if (state.boardW === w && state.boardH === h) return;
    const { gl } = state;
    gl.bindTexture(gl.TEXTURE_2D, state.texA);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, state.texB);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    state.boardW = w;
    state.boardH = h;
  }

  private uploadLayerTexture(state: GlState, item: LayerCompositeItem, boardW: number, boardH: number): WebGLTexture | null {
    const { gl } = state;
    let entry = state.layerTextures.get(item.id);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);

    if (!entry || entry.width !== boardW || entry.height !== boardH) {
      if (entry) gl.deleteTexture(entry.tex);
      const tex = createRgbaTexture(gl, boardW, boardH);
      if (!tex) return null;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, boardW, boardH, 0, gl.RGBA, gl.UNSIGNED_BYTE, item.canvas);
      entry = { tex, version: item.version, width: boardW, height: boardH };
      state.layerTextures.set(item.id, entry);
      return tex;
    }

    if (entry.version !== item.version) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      const dr = item.dirtyRect;
      if (dr && dr.w > 0 && dr.h > 0 && dr.w * dr.h < boardW * boardH * 0.6) {
        if (!this.uploadCanvas || this.uploadCanvas.width !== dr.w || this.uploadCanvas.height !== dr.h) {
          this.uploadCanvas = document.createElement('canvas');
          this.uploadCanvas.width = dr.w;
          this.uploadCanvas.height = dr.h;
          this.uploadCtx = this.uploadCanvas.getContext('2d');
        }
        if (this.uploadCtx) {
          this.uploadCtx.clearRect(0, 0, dr.w, dr.h);
          this.uploadCtx.drawImage(item.canvas, dr.x, dr.y, dr.w, dr.h, 0, 0, dr.w, dr.h);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, dr.x, dr.y, gl.RGBA, gl.UNSIGNED_BYTE, this.uploadCanvas);
          entry.version = item.version;
          return entry.tex;
        }
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, boardW, boardH, 0, gl.RGBA, gl.UNSIGNED_BYTE, item.canvas);
      entry.version = item.version;
    }

    return entry.tex;
  }

  private compositeWebGL2(state: GlState, items: readonly LayerCompositeItem[], boardW: number, boardH: number): void {
    const { gl, compLocs } = state;
    this.ensureGlBoardSize(state, boardW, boardH);

    // Prune deleted layer textures
    const activeIds = new Set(items.map(i => i.id));
    for (const [id, entry] of state.layerTextures) {
      if (!activeIds.has(id)) {
        gl.deleteTexture(entry.tex);
        state.layerTextures.delete(id);
      }
    }

    // Upload any changed layers
    const uploadedTex = new Map<string, WebGLTexture>();
    const itemById = new Map<string, LayerCompositeItem>();
    for (const item of items) {
      itemById.set(item.id, item);
      const tex = this.uploadLayerTexture(state, item, boardW, boardH);
      if (tex) uploadedTex.set(item.id, tex);
    }

    gl.bindVertexArray(state.vao);
    gl.useProgram(state.compProg);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, boardW, boardH);

    // Clear starting ping-pong target (texA) to transparent
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fboA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let readTex = state.texA;
    let writeFbo = state.fboB;
    let writeTex = state.texB;

    gl.uniform2f(compLocs.u_boardSize, boardW, boardH);
    gl.uniform1i(compLocs.u_dstTex, 0);
    gl.uniform1i(compLocs.u_srcTex, 1);
    gl.uniform1i(compLocs.u_clipTex, 2);

    for (const item of items) {
      const srcTex = uploadedTex.get(item.id);
      if (!srcTex) continue;

      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);

      gl.uniform2f(compLocs.u_srcOffset, item.x, item.y);
      if (item.resizeTransform) {
        const { from, to } = item.resizeTransform;
        gl.uniform1i(compLocs.u_srcResizing, 1);
        gl.uniform4f(compLocs.u_srcFrom, from.x, from.y, from.width, from.height);
        gl.uniform4f(compLocs.u_srcTo, to.x, to.y, to.width, to.height);
      } else {
        gl.uniform1i(compLocs.u_srcResizing, 0);
        gl.uniform4f(compLocs.u_srcFrom, 0, 0, 1, 1);
        gl.uniform4f(compLocs.u_srcTo, 0, 0, 1, 1);
      }

      const baseItem = item.clipping && item.baseLayerId ? itemById.get(item.baseLayerId) : undefined;
      const clipTex = baseItem ? uploadedTex.get(baseItem.id) : undefined;
      if (baseItem && clipTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, clipTex);
        gl.uniform1i(compLocs.u_hasClip, 1);
        gl.uniform2f(compLocs.u_clipOffset, baseItem.x, baseItem.y);
        if (baseItem.resizeTransform) {
          const { from, to } = baseItem.resizeTransform;
          gl.uniform1i(compLocs.u_clipResizing, 1);
          gl.uniform4f(compLocs.u_clipFrom, from.x, from.y, from.width, from.height);
          gl.uniform4f(compLocs.u_clipTo, to.x, to.y, to.width, to.height);
        } else {
          gl.uniform1i(compLocs.u_clipResizing, 0);
          gl.uniform4f(compLocs.u_clipFrom, 0, 0, 1, 1);
          gl.uniform4f(compLocs.u_clipTo, 0, 0, 1, 1);
        }
      } else {
        gl.uniform1i(compLocs.u_hasClip, 0);
      }

      gl.uniform1f(compLocs.u_opacity, item.opacity);
      gl.uniform1i(compLocs.u_blendMode, BLEND_MODE_INDEX[item.blendMode] ?? 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Swap ping-pong buffers
      const prevRead = readTex;
      readTex = writeTex;
      writeTex = prevRead;
      writeFbo = readTex === state.texA ? state.fboB : state.fboA;
    }

    state.outputTex = readTex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private compositeCanvas2D(items: readonly LayerCompositeItem[], boardW: number, boardH: number): void {
    if (!this.composite2dCanvas || this.composite2dCanvas.width !== boardW || this.composite2dCanvas.height !== boardH) {
      this.composite2dCanvas = document.createElement('canvas');
      this.composite2dCanvas.width = boardW;
      this.composite2dCanvas.height = boardH;
      this.composite2dCtx = this.composite2dCanvas.getContext('2d');
    }
    if (!this.scratch2dCanvas || this.scratch2dCanvas.width !== boardW || this.scratch2dCanvas.height !== boardH) {
      this.scratch2dCanvas = document.createElement('canvas');
      this.scratch2dCanvas.width = boardW;
      this.scratch2dCanvas.height = boardH;
      this.scratch2dCtx = this.scratch2dCanvas.getContext('2d');
    }
    const ctx = this.composite2dCtx;
    const sCtx = this.scratch2dCtx;
    if (!ctx || !sCtx) return;

    ctx.clearRect(0, 0, boardW, boardH);
    let baseItem: LayerCompositeItem | null = null;
    for (const item of items) {
      if (!item.clipping) baseItem = item;
      ctx.save();
      ctx.globalAlpha = item.opacity;
      if (item.blendMode !== 'normal') {
        ctx.globalCompositeOperation = item.blendMode;
      }
      if (item.clipping && baseItem) {
        sCtx.clearRect(0, 0, boardW, boardH);
        if (baseItem.resizeTransform) {
          const { from, to } = baseItem.resizeTransform;
          sCtx.drawImage(baseItem.canvas, from.x - baseItem.x, from.y - baseItem.y, from.width, from.height, to.x, to.y, to.width, to.height);
        } else {
          sCtx.drawImage(baseItem.canvas, baseItem.x, baseItem.y);
        }
        sCtx.globalCompositeOperation = 'source-in';
        if (item.resizeTransform) {
          const { from, to } = item.resizeTransform;
          sCtx.drawImage(item.canvas, from.x - item.x, from.y - item.y, from.width, from.height, to.x, to.y, to.width, to.height);
        } else {
          sCtx.drawImage(item.canvas, item.x, item.y);
        }
        sCtx.globalCompositeOperation = 'source-over';
        ctx.drawImage(this.scratch2dCanvas!, 0, 0);
      } else if (item.resizeTransform) {
        const { from, to } = item.resizeTransform;
        ctx.drawImage(item.canvas, from.x - item.x, from.y - item.y, from.width, from.height, to.x, to.y, to.width, to.height);
      } else {
        ctx.drawImage(item.canvas, item.x, item.y);
      }
      ctx.restore();
    }
  }

  /**
   * Stage B: Presents the already-composited board texture onto the screen viewport canvas.
   * Performs a single GPU quad draw call on pan, zoom, and mirror toggles.
   */
  present(viewport: BoardViewport, mirrorView: boolean): void {
    this.lastViewport = viewport;
    this.lastMirror = mirrorView;
    if (this.mode === 'webgl2' && this.glState && this.canvas) {
      const { gl, presProg, presLocs, outputTex, vao } = this.glState;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      gl.useProgram(presProg);

      const filter = viewport.zoom >= 2 ? gl.NEAREST : gl.LINEAR;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, outputTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

      const [r, g, b] = parseHexRgb(this.bgColor);
      gl.uniform1i(presLocs.u_compositeTex, 0);
      gl.uniform2f(presLocs.u_viewSize, this.cssWidth, this.cssHeight);
      gl.uniform2f(presLocs.u_boardSize, this.boardW, this.boardH);
      gl.uniform3f(presLocs.u_viewport, viewport.x, viewport.y, viewport.zoom);
      gl.uniform3f(presLocs.u_bgColor, r / 255, g / 255, b / 255);
      gl.uniform1f(presLocs.u_transparent, this.transparent ? 1 : 0);
      gl.uniform1f(presLocs.u_mirror, mirrorView ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }

    if (this.mode === 'canvas2d' && this.view2dCtx && this.canvas) {
      const ctx = this.view2dCtx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.scale(this.dpr, this.dpr);
      if (mirrorView) {
        ctx.translate(this.cssWidth, 0);
        ctx.scale(-1, 1);
      }

      const bx = viewport.x;
      const by = viewport.y;
      const bw = this.boardW * viewport.zoom;
      const bh = this.boardH * viewport.zoom;

      // Drop shadow + board paper fill
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = this.transparent ? '#f8fafc' : this.bgColor;
      ctx.fillRect(bx, by, bw, bh);
      ctx.restore();

      if (this.transparent) {
        const pattern = this.ensureCheckerPattern(ctx);
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fillRect(bx, by, bw, bh);
        }
      }

      if (this.composite2dCanvas) {
        ctx.save();
        ctx.imageSmoothingEnabled = viewport.zoom < 2;
        ctx.drawImage(this.composite2dCanvas, bx, by, bw, bh);
        ctx.restore();
      }

      ctx.strokeStyle = '#d1d5db';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.restore();
    }
  }

  private ensureCheckerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    if (this.checkerPattern) return this.checkerPattern;
    const tile = document.createElement('canvas');
    tile.width = 20;
    tile.height = 20;
    const tctx = tile.getContext('2d');
    if (!tctx) return null;
    tctx.fillStyle = '#f8fafc';
    tctx.fillRect(0, 0, 20, 20);
    tctx.fillStyle = '#e2e8f0';
    tctx.fillRect(0, 0, 10, 10);
    tctx.fillRect(10, 10, 10, 10);
    this.checkerPattern = ctx.createPattern(tile, 'repeat');
    return this.checkerPattern;
  }

  rePresent(): void {
    this.present(this.lastViewport, this.lastMirror);
  }

  drawLayerThumbnail(
    layerId: string,
    targetCanvas: HTMLCanvasElement,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    boardWidth: number,
    boardHeight: number,
  ): boolean {
    return this.rasterizer.drawLayerThumbnail(layerId, targetCanvas, layers, shapes, boardWidth, boardHeight);
  }

  getLayerPixelData(
    layerId: string,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    boardWidth: number,
    boardHeight: number,
  ): Uint8ClampedArray | null {
    return this.rasterizer.getLayerPixelData(layerId, layers, shapes, boardWidth, boardHeight);
  }

  getCompositePixelData(
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    boardWidth: number,
    boardHeight: number,
  ): Uint8ClampedArray | null {
    return this.rasterizer.getCompositePixelData(layers, shapes, boardWidth, boardHeight);
  }

  samplePatch(
    centerX: number,
    centerY: number,
    radius: number,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    draftsByLayer: ReadonlyMap<string, BoardShape[]>,
    movingLayer: BoardLayer | null,
    resizingPreview: { id: string; layer: BoardLayer; shapes: BoardShape[]; fromBounds: BoardBox; bounds: BoardBox } | null,
  ): { grid: string[]; centerHex: string; px: number; py: number } | null {
    return this.rasterizer.sampleCompositePatch(
      centerX,
      centerY,
      radius,
      layers,
      shapes,
      draftsByLayer,
      movingLayer,
      resizingPreview,
      this.boardW,
      this.boardH,
      this.bgColor,
      this.transparent,
    );
  }

  samplePixel(
    x: number,
    y: number,
    layers: readonly BoardLayer[],
    shapes: readonly BoardShape[],
    draftsByLayer: ReadonlyMap<string, BoardShape[]>,
    movingLayer: BoardLayer | null,
    resizingPreview: { id: string; layer: BoardLayer; shapes: BoardShape[]; fromBounds: BoardBox; bounds: BoardBox } | null,
  ): string | null {
    const patch = this.samplePatch(x, y, 0, layers, shapes, draftsByLayer, movingLayer, resizingPreview);
    return patch ? patch.centerHex : null;
  }

  private detachListeners(): void {
    if (this.canvas) {
      if (this.contextLostHandler) this.canvas.removeEventListener('webglcontextlost', this.contextLostHandler);
      if (this.contextRestoredHandler) this.canvas.removeEventListener('webglcontextrestored', this.contextRestoredHandler);
    }
    this.contextLostHandler = null;
    this.contextRestoredHandler = null;
  }

  private disposeGl(): void {
    const state = this.glState;
    if (!state) return;
    const { gl } = state;
    for (const entry of state.layerTextures.values()) {
      gl.deleteTexture(entry.tex);
    }
    state.layerTextures.clear();
    gl.deleteTexture(state.texA);
    gl.deleteTexture(state.texB);
    gl.deleteFramebuffer(state.fboA);
    gl.deleteFramebuffer(state.fboB);
    gl.deleteBuffer(state.vbo);
    gl.deleteVertexArray(state.vao);
    gl.deleteProgram(state.compProg);
    gl.deleteProgram(state.presProg);
    this.glState = null;
  }

  dispose(): void {
    this.detachListeners();
    this.disposeGl();
    this.canvas = null;
    this.view2dCtx = null;
    this.mode = 'none';
  }
}
