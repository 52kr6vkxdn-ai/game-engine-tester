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

// Default properties per light type
export function defaultLightProps(type) {
    const base = {
        color:     0xFFFFFF,
        intensity: 1.0,
        enabled:   true,
    };
    switch (type) {
        case 'point':
            return { ...base, radius: 200, falloff: 2.0 };
        case 'spot':
            return { ...base, radius: 250, angle: 45, falloff: 1.8, direction: 0 };
        case 'directional':
            return { ...base, angle: 0, softness: 0.3 };
        case 'area':
            return { ...base, width: 150, height: 80, falloff: 1.5 };
        default:
            return base;
    }
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

    const m = state.gizmoMode || 'translate';
    grpTranslate.visible = true; // lights always show translate
}

function _makeLightSelectable(container) {
    container.eventMode = 'static';
    container._lightHelper.eventMode = 'static';
    container._lightHelper.cursor = 'pointer';

    container.on('pointerdown', (e) => {
        if (state.isPlaying) { e.stopPropagation(); return; }
        if (e.button !== 0) return;
        import('./engine.objects.js').then(m => m.selectObject(container));
        e.stopPropagation();
    });
    container._lightHelper.on('pointerdown', (e) => {
        if (state.isPlaying) { e.stopPropagation(); return; }
        import('./engine.objects.js').then(m => m.selectObject(container));
        e.stopPropagation();
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

// ── Apply 2D lighting to the scene (composite blend) ─────────
// We use PIXI's multiply/add blend on a lighting layer
export function applyLighting() {
    // For now, lighting is rendered via helper overlays.
    // A full GPU lighting pipeline would require render textures.
    // TODO: Implement render-texture-based shadow+light compositing.
}

// ── Inspector HTML for a light object ───────────────────────
export function buildLightInspectorHTML(obj) {
    if (!obj?.isLight) return '';
    const p = obj.lightProps;
    const type = obj.lightType;

    const hexColor = '#' + (p.color >>> 0).toString(16).padStart(6, '0').slice(-6);
    const pct = v => Math.round(v * 100);

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
        </div>`;
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
        </div>`;
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

    bind('li-intensity', 'intensity', parseFloat, 'li-intensity-val', v => v.toFixed(2));
    bind('li-radius',    'radius',    parseFloat, 'li-radius-val',    v => v + 'px');
    bind('li-angle',     'angle',     parseFloat, 'li-angle-val',     v => v + '°');
    bind('li-direction', 'direction', parseFloat, 'li-direction-val', v => v + '°');
    bind('li-falloff',   'falloff',   parseFloat, 'li-falloff-val',   v => v.toFixed(1));
    bind('li-softness',  'softness',  parseFloat, 'li-softness-val',  v => v.toFixed(2));
    bind('li-width',     'width',     parseFloat, 'li-width-val',     v => v + 'px');
    bind('li-height',    'height',    parseFloat, 'li-height-val',    v => v + 'px');
}

// ── Snapshot helpers ─────────────────────────────────────────
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
