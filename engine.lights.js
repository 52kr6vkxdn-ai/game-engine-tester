/* ============================================================
   Zengine — engine.lights.js
   Advanced 2D Lighting System
   ============================================================ */

import { state } from './engine.state.js';

// ── Light type definitions ───────────────────────────────────
export const LIGHT_TYPES = {
    point:       { label: 'Point Light',       icon: '💡' },
    spot:        { label: 'Spot Light',         icon: '🔦' },
    directional: { label: 'Directional Light',  icon: '☀️' },
    area:        { label: 'Area Light',         icon: '▭'  },
};

// Shared shadow settings appended to lights that can cast shadows
function defaultShadowProps() {
    return {
        castShadows:    false,
        shadowStrength: 0.85,   // 0..1 darkness inside shadowed regions
        shadowSoftness: 8,      // px gaussian blur applied to shadow mask
        shadowSamples:  3,      // 1..6 — multi-sample for penumbra (soft edges)
        shadowSize:     14,     // light-source radius in px (larger = softer penumbra)
        shadowColor:    0x000000,
        shadowBias:     1.5,    // pushes ray origin out a bit to avoid self-shadow acne
    };
}

// Default properties per light type
export function defaultLightProps(type) {
    const base = {
        color:     0xFFFFFF,
        intensity: 1.0,
        enabled:   true,
    };
    switch (type) {
        case 'point':
            return { ...base, radius: 200, falloff: 2.0, ...defaultShadowProps() };
        case 'spot':
            return { ...base, radius: 250, angle: 45, falloff: 1.8, direction: 0, ...defaultShadowProps() };
        case 'directional':
            return { ...base, angle: 0, softness: 0.3 };
        case 'area':
            return { ...base, width: 150, height: 80, falloff: 1.5 };
        default:
            return base;
    }
}

// Ensure older loaded lights get the new shadow keys
function _ensureShadowDefaults(p) {
    if (!p) return;
    const def = defaultShadowProps();
    for (const k in def) if (p[k] === undefined) p[k] = def[k];
}

// ── Create a 2D Light object ─────────────────────────────────
export function createLight(type = 'point', x = 0, y = 0) {
    const { _uniqueLightName } = _nameUtils();

    const container = new PIXI.Container();
    container.x = x;
    container.y = y;
    container.isLight    = true;
    container.lightType  = type;
    container.label      = _uniqueLightName(LIGHT_TYPES[type]?.label || 'Light');
    container.lightProps = defaultLightProps(type);
    container.animations = [];
    container.activeAnimIndex = 0;
    container.unityZ = 0;

    // Build the editor helper gizmo (visible in editor, hidden in play)
    _buildLightHelper(container);

    // Attach standard gizmo handles for translate
    _attachTranslateGizmo(container);

    if (state._bindGizmoHandles) state._bindGizmoHandles(container);
    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);

    _makeLightSelectable(container);

    // Select it
    import('./engine.objects.js').then(m => m.selectObject(container));
    import('./engine.ui.js').then(m => { m.refreshHierarchy(); });

    return container;
}

// ── Build the visual helper shown in editor ──────────────────
export function _buildLightHelper(container) {
    // Remove old helper
    if (container._lightHelper) {
        container.removeChild(container._lightHelper);
        try { container._lightHelper.destroy(); } catch(_) {}
    }

    const g = new PIXI.Graphics();
    const p = container.lightProps;
    const col = p.color ?? 0xFFFFFF;
    const r = ((col >> 16) & 0xFF) / 255;
    const gv = ((col >> 8) & 0xFF) / 255;
    const b = (col & 0xFF) / 255;
    const hexCol = col;

    switch (container.lightType) {
        case 'point': {
            const rad = p.radius ?? 200;
            // Outer radius ring (dashed look via many segments)
            g.lineStyle(1, hexCol, 0.35);
            g.drawCircle(0, 0, rad);
            // Falloff gradient rings
            g.lineStyle(1, hexCol, 0.15);
            g.drawCircle(0, 0, rad * 0.66);
            g.lineStyle(1, hexCol, 0.08);
            g.drawCircle(0, 0, rad * 0.33);
            // Center cross + dot
            g.lineStyle(1.5, hexCol, 0.9);
            g.moveTo(-8, 0); g.lineTo(8, 0);
            g.moveTo(0, -8); g.lineTo(0, 8);
            g.lineStyle(0);
            g.beginFill(hexCol, 1); g.drawCircle(0, 0, 3); g.endFill();
            // Inner glow fill
            g.beginFill(hexCol, 0.07); g.drawCircle(0, 0, rad); g.endFill();
            break;
        }
        case 'spot': {
            const rad = p.radius ?? 250;
            const halfAngle = ((p.angle ?? 45) / 2) * Math.PI / 180;
            const dir = (p.direction ?? 0) * Math.PI / 180;
            const x1 = Math.cos(dir - halfAngle) * rad;
            const y1 = Math.sin(dir - halfAngle) * rad;
            const x2 = Math.cos(dir + halfAngle) * rad;
            const y2 = Math.sin(dir + halfAngle) * rad;
            // Cone outline
            g.lineStyle(1.5, hexCol, 0.7);
            g.moveTo(0, 0); g.lineTo(x1, y1);
            g.moveTo(0, 0); g.lineTo(x2, y2);
            // Arc
            g.lineStyle(1, hexCol, 0.5);
            g.arc(0, 0, rad, dir - halfAngle, dir + halfAngle);
            // Fill cone
            g.lineStyle(0);
            g.beginFill(hexCol, 0.08);
            g.moveTo(0, 0); g.lineTo(x1, y1);
            g.arc(0, 0, rad, dir - halfAngle, dir + halfAngle);
            g.lineTo(0, 0); g.endFill();
            // Center dot
            g.beginFill(hexCol, 1); g.drawCircle(0, 0, 4); g.endFill();
            // Direction tick
            g.lineStyle(2, hexCol, 0.9);
            g.moveTo(0, 0); g.lineTo(Math.cos(dir) * 20, Math.sin(dir) * 20);
            break;
        }
        case 'directional': {
            const angle = (p.angle ?? 0) * Math.PI / 180;
            const len = 80;
            // Multiple parallel rays
            for (let i = -2; i <= 2; i++) {
                const offX = Math.cos(angle + Math.PI/2) * i * 14;
                const offY = Math.sin(angle + Math.PI/2) * i * 14;
                const alpha = i === 0 ? 0.9 : 0.4 - Math.abs(i) * 0.1;
                g.lineStyle(i === 0 ? 2 : 1, hexCol, alpha);
                g.moveTo(offX, offY);
                g.lineTo(offX + Math.cos(angle) * len, offY + Math.sin(angle) * len);
                // Arrowhead
                if (i === 0) {
                    const ax = offX + Math.cos(angle) * len;
                    const ay = offY + Math.sin(angle) * len;
                    g.moveTo(ax - Math.cos(angle - 0.4) * 10, ay - Math.sin(angle - 0.4) * 10);
                    g.lineTo(ax, ay);
                    g.lineTo(ax - Math.cos(angle + 0.4) * 10, ay - Math.sin(angle + 0.4) * 10);
                }
            }
            // Sun center
            g.lineStyle(0);
            g.beginFill(hexCol, 1); g.drawCircle(0, 0, 8); g.endFill();
            g.beginFill(hexCol, 0.2); g.drawCircle(0, 0, 16); g.endFill();
            break;
        }
        case 'area': {
            const hw = (p.width ?? 150) / 2;
            const hh = (p.height ?? 80) / 2;
            // Filled rect
            g.lineStyle(0);
            g.beginFill(hexCol, 0.08); g.drawRoundedRect(-hw, -hh, hw*2, hh*2, 4); g.endFill();
            // Outline
            g.lineStyle(1.5, hexCol, 0.7);
            g.drawRoundedRect(-hw, -hh, hw*2, hh*2, 4);
            // Center cross
            g.lineStyle(1, hexCol, 0.5);
            g.moveTo(-hw, 0); g.lineTo(hw, 0);
            g.moveTo(0, -hh); g.lineTo(0, hh);
            // Center dot
            g.lineStyle(0);
            g.beginFill(hexCol, 1); g.drawCircle(0, 0, 3); g.endFill();
            // Rays downward from surface
            for (let i = -2; i <= 2; i++) {
                const rx = (hw * 0.4) * i / 2;
                g.lineStyle(1, hexCol, 0.3);
                g.moveTo(rx, hh); g.lineTo(rx, hh + 24);
            }
            break;
        }
    }

    container._lightHelper = g;
    container.addChildAt(g, 0);
}

// ── Translate-only gizmo for lights ─────────────────────────
function _attachTranslateGizmo(container) {
    const gizmoContainer = new PIXI.Container();
    container.addChild(gizmoContainer);
    container._gizmoContainer = gizmoContainer;

    const transX = _makeAxisLine(0xFF4F4B, 50, false); transX.cursor = 'ew-resize';
    const transY = _makeAxisLine(0x8FC93A, 50, true);  transY.cursor = 'ns-resize';
    const transCenter = _makeSquareHandle(0xFFFFFF, 0.4, 'move');
    const grpTranslate = new PIXI.Container();
    grpTranslate.addChild(transX, transY, transCenter);
    container._grpTranslate = grpTranslate;

    // Lights only have translate (rotation handled via lightProps.direction/angle)
    const grpRotate = new PIXI.Container(); grpRotate.visible = false;
    const grpScale  = new PIXI.Container(); grpScale.visible  = false;
    container._grpRotate = grpRotate;
    container._grpScale  = grpScale;

    gizmoContainer.addChild(grpTranslate, grpRotate, grpScale);
    container._gizmoHandles = {
        transX, transY, transCenter,
        scaleX: transX, scaleY: transY, scaleCenter: transCenter,
        rotRing: transCenter,
    };

    // Stop propagation on each handle so the container's broad pointerdown
    // doesn't fire simultaneously with a gizmo drag start.
    [transX, transY, transCenter].forEach(h => {
        h.on('pointerdown', e => e.stopPropagation());
    });

    container.cursor = 'pointer';
    grpTranslate.visible = true; // lights always show translate
}

function _makeLightSelectable(container) {
    container.eventMode = 'static';
    // Keep helper non-interactive so gizmo handles (which sit on top) receive events.
    // The container itself catches clicks that miss the gizmo handles.
    container._lightHelper.eventMode = 'none';

    container.on('pointerdown', (e) => {
        if (state.isPlaying) { e.stopPropagation(); return; }
        if (e.button !== 0) return;
        import('./engine.objects.js').then(m => m.selectObject(container));
        // Do NOT stopPropagation here — let the gizmo handles fire if hit
    });
}

// ── Show/hide helpers in play mode ──────────────────────────
export function setLightHelpersVisible(visible) {
    for (const obj of state.gameObjects) {
        if (!obj.isLight) continue;
        if (obj._lightHelper) obj._lightHelper.visible = visible;
        if (obj._gizmoContainer) obj._gizmoContainer.visible = visible && (obj === state.gameObject);
    }
}

// ============================================================
//  DYNAMIC 2D LIGHTING COMPOSITOR
//  - Builds an offscreen "darkness" RenderTexture filled with
//    ambient color, then ADD-blends each light's contribution
//    using cached gradient/cone/area textures. The result is
//    blitted over the scene with MULTIPLY → unlit areas darken,
//    lit areas reveal full color.
//  - A second additive "bloom" pass on top gives soft halos.
// ============================================================

const _lightTexCache = new Map();
let _lightingInited  = false;
let _lightingTickerFn = null;

// Editor ambient is brighter so the scene stays workable; play mode
// drops to a dramatic dark ambient so lights pop.
const AMBIENT_EDIT = 0x6e6e80;
const AMBIENT_PLAY = 0x0e0e1a;

// World-level lighting settings (overridable via the "World Lighting" panel)
export function getLightingSettings() {
    if (!state.lightingSettings) {
        state.lightingSettings = {
            enabled:        true,
            ambient:        0x162030,  // single ambient — same in editor + play
            darkness:       0.85,      // 0 = no darkening, 1 = pitch dark
            shadowMult:     1.0,    // multiplies all per-light shadow softness
            shadowQuality:  1.0,    // multiplier for samples (perf/quality)
        };
    }
    return state.lightingSettings;
}

// Helper: mix a colour toward black by `darkness` (0..1, 1 = full black)
function _applyDarkness(color, darkness) {
    const r = (color >> 16) & 0xFF;
    const g = (color >> 8)  & 0xFF;
    const b = (color)       & 0xFF;
    const k = 1 - Math.max(0, Math.min(1, darkness));
    const rr = (r * k) | 0, gg = (g * k) | 0, bb = (b * k) | 0;
    return (rr << 16) | (gg << 8) | bb;
}

export function initLighting() {
    if (_lightingInited || !state.app) return;
    const { app } = state;
    const w = Math.max(1, app.screen.width);
    const h = Math.max(1, app.screen.height);
    const res = app.renderer.resolution;

    state.lightingMaskRT     = PIXI.RenderTexture.create({ width: w, height: h, resolution: res });
    state.lightingMaskSprite = new PIXI.Sprite(state.lightingMaskRT);
    state.lightingMaskSprite.blendMode = PIXI.BLEND_MODES.MULTIPLY;
    state.lightingMaskSprite.eventMode = 'none';

    state.lightingGlowRT     = PIXI.RenderTexture.create({ width: w, height: h, resolution: res });
    state.lightingGlowSprite = new PIXI.Sprite(state.lightingGlowRT);
    state.lightingGlowSprite.blendMode = PIXI.BLEND_MODES.ADD;
    state.lightingGlowSprite.eventMode = 'none';

    // Sit on top of the scene container, below any future overlay UI
    app.stage.addChild(state.lightingMaskSprite);
    app.stage.addChild(state.lightingGlowSprite);

    state._lightingScratch = new PIXI.Container();

    _initGPULighting();

    _lightingTickerFn = _renderLightingFrame;
    app.ticker.add(_lightingTickerFn);

    app.renderer.on('resize', _onLightingResize);
    _lightingInited = true;
}

// ============================================================
//  GPU PIPELINE — FBM dynamic fog (full WebGL fragment shader)
// ============================================================
const FOG_FRAG = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform float uTime;
uniform vec3  uColor;
uniform float uDensity;
uniform float uScale;
uniform float uSpeed;
uniform float uVerticalFade;
uniform float uOctaves;       // 1..8 detail layers
uniform float uContrast;      // 0..3 sharpness of fog edges
uniform float uBrightness;    // multiplier on output color
uniform vec2  uWind;          // direction vector (scrolls FBM)
uniform float uDetail;        // mix of high-frequency noise (0..1)
uniform float uMaxAlpha;      // hard cap on opacity — guarantees sprites stay visible
float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0 - 2.0*f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p, float oct) {
    float v = 0.0, amp = 0.55;
    int N = int(clamp(oct, 1.0, 8.0));
    for (int i = 0; i < 8; i++) {
        if (i >= N) break;
        v += amp * vnoise(p);
        p = p * 2.05 + vec2(1.7, 9.2);
        amp *= 0.55;
    }
    return v;
}
void main() {
    vec2 uv = vTextureCoord;
    vec2 p = uv * uScale * 4.0;
    p += uWind * uTime * uSpeed;
    float n1 = fbm(p, uOctaves);
    float n2 = fbm(p * 0.5 - uWind * uTime * uSpeed * 0.6, uOctaves);
    float n  = mix(n1, n2, 0.5);
    // Detail layer (high freq) for billowing texture
    float det = vnoise(p * 6.0 + uWind * uTime * uSpeed * 1.4);
    n = mix(n, n * 0.6 + det * 0.4, clamp(uDetail, 0.0, 1.0));
    // Contrast — sharpen the noise into wisps
    float lo = 0.5 - 0.5 / max(uContrast, 0.001);
    float hi = 0.5 + 0.5 / max(uContrast, 0.001);
    n = smoothstep(clamp(lo, 0.0, 1.0), clamp(hi, 0.0, 1.0), n);
    float vFade = mix(1.0 - uVerticalFade, 1.0, uv.y);
    float a = clamp(n * uDensity * vFade, 0.0, 1.0);
    a = min(a, clamp(uMaxAlpha, 0.0, 1.0));
    gl_FragColor = vec4(uColor * uBrightness * a, a);
}`;

let _gpuInited = false;
let _fogSprite = null;
let _fogFilter = null;

function _initGPULighting() {
    if (_gpuInited || !state.app) return;
    const app = state.app;
    // Fog: fullscreen sprite + custom filter
    _fogSprite = new PIXI.Sprite(PIXI.Texture.WHITE);
    _fogSprite.eventMode = 'none';
    _fogSprite.tint = 0xFFFFFF;
    _fogSprite.alpha = 1;
    _fogSprite.blendMode = PIXI.BLEND_MODES.NORMAL;
    _fogSprite.width  = app.screen.width;
    _fogSprite.height = app.screen.height;
    _fogFilter = new PIXI.Filter(undefined, FOG_FRAG, {
        uTime: 0,
        uColor: new Float32Array([0.78, 0.83, 0.92]),
        uDensity: 0.45,
        uScale: 1.4,
        uSpeed: 0.06,
        uVerticalFade: 0.35,
        uOctaves: 5,
        uContrast: 1.0,
        uBrightness: 1.0,
        uWind: new Float32Array([1.0, 0.4]),
        uDetail: 0.25,
        uMaxAlpha: 0.55,        // sprites stay visible
    });
    _fogSprite.filters = [_fogFilter];
    _fogSprite.filterArea = new PIXI.Rectangle(0, 0, app.screen.width, app.screen.height);
    _fogSprite.visible = false;
    app.stage.addChild(_fogSprite);

    _gpuInited = true;
}

function _resizeGPU(w, h) {
    if (!_gpuInited) return;
    if (_fogSprite) {
        _fogSprite.width = w; _fogSprite.height = h;
        _fogSprite.filterArea = new PIXI.Rectangle(0, 0, w, h);
    }
}

function _onLightingResize() {
    const { app } = state;
    if (!state.lightingMaskRT) return;
    const w = Math.max(1, app.screen.width);
    const h = Math.max(1, app.screen.height);
    state.lightingMaskRT.resize(w, h);
    state.lightingGlowRT.resize(w, h);
    // Resize shadow canvas too
    if (state._shadowCanvas) {
        state._shadowCanvas.width  = w;
        state._shadowCanvas.height = h;
    }
    _resizeGPU(w, h);
}

// ── Shadow canvas (2D, CPU ray-cast) ──────────────────────────
function _ensureShadowCanvas() {
    if (state._shadowCanvas) return;
    const c = document.createElement('canvas');
    c.width  = Math.max(1, state.app.screen.width);
    c.height = Math.max(1, state.app.screen.height);
    state._shadowCanvas = c;
    state._shadowCtx    = c.getContext('2d');
    // PIXI texture that wraps the canvas — updated each frame
    state._shadowTex    = PIXI.Texture.from(c);
    state._shadowSprite = new PIXI.Sprite(state._shadowTex);
    state._shadowSprite.blendMode = PIXI.BLEND_MODES.MULTIPLY;
    state._shadowSprite.eventMode = 'none';
    // Insert between the mask and glow sprites
    const idx = state.app.stage.children.indexOf(state.lightingGlowSprite);
    state.app.stage.addChildAt(state._shadowSprite, idx);
}

// ── Collect occluder AABBs in screen space ────────────────────
function _aabbToOccluder(b) {
    return {
        x: b.x, y: b.y, w: b.width, h: b.height,
        corners: [
            { x: b.x,           y: b.y },
            { x: b.x + b.width, y: b.y },
            { x: b.x + b.width, y: b.y + b.height },
            { x: b.x,           y: b.y + b.height },
        ],
        segments: [
            [{ x: b.x,           y: b.y },           { x: b.x + b.width, y: b.y }],
            [{ x: b.x + b.width, y: b.y },           { x: b.x + b.width, y: b.y + b.height }],
            [{ x: b.x + b.width, y: b.y + b.height },{ x: b.x,           y: b.y + b.height }],
            [{ x: b.x,           y: b.y + b.height },{ x: b.x,           y: b.y }],
        ],
    };
}

function _getOccluders() {
    const occluders = [];
    for (const obj of state.gameObjects) {
        if (obj.isLight) continue;
        if (obj.lightProps?.castsShadow === false) continue;

        // Per-tile occluders for tilemaps — each non-empty cell becomes its own AABB
        if (obj.isTilemap && obj.tilemapData) {
            const d = obj.tilemapData;
            const tw = d.tileW, th = d.tileH;
            // Convert tile-local rect (0,0,tw,th) to screen via container transform
            const topLeft = obj.toGlobal(new PIXI.Point(0, 0));
            const sx = obj.scale?.x ?? 1;
            const sy = obj.scale?.y ?? 1;
            const cam = state.sceneContainer.scale.x;
            const screenTW = tw * sx * cam;
            const screenTH = th * sy * cam;
            // Quick reject: if a tilemap has thousands of tiles, only emit
            // those whose screen position is on-screen + a margin
            const sw = state.app.screen.width;
            const sh = state.app.screen.height;
            const margin = 256;
            for (let r = 0; r < d.rows; r++) {
                for (let c = 0; c < d.cols; c++) {
                    const idx = r * d.cols + c;
                    if (d.tiles[idx] < 0) continue;
                    const x = topLeft.x + c * screenTW;
                    const y = topLeft.y + r * screenTH;
                    if (x + screenTW < -margin || x > sw + margin ||
                        y + screenTH < -margin || y > sh + margin) continue;
                    occluders.push(_aabbToOccluder({
                        x, y, width: screenTW, height: screenTH,
                    }));
                }
            }
            continue;
        }

        if (!obj.isImage) continue;
        try {
            const b = obj.getBounds();
            if (b.width < 2 || b.height < 2) continue;
            occluders.push(_aabbToOccluder(b));
        } catch (_) {}
    }
    return occluders;
}

// ── Ray-segment intersection (returns t along ray, or Infinity) ─
function _raySegIntersect(ox, oy, dx, dy, ax, ay, bx, by) {
    const r_dx = dx, r_dy = dy;
    const s_dx = bx - ax, s_dy = by - ay;
    const denom = r_dx * s_dy - r_dy * s_dx;
    if (Math.abs(denom) < 1e-10) return Infinity;
    const t = ((ax - ox) * s_dy - (ay - oy) * s_dx) / denom;
    const u = ((ax - ox) * r_dy - (ay - oy) * r_dx) / denom;
    if (t >= 0 && u >= 0 && u <= 1) return t;
    return Infinity;
}

// ── Build visibility polygon for one light ────────────────────
function _buildVisibilityPolygon(lx, ly, radius, occluders, screenW, screenH) {
    // Boundary segments (screen edges, slightly padded)
    const pad = 2;
    const boundary = [
        [{ x: -pad,     y: -pad      }, { x: screenW+pad, y: -pad       }],
        [{ x: screenW+pad,y: -pad    }, { x: screenW+pad,  y: screenH+pad}],
        [{ x: screenW+pad,y:screenH+pad},{ x: -pad,        y: screenH+pad}],
        [{ x: -pad,     y:screenH+pad}, { x: -pad,         y: -pad       }],
    ];

    const allSegs = [
        ...boundary,
        ...occluders.flatMap(o => o.segments),
    ];

    // Unique angles to cast rays toward — occluder corners + tiny offsets
    const angles = new Set();
    const boundaryCorners = [
        { x: -pad, y: -pad }, { x: screenW+pad, y: -pad },
        { x: screenW+pad, y: screenH+pad }, { x: -pad, y: screenH+pad },
    ];
    const allCorners = [
        ...boundaryCorners,
        ...occluders.flatMap(o => o.corners),
    ];

    for (const c of allCorners) {
        const a = Math.atan2(c.y - ly, c.x - lx);
        angles.add(a - 0.0001);
        angles.add(a);
        angles.add(a + 0.0001);
    }

    // Cast each ray, find closest intersection
    const hits = [];
    for (const angle of angles) {
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);

        let minT = Infinity;
        for (const seg of allSegs) {
            const t = _raySegIntersect(lx, ly, dx, dy, seg[0].x, seg[0].y, seg[1].x, seg[1].y);
            if (t < minT) minT = t;
        }
        if (minT === Infinity) minT = radius * 2;
        // Clamp to radius
        const clampedT = Math.min(minT, radius);
        hits.push({ angle, x: lx + dx * clampedT, y: ly + dy * clampedT });
    }

    // Sort by angle
    hits.sort((a, b) => a.angle - b.angle);
    return hits;
}

// ── Lazy scratch canvas used per-light to allow tinted shadows ──
function _ensureShadowScratch(w, h) {
    if (!state._shadowScratch || state._shadowScratch.width !== w || state._shadowScratch.height !== h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        state._shadowScratch = c;
        state._shadowScratchCtx = c.getContext('2d');
    }
    return state._shadowScratchCtx;
}

// ── Draw shadow layer for one frame ──────────────────────────
function _renderShadowFrame(lights, occluders) {
    _ensureShadowCanvas();
    const c   = state._shadowCanvas;
    const ctx = state._shadowCtx;
    const w   = c.width;
    const h   = c.height;
    const cfg = getLightingSettings();

    // Start fully lit (white = no darkening in MULTIPLY)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const shadowCasters = lights.filter(L => {
        const p = L.lightProps;
        if (!p?.enabled || !p.castShadows) return false;
        return L.lightType === 'point' || L.lightType === 'spot';
    });

    if (!shadowCasters.length) {
        state._shadowSprite.visible = false;
        state._shadowTex.update();
        return;
    }
    state._shadowSprite.visible = true;

    const scratchCtx = _ensureShadowScratch(w, h);

    for (const L of shadowCasters) {
        const p   = L.lightProps;
        _ensureShadowDefaults(p);
        const pos = state.sceneContainer.toGlobal(new PIXI.Point(L.x, L.y));
        const lx  = pos.x, ly = pos.y;
        const camScale = state.sceneContainer.scale.x;

        // Effective shadow zone radius
        const radius = (p.radius ?? 200) * camScale;
        if (radius < 4) continue;

        // Penumbra: multi-sample around the light origin within shadowSize
        const samples = Math.max(1, Math.min(8,
            Math.round((p.shadowSamples ?? 3) * (cfg.shadowQuality ?? 1))
        ));
        const sourceR = Math.max(0, (p.shadowSize ?? 14) * camScale);
        const strength = Math.max(0, Math.min(1, p.shadowStrength ?? 0.85));
        const blurPx   = Math.max(0, (p.shadowSoftness ?? 8) * (cfg.shadowMult ?? 1));
        const sCol     = p.shadowColor ?? 0x000000;
        const sR = (sCol >> 16) & 0xFF;
        const sG = (sCol >> 8)  & 0xFF;
        const sB = (sCol)       & 0xFF;
        const colCss = `rgb(${sR},${sG},${sB})`;
        const bias   = p.shadowBias ?? 1.5;

        // Render this light's shadow into the scratch canvas, then blur,
        // then composite over the main shadow canvas with MULTIPLY.
        scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
        scratchCtx.globalCompositeOperation = 'source-over';
        scratchCtx.globalAlpha = 1;
        scratchCtx.filter = 'none';
        scratchCtx.clearRect(0, 0, w, h);

        // 1) Paint the falloff "shadow zone" (gradient toward dark at center→edge)
        const grd = scratchCtx.createRadialGradient(lx, ly, 0, lx, ly, radius);
        grd.addColorStop(0,   `rgba(${sR},${sG},${sB},${strength})`);
        grd.addColorStop(0.6, `rgba(${sR},${sG},${sB},${strength * 0.78})`);
        grd.addColorStop(1,   `rgba(${sR},${sG},${sB},0)`);

        // For spot — only darken inside the cone (keeps shadows directional)
        let coneClip = null;
        if (L.lightType === 'spot') {
            const halfAng = ((p.angle ?? 45) / 2) * Math.PI / 180;
            const dirAng  = ((p.direction ?? 0)) * Math.PI / 180;
            coneClip = { dir: dirAng, half: halfAng, len: radius };
        }

        scratchCtx.save();
        if (coneClip) {
            scratchCtx.beginPath();
            scratchCtx.moveTo(lx, ly);
            scratchCtx.arc(lx, ly, coneClip.len,
                coneClip.dir - coneClip.half, coneClip.dir + coneClip.half);
            scratchCtx.closePath();
            scratchCtx.clip();
        }
        scratchCtx.beginPath();
        scratchCtx.arc(lx, ly, radius, 0, Math.PI * 2);
        scratchCtx.fillStyle = grd;
        scratchCtx.fill();

        // 2) Cut out the lit (visibility) area — averaged across N origin samples
        scratchCtx.globalCompositeOperation = 'destination-out';
        const perSampleAlpha = 1 / samples;

        for (let i = 0; i < samples; i++) {
            // Place sample on a small ring around the light center
            const angle = (i / samples) * Math.PI * 2;
            const ox = lx + Math.cos(angle) * sourceR;
            const oy = ly + Math.sin(angle) * sourceR;

            // Push origin slightly away from any nearby occluder edge to avoid acne
            const poly = _buildVisibilityPolygon(ox, oy, radius + bias, occluders, w, h);
            if (poly.length < 3) continue;

            scratchCtx.globalAlpha = perSampleAlpha;
            scratchCtx.beginPath();
            scratchCtx.moveTo(poly[0].x, poly[0].y);
            for (let k = 1; k < poly.length; k++) scratchCtx.lineTo(poly[k].x, poly[k].y);
            scratchCtx.closePath();
            scratchCtx.fill();
        }
        scratchCtx.restore();

        // 3) Blur the result for a soft penumbra & blit to main shadow canvas
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 1;
        if (blurPx > 0.1) ctx.filter = `blur(${blurPx}px)`;
        else ctx.filter = 'none';
        // First fill the area outside the shadow zone with pure white so MULTIPLY
        // leaves it untouched — already done by default canvas (white background).
        ctx.drawImage(state._shadowScratch, 0, 0);
        ctx.restore();
    }

    // Push updated pixels to PIXI texture
    state._shadowTex.update();
}

function _renderLightingFrame() {
    if (!_lightingInited) return;
    const { app, sceneContainer } = state;
    if (!sceneContainer) return;

    const lights = state.gameObjects.filter(o => o.isLight && o.lightProps?.enabled);

    if (!lights.length) {
        state.lightingMaskSprite.visible = false;
        state.lightingGlowSprite.visible = false;
        if (state._shadowSprite) state._shadowSprite.visible = false;
        return;
    }
    state.lightingMaskSprite.visible = true;
    state.lightingGlowSprite.visible = true;

    const scratch = state._lightingScratch;
    scratch.removeChildren();

    // ── Pass 1: darkness mask (MULTIPLY) ──────────────────
    const cfg = getLightingSettings();
    if (!cfg.enabled) {
        state.lightingMaskSprite.visible = false;
        state.lightingGlowSprite.visible = false;
        if (state._shadowSprite) state._shadowSprite.visible = false;
        return;
    }
    const baseColor = cfg.ambient;
    const darkness  = cfg.darkness;
    const ambient   = _applyDarkness(baseColor, darkness);
    const base = new PIXI.Sprite(PIXI.Texture.WHITE);
    base.tint = ambient;
    base.width  = app.screen.width;
    base.height = app.screen.height;
    scratch.addChild(base);

    for (const L of lights) {
        const s = _buildLightContribution(L, false);
        if (s) scratch.addChild(s);
    }
    app.renderer.render(scratch, { renderTexture: state.lightingMaskRT, clear: true });

    // ── Pass 2: bloom/glow (ADD) ──────────────────────────
    scratch.removeChildren();
    for (const L of lights) {
        const s = _buildLightContribution(L, true);
        if (s) scratch.addChild(s);
    }
    app.renderer.render(scratch, { renderTexture: state.lightingGlowRT, clear: true });

    // ── Pass 3: shadows (MULTIPLY canvas overlay) ─────────
    const occluders = _getOccluders();
    _renderShadowFrame(lights, occluders);

    // ── Pass 4: GPU dynamic fog ──────────────────────────
    _renderFog();
}

// (removed) GPU god-ray pass
// ── GPU FBM fog ─────────────────────────────────────────────
// Fog is on iff at least one isFog GameObject exists in the scene.
// Deleting the Fog object instantly hides the fog sprite next frame.
function _renderFog() {
    if (!_gpuInited || !_fogSprite || !_fogFilter) return;
    const fogObj = state.gameObjects.find(o => o?.isFog && o.fogProps?.enabled !== false);
    if (!fogObj) { _fogSprite.visible = false; return; }
    const fp  = fogObj.fogProps || {};
    const cfg = getLightingSettings();
    _fogSprite.visible = true;
    const u = _fogFilter.uniforms;
    u.uTime = performance.now() / 1000;
    u.uDensity      = fp.density      ?? 0.45;
    u.uScale        = fp.scale        ?? 1.4;
    u.uSpeed        = fp.speed        ?? 0.06;
    u.uVerticalFade = fp.verticalFade ?? 0.35;
    u.uOctaves      = fp.octaves      ?? 5;
    u.uContrast     = fp.contrast     ?? 1.0;
    u.uBrightness   = fp.brightness   ?? 1.0;
    u.uDetail       = fp.detail       ?? 0.25;
    // Hard cap on opacity so sprites stay clearly visible
    u.uMaxAlpha     = Math.min(0.92, fp.maxAlpha ?? 0.55);
    const ang = ((fp.windAngle ?? 25) * Math.PI) / 180;
    u.uWind[0] = Math.cos(ang);
    u.uWind[1] = Math.sin(ang);
    const c = fp.color ?? 0xC8D4E8;
    u.uColor[0] = ((c >> 16) & 0xFF) / 255;
    u.uColor[1] = ((c >> 8)  & 0xFF) / 255;
    u.uColor[2] = ( c        & 0xFF) / 255;
}

function _buildLightContribution(L, forGlow) {
    const p = L.lightProps;
    if (!p) return null;
    const camScale = state.sceneContainer.scale.x;

    // Scene-local → screen position
    const pos = state.sceneContainer.toGlobal(new PIXI.Point(L.x, L.y));

    // Glow contribution is softer and slightly tinted-up
    const intensityMul = forGlow ? 0.45 : 1.0;
    const baseIntensity = (p.intensity ?? 1) * intensityMul;

    if (L.lightType === 'directional') {
        // A directional/sun light tints everything additively.
        // We bias the tint toward the light direction with a soft gradient.
        const tex = _getDirectionalTexture(p.softness ?? 0.3);
        const s = new PIXI.Sprite(tex);
        s.anchor.set(0.5);
        s.width  = state.app.screen.width  * 1.5;
        s.height = state.app.screen.height * 1.5;
        s.x = state.app.screen.width  / 2;
        s.y = state.app.screen.height / 2;
        s.rotation = ((p.angle ?? 0) * Math.PI) / 180;
        s.tint = p.color ?? 0xFFFFFF;
        s.blendMode = PIXI.BLEND_MODES.ADD;
        s.alpha = Math.min(1.0, baseIntensity * 0.6);
        return s;
    }

    let tex, w, h, rotation = 0;
    if (L.lightType === 'point') {
        tex = _getPointTexture(p.falloff ?? 2);
        const r = (p.radius ?? 200) * camScale * 2;
        w = h = r;
    } else if (L.lightType === 'spot') {
        tex = _getSpotTexture(p.angle ?? 45, p.falloff ?? 1.8);
        const r = (p.radius ?? 250) * camScale * 2;
        w = h = r;
        rotation = ((p.direction ?? 0) * Math.PI) / 180;
    } else if (L.lightType === 'area') {
        tex = _getAreaTexture(p.falloff ?? 1.5);
        // Soft texture is square; stretch to width/height with a bit of bleed
        w = (p.width  ?? 150) * camScale * 1.8;
        h = (p.height ?? 80)  * camScale * 1.8;
    } else {
        return null;
    }

    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5);
    s.x = pos.x;
    s.y = pos.y;
    s.width  = w;
    s.height = h;
    s.rotation = rotation;
    s.tint = p.color ?? 0xFFFFFF;
    s.blendMode = PIXI.BLEND_MODES.ADD;
    s.alpha = Math.min(2.0, baseIntensity);
    return s;
}

// Cached gradient textures ────────────────────────────────────
function _getPointTexture(falloff) {
    const key = `point:${Math.round(falloff * 10)}`;
    if (_lightTexCache.has(key)) return _lightTexCache.get(key);
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - cx) / cx, dy = (y - cy) / cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            const t = Math.max(0, 1 - d);
            const a = Math.pow(t, falloff);
            const i = (y * size + x) * 4;
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = (a * 255) | 0;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(c);
    _lightTexCache.set(key, tex);
    return tex;
}

function _getSpotTexture(angleDeg, falloff) {
    const key = `spot:${Math.round(angleDeg)}:${Math.round(falloff * 10)}`;
    if (_lightTexCache.has(key)) return _lightTexCache.get(key);
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const halfRad = (angleDeg / 2) * Math.PI / 180;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - cx) / cx, dy = (y - cy) / cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            let a = 0;
            if (d <= 1 && (dx !== 0 || dy !== 0)) {
                // Cone axis points along +X (rotation handled by sprite)
                const ang = Math.atan2(dy, dx);
                const aa = Math.abs(ang);
                const angT = 1 - Math.min(1, aa / halfRad);
                // Soft edge on the cone sides
                const angSoft = Math.pow(Math.max(0, angT), 1.3);
                const radSoft = Math.pow(1 - d, falloff);
                a = angSoft * radSoft;
            }
            const i = (y * size + x) * 4;
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = (Math.min(1, a) * 255) | 0;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(c);
    _lightTexCache.set(key, tex);
    return tex;
}

function _getAreaTexture(falloff) {
    const key = `area:${Math.round(falloff * 10)}`;
    if (_lightTexCache.has(key)) return _lightTexCache.get(key);
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const half = size / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // Squared distance from edge — gives a soft rectangle with rounded corners
            const fx = Math.max(0, Math.abs(x - half) / half);
            const fy = Math.max(0, Math.abs(y - half) / half);
            const d  = Math.sqrt(fx * fx + fy * fy) * 0.85 + Math.max(fx, fy) * 0.15;
            const a  = Math.pow(Math.max(0, 1 - d), falloff);
            const i  = (y * size + x) * 4;
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = (Math.min(1, a) * 255) | 0;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(c);
    _lightTexCache.set(key, tex);
    return tex;
}


function _getDirectionalTexture(softness) {
    const key = `dir:${Math.round(softness * 100)}`;
    if (_lightTexCache.has(key)) return _lightTexCache.get(key);
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    // Gradient that brightens toward +X side, softness widens the bright band
    const sharpness = 1 + (1 - Math.min(1, Math.max(0, softness))) * 4;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const tx = x / (size - 1);     // 0 (left/back) → 1 (right/front)
            const a  = Math.pow(tx, sharpness);
            const i  = (y * size + x) * 4;
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = (Math.min(1, a) * 255) | 0;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(c);
    _lightTexCache.set(key, tex);
    return tex;
}

// Legacy entry point — kept for older callers
export function applyLighting() { initLighting(); }

// ── Inspector HTML for a light object ───────────────────────
function _shadowBlockHTML(p) {
    const sCol = '#' + ((p.shadowColor ?? 0) >>> 0).toString(16).padStart(6, '0').slice(-6);
    return `
    <div class="shadow-sub" style="margin-top:6px;border-top:1px solid #2a2a36;padding-top:6px;">
        <div class="prop-row">
            <span class="prop-label" style="color:#bb9;">Cast Shadows</span>
            <input type="checkbox" id="li-cast-shadows" ${p.castShadows ? 'checked' : ''} style="accent-color:#facc15;width:14px;height:14px;">
        </div>
        <div id="li-shadow-controls" style="${p.castShadows ? '' : 'opacity:.45;pointer-events:none;'}">
            <div class="prop-row">
                <span class="prop-label">Strength</span>
                <input type="range" id="li-sh-strength" min="0" max="1" step="0.01" value="${p.shadowStrength ?? 0.85}" class="light-slider">
                <span id="li-sh-strength-val" class="prop-val">${(p.shadowStrength ?? 0.85).toFixed(2)}</span>
            </div>
            <div class="prop-row">
                <span class="prop-label">Softness</span>
                <input type="range" id="li-sh-softness" min="0" max="40" step="0.5" value="${p.shadowSoftness ?? 8}" class="light-slider">
                <span id="li-sh-softness-val" class="prop-val">${(p.shadowSoftness ?? 8).toFixed(1)}px</span>
            </div>
            <div class="prop-row">
                <span class="prop-label">Penumbra</span>
                <input type="range" id="li-sh-samples" min="1" max="6" step="1" value="${p.shadowSamples ?? 3}" class="light-slider">
                <span id="li-sh-samples-val" class="prop-val">${p.shadowSamples ?? 3}</span>
            </div>
            <div class="prop-row">
                <span class="prop-label">Source Size</span>
                <input type="range" id="li-sh-size" min="0" max="60" step="0.5" value="${p.shadowSize ?? 14}" class="light-slider">
                <span id="li-sh-size-val" class="prop-val">${(p.shadowSize ?? 14).toFixed(1)}px</span>
            </div>
            <div class="prop-row">
                <span class="prop-label">Bias</span>
                <input type="range" id="li-sh-bias" min="0" max="10" step="0.1" value="${p.shadowBias ?? 1.5}" class="light-slider">
                <span id="li-sh-bias-val" class="prop-val">${(p.shadowBias ?? 1.5).toFixed(1)}</span>
            </div>
            <div class="prop-row">
                <span class="prop-label">Color</span>
                <input type="color" id="li-sh-color" value="${sCol}">
            </div>
        </div>
    </div>`;
}

export function buildLightInspectorHTML(obj) {
    if (!obj?.isLight) return '';
    const p = obj.lightProps;
    _ensureShadowDefaults(p);
    const type = obj.lightType;

    const hexColor = '#' + (p.color >>> 0).toString(16).padStart(6, '0').slice(-6);

    let typeSpecific = '';
    if (type === 'point') {
        typeSpecific = `
        <div class="prop-row">
            <span class="prop-label">Radius</span>
            <input type="range" id="li-radius" min="10" max="800" step="5" value="${p.radius}" class="light-slider">
            <span id="li-radius-val" class="prop-val">${p.radius}px</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Falloff</span>
            <input type="range" id="li-falloff" min="0.5" max="5" step="0.1" value="${p.falloff}" class="light-slider">
            <span id="li-falloff-val" class="prop-val">${p.falloff.toFixed(1)}</span>
        </div>
        ${_shadowBlockHTML(p)}`;
    } else if (type === 'spot') {
        typeSpecific = `
        <div class="prop-row">
            <span class="prop-label">Radius</span>
            <input type="range" id="li-radius" min="20" max="800" step="5" value="${p.radius}" class="light-slider">
            <span id="li-radius-val" class="prop-val">${p.radius}px</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Angle</span>
            <input type="range" id="li-angle" min="5" max="170" step="1" value="${p.angle}" class="light-slider">
            <span id="li-angle-val" class="prop-val">${p.angle}°</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Direction</span>
            <input type="range" id="li-direction" min="0" max="360" step="1" value="${p.direction}" class="light-slider">
            <span id="li-direction-val" class="prop-val">${p.direction}°</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Falloff</span>
            <input type="range" id="li-falloff" min="0.5" max="5" step="0.1" value="${p.falloff}" class="light-slider">
            <span id="li-falloff-val" class="prop-val">${p.falloff.toFixed(1)}</span>
        </div>
        ${_shadowBlockHTML(p)}`;
    } else if (type === 'directional') {
        typeSpecific = `
        <div class="prop-row">
            <span class="prop-label">Angle</span>
            <input type="range" id="li-angle" min="0" max="360" step="1" value="${p.angle}" class="light-slider">
            <span id="li-angle-val" class="prop-val">${p.angle}°</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Softness</span>
            <input type="range" id="li-softness" min="0" max="1" step="0.05" value="${p.softness}" class="light-slider">
            <span id="li-softness-val" class="prop-val">${p.softness.toFixed(2)}</span>
        </div>`;
    } else if (type === 'area') {
        typeSpecific = `
        <div class="prop-row">
            <span class="prop-label">Width</span>
            <input type="range" id="li-width" min="20" max="600" step="5" value="${p.width}" class="light-slider">
            <span id="li-width-val" class="prop-val">${p.width}px</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Height</span>
            <input type="range" id="li-height" min="20" max="400" step="5" value="${p.height}" class="light-slider">
            <span id="li-height-val" class="prop-val">${p.height}px</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Falloff</span>
            <input type="range" id="li-falloff" min="0.5" max="5" step="0.1" value="${p.falloff}" class="light-slider">
            <span id="li-falloff-val" class="prop-val">${p.falloff.toFixed(1)}</span>
        </div>`;
    }

    return `
    <div class="component-block" id="inspector-light-section">
        <div class="component-header">
            <div class="flex items-center gap-2">
                <input type="checkbox" id="li-enabled" ${p.enabled ? 'checked' : ''} style="accent-color:#facc15;">
                <svg viewBox="0 0 24 24" class="icon-stroke" style="color:#facc15;"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                <span style="font-weight:600; color:#facc15;">${LIGHT_TYPES[type]?.label || 'Light'}</span>
            </div>
        </div>
        <div class="component-body">
            <div class="prop-row">
                <span class="prop-label">Color</span>
                <input type="color" id="li-color" value="${hexColor}">
            </div>
            <div class="prop-row">
                <span class="prop-label">Intensity</span>
                <input type="range" id="li-intensity" min="0" max="3" step="0.05" value="${p.intensity}" class="light-slider">
                <span id="li-intensity-val" class="prop-val">${p.intensity.toFixed(2)}</span>
            </div>
            ${typeSpecific}
        </div>
    </div>`;
}

// ── Bind light inspector events ──────────────────────────────
export function bindLightInspector(obj) {
    if (!obj?.isLight) return;
    const p = obj.lightProps;

    const bind = (id, prop, parse, fmtId, fmt) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            p[prop] = parse(el.value);
            const valEl = document.getElementById(fmtId);
            if (valEl) valEl.textContent = fmt(p[prop]);
            _buildLightHelper(obj);
        });
    };

    const col = document.getElementById('li-color');
    if (col) col.addEventListener('input', () => {
        p.color = parseInt(col.value.replace('#', ''), 16);
        _buildLightHelper(obj);
    });

    const en = document.getElementById('li-enabled');
    if (en) en.addEventListener('change', () => {
        p.enabled = en.checked;
        if (obj._lightHelper) obj._lightHelper.alpha = p.enabled ? 1 : 0.3;
    });

    const cs = document.getElementById('li-cast-shadows');
    if (cs) cs.addEventListener('change', () => {
        p.castShadows = cs.checked;
        const wrap = document.getElementById('li-shadow-controls');
        if (wrap) wrap.style.cssText = p.castShadows ? '' : 'opacity:.45;pointer-events:none;';
    });

    const shCol = document.getElementById('li-sh-color');
    if (shCol) shCol.addEventListener('input', () => {
        p.shadowColor = parseInt(shCol.value.replace('#', ''), 16);
    });

    const anim = document.getElementById('li-animate');
    if (anim) anim.addEventListener('change', () => { p.animate = anim.checked; });

    bind('li-intensity', 'intensity', parseFloat, 'li-intensity-val', v => v.toFixed(2));
    bind('li-radius',    'radius',    parseFloat, 'li-radius-val',    v => v + 'px');
    bind('li-angle',     'angle',     parseFloat, 'li-angle-val',     v => v + '°');
    bind('li-direction', 'direction', parseFloat, 'li-direction-val', v => v + '°');
    bind('li-falloff',   'falloff',   parseFloat, 'li-falloff-val',   v => v.toFixed(1));
    bind('li-softness',  'softness',  parseFloat, 'li-softness-val',  v => v.toFixed(2));
    bind('li-width',     'width',     parseFloat, 'li-width-val',     v => v + 'px');
    bind('li-height',    'height',    parseFloat, 'li-height-val',    v => v + 'px');
    // Shadow advanced
    bind('li-sh-strength', 'shadowStrength', parseFloat, 'li-sh-strength-val', v => v.toFixed(2));
    bind('li-sh-softness', 'shadowSoftness', parseFloat, 'li-sh-softness-val', v => v.toFixed(1) + 'px');
    bind('li-sh-samples',  'shadowSamples',  v => parseInt(v, 10), 'li-sh-samples-val', v => String(v));
    bind('li-sh-size',     'shadowSize',     parseFloat, 'li-sh-size-val',     v => v.toFixed(1) + 'px');
    bind('li-sh-bias',     'shadowBias',     parseFloat, 'li-sh-bias-val',     v => v.toFixed(1));
}

// ============================================================
//  WORLD LIGHTING PANEL  (global ambient + global shadow)
// ============================================================
export function buildWorldLightingHTML() {
    const cfg = getLightingSettings();
    const toHex = c => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
    return `
    <div class="component-block" id="world-lighting-block">
        <div class="component-header">
            <input type="checkbox" id="wl-enabled" ${cfg.enabled ? 'checked' : ''} style="accent-color:#facc15;">
            <svg viewBox="0 0 24 24" class="comp-icon" style="color:#facc15;"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1l2.1-2.1M17 7l2.1-2.1"/></svg>
            <span style="font-weight:600; color:#facc15;">World Lighting</span>
        </div>
        <div class="component-body">
            <div class="prop-row"><span class="prop-label">Ambient</span>
                <input type="color" id="wl-amb-color" value="${toHex(cfg.ambient)}"></div>
            <div class="prop-row"><span class="prop-label">Darkness</span>
                <input type="range" id="wl-darkness" min="0" max="1" step="0.01" value="${cfg.darkness}" class="light-slider">
                <span id="wl-darkness-val" class="prop-val">${cfg.darkness.toFixed(2)}</span></div>
            <div class="prop-row"><span class="prop-label">Shadow Softness ×</span>
                <input type="range" id="wl-shmult" min="0" max="3" step="0.05" value="${cfg.shadowMult}" class="light-slider">
                <span id="wl-shmult-val" class="prop-val">${cfg.shadowMult.toFixed(2)}</span></div>
            <div class="prop-row"><span class="prop-label">Shadow Quality</span>
                <input type="range" id="wl-shq" min="0.5" max="2" step="0.05" value="${cfg.shadowQuality}" class="light-slider">
                <span id="wl-shq-val" class="prop-val">${cfg.shadowQuality.toFixed(2)}</span></div>
        </div>
    </div>

    `;
}

export function bindWorldLighting() {
    const cfg = getLightingSettings();
    const en = document.getElementById('wl-enabled');
    if (en) en.addEventListener('change', () => { cfg.enabled = en.checked; });
    const ac = document.getElementById('wl-amb-color');
    if (ac) ac.addEventListener('input', () => { cfg.ambient = parseInt(ac.value.replace('#',''), 16); });
    const wireRange = (id, prop, valId, fmt) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            cfg[prop] = parseFloat(el.value);
            const v = document.getElementById(valId);
            if (v) v.textContent = fmt(cfg[prop]);
        });
    };
    wireRange('wl-darkness',  'darkness',     'wl-darkness-val',  v => v.toFixed(2));
    wireRange('wl-shmult',    'shadowMult',   'wl-shmult-val',    v => v.toFixed(2));
    wireRange('wl-shq',       'shadowQuality','wl-shq-val',       v => v.toFixed(2));
}

// ── Snapshot helpers ─────────────────────────────────────────
// ============================================================
//  Fog GameObject — addable / removable like a Light
// ============================================================
export function defaultFogProps() {
    return {
        enabled: true,
        color:        0xC8D4E8,
        density:      0.45,
        scale:        1.4,
        speed:        0.06,
        verticalFade: 0.35,
        octaves:      5,    // FBM detail layers (1..8)
        contrast:     1.0,  // wisp sharpness (0.2..3)
        brightness:   1.0,  // color multiplier
        detail:       0.25, // high-frequency mix (0..1)
        windAngle:    25,   // scroll direction in degrees
        maxAlpha:     0.55, // opacity cap — keeps sprites visible
    };
}

export function createFog(x = 0, y = 0) {
    const container = new PIXI.Container();
    container.x = x; container.y = y;
    container.isFog    = true;
    container.fogProps = defaultFogProps();
    container.animations = [];
    container.activeAnimIndex = 0;
    container.unityZ = 0;

    // Unique label
    let n = 1;
    const used = new Set(state.gameObjects.map(o => o.label));
    let lbl = 'Fog';
    while (used.has(lbl)) lbl = 'Fog ' + (++n);
    container.label = lbl;

    // Editor helper — small icon so it's visible/selectable in scene
    const g = new PIXI.Graphics();
    g.lineStyle(2, 0xa3b8d8, 0.95);
    g.beginFill(0x1a2540, 0.55);
    g.drawCircle(0, 0, 18);
    g.endFill();
    g.lineStyle(2, 0xa3b8d8, 0.85);
    g.moveTo(-12, -4); g.lineTo(12, -4);
    g.moveTo(-14,  2); g.lineTo(14,  2);
    g.moveTo(-10,  8); g.lineTo(10,  8);
    container.addChild(g);
    container._fogHelper = g;

    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);

    _makeLightSelectable(container);

    import('./engine.objects.js').then(m => m.selectObject(container));
    import('./engine.ui.js').then(m => { m.refreshHierarchy(); });
    return container;
}

export function buildFogInspectorHTML(obj) {
    if (!obj?.isFog) return '';
    const p = obj.fogProps;
    const toHex = c => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);

    const sliderRow = (label, id, min, max, step, val, fmt, tip='') => `
        <div class="prop-row" style="flex-direction:column;align-items:stretch;gap:2px;padding:5px 0;border-bottom:1px solid #1a2333;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
                <span class="prop-label" style="font-size:11px;color:#9ab;">${label}</span>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span id="${id}-val" style="font-family:monospace;font-size:11px;color:#cde;min-width:38px;text-align:right;">${fmt(val)}</span>
                    <input type="number" id="${id}-num" min="${min}" max="${max}" step="${step}" value="${val}"
                        style="width:52px;background:#0d1520;border:1px solid #2a3a4a;border-radius:3px;color:#cde;font-size:11px;padding:1px 4px;text-align:right;">
                </div>
            </div>
            <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}" class="light-slider" style="width:100%;">
            ${tip ? `<div style="font-size:9.5px;color:#556;margin-top:1px;">${tip}</div>` : ''}
        </div>`;

    return `
    <div class="component-block" style="border-left:3px solid #6890b8;">
        <div class="component-header" style="background:#0e1c2e;">
            <input type="checkbox" id="fog-enabled" ${p.enabled ? 'checked' : ''} style="accent-color:#a3b8d8;width:14px;height:14px;">
            <svg viewBox="0 0 24 24" class="comp-icon" style="color:#7aaad8;"><path d="M3 8h12M3 14h18M5 20h14M5 4h10" stroke="currentColor" stroke-width="2" fill="none"/></svg>
            <span style="font-weight:700;color:#a3c8e8;letter-spacing:.5px;">Dynamic Fog  <span style="font-weight:400;font-size:10px;color:#5a7a9a;">(GPU Shader)</span></span>
        </div>
        <div class="component-body" style="padding:0 8px 8px;">

            <!-- PRESETS -->
            <div style="padding:6px 0 4px;border-bottom:1px solid #1a2333;">
                <div style="font-size:10px;color:#6a8aaa;margin-bottom:4px;text-transform:uppercase;letter-spacing:.8px;">Quick Presets</div>
                <div style="display:flex;flex-wrap:wrap;gap:3px;">
                    <button data-fog-preset="thin"    style="flex:1;min-width:60px;background:#0d1928;border:1px solid #2a4060;color:#7aaad8;border-radius:3px;padding:3px 6px;font-size:10px;cursor:pointer;">🌫 Thin</button>
                    <button data-fog-preset="thick"   style="flex:1;min-width:60px;background:#0d1928;border:1px solid #2a4060;color:#7aaad8;border-radius:3px;padding:3px 6px;font-size:10px;cursor:pointer;">☁️ Thick</button>
                    <button data-fog-preset="night"   style="flex:1;min-width:60px;background:#0d1928;border:1px solid #2a4060;color:#7aaad8;border-radius:3px;padding:3px 6px;font-size:10px;cursor:pointer;">🌑 Night</button>
                    <button data-fog-preset="mystic"  style="flex:1;min-width:60px;background:#0d1928;border:1px solid #2a4060;color:#b07ad8;border-radius:3px;padding:3px 6px;font-size:10px;cursor:pointer;">✨ Mystic</button>
                    <button data-fog-preset="desert"  style="flex:1;min-width:60px;background:#0d1928;border:1px solid #2a4060;color:#d8b07a;border-radius:3px;padding:3px 6px;font-size:10px;cursor:pointer;">🏜 Desert</button>
                    <button data-fog-preset="reset"   style="flex:1;min-width:60px;background:#1a0d0d;border:1px solid #4a2020;color:#c87a7a;border-radius:3px;padding:3px 6px;font-size:10px;cursor:pointer;">↺ Reset</button>
                </div>
            </div>

            <!-- COLOR -->
            <div class="prop-row" style="padding:6px 0;border-bottom:1px solid #1a2333;">
                <span class="prop-label" style="font-size:11px;color:#9ab;">Fog Color</span>
                <div style="display:flex;align-items:center;gap:6px;">
                    <input type="color" id="fog-color" value="${toHex(p.color)}" style="width:36px;height:24px;border:none;background:none;cursor:pointer;padding:0;">
                    <input type="text" id="fog-color-hex" value="${toHex(p.color)}"
                        style="width:70px;background:#0d1520;border:1px solid #2a3a4a;border-radius:3px;color:#cde;font-size:11px;font-family:monospace;padding:2px 5px;">
                </div>
            </div>

            <!-- MAIN CONTROLS -->
            <div style="font-size:10px;color:#6a8aaa;padding:6px 0 2px;text-transform:uppercase;letter-spacing:.8px;">Shape &amp; Motion</div>
            ${sliderRow('Density', 'fog-density', 0, 1.5, 0.01, p.density, v=>v.toFixed(2), 'How opaque / thick the fog appears')}
            ${sliderRow('Scale', 'fog-scale', 0.2, 6, 0.05, p.scale, v=>v.toFixed(2), 'Size of fog clouds — larger = softer blobs')}
            ${sliderRow('Speed', 'fog-speed', 0, 1, 0.005, p.speed, v=>v.toFixed(3), 'Scroll/drift speed of the fog layer')}
            ${sliderRow('Wind Direction', 'fog-wind', 0, 360, 1, p.windAngle, v=>(v|0)+'°', 'Angle the fog drifts toward (0 = right)')}
            ${sliderRow('Vertical Fade', 'fog-vfade', 0, 1, 0.01, p.verticalFade, v=>v.toFixed(2), 'Fade fog toward top of screen (0 = none)')}

            <div style="font-size:10px;color:#6a8aaa;padding:6px 0 2px;text-transform:uppercase;letter-spacing:.8px;">Look &amp; Detail</div>
            ${sliderRow('Contrast', 'fog-contrast', 0.2, 3, 0.01, p.contrast, v=>v.toFixed(2), 'Edge sharpness of fog wisps')}
            ${sliderRow('Brightness', 'fog-bright', 0.2, 2, 0.01, p.brightness, v=>v.toFixed(2), 'Overall luminance multiplier')}
            ${sliderRow('Detail', 'fog-detail', 0, 1, 0.01, p.detail, v=>v.toFixed(2), 'High-frequency texture mix — adds wispy tendrils')}
            ${sliderRow('Octaves (FBM)', 'fog-oct', 1, 8, 1, p.octaves, v=>String(v|0), 'Fractal detail layers — higher = more complex (costs GPU)')}

            <div style="font-size:10px;color:#6a8aaa;padding:6px 0 2px;text-transform:uppercase;letter-spacing:.8px;">Opacity</div>
            ${sliderRow('Max Opacity', 'fog-maxa', 0.05, 1.0, 0.01, p.maxAlpha, v=>v.toFixed(2), 'Hard cap so sprites stay visible beneath fog')}

        </div>
    </div>`;
}

export function bindFogInspector(obj) {
    if (!obj?.isFog) return;
    const p = obj.fogProps;

    // Enabled toggle
    const en = document.getElementById('fog-enabled');
    if (en) en.addEventListener('change', () => { p.enabled = en.checked; });

    // Color — sync color picker ↔ hex text input
    const col    = document.getElementById('fog-color');
    const colHex = document.getElementById('fog-color-hex');
    if (col) col.addEventListener('input', () => {
        p.color = parseInt(col.value.replace('#',''), 16);
        if (colHex) colHex.value = col.value;
    });
    if (colHex) colHex.addEventListener('input', () => {
        const v = colHex.value.replace(/[^0-9a-fA-F]/g,'').slice(0,6);
        if (v.length === 6) {
            p.color = parseInt(v, 16);
            if (col) col.value = '#' + v;
        }
    });

    // Generic slider + number input wiring
    const wire = (id, prop, valId, fmt) => {
        const slider = document.getElementById(id);
        const numInp = document.getElementById(id + '-num');
        const valEl  = document.getElementById(valId);
        const apply  = rawVal => {
            const min  = parseFloat(slider?.min  ?? '-Infinity');
            const max  = parseFloat(slider?.max  ??  'Infinity');
            const step = parseFloat(slider?.step ?? '0.01');
            let v = parseFloat(rawVal);
            if (isNaN(v)) return;
            v = Math.max(min, Math.min(max, v));
            // Snap to step for integer-like props (octaves)
            if (step >= 1) v = Math.round(v);
            p[prop] = v;
            if (slider) slider.value = v;
            if (numInp) numInp.value  = v;
            if (valEl)  valEl.textContent = fmt(p[prop]);
        };
        if (slider) slider.addEventListener('input', () => apply(slider.value));
        if (numInp) numInp.addEventListener('input', () => apply(numInp.value));
    };

    wire('fog-density', 'density',     'fog-density-val', v => v.toFixed(2));
    wire('fog-scale',   'scale',       'fog-scale-val',   v => v.toFixed(2));
    wire('fog-speed',   'speed',       'fog-speed-val',   v => v.toFixed(3));
    wire('fog-vfade',   'verticalFade','fog-vfade-val',   v => v.toFixed(2));
    wire('fog-oct',     'octaves',     'fog-oct-val',     v => String(v|0));
    wire('fog-contrast','contrast',    'fog-contrast-val',v => v.toFixed(2));
    wire('fog-bright',  'brightness',  'fog-bright-val',  v => v.toFixed(2));
    wire('fog-detail',  'detail',      'fog-detail-val',  v => v.toFixed(2));
    wire('fog-wind',    'windAngle',   'fog-wind-val',    v => (v|0) + '°');
    wire('fog-maxa',    'maxAlpha',    'fog-maxa-val',    v => v.toFixed(2));

    // Preset helper — sets p values then refreshes all inputs
    const applyPreset = preset => {
        const presets = {
            thin:   { enabled:true, color:0xd0dce8, density:0.20, scale:2.0, speed:0.04, verticalFade:0.15, octaves:4, contrast:0.8, brightness:1.1, detail:0.1,  windAngle:15,  maxAlpha:0.30 },
            thick:  { enabled:true, color:0x8898a8, density:1.10, scale:1.2, speed:0.08, verticalFade:0.50, octaves:6, contrast:1.4, brightness:0.9, detail:0.35, windAngle:30,  maxAlpha:0.80 },
            night:  { enabled:true, color:0x101830, density:0.70, scale:1.8, speed:0.03, verticalFade:0.40, octaves:5, contrast:1.2, brightness:0.6, detail:0.20, windAngle:200, maxAlpha:0.65 },
            mystic: { enabled:true, color:0x7040c0, density:0.55, scale:1.5, speed:0.12, verticalFade:0.30, octaves:7, contrast:1.8, brightness:1.3, detail:0.55, windAngle:90,  maxAlpha:0.60 },
            desert: { enabled:true, color:0xd0a060, density:0.40, scale:2.5, speed:0.18, verticalFade:0.10, octaves:3, contrast:0.9, brightness:1.4, detail:0.15, windAngle:45,  maxAlpha:0.45 },
            reset:  defaultFogProps(),
        };
        const src = presets[preset];
        if (!src) return;
        Object.assign(p, src);
        // Refresh all UI controls
        if (en)     { en.checked = p.enabled; }
        const hex = '#' + (p.color >>> 0).toString(16).padStart(6,'0').slice(-6);
        if (col)    col.value    = hex;
        if (colHex) colHex.value = hex;
        const refresh = (id, prop, fmt) => {
            const s = document.getElementById(id);
            const n = document.getElementById(id + '-num');
            const v = document.getElementById(id + '-val');
            if (s) s.value = p[prop];
            if (n) n.value = p[prop];
            if (v) v.textContent = fmt(p[prop]);
        };
        refresh('fog-density', 'density',     v => v.toFixed(2));
        refresh('fog-scale',   'scale',        v => v.toFixed(2));
        refresh('fog-speed',   'speed',        v => v.toFixed(3));
        refresh('fog-vfade',   'verticalFade', v => v.toFixed(2));
        refresh('fog-oct',     'octaves',      v => String(v|0));
        refresh('fog-contrast','contrast',     v => v.toFixed(2));
        refresh('fog-bright',  'brightness',   v => v.toFixed(2));
        refresh('fog-detail',  'detail',       v => v.toFixed(2));
        refresh('fog-wind',    'windAngle',    v => (v|0) + '°');
        refresh('fog-maxa',    'maxAlpha',     v => v.toFixed(2));
    };

    document.querySelectorAll('[data-fog-preset]').forEach(btn => {
        btn.addEventListener('click', () => applyPreset(btn.dataset.fogPreset));
    });
}

export function snapshotLight(obj) {
    return {
        isLight: true, lightType: obj.lightType,
        label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
        lightProps: JSON.parse(JSON.stringify(obj.lightProps)),
    };
}

export async function restoreLight(s) {
    const obj = createLight(s.lightType, s.x, s.y);
    obj.label = s.label;
    obj.unityZ = s.unityZ || 0;
    obj.lightProps = JSON.parse(JSON.stringify(s.lightProps));
    // Backfill any missing keys (older snapshots)
    const def = defaultLightProps(s.lightType);
    for (const k in def) if (obj.lightProps[k] === undefined) obj.lightProps[k] = def[k];
    _ensureShadowDefaults(obj.lightProps);
    _buildLightHelper(obj);
    return obj;
}

// ── Internal helpers ─────────────────────────────────────────
function _nameUtils() {
    return {
        _uniqueLightName(base) {
            const existing = new Set(state.gameObjects.map(o => o.label));
            if (!existing.has(base)) return base;
            let i = 2;
            while (existing.has(`${base} (${i})`)) i++;
            return `${base} (${i})`;
        }
    };
}

function _makeAxisLine(color, length, isY) {
    const g = new PIXI.Graphics();
    g.beginFill(color);
    g.lineStyle(2, color);
    if (isY) g.drawRect(-1, -length, 2, length);
    else     g.drawRect(0, -1, length, 2);
    g.lineStyle(0);
    if (isY) { g.moveTo(-6, -length); g.lineTo(0, -length-10); g.lineTo(6, -length); }
    else     { g.moveTo(length, -6);  g.lineTo(length+10, 0);  g.lineTo(length, 6); }
    g.endFill();
    g.eventMode = 'static';
    return g;
}

function _makeSquareHandle(color, alpha, cursor) {
    const g = new PIXI.Graphics();
    g.beginFill(color, alpha); g.drawRect(-7, -7, 14, 14); g.endFill();
    g.eventMode = 'static'; g.cursor = cursor;
    return g;
}
