/* ============================================================
   Zengine — engine.physics.js
   Matter.js 2D physics integration.

   • Runs ONLY in play mode (started/stopped by engine.playmode.js)
   • Each game object can have a physics body type:
       'static'   — immovable (walls, ground, platforms)
       'dynamic'  — full physics (gravity, forces, collisions)
       'kinematic'— moved by code, not gravity; still collides
       'none'     — no physics (default)
   • Body type is set per-object: obj.physicsBody = 'static'|'dynamic'|'kinematic'|'none'
   • Auto-tilemaps with physics = 'static' generate one rectangle
     body per filled cell.

   Matter.js is loaded via CDN. To use a local copy, replace:
     const MATTER_CDN = 'https://cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js';
   with the path to your local file, e.g.:
     const MATTER_CDN = './matter.min.js';
   ============================================================ */

import { state } from './engine.state.js';

// ── CDN / local path — swap this to use a downloaded copy ────
const MATTER_CDN = 'https://cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js';

// ── Module-level physics state ────────────────────────────────
let _engine   = null;  // Matter.Engine
let _runner   = null;  // Matter.Runner
let _rafId    = null;  // requestAnimationFrame id
let _bodies   = [];    // { obj, body, offsetX, offsetY }[]
let _loaded   = false; // Matter.js script loaded?

// ─────────────────────────────────────────────────────────────
// Load Matter.js (CDN or local) — called once
// ─────────────────────────────────────────────────────────────

function _loadMatter() {
    return new Promise((resolve, reject) => {
        if (window.Matter) { _loaded = true; resolve(); return; }
        if (document.getElementById('matter-js-script')) {
            // Already injected but not yet loaded
            document.getElementById('matter-js-script').addEventListener('load', () => { _loaded = true; resolve(); });
            document.getElementById('matter-js-script').addEventListener('error', reject);
            return;
        }
        const s   = document.createElement('script');
        s.id      = 'matter-js-script';
        s.src     = MATTER_CDN;
        s.onload  = () => { _loaded = true; resolve(); };
        s.onerror = () => reject(new Error(`Failed to load Matter.js from: ${MATTER_CDN}`));
        document.head.appendChild(s);
    });
}

// ─────────────────────────────────────────────────────────────
// Start physics simulation (called by enterPlayMode)
// ─────────────────────────────────────────────────────────────

export async function startPhysics() {
    if (_engine) stopPhysics(); // safety

    try {
        await _loadMatter();
    } catch (err) {
        console.error('[Physics] Matter.js failed to load:', err);
        return;
    }

    const { Engine, Runner, Bodies, Body, Composite, Events } = window.Matter;

    _engine = Engine.create({ gravity: { x: 0, y: 1 } });
    _bodies = [];

    const bodiesToAdd = [];

    for (const obj of state.gameObjects) {
        const type = obj.physicsBody || 'none';
        if (type === 'none') continue;

        // Auto-tilemap: one rectangle body per filled cell
        if (obj.isAutoTilemap && type === 'static') {
            const d      = obj.autoTileData;
            const cells  = d.cells;
            const ox     = obj.x, oy = obj.y;

            for (let row = 0; row < d.rows; row++) {
                for (let col = 0; col < d.cols; col++) {
                    const v = cells[row * d.cols + col];
                    const filled = Array.isArray(v) ? v.length > 0 : !!v;
                    if (!filled) continue;
                    const cx = ox + col * d.tileW + d.tileW / 2;
                    const cy = oy + row * d.tileH + d.tileH / 2;
                    const body = Bodies.rectangle(cx, cy, d.tileW, d.tileH, {
                        isStatic: true,
                        label:    `autotile_${obj.label}_${row}_${col}`,
                        friction: 0.3, restitution: 0.1,
                    });
                    bodiesToAdd.push(body);
                }
            }
            continue;
        }

        // Regular sprite / image
        const isStatic    = type === 'static';
        const isKinematic = type === 'kinematic';

        // Determine size from sprite or use defaults
        let w = 40, h = 40;
        if (obj.spriteGraphic) {
            w = obj.spriteGraphic.width  * Math.abs(obj.scale?.x ?? 1);
            h = obj.spriteGraphic.height * Math.abs(obj.scale?.y ?? 1);
        } else if (obj.width && obj.height) {
            w = obj.width; h = obj.height;
        }

        const body = Bodies.rectangle(obj.x, obj.y, Math.max(w, 4), Math.max(h, 4), {
            isStatic:    isStatic,
            isSensor:    false,
            label:       obj.label,
            friction:    obj.physicsFriction    ?? 0.3,
            restitution: obj.physicsRestitution ?? 0.1,
            frictionAir: isKinematic ? 1 : 0.01,  // kinematic objects resist gravity via high air friction
        });

        // Kinematic: effectively zero gravity by setting mass to zero-like behavior
        if (isKinematic) {
            Body.setMass(body, 1);
            Body.setInertia(body, Infinity);
        }

        // Sync initial position
        Body.setPosition(body, { x: obj.x, y: obj.y });
        if (!isStatic && !isKinematic) {
            Body.setAngle(body, obj.rotation || 0);
        }

        // Store velocity for kinematic
        if (isKinematic) {
            body.isKinematic = true;
            Body.setVelocity(body, { x: 0, y: 0 });
        }

        bodiesToAdd.push(body);
        _bodies.push({ obj, body, type });
    }

    Composite.add(_engine.world, bodiesToAdd);

    // ── Main loop ──
    let lastTime = null;
    function _tick(now) {
        _rafId = requestAnimationFrame(_tick);
        if (state.isPaused) return;
        const delta = lastTime ? Math.min(now - lastTime, 50) : 16.67;
        lastTime    = now;

        Engine.update(_engine, delta);

        // Sync Matter bodies → PixiJS objects
        for (const entry of _bodies) {
            const { obj, body, type } = entry;
            if (type === 'static') continue; // statics never move

            if (type === 'kinematic') {
                // For kinematic: push the Matter body toward current PIXI position
                // (allows script-driven movement to interact with physics)
                Body.setPosition(body, { x: obj.x, y: obj.y });
                Body.setAngle(body, obj.rotation || 0);
            } else {
                // Dynamic: copy Matter body position back to PIXI
                obj.x        = body.position.x;
                obj.y        = body.position.y;
                obj.rotation = body.angle;
            }
        }
    }

    _rafId = requestAnimationFrame(_tick);
    console.log(`[Physics] Started — ${_bodies.length} physics objects, ${bodiesToAdd.length} total bodies`);
}

// ─────────────────────────────────────────────────────────────
// Stop physics (called by stopPlayMode)
// ─────────────────────────────────────────────────────────────

export function stopPhysics() {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_engine && window.Matter) {
        window.Matter.Engine.clear(_engine);
        window.Matter.Composite.clear(_engine.world, false);
    }
    _engine = null;
    _bodies = [];
    console.log('[Physics] Stopped');
}

// ─────────────────────────────────────────────────────────────
// Inspector HTML — shown for every regular game object
// ─────────────────────────────────────────────────────────────

export function buildPhysicsInspectorHTML(obj) {
    const type         = obj.physicsBody      ?? 'none';
    const friction     = obj.physicsFriction    ?? 0.3;
    const restitution  = obj.physicsRestitution ?? 0.1;

    const opt = v => `<option value="${v}" ${type === v ? 'selected' : ''}>${v.charAt(0).toUpperCase() + v.slice(1)}</option>`;

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
          <select id="physics-body-type" style="background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 6px;font-size:11px;cursor:pointer;">
            ${opt('none')}
            ${opt('static')}
            ${opt('dynamic')}
            ${opt('kinematic')}
          </select>
        </div>

        <div id="physics-extra-props" style="display:${type === 'none' ? 'none' : 'flex'};flex-direction:column;gap:5px;">
          <div class="prop-row">
            <span class="prop-label">Friction</span>
            <input id="physics-friction" type="number" value="${friction}" min="0" max="1" step="0.05"
              style="width:60px;background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;">
          </div>
          <div class="prop-row">
            <span class="prop-label">Bounce</span>
            <input id="physics-restitution" type="number" value="${restitution}" min="0" max="1" step="0.05"
              style="width:60px;background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;">
          </div>
          <div style="background:#1a1400;border:1px solid #facc1544;border-radius:3px;padding:4px 6px;font-size:9px;color:#facc1599;">
            Physics runs only in play mode ▶
          </div>
        </div>

      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// Bind inspector events (call after injecting HTML)
// ─────────────────────────────────────────────────────────────

export function bindPhysicsInspector(obj) {
    const sel   = document.getElementById('physics-body-type');
    const extra = document.getElementById('physics-extra-props');
    const fric  = document.getElementById('physics-friction');
    const rest  = document.getElementById('physics-restitution');

    if (!sel) return;

    sel.addEventListener('change', () => {
        obj.physicsBody = sel.value;
        if (extra) extra.style.display = sel.value === 'none' ? 'none' : 'flex';
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
    });

    fric?.addEventListener('change', () => {
        obj.physicsFriction = Math.max(0, Math.min(1, parseFloat(fric.value) || 0));
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
    });

    rest?.addEventListener('change', () => {
        obj.physicsRestitution = Math.max(0, Math.min(1, parseFloat(rest.value) || 0));
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
    });
}

// ─────────────────────────────────────────────────────────────
// Snapshot helpers (so physics props survive scene save/load)
// ─────────────────────────────────────────────────────────────

export function snapshotPhysics(obj) {
    return {
        physicsBody:        obj.physicsBody        ?? 'none',
        physicsFriction:    obj.physicsFriction    ?? 0.3,
        physicsRestitution: obj.physicsRestitution ?? 0.1,
    };
}

export function restorePhysics(obj, snap) {
    if (!snap) return;
    obj.physicsBody        = snap.physicsBody        ?? 'none';
    obj.physicsFriction    = snap.physicsFriction    ?? 0.3;
    obj.physicsRestitution = snap.physicsRestitution ?? 0.1;
}
