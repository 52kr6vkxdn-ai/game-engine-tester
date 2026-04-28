/* ============================================================
   Zengine — engine.physics.js  v3
   Matter.js 2D physics — fully corrected body sizing + per-frame
   collision polygon support.

   KEY FIXES vs v2:
   • Body size: read from texture.orig (raw pixel size) and apply
     scale ONCE — never double-multiply.
   • fromVertices centroid shift: Matter shifts the body's position
     after fromVertices; we correct it by computing the centroid
     manually and re-centering.
   • Per-frame polygons: obj.physicsPolygons = { [frameId]: [{x,y}] }
     The editor lets you set a shape per frame OR a "shared" shape
     that all frames inherit.  At runtime we pick the active frame's
     polygon, falling back to shared → box.
   • Tilemaps: always static, auto-generated rectangle bodies,
     locked in the inspector.

   To swap CDN → local file, change MATTER_CDN to './matter.min.js'
   ============================================================ */

import { state } from './engine.state.js';

const MATTER_CDN = 'https://cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js';

// ── Module state ──────────────────────────────────────────────
let _engine = null;
let _rafId  = null;
let _bodies = [];  // { obj, body, type }[]

// ─────────────────────────────────────────────────────────────
// CDN loader
// ─────────────────────────────────────────────────────────────

function _loadMatter() {
    return new Promise((resolve, reject) => {
        if (window.Matter) { resolve(); return; }
        const el = document.getElementById('matter-js-script');
        if (el) { el.addEventListener('load', resolve); el.addEventListener('error', reject); return; }
        const s  = document.createElement('script');
        s.id     = 'matter-js-script';
        s.src    = MATTER_CDN;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Matter.js load failed: ' + MATTER_CDN));
        document.head.appendChild(s);
    });
}

// ─────────────────────────────────────────────────────────────
// Get raw (unscaled) sprite size in pixels
// ─────────────────────────────────────────────────────────────

function _rawSize(obj) {
    // Priority: texture original size → displayWidth/Height ÷ scale → 40×40
    const sg  = obj.spriteGraphic;
    const rs  = obj._runtimeSprite;
    const src = sg || rs;
    if (src?.texture?.orig) {
        return { w: src.texture.orig.width, h: src.texture.orig.height };
    }
    if (src?.texture?.width) {
        return { w: src.texture.width, h: src.texture.height };
    }
    // Fallback: read display size and un-apply scale
    const sx = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy = Math.abs(obj.scale?.y ?? 1) || 1;
    if (src?.width && src?.height) {
        return { w: src.width / sx, h: src.height / sy };
    }
    return { w: 40, h: 40 };
}

// ─────────────────────────────────────────────────────────────
// Pick the polygon for a given frame (or shared)
// obj.physicsPolygons = { shared: [{x,y}], [frameId]: [{x,y}] }
// ─────────────────────────────────────────────────────────────

function _getActivePolygon(obj) {
    const map = obj.physicsPolygons;
    if (!map) return obj.physicsPolygon || null; // legacy single polygon

    // Active frame
    const anim      = obj.animations?.[obj.activeAnimIndex ?? 0];
    const frameId   = anim?.frames?.[0]?.id;  // at rest, frame 0 of active anim
    if (frameId && Array.isArray(map[frameId]) && map[frameId].length >= 3) return map[frameId];
    if (Array.isArray(map.shared) && map.shared.length >= 3) return map.shared;
    return null;
}

// ─────────────────────────────────────────────────────────────
// Build a Matter body — fixed sizing & centroid
// ─────────────────────────────────────────────────────────────

function _makeBody(Bodies, Body, obj, cx, cy) {
    const raw    = _rawSize(obj);
    const sx     = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy     = Math.abs(obj.scale?.y ?? 1) || 1;
    const w      = raw.w * sx;   // world-space width
    const h      = raw.h * sy;   // world-space height
    const opts   = _bodyOpts(obj);
    const shape  = obj.physicsShape ?? 'box';
    const poly   = _getActivePolygon(obj);

    if (shape === 'circle') {
        const r = Math.max(Math.min(w, h) / 2, 2);
        return Bodies.circle(cx, cy, r, opts);
    }

    if ((shape === 'polygon' || shape === 'shared') && Array.isArray(poly) && poly.length >= 3) {
        // Transform local-pixel verts → world verts (apply scale, no extra translate)
        const worldVerts = poly.map(p => ({ x: p.x * sx, y: p.y * sy }));

        try {
            // Matter.fromVertices places the body so its centroid is at (cx,cy)
            // but it also offsets the vertices internally by the centroid delta.
            // We compensate after creation.
            const body = Bodies.fromVertices(cx, cy, worldVerts, { ...opts, flagInternal: false }, true);

            // fromVertices shifts the body by (centroid - cx, centroid - cy).
            // Correct it back so the body centre matches the object position.
            const centroid = _centroid(worldVerts);
            const dx = cx - (body.position.x - (centroid.x - cx));
            const dy = cy - (body.position.y - (centroid.y - cy));
            Body.setPosition(body, { x: cx, y: cy });
            return body;
        } catch (e) {
            console.warn('[Physics] fromVertices failed, using box:', e.message);
        }
    }

    // Box (default)
    return Bodies.rectangle(cx, cy, Math.max(w, 4), Math.max(h, 4), opts);
}

function _bodyOpts(obj) {
    return {
        isStatic:    obj.physicsBody === 'static',
        label:       obj.label,
        friction:    obj.physicsFriction    ?? 0.3,
        restitution: obj.physicsRestitution ?? 0.1,
        frictionAir: obj.physicsBody === 'kinematic' ? 1.0 : 0.01,
    };
}

function _centroid(verts) {
    let cx = 0, cy = 0;
    verts.forEach(v => { cx += v.x; cy += v.y; });
    return { x: cx / verts.length, y: cy / verts.length };
}

// ─────────────────────────────────────────────────────────────
// Start physics
// ─────────────────────────────────────────────────────────────

export async function startPhysics() {
    if (_engine) stopPhysics();
    try { await _loadMatter(); }
    catch (err) { console.error('[Physics]', err); return; }

    const { Engine, Bodies, Body, Composite } = window.Matter;
    _engine = Engine.create({ gravity: { x: 0, y: 1 } });
    _bodies = [];
    const toAdd = [];

    for (const obj of state.gameObjects) {

        // ── Tilemap → auto static per-cell ──
        if (obj.isTilemap) {
            const td = obj.tilemapData;
            for (let r = 0; r < td.rows; r++) {
                for (let c = 0; c < td.cols; c++) {
                    if (!td.tiles[r * td.cols + c]) continue;
                    toAdd.push(Bodies.rectangle(
                        obj.x + c * td.tileW + td.tileW / 2,
                        obj.y + r * td.tileH + td.tileH / 2,
                        td.tileW, td.tileH,
                        { isStatic: true, label: `tm_${obj.label}_${r}_${c}`, friction: 0.3, restitution: 0.1 }
                    ));
                }
            }
            continue;
        }

        // ── Auto-tilemap → auto static per-cell ──
        if (obj.isAutoTilemap) {
            const d = obj.autoTileData;
            for (let r = 0; r < d.rows; r++) {
                for (let c = 0; c < d.cols; c++) {
                    const v = d.cells[r * d.cols + c];
                    if (!(Array.isArray(v) ? v.length : v)) continue;
                    toAdd.push(Bodies.rectangle(
                        obj.x + c * d.tileW + d.tileW / 2,
                        obj.y + r * d.tileH + d.tileH / 2,
                        d.tileW, d.tileH,
                        { isStatic: true, label: `at_${obj.label}_${r}_${c}`, friction: 0.3, restitution: 0.1 }
                    ));
                }
            }
            continue;
        }

        // ── Regular sprite ──
        const type = obj.physicsBody || 'none';
        if (type === 'none') continue;

        const body = _makeBody(Bodies, Body, obj, obj.x, obj.y);
        if (!body) continue;

        if (type !== 'static') Body.setAngle(body, obj.rotation || 0);
        if (type === 'kinematic') window.Matter.Body.setInertia(body, Infinity);

        toAdd.push(body);
        _bodies.push({ obj, body, type });
    }

    Composite.add(_engine.world, toAdd);

    let last = null;
    function tick(now) {
        _rafId = requestAnimationFrame(tick);
        if (state.isPaused) return;
        const dt = last ? Math.min(now - last, 50) : 16.67;
        last = now;
        Engine.update(_engine, dt);
        for (const { obj, body, type } of _bodies) {
            if (type === 'static') continue;
            if (type === 'kinematic') {
                window.Matter.Body.setPosition(body, { x: obj.x, y: obj.y });
                window.Matter.Body.setAngle(body, obj.rotation || 0);
            } else {
                obj.x = body.position.x;
                obj.y = body.position.y;
                obj.rotation = body.angle;
            }
        }
    }
    _rafId = requestAnimationFrame(tick);
}

// ─────────────────────────────────────────────────────────────
// Stop physics
// ─────────────────────────────────────────────────────────────

export function stopPhysics() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_engine && window.Matter) {
        window.Matter.Composite.clear(_engine.world, false);
        window.Matter.Engine.clear(_engine);
    }
    _engine = null; _bodies = [];
}

// ─────────────────────────────────────────────────────────────
// Inspector HTML
// ─────────────────────────────────────────────────────────────

export function buildPhysicsInspectorHTML(obj) {
    if (obj.isTilemap || obj.isAutoTilemap) {
        return `<div class="component-block" id="inspector-physics-section">
          <div class="component-header">
            <svg viewBox="0 0 24 24" class="comp-icon" style="color:#facc15;fill:none;stroke:currentColor;stroke-width:2;">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>
            </svg>
            <span style="font-weight:600;color:#facc15;">Physics</span>
          </div>
          <div class="component-body" style="display:flex;flex-direction:column;gap:5px;">
            <div class="prop-row">
              <span class="prop-label">Body</span>
              <span style="color:#4ade80;font-size:11px;font-weight:600;">Static (locked)</span>
            </div>
            <div style="background:#1a1a10;border:1px solid #facc1533;border-radius:3px;padding:4px 6px;font-size:9px;color:#facc1566;">
              Tilemaps are always static colliders — one box per filled tile.
            </div>
          </div>
        </div>`;
    }

    const type   = obj.physicsBody      ?? 'none';
    const fric   = obj.physicsFriction    ?? 0.3;
    const rest   = obj.physicsRestitution ?? 0.1;
    const shape  = obj.physicsShape      ?? 'box';

    const OPT  = (v, l) => `<option value="${v}" ${type  === v ? 'selected' : ''}>${l}</option>`;

    // Collision shape summary for display only
    const polyMap = obj.physicsPolygons || {};
    const hasShape = (shape === 'polygon') && (
        Array.isArray(polyMap.shared) && polyMap.shared.length >= 3
    );
    const shapeLabel = shape === 'circle' ? '◯ Circle' : shape === 'polygon' ? (hasShape ? '⬡ Polygon ✓' : '⬡ Polygon (edit in Animation)') : '▭ Box';
    const shapeColor = shape === 'polygon' && !hasShape ? '#666' : '#a78bfa';

    return `
    <div class="component-block" id="inspector-physics-section">
      <div class="component-header">
        <svg viewBox="0 0 24 24" class="comp-icon" style="color:#facc15;fill:none;stroke:currentColor;stroke-width:2;">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
        </svg>
        <span style="font-weight:600;color:#facc15;">Physics</span>
      </div>
      <div class="component-body" style="display:flex;flex-direction:column;gap:6px;">

        <div class="prop-row">
          <span class="prop-label">Body type</span>
          <select id="phys-type" style="${_sel()}">
            ${OPT('none','None')} ${OPT('static','Static')}
            ${OPT('dynamic','Dynamic')} ${OPT('kinematic','Kinematic')}
          </select>
        </div>

        <div id="phys-extra" style="display:${type==='none'?'none':'flex'};flex-direction:column;gap:5px;">

          <div class="prop-row">
            <span class="prop-label">Shape</span>
            <span style="font-size:10px;color:${shapeColor};">${shapeLabel}</span>
          </div>

          <div style="background:#0d0d1a;border:1px solid #7c3aed33;border-radius:3px;padding:4px 7px;font-size:9px;color:#7c6aaa;line-height:1.5;">
            ✏ Edit collision shape in the <strong style="color:#a78bfa;">Animation Editor</strong><br>
            (double-click the object → Collision tab)
          </div>

          <div class="prop-row">
            <span class="prop-label">Friction</span>
            <input id="phys-friction" type="number" value="${fric}" min="0" max="1" step="0.05" style="width:60px;${_inp()}">
          </div>
          <div class="prop-row">
            <span class="prop-label">Bounce</span>
            <input id="phys-bounce" type="number" value="${rest}" min="0" max="1" step="0.05" style="width:60px;${_inp()}">
          </div>

          <div style="background:#1a1400;border:1px solid #facc1533;border-radius:3px;padding:4px 6px;font-size:9px;color:#facc1566;">
            Physics active in play mode ▶
          </div>
          <button id="phys-show-collision" style="${_btn('#facc15')}width:100%;margin-top:2px;font-size:10px;">
            👁 Show Collision Shape
          </button>
        </div>
      </div>
    </div>`;
}

function _frameBtn(hasShape, frameId) {
    const active = hasShape;
    return `background:${active ? '#1a1a30' : '#0a0a18'};border:1px solid ${active ? '#7c3aed' : '#1a1a30'};
            color:${active ? '#a78bfa' : '#555'};border-radius:3px;padding:2px 6px;cursor:pointer;
            font-size:9px;font-weight:${active ? '700' : '400'};`;
}

function _polySummary(poly) {
    return (Array.isArray(poly) && poly.length >= 3)
        ? `${poly.length} vertices defined`
        : 'No shape — draw one below';
}

// ─────────────────────────────────────────────────────────────
// Auto-fit: generate a tight collision shape from sprite alpha
// ─────────────────────────────────────────────────────────────

export function autoFitCollisionShape(obj) {
    _autoFitCollisionShape(obj);
}

function _autoFitCollisionShape(obj) {
    // Try alpha-based hull from sprite frames, fall back to box
    const dataURL = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.dataURL
                 || obj.spriteGraphic?.texture?.baseTexture?.resource?.source?.src
                 || null;

    if (dataURL) {
        _alphaHullFromDataURL(dataURL, obj);
    } else {
        // Fallback: tight box from sprite size
        const raw = _rawSize(obj);
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = _defaultBox(raw.w, raw.h);
        obj.physicsShape = 'polygon';
        if (!obj.physicsPolygon) obj.physicsPolygon = obj.physicsPolygons.shared.slice();
    }
}

function _alphaHullFromDataURL(dataURL, obj) {
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth  || 64;
        canvas.height = img.naturalHeight || 64;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        try {
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const hull   = _computeAlphaOBB(pixels, canvas.width, canvas.height);
            if (hull && hull.length >= 3) {
                if (!obj.physicsPolygons) obj.physicsPolygons = {};
                obj.physicsPolygons.shared = hull;
                obj.physicsShape  = 'polygon';
                obj.physicsPolygon = hull.slice();
                import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
                return;
            }
        } catch(_) {}

        // Fallback to tight box
        const raw = _rawSize(obj);
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = _defaultBox(raw.w, raw.h);
        obj.physicsShape = 'polygon';
        obj.physicsPolygon = obj.physicsPolygons.shared.slice();
        import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
    };
    img.src = dataURL;
}

// Compute an axis-aligned bounding box from non-transparent pixels,
// returned as centred polygon vertices (like _defaultBox).
function _computeAlphaOBB(imageData, w, h) {
    const data = imageData.data;
    const THRESHOLD = 20; // alpha threshold
    let minX = w, maxX = 0, minY = h, maxY = 0;
    let found = false;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const a = data[(y * w + x) * 4 + 3];
            if (a > THRESHOLD) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                found = true;
            }
        }
    }

    if (!found) return null;

    // Add 1px padding
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(w - 1, maxX + 1);
    maxY = Math.min(h - 1, maxY + 1);

    // Convert to centred coordinates
    const cx = w / 2, cy = h / 2;
    return [
        { x: minX - cx, y: minY - cy },
        { x: maxX - cx, y: minY - cy },
        { x: maxX - cx, y: maxY - cy },
        { x: minX - cx, y: maxY - cy },
    ];
}



export function bindPhysicsInspector(obj) {
    const typeEl  = document.getElementById('phys-type');
    const extra   = document.getElementById('phys-extra');
    const fricEl  = document.getElementById('phys-friction');
    const bnceEl  = document.getElementById('phys-bounce');
    if (!typeEl) return;

    typeEl.addEventListener('change', () => {
        obj.physicsBody = typeEl.value;
        if (extra) extra.style.display = typeEl.value === 'none' ? 'none' : 'flex';
        // Auto-generate default collision shape on first enable
        if (typeEl.value !== 'none' && !obj._collisionShapeInit) {
            _autoFitCollisionShape(obj);
            obj._collisionShapeInit = true;
        }
        _pushUndo();
        import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
    });

    fricEl?.addEventListener('change', () => {
        obj.physicsFriction = Math.max(0, Math.min(1, parseFloat(fricEl.value) || 0));
        _pushUndo();
    });
    bnceEl?.addEventListener('change', () => {
        obj.physicsRestitution = Math.max(0, Math.min(1, parseFloat(bnceEl.value) || 0));
        _pushUndo();
    });

    // "Show Collision" button — toggles the global overlay
    document.getElementById('phys-show-collision')?.addEventListener('click', () => {
        import('./engine.collision-overlay.js').then(m => {
            m.setCollisionVisible(!state.showCollision);
            const btn = document.getElementById('phys-show-collision');
            if (btn) {
                btn.textContent = state.showCollision ? '👁 Hide Collision Shape' : '👁 Show Collision Shape';
                btn.style.background = state.showCollision ? '#facc1533' : '';
            }
        });
    });
}

function _pushUndo() {
    import('./engine.history.js').then(({ pushUndo }) => pushUndo());
}

// ─────────────────────────────────────────────────────────────
// Polygon Editor
// Opens for a specific frameId ('shared' | frame UUID)
// ─────────────────────────────────────────────────────────────

export function openPolygonEditor(obj, frameId = 'shared') {
    document.getElementById('poly-editor-panel')?.remove();

    // Ensure polygon map exists
    if (!obj.physicsPolygons || typeof obj.physicsPolygons !== 'object') {
        obj.physicsPolygons = {};
        // Migrate legacy single polygon
        if (Array.isArray(obj.physicsPolygon) && obj.physicsPolygon.length >= 3) {
            obj.physicsPolygons.shared = obj.physicsPolygon.map(p => ({ x: p.x, y: p.y }));
        }
    }

    // Get raw sprite size
    const raw = _rawSize(obj);
    const sprW = raw.w, sprH = raw.h;
    const SCALE = Math.min(420 / sprW, 420 / sprH, 4);
    const cvW   = Math.round(sprW * SCALE);
    const cvH   = Math.round(sprH * SCALE);

    // Load existing polygon for this frame (or shared or default box)
    const existing = obj.physicsPolygons[frameId];
    let pts = (Array.isArray(existing) && existing.length >= 3)
        ? existing.map(p => ({ x: p.x, y: p.y }))
        : _defaultBox(sprW, sprH);

    // Find frame dataURL for preview
    let previewURL = null;
    if (frameId !== 'shared') {
        for (const anim of (obj.animations || [])) {
            const f = (anim.frames || []).find(f => f.id === frameId);
            if (f) { previewURL = f.dataURL; break; }
        }
    } else {
        // Use first frame of first anim for shared preview
        previewURL = obj.animations?.[0]?.frames?.[0]?.dataURL || null;
    }
    // Fallback to current spriteGraphic texture
    if (!previewURL && obj.spriteGraphic?.texture?.baseTexture?.resource?.source) {
        const src = obj.spriteGraphic.texture.baseTexture.resource.source;
        previewURL = src.src || src.currentSrc || null;
    }

    const frameLabel = frameId === 'shared' ? 'All Frames (Shared)' : (frameId || 'shared');

    const panel = document.createElement('div');
    panel.id = 'poly-editor-panel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);font-family:sans-serif;';

    panel.innerHTML = `
    <div style="background:#0d0d1e;border:1px solid #7c3aed66;border-radius:8px;overflow:hidden;
                display:flex;flex-direction:column;width:min(700px,95vw);max-height:92vh;">

      <div style="padding:12px 16px;border-bottom:1px solid #1a1a30;display:flex;align-items:center;gap:10px;">
        <span style="color:#7c3aed;font-weight:700;font-size:13px;">Collision Shape Editor</span>
        <span style="color:#555;font-size:11px;">→</span>
        <span style="color:#a78bfa;font-size:11px;">${frameLabel}</span>
        <div style="display:flex;gap:5px;margin-left:auto;">
          <button id="pe-box"    style="${_btn('#3b82f6')}">↺ Box</button>
          <button id="pe-circle" style="${_btn('#06b6d4')}">↺ Circle</button>
          <button id="pe-clear"  style="${_btn('#ef4444')}">✕ Clear</button>
          <div style="width:1px;height:16px;background:#222;margin:0 2px;"></div>
          <button id="pe-undo" style="${_btn('#888')}" title="Undo (Ctrl+Z)">↩</button>
          <button id="pe-redo" style="${_btn('#888')}" title="Redo (Ctrl+Y)">↪</button>
        </div>
      </div>

      <div style="display:flex;flex:1;overflow:hidden;">

        <!-- Canvas -->
        <div style="display:flex;flex-direction:column;align-items:center;padding:14px;gap:6px;">
          <div style="color:#555;font-size:9px;text-transform:uppercase;letter-spacing:.05em;text-align:center;">
            Click canvas: add point  •  Drag point: move  •  Right-click point: delete
          </div>
          <canvas id="pe-canvas" width="${cvW}" height="${cvH}"
            style="background:#080812;border:1px solid #1a1a30;border-radius:4px;cursor:crosshair;display:block;flex-shrink:0;"
            oncontextmenu="return false;"></canvas>
          <div style="display:flex;gap:6px;align-items:center;">
            <label style="color:#666;font-size:10px;display:flex;align-items:center;gap:4px;">
              <input id="pe-show-grid" type="checkbox" checked style="accent-color:#7c3aed;"> Grid
            </label>
            <label style="color:#666;font-size:10px;display:flex;align-items:center;gap:4px;">
              <input id="pe-show-sprite" type="checkbox" checked style="accent-color:#7c3aed;"> Preview sprite
            </label>
            <label style="color:#666;font-size:10px;display:flex;align-items:center;gap:4px;">
              <input id="pe-snap-grid" type="checkbox" style="accent-color:#7c3aed;"> Snap
            </label>
          </div>
        </div>

        <!-- Vertex panel -->
        <div style="width:180px;flex-shrink:0;border-left:1px solid #1a1a30;display:flex;flex-direction:column;overflow:hidden;">
          <div style="padding:8px 10px;border-bottom:1px solid #1a1a30;color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">
            Vertices (local px)
          </div>
          <div id="pe-vlist" style="flex:1;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:3px;"></div>
          <div id="pe-status" style="padding:6px 10px;border-top:1px solid #1a1a30;color:#555;font-size:9px;"></div>
        </div>
      </div>

      <div style="padding:10px 16px;border-top:1px solid #1a1a30;display:flex;justify-content:flex-end;gap:8px;">
        <button id="pe-cancel" style="${_btn('#555')}">Cancel</button>
        <button id="pe-copy-to-all" style="${_btn('#06b6d4')}" title="Copy this shape to all frames">Copy to all frames</button>
        <button id="pe-save"   style="${_btn('#7c3aed')}font-weight:700;">✓ Save</button>
      </div>
    </div>`;

    document.body.appendChild(panel);

    const canvas = panel.querySelector('#pe-canvas');
    const ctx    = canvas.getContext('2d');
    let spriteImg  = null;
    let showGrid   = true;
    let showSprite = true;

    if (previewURL) {
        spriteImg = new Image();
        spriteImg.onload = draw;
        spriteImg.src = previewURL;
    }

    const SNAP = 10 / SCALE;
    let dragging = -1, hover = -1;
    let snapToGrid = false;
    const GRID_SNAP = Math.max(2, Math.round(Math.min(sprW, sprH) / 16)); // local-px snap size

    // Undo/redo stacks
    const _undoStack = [JSON.stringify(pts)];
    let _undoIdx = 0;

    function _pushHistory() {
        // Discard any future states
        _undoStack.splice(_undoIdx + 1);
        _undoStack.push(JSON.stringify(pts));
        if (_undoStack.length > 50) _undoStack.shift();
        _undoIdx = _undoStack.length - 1;
    }
    function _undo() {
        if (_undoIdx <= 0) return;
        _undoIdx--;
        pts = JSON.parse(_undoStack[_undoIdx]);
        draw();
    }
    function _redo() {
        if (_undoIdx >= _undoStack.length - 1) return;
        _undoIdx++;
        pts = JSON.parse(_undoStack[_undoIdx]);
        draw();
    }

    // Coordinate helpers — origin at top-left of canvas, local origin at canvas centre
    function toCanvas(p) { return { x: (p.x + sprW/2) * SCALE, y: (p.y + sprH/2) * SCALE }; }
    function toLocal(cx, cy) {
        let lx = cx / SCALE - sprW/2;
        let ly = cy / SCALE - sprH/2;
        if (snapToGrid) {
            lx = Math.round(lx / GRID_SNAP) * GRID_SNAP;
            ly = Math.round(ly / GRID_SNAP) * GRID_SNAP;
        }
        return { x: lx, y: ly };
    }

    function evPos(e) {
        const r  = canvas.getBoundingClientRect();
        const sx = cvW / r.width, sy = cvH / r.height;
        const s  = e.touches ? e.touches[0] : e;
        return { cx: (s.clientX - r.left) * sx, cy: (s.clientY - r.top) * sy };
    }

    function nearestPt(cx, cy) {
        let best = -1, bd = Infinity;
        pts.forEach((p, i) => {
            const c = toCanvas(p);
            const d = Math.hypot(cx - c.x, cy - c.y);
            if (d < bd) { bd = d; best = i; }
        });
        return bd < SNAP * SCALE ? best : -1;
    }

    function draw() {
        ctx.clearRect(0, 0, cvW, cvH);

        // Background
        ctx.fillStyle = '#080812'; ctx.fillRect(0, 0, cvW, cvH);

        // Sprite preview
        if (showSprite && spriteImg?.complete && spriteImg.naturalWidth > 0) {
            ctx.globalAlpha = 0.4;
            ctx.drawImage(spriteImg, 0, 0, cvW, cvH);
            ctx.globalAlpha = 1;
        }

        // Grid (in local-pixel units)
        if (showGrid) {
            const step = Math.max(8, Math.round(Math.min(sprW, sprH) / 8)) * SCALE;
            ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
            for (let x = cvW/2 % step; x < cvW; x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,cvH); ctx.stroke(); }
            for (let y = cvH/2 % step; y < cvH; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(cvW,y); ctx.stroke(); }
            // Snap grid overlay
            if (snapToGrid) {
                const snapStep = GRID_SNAP * SCALE;
                ctx.strokeStyle = 'rgba(124,58,237,0.18)'; ctx.lineWidth = 0.5;
                for (let x = cvW/2 % snapStep; x < cvW; x += snapStep) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,cvH); ctx.stroke(); }
                for (let y = cvH/2 % snapStep; y < cvH; y += snapStep) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(cvW,y); ctx.stroke(); }
            }
            // Centre cross
            ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.setLineDash([3,3]);
            ctx.beginPath(); ctx.moveTo(cvW/2,0); ctx.lineTo(cvW/2,cvH); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0,cvH/2); ctx.lineTo(cvW,cvH/2); ctx.stroke();
            ctx.setLineDash([]);
        }

        if (pts.length === 0) {
            ctx.fillStyle = '#444'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Click to add vertices', cvW/2, cvH/2); ctx.textAlign = 'left';
            rebuildList(); updateStatus(); return;
        }

        // Polygon fill + stroke
        const c0 = toCanvas(pts[0]);
        ctx.beginPath(); ctx.moveTo(c0.x, c0.y);
        for (let i = 1; i < pts.length; i++) { const c = toCanvas(pts[i]); ctx.lineTo(c.x, c.y); }
        if (pts.length >= 3) ctx.closePath();
        ctx.fillStyle   = 'rgba(124,58,237,0.2)'; if (pts.length >= 3) ctx.fill();
        ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 1.5; ctx.stroke();

        // Vertices
        pts.forEach((p, i) => {
            const c = toCanvas(p);
            const big = i === dragging || i === hover;
            ctx.beginPath(); ctx.arc(c.x, c.y, big ? 7 : 4, 0, Math.PI*2);
            ctx.fillStyle   = i === dragging ? '#facc15' : i === hover ? '#fff' : '#a78bfa';
            ctx.strokeStyle = '#0d0d1e'; ctx.lineWidth = 1.5;
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = i === dragging ? '#000' : '#fff';
            ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(String(i), c.x, c.y + 3); ctx.textAlign = 'left';
        });

        rebuildList(); updateStatus();
    }

    function updateStatus() {
        const el = panel.querySelector('#pe-status');
        if (!el) return;
        el.textContent = pts.length >= 3
            ? `✓ ${pts.length} vertices — valid`
            : `${pts.length} / 3+ vertices needed`;
        el.style.color = pts.length >= 3 ? '#4ade80' : '#ef4444';
    }

    function rebuildList() {
        const el = panel.querySelector('#pe-vlist');
        if (!el) return;
        el.innerHTML = '';
        pts.forEach((p, i) => {
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;gap:3px;background:${i===hover?'#140e28':'transparent'};border-radius:2px;padding:1px 2px;`;
            row.innerHTML = `
              <span style="color:#7c3aed;font-size:9px;min-width:12px;">${i}</span>
              <input type="number" data-i="${i}" data-ax="x" value="${p.x.toFixed(1)}"
                style="width:46px;${_inp()}background:#0a0a12;font-size:9px;padding:1px 3px;">
              <input type="number" data-i="${i}" data-ax="y" value="${p.y.toFixed(1)}"
                style="width:46px;${_inp()}background:#0a0a12;font-size:9px;padding:1px 3px;">
              <button data-del="${i}" style="${_btn('#ef4444')}padding:1px 3px;font-size:9px;line-height:1;">✕</button>`;
            el.appendChild(row);
        });
        el.querySelectorAll('input[data-i]').forEach(inp => {
            inp.addEventListener('change', () => {
                const i = parseInt(inp.dataset.i), ax = inp.dataset.ax;
                pts[i][ax] = parseFloat(inp.value) || 0;
                draw();
            });
        });
        el.querySelectorAll('button[data-del]').forEach(btn => {
            btn.addEventListener('click', () => { pts.splice(parseInt(btn.dataset.del), 1); draw(); });
        });
    }

    // ── Canvas events ──
    canvas.addEventListener('mousedown', e => {
        e.preventDefault();
        const { cx, cy } = evPos(e);
        if (e.button === 2) {
            const i = nearestPt(cx, cy);
            if (i >= 0) { pts.splice(i, 1); hover = -1; _pushHistory(); draw(); }
            return;
        }
        const i = nearestPt(cx, cy);
        if (i >= 0) { dragging = i; canvas.style.cursor = 'grabbing'; }
        else { pts.push(toLocal(cx, cy)); _pushHistory(); draw(); }
    });

    const _onMove = e => {
        const { cx, cy } = evPos(e);
        if (dragging >= 0) { pts[dragging] = toLocal(cx, cy); draw(); return; }
        const old = hover; hover = nearestPt(cx, cy);
        canvas.style.cursor = hover >= 0 ? 'grab' : 'crosshair';
        if (hover !== old) draw();
    };
    const _onUp = () => { if (dragging >= 0) { dragging = -1; canvas.style.cursor = hover >= 0 ? 'grab' : 'crosshair'; _pushHistory(); draw(); } };

    window.addEventListener('mousemove', _onMove);
    window.addEventListener('mouseup',   _onUp);
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    panel.querySelector('#pe-show-grid').addEventListener('change',   e => { showGrid   = e.target.checked; draw(); });
    panel.querySelector('#pe-show-sprite').addEventListener('change', e => { showSprite = e.target.checked; draw(); });
    panel.querySelector('#pe-snap-grid').addEventListener('change',   e => { snapToGrid = e.target.checked; });
    panel.querySelector('#pe-box').addEventListener('click',    () => { pts = _defaultBox(sprW, sprH);       _pushHistory(); draw(); });
    panel.querySelector('#pe-circle').addEventListener('click', () => { pts = _defaultCircle(Math.min(sprW, sprH) / 2); _pushHistory(); draw(); });
    panel.querySelector('#pe-clear').addEventListener('click',  () => { pts = []; _pushHistory(); draw(); });
    panel.querySelector('#pe-undo')?.addEventListener('click', _undo);
    panel.querySelector('#pe-redo')?.addEventListener('click', _redo);

    // Keyboard shortcuts: Ctrl+Z undo, Ctrl+Y/Ctrl+Shift+Z redo, Delete/Backspace remove hover
    const _keyHandler = e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); _undo(); }
        else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); _redo(); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && hover >= 0) {
            pts.splice(hover, 1); hover = -1; _pushHistory(); draw();
        }
    };
    window.addEventListener('keydown', _keyHandler);

    function saveAndClose() {
        window.removeEventListener('mousemove', _onMove);
        window.removeEventListener('mouseup',   _onUp);
        window.removeEventListener('keydown',   _keyHandler);
        if (pts.length >= 3) {
            if (!obj.physicsPolygons) obj.physicsPolygons = {};
            obj.physicsPolygons[frameId] = pts.map(p => ({ x: p.x, y: p.y }));
            obj.physicsShape = 'polygon';
            // Legacy compat
            if (frameId === 'shared') obj.physicsPolygon = obj.physicsPolygons.shared.slice();
        }
        import('./engine.ui.js').then(m => m.syncPixiToInspector?.());
        import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
        _pushUndo();
        panel.remove();
    }

    panel.querySelector('#pe-save').addEventListener('click', saveAndClose);

    panel.querySelector('#pe-copy-to-all').addEventListener('click', () => {
        if (pts.length < 3) return;
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = pts.map(p => ({ x: p.x, y: p.y }));
        const anims = obj.animations || [];
        anims.forEach(anim => (anim.frames || []).forEach(f => {
            obj.physicsPolygons[f.id] = pts.map(p => ({ x: p.x, y: p.y }));
        }));
        saveAndClose();
    });

    panel.querySelector('#pe-cancel').addEventListener('click', () => {
        window.removeEventListener('mousemove', _onMove);
        window.removeEventListener('mouseup',   _onUp);
        window.removeEventListener('keydown',   _keyHandler);
        panel.remove();
    });
    panel.addEventListener('mousedown', e => {
        if (e.target === panel) {
            window.removeEventListener('mousemove', _onMove);
            window.removeEventListener('mouseup',   _onUp);
            window.removeEventListener('keydown',   _keyHandler);
            panel.remove();
        }
    });

    draw();
}

// ─────────────────────────────────────────────────────────────
// Default shapes
// ─────────────────────────────────────────────────────────────

function _defaultBox(w, h) {
    const hw = w/2 - 0.5, hh = h/2 - 0.5;
    return [{ x:-hw,y:-hh },{ x:hw,y:-hh },{ x:hw,y:hh },{ x:-hw,y:hh }];
}

function _defaultCircle(r, n = 12) {
    return Array.from({ length: n }, (_, i) => ({
        x: Math.round(Math.cos((i/n)*Math.PI*2) * (r-0.5) * 10) / 10,
        y: Math.round(Math.sin((i/n)*Math.PI*2) * (r-0.5) * 10) / 10,
    }));
}

// ─────────────────────────────────────────────────────────────
// Snapshot helpers (include physicsPolygons)
// ─────────────────────────────────────────────────────────────

export function snapshotPhysics(obj) {
    return {
        physicsBody:        obj.physicsBody        ?? 'none',
        physicsFriction:    obj.physicsFriction    ?? 0.3,
        physicsRestitution: obj.physicsRestitution ?? 0.1,
        physicsShape:       obj.physicsShape       ?? 'box',
        physicsPolygon:     obj.physicsPolygon     ? JSON.parse(JSON.stringify(obj.physicsPolygon)) : null,
        physicsPolygons:    obj.physicsPolygons    ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
    };
}

export function restorePhysics(obj, snap) {
    if (!snap) return;
    obj.physicsBody        = snap.physicsBody        ?? 'none';
    obj.physicsFriction    = snap.physicsFriction    ?? 0.3;
    obj.physicsRestitution = snap.physicsRestitution ?? 0.1;
    obj.physicsShape       = snap.physicsShape       ?? 'box';
    obj.physicsPolygon     = snap.physicsPolygon     ? JSON.parse(JSON.stringify(snap.physicsPolygon))  : null;
    obj.physicsPolygons    = snap.physicsPolygons    ? JSON.parse(JSON.stringify(snap.physicsPolygons)) : null;
}

// ─────────────────────────────────────────────────────────────
// Style helpers
// ─────────────────────────────────────────────────────────────

function _btn(c)  { return `background:${c}22;border:1px solid ${c}66;color:${c};border-radius:3px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;`; }
function _sel()   { return `background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 6px;font-size:11px;cursor:pointer;`; }
function _inp()   { return `background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;`; }
