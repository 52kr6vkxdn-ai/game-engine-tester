/* ============================================================
   Zengine — engine.physics.js  v2
   Matter.js 2D physics integration.

   Key rules:
   • Tilemaps and Auto-Tilemaps are ALWAYS static — their physics
     type is locked to 'static' and cannot be changed.
   • Regular sprites can be: none | static | dynamic | kinematic
   • Each object can have a custom collision shape:
       'box'     — axis-aligned bounding rectangle (default)
       'circle'  — circle fitted to the shorter axis
       'polygon' — user-drawn convex polygon (in object-local coords)
   • Physics runs ONLY in play mode.

   To swap CDN for local file, change MATTER_CDN below to
   e.g. './matter.min.js'
   ============================================================ */

import { state } from './engine.state.js';

const MATTER_CDN = 'https://cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js';

// ── Module-level state ────────────────────────────────────────
let _engine   = null;
let _rafId    = null;
let _bodies   = [];   // { obj, body, type }[]

// ─────────────────────────────────────────────────────────────
// CDN loader
// ─────────────────────────────────────────────────────────────

function _loadMatter() {
    return new Promise((resolve, reject) => {
        if (window.Matter) { resolve(); return; }
        const existing = document.getElementById('matter-js-script');
        if (existing) {
            existing.addEventListener('load',  resolve);
            existing.addEventListener('error', reject);
            return;
        }
        const s   = document.createElement('script');
        s.id      = 'matter-js-script';
        s.src     = MATTER_CDN;
        s.onload  = resolve;
        s.onerror = () => reject(new Error(`Matter.js failed to load from: ${MATTER_CDN}`));
        document.head.appendChild(s);
    });
}

// ─────────────────────────────────────────────────────────────
// Collision shape → Matter body vertices
// ─────────────────────────────────────────────────────────────

function _makeMatterBody(Bodies, Body, Vertices, obj, cx, cy, w, h) {
    const shape  = obj.physicsShape || 'box';
    const verts  = obj.physicsPolygon;          // [{x,y}] in local-pixel coords

    if (shape === 'circle') {
        const r = Math.max(Math.min(w, h) / 2, 2);
        return Bodies.circle(cx, cy, r, _bodyOpts(obj));
    }

    if (shape === 'polygon' && Array.isArray(verts) && verts.length >= 3) {
        // verts are in local coords; transform to world
        const worldVerts = verts.map(p => ({
            x: cx + p.x * (obj.scale?.x ?? 1),
            y: cy + p.y * (obj.scale?.y ?? 1),
        }));
        try {
            // Matter.js requires convex polygon; use fromVertices which handles decomp
            return Bodies.fromVertices(cx, cy, worldVerts, _bodyOpts(obj), true);
        } catch (_) {
            // Fall back to box if polygon is invalid
        }
    }

    // Default: box
    return Bodies.rectangle(cx, cy, Math.max(w, 4), Math.max(h, 4), _bodyOpts(obj));
}

function _bodyOpts(obj) {
    return {
        isStatic:    (obj.physicsBody === 'static'),
        label:       obj.label,
        friction:    obj.physicsFriction    ?? 0.3,
        restitution: obj.physicsRestitution ?? 0.1,
        frictionAir: obj.physicsBody === 'kinematic' ? 1.0 : 0.01,
    };
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

export async function startPhysics() {
    if (_engine) stopPhysics();

    try { await _loadMatter(); }
    catch (err) { console.error('[Physics] Matter.js load failed:', err); return; }

    const { Engine, Bodies, Body, Composite, Vertices } = window.Matter;

    _engine = Engine.create({ gravity: { x: 0, y: 1 } });
    _bodies = [];
    const toAdd = [];

    for (const obj of state.gameObjects) {
        // ── Tilemaps: always static, one body per filled cell ──
        if (obj.isTilemap) {
            const td   = obj.tilemapData;
            const ox   = obj.x, oy = obj.y;
            for (let row = 0; row < td.rows; row++) {
                for (let col = 0; col < td.cols; col++) {
                    if (!td.tiles[row * td.cols + col]) continue;
                    const cx = ox + col * td.tileW + td.tileW / 2;
                    const cy = oy + row * td.tileH + td.tileH / 2;
                    toAdd.push(Bodies.rectangle(cx, cy, td.tileW, td.tileH, {
                        isStatic: true, label: `tm_${obj.label}_${row}_${col}`,
                        friction: 0.3, restitution: 0.1,
                    }));
                }
            }
            continue;
        }

        if (obj.isAutoTilemap) {
            const d   = obj.autoTileData;
            const ox  = obj.x, oy = obj.y;
            for (let row = 0; row < d.rows; row++) {
                for (let col = 0; col < d.cols; col++) {
                    const v = d.cells[row * d.cols + col];
                    if (!(Array.isArray(v) ? v.length : v)) continue;
                    const cx = ox + col * d.tileW + d.tileW / 2;
                    const cy = oy + row * d.tileH + d.tileH / 2;
                    toAdd.push(Bodies.rectangle(cx, cy, d.tileW, d.tileH, {
                        isStatic: true, label: `at_${obj.label}_${row}_${col}`,
                        friction: 0.3, restitution: 0.1,
                    }));
                }
            }
            continue;
        }

        // ── Regular objects ──
        const type = obj.physicsBody || 'none';
        if (type === 'none') continue;

        let w = 40, h = 40;
        if (obj.spriteGraphic) {
            w = (obj.spriteGraphic.texture?.orig?.width  || obj.spriteGraphic.width  || 40) * Math.abs(obj.scale?.x ?? 1);
            h = (obj.spriteGraphic.texture?.orig?.height || obj.spriteGraphic.height || 40) * Math.abs(obj.scale?.y ?? 1);
        }

        const body = _makeMatterBody(Bodies, Body, Vertices, obj, obj.x, obj.y, w, h);
        if (!body) continue;

        Body.setAngle(body, obj.rotation || 0);
        if (type === 'kinematic') Body.setInertia(body, Infinity);

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
                obj.x        = body.position.x;
                obj.y        = body.position.y;
                obj.rotation = body.angle;
            }
        }
    }
    _rafId = requestAnimationFrame(tick);
}

// ─────────────────────────────────────────────────────────────
// Stop
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
    const isTilemap = obj.isTilemap || obj.isAutoTilemap;

    // Tilemaps: locked static, but show collision shape editor
    if (isTilemap) {
        return `
        <div class="component-block" id="inspector-physics-section">
          <div class="component-header">
            <svg viewBox="0 0 24 24" class="comp-icon" style="color:#facc15;fill:none;stroke:currentColor;stroke-width:2;">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18M9 3v18"/>
            </svg>
            <span style="font-weight:600;color:#facc15;">Physics</span>
          </div>
          <div class="component-body" style="display:flex;flex-direction:column;gap:5px;">
            <div class="prop-row">
              <span class="prop-label">Body</span>
              <span style="color:#4ade80;font-size:11px;font-weight:600;">Static (locked)</span>
            </div>
            <div style="background:#1a1a10;border:1px solid #facc1533;border-radius:3px;padding:4px 6px;font-size:9px;color:#facc1577;">
              Tilemaps are always static colliders. Physics active in play mode ▶
            </div>
          </div>
        </div>`;
    }

    // Regular sprite
    const type        = obj.physicsBody      ?? 'none';
    const friction    = obj.physicsFriction    ?? 0.3;
    const restitution = obj.physicsRestitution ?? 0.1;
    const shape       = obj.physicsShape      ?? 'box';

    const opt  = (v, label) => `<option value="${v}" ${type  === v ? 'selected' : ''}>${label}</option>`;
    const sopt = (v, label) => `<option value="${v}" ${shape === v ? 'selected' : ''}>${label}</option>`;

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
            ${opt('none',      'None')}
            ${opt('static',    'Static')}
            ${opt('dynamic',   'Dynamic')}
            ${opt('kinematic', 'Kinematic')}
          </select>
        </div>

        <div id="phys-extra" style="display:${type === 'none' ? 'none' : 'flex'};flex-direction:column;gap:5px;">

          <div class="prop-row">
            <span class="prop-label">Collision</span>
            <select id="phys-shape" style="${_sel()}">
              ${sopt('box',     '▭ Box')}
              ${sopt('circle',  '◯ Circle')}
              ${sopt('polygon', '⬡ Polygon')}
            </select>
          </div>

          <div id="phys-polygon-row" style="display:${shape === 'polygon' ? 'flex' : 'none'};flex-direction:column;gap:4px;">
            <button id="phys-edit-polygon" style="${_btn('#7c3aed')}width:100%;margin-top:2px;">
              ✏ Edit Collision Polygon
            </button>
            <div id="phys-poly-summary" style="color:#888;font-size:9px;text-align:center;">
              ${_polySummary(obj)}
            </div>
          </div>

          <div class="prop-row">
            <span class="prop-label">Friction</span>
            <input id="phys-friction" type="number" value="${friction}" min="0" max="1" step="0.05"
              style="width:60px;${_inp()}">
          </div>
          <div class="prop-row">
            <span class="prop-label">Bounce</span>
            <input id="phys-bounce" type="number" value="${restitution}" min="0" max="1" step="0.05"
              style="width:60px;${_inp()}">
          </div>

          <div style="background:#1a1400;border:1px solid #facc1533;border-radius:3px;padding:4px 6px;font-size:9px;color:#facc1566;">
            Physics active in play mode ▶
          </div>
        </div>
      </div>
    </div>`;
}

function _polySummary(obj) {
    const p = obj.physicsPolygon;
    return (Array.isArray(p) && p.length >= 3)
        ? `${p.length} vertices defined`
        : 'No polygon — draw one';
}

// ─────────────────────────────────────────────────────────────
// Bind inspector events
// ─────────────────────────────────────────────────────────────

export function bindPhysicsInspector(obj) {
    const typeEl   = document.getElementById('phys-type');
    const extra    = document.getElementById('phys-extra');
    const shapeEl  = document.getElementById('phys-shape');
    const polyRow  = document.getElementById('phys-polygon-row');
    const editBtn  = document.getElementById('phys-edit-polygon');
    const fricEl   = document.getElementById('phys-friction');
    const bounceEl = document.getElementById('phys-bounce');

    if (!typeEl) return;

    typeEl.addEventListener('change', () => {
        obj.physicsBody = typeEl.value;
        if (extra) extra.style.display = typeEl.value === 'none' ? 'none' : 'flex';
        _pushUndo();
    });

    shapeEl?.addEventListener('change', () => {
        obj.physicsShape = shapeEl.value;
        if (polyRow) polyRow.style.display = shapeEl.value === 'polygon' ? 'flex' : 'none';
        _pushUndo();
    });

    editBtn?.addEventListener('click', () => openPolygonEditor(obj));

    fricEl?.addEventListener('change', () => {
        obj.physicsFriction = Math.max(0, Math.min(1, parseFloat(fricEl.value) || 0));
        _pushUndo();
    });

    bounceEl?.addEventListener('change', () => {
        obj.physicsRestitution = Math.max(0, Math.min(1, parseFloat(bounceEl.value) || 0));
        _pushUndo();
    });
}

function _pushUndo() {
    import('./engine.history.js').then(({ pushUndo }) => pushUndo());
}

// ─────────────────────────────────────────────────────────────
// Collision Polygon Editor
// ─────────────────────────────────────────────────────────────

export function openPolygonEditor(obj) {
    document.getElementById('poly-editor-panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'poly-editor-panel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.75);backdrop-filter:blur(3px);font-family:sans-serif;';

    // Get sprite size for canvas
    let sprW = 120, sprH = 120;
    if (obj.spriteGraphic) {
        sprW = obj.spriteGraphic.texture?.orig?.width  || obj.spriteGraphic.width  || 120;
        sprH = obj.spriteGraphic.texture?.orig?.height || obj.spriteGraphic.height || 120;
    }
    const SCALE  = Math.min(400 / sprW, 400 / sprH, 3);
    const cvW    = Math.round(sprW * SCALE);
    const cvH    = Math.round(sprH * SCALE);

    // Current polygon (in local pixel coords)
    let pts = Array.isArray(obj.physicsPolygon) && obj.physicsPolygon.length >= 3
        ? obj.physicsPolygon.map(p => ({ x: p.x, y: p.y }))
        : _defaultBox(sprW, sprH);

    let draggingIdx = -1;
    let hoverIdx    = -1;
    const SNAP_R    = 10;

    panel.innerHTML = `
    <div style="background:#0d0d1e;border:1px solid #7c3aed55;border-radius:8px;padding:0;overflow:hidden;
                display:flex;flex-direction:column;min-width:500px;max-width:90vw;">

      <!-- Header -->
      <div style="padding:12px 16px;border-bottom:1px solid #1a1a30;display:flex;align-items:center;justify-content:space-between;">
        <span style="color:#7c3aed;font-weight:700;font-size:14px;">Collision Polygon Editor</span>
        <div style="display:flex;gap:6px;">
          <button id="pe-reset-box"    style="${_btn('#3b82f6')}">↺ Box</button>
          <button id="pe-reset-circle" style="${_btn('#06b6d4')}">↺ Circle</button>
          <button id="pe-clear"        style="${_btn('#ef4444')}">✕ Clear</button>
        </div>
      </div>

      <!-- Canvas -->
      <div style="padding:16px;display:flex;gap:16px;align-items:flex-start;">
        <div style="display:flex;flex-direction:column;gap:6px;align-items:center;">
          <div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">
            Click: add vertex  •  Drag: move  •  Right-click: delete
          </div>
          <canvas id="pe-canvas" width="${cvW}" height="${cvH}"
            style="background:#0a0a18;border:1px solid #1a1a30;border-radius:4px;cursor:crosshair;display:block;"
            oncontextmenu="return false;"></canvas>
        </div>

        <!-- Vertex list -->
        <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-width:140px;">
          <div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Vertices (local px)</div>
          <div id="pe-vertex-list" style="display:flex;flex-direction:column;gap:3px;max-height:340px;overflow-y:auto;"></div>
          <div id="pe-info" style="color:#555;font-size:9px;margin-top:6px;"></div>
        </div>
      </div>

      <!-- Footer -->
      <div style="padding:10px 16px;border-top:1px solid #1a1a30;display:flex;justify-content:flex-end;gap:8px;">
        <button id="pe-cancel" style="${_btn('#555')}">Cancel</button>
        <button id="pe-save"   style="${_btn('#7c3aed')}font-weight:700;">✓ Save Polygon</button>
      </div>
    </div>`;

    document.body.appendChild(panel);

    const canvas = panel.querySelector('#pe-canvas');
    const ctx    = canvas.getContext('2d');

    // ── Load sprite preview ──
    let spriteImg = null;
    if (obj.spriteGraphic?.texture?.baseTexture?.resource?.source) {
        const src = obj.spriteGraphic.texture.baseTexture.resource.source;
        spriteImg = new Image();
        spriteImg.onload = draw;
        spriteImg.src    = src.src || src.currentSrc || '';
    }

    function localToCanvas(p) {
        return { x: (p.x + sprW/2) * SCALE, y: (p.y + sprH/2) * SCALE };
    }
    function canvasToLocal(x, y) {
        return { x: x / SCALE - sprW/2, y: y / SCALE - sprH/2 };
    }

    function draw() {
        ctx.clearRect(0, 0, cvW, cvH);

        // Sprite preview
        if (spriteImg?.complete && spriteImg.naturalWidth > 0) {
            ctx.globalAlpha = 0.35;
            ctx.drawImage(spriteImg, 0, 0, cvW, cvH);
            ctx.globalAlpha = 1;
        } else {
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, cvW, cvH);
        }

        // Center cross-hair
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth   = 0.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(cvW/2, 0); ctx.lineTo(cvW/2, cvH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, cvH/2); ctx.lineTo(cvW, cvH/2); ctx.stroke();
        ctx.setLineDash([]);

        if (pts.length < 2) {
            ctx.fillStyle = '#555'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Click to add vertices', cvW/2, cvH/2);
            rebuildList(); return;
        }

        // Fill
        ctx.beginPath();
        const c0 = localToCanvas(pts[0]); ctx.moveTo(c0.x, c0.y);
        for (let i = 1; i < pts.length; i++) { const c = localToCanvas(pts[i]); ctx.lineTo(c.x, c.y); }
        ctx.closePath();
        ctx.fillStyle   = 'rgba(124,58,237,0.18)'; ctx.fill();
        ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 1.5; ctx.stroke();

        // Vertices
        pts.forEach((p, i) => {
            const c = localToCanvas(p);
            const isHover = i === hoverIdx;
            const isDrag  = i === draggingIdx;
            ctx.beginPath();
            ctx.arc(c.x, c.y, isDrag ? 8 : isHover ? 6 : 4, 0, Math.PI * 2);
            ctx.fillStyle   = isDrag ? '#facc15' : isHover ? '#fff' : '#7c3aed';
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
            ctx.fill(); ctx.stroke();

            // Index label
            ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(String(i), c.x, c.y + 3.5);
        });

        rebuildList();
        panel.querySelector('#pe-info').textContent = pts.length >= 3
            ? `${pts.length} vertices — valid polygon`
            : `${pts.length} vertices — need at least 3`;
    }

    function rebuildList() {
        const listEl = panel.querySelector('#pe-vertex-list');
        listEl.innerHTML = '';
        pts.forEach((p, i) => {
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;gap:4px;padding:2px 4px;border-radius:2px;background:${i===hoverIdx?'#1a1030':'transparent'};font-size:10px;color:#aaa;`;
            row.innerHTML = `<span style="color:#7c3aed;min-width:14px;">${i}</span>
              <span>x: <input type="number" value="${p.x.toFixed(1)}" data-i="${i}" data-ax="x"
                style="width:50px;${_inp()}background:#0a0a18;"> px</span>
              <span>y: <input type="number" value="${p.y.toFixed(1)}" data-i="${i}" data-ax="y"
                style="width:50px;${_inp()}background:#0a0a18;"> px</span>
              <button data-del="${i}" style="${_btn('#ef4444')}padding:1px 4px;font-size:9px;">✕</button>`;
            listEl.appendChild(row);
        });
        listEl.querySelectorAll('input[data-i]').forEach(inp => {
            inp.addEventListener('change', () => {
                const i  = parseInt(inp.dataset.i);
                const ax = inp.dataset.ax;
                pts[i][ax] = parseFloat(inp.value) || 0;
                draw();
            });
        });
        listEl.querySelectorAll('button[data-del]').forEach(btn => {
            btn.addEventListener('click', () => {
                pts.splice(parseInt(btn.dataset.del), 1);
                draw();
            });
        });
    }

    // ── Canvas interactions ──
    function _getIdx(e) {
        const rect = canvas.getBoundingClientRect();
        const cx   = (e.clientX - rect.left) * (cvW / rect.width);
        const cy   = (e.clientY - rect.top)  * (cvH / rect.height);
        for (let i = 0; i < pts.length; i++) {
            const c = localToCanvas(pts[i]);
            if (Math.hypot(cx - c.x, cy - c.y) < SNAP_R) return i;
        }
        return -1;
    }

    canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const cx   = (e.clientX - rect.left) * (cvW / rect.width);
        const cy   = (e.clientY - rect.top)  * (cvH / rect.height);

        if (draggingIdx >= 0) {
            pts[draggingIdx] = canvasToLocal(cx, cy);
            draw(); return;
        }
        const old = hoverIdx;
        hoverIdx = _getIdx(e);
        if (hoverIdx !== old) draw();
        canvas.style.cursor = hoverIdx >= 0 ? 'grab' : 'crosshair';
    });

    canvas.addEventListener('mousedown', e => {
        e.preventDefault();
        const idx = _getIdx(e);
        if (e.button === 0) {
            if (idx >= 0) { draggingIdx = idx; canvas.style.cursor = 'grabbing'; }
            else {
                const rect = canvas.getBoundingClientRect();
                const cx   = (e.clientX - rect.left) * (cvW / rect.width);
                const cy   = (e.clientY - rect.top)  * (cvH / rect.height);
                pts.push(canvasToLocal(cx, cy));
                draw();
            }
        }
    });

    canvas.addEventListener('contextmenu', e => {
        e.preventDefault();
        const idx = _getIdx(e);
        if (idx >= 0) { pts.splice(idx, 1); hoverIdx = -1; draw(); }
    });

    window.addEventListener('mouseup', () => {
        if (draggingIdx >= 0) { draggingIdx = -1; canvas.style.cursor = hoverIdx >= 0 ? 'grab' : 'crosshair'; draw(); }
    }, { once: false });

    // ── Preset buttons ──
    panel.querySelector('#pe-reset-box').addEventListener('click', () => {
        pts = _defaultBox(sprW, sprH); draw();
    });
    panel.querySelector('#pe-reset-circle').addEventListener('click', () => {
        pts = _defaultCircle(Math.min(sprW, sprH) / 2); draw();
    });
    panel.querySelector('#pe-clear').addEventListener('click', () => {
        pts = []; draw();
    });

    // ── Save / Cancel ──
    panel.querySelector('#pe-save').addEventListener('click', () => {
        if (pts.length >= 3) {
            obj.physicsPolygon = pts.map(p => ({ x: p.x, y: p.y }));
            obj.physicsShape   = 'polygon';
            // Refresh inspector
            import('./engine.ui.js').then(m => m.syncPixiToInspector?.());
            _pushUndo();
        }
        panel.remove();
    });
    panel.querySelector('#pe-cancel').addEventListener('click', () => panel.remove());
    panel.addEventListener('mousedown', e => { if (e.target === panel) panel.remove(); });

    draw();
}

function _defaultBox(w, h) {
    const hw = w/2 - 1, hh = h/2 - 1;
    return [ {x:-hw,y:-hh}, {x:hw,y:-hh}, {x:hw,y:hh}, {x:-hw,y:hh} ];
}

function _defaultCircle(r, n = 12) {
    return Array.from({ length: n }, (_, i) => ({
        x: Math.cos((i / n) * Math.PI * 2) * (r - 1),
        y: Math.sin((i / n) * Math.PI * 2) * (r - 1),
    }));
}

// ─────────────────────────────────────────────────────────────
// Snapshot helpers
// ─────────────────────────────────────────────────────────────

export function snapshotPhysics(obj) {
    return {
        physicsBody:        obj.physicsBody        ?? 'none',
        physicsFriction:    obj.physicsFriction    ?? 0.3,
        physicsRestitution: obj.physicsRestitution ?? 0.1,
        physicsShape:       obj.physicsShape       ?? 'box',
        physicsPolygon:     obj.physicsPolygon     ? JSON.parse(JSON.stringify(obj.physicsPolygon)) : null,
    };
}

export function restorePhysics(obj, snap) {
    if (!snap) return;
    obj.physicsBody        = snap.physicsBody        ?? 'none';
    obj.physicsFriction    = snap.physicsFriction    ?? 0.3;
    obj.physicsRestitution = snap.physicsRestitution ?? 0.1;
    obj.physicsShape       = snap.physicsShape       ?? 'box';
    obj.physicsPolygon     = snap.physicsPolygon     ? JSON.parse(JSON.stringify(snap.physicsPolygon)) : null;
}

// ─────────────────────────────────────────────────────────────
// Style helpers
// ─────────────────────────────────────────────────────────────

function _btn(c) {
    return `background:${c}22;border:1px solid ${c}66;color:${c};border-radius:3px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;`;
}
function _sel() {
    return `background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 6px;font-size:11px;cursor:pointer;`;
}
function _inp() {
    return `background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;`;
}
