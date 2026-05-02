/* ============================================================
   Zengine — engine.scripting.js
   Sandboxed JavaScript scripting system.
   Scripts run ONLY in Play Mode, inside a locked-down API.
   ============================================================ */

import { state } from './engine.state.js';

// ── Script Storage (IndexedDB) ────────────────────────────────
const DB_NAME    = 'ZengineScripts';
const DB_VERSION = 1;
const STORE      = 'scripts';

let _db = null;

function _openDB() {
    return new Promise((resolve, reject) => {
        if (_db) { resolve(_db); return; }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'name' });
                store.createIndex('name', 'name', { unique: true });
            }
        };
        req.onsuccess = e => { _db = e.target.result; resolve(_db); };
        req.onerror   = e => reject(e.target.error);
    });
}

export async function saveScript(name, code) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.put({ name, code, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror    = e  => reject(e.target.error);
    });
}

export async function loadScript(name) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req   = store.get(name);
        req.onsuccess = e => resolve(e.target.result || null);
        req.onerror   = e => reject(e.target.error);
    });
}

export async function listScripts() {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const req   = store.getAll();
        req.onsuccess = e => resolve(e.target.result || []);
        req.onerror   = e => reject(e.target.error);
    });
}

export async function deleteScript(name) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        store.delete(name);
        tx.oncomplete = () => resolve();
        tx.onerror    = e  => reject(e.target.error);
    });
}

// ── Active script instances (cleared on stop) ─────────────────
const _activeInstances = [];
let   _tickerFn        = null;

// ── Build the sandboxed API for one object ───────────────────
function _buildSandbox(obj) {
    // --- Input state (updated by runtime) ---
    const _keys    = new Set();
    const _keysJustDown = new Set();
    const _mouse   = { x: 0, y: 0, down: false };

    const api = {
        // ── Transform ───────────────────────────────────────
        get x()        { return obj.x  /  100; },
        set x(v)       { obj.x  =  v   * 100;  },
        get y()        { return -obj.y /  100; },
        set y(v)       { obj.y  = -v   * 100;  },
        get rotation() { return -(obj.rotation * 180 / Math.PI); },
        set rotation(v){ obj.rotation = -(v * Math.PI / 180); },
        get scaleX()   { return obj.scale.x; },
        set scaleX(v)  { obj.scale.x = v;    },
        get scaleY()   { return obj.scale.y; },
        set scaleY(v)  { obj.scale.y = v;    },
        get visible()  { return obj.visible; },
        set visible(v) { obj.visible = !!v;  },
        get alpha()    { return obj.alpha;   },
        set alpha(v)   { obj.alpha = Math.max(0, Math.min(1, v)); },

        // ── Movement helpers ─────────────────────────────────
        translate(dx, dy) {
            obj.x += dx * 100;
            obj.y -= dy * 100;
        },
        moveTo(x, y) {
            obj.x =  x * 100;
            obj.y = -y * 100;
        },
        lookAt(tx, ty) {
            const dx = tx * 100 - obj.x;
            const dy = ty * 100 - obj.y;
            obj.rotation = -Math.atan2(-dy, dx);
        },

        // ── Input ────────────────────────────────────────────
        input: {
            isKeyDown:     (k) => _keys.has(k.toLowerCase()),
            isKeyJustDown: (k) => _keysJustDown.has(k.toLowerCase()),
            get mouseX()  { return _mouse.x; },
            get mouseY()  { return _mouse.y; },
            get mouseDown(){ return _mouse.down; },
        },

        // ── Animation ────────────────────────────────────────
        playAnimation(name) {
            const idx = obj.animations?.findIndex(a => a.name === name);
            if (idx !== undefined && idx >= 0) {
                obj.activeAnimIndex = idx;
                if (obj._runtimeSprite && obj.animations[idx]?.frames?.length > 1) {
                    try { obj._runtimeSprite.gotoAndPlay(0); } catch (_) {}
                }
            }
        },
        stopAnimation() {
            if (obj._runtimeSprite) {
                try { obj._runtimeSprite.stop(); } catch (_) {}
            }
        },
        get currentAnimation() {
            return obj.animations?.[obj.activeAnimIndex]?.name ?? '';
        },

        // ── Physics ──────────────────────────────────────────
        physics: {
            applyForce(fx, fy) {
                if (obj._physicsBody?.applyForce) {
                    obj._physicsBody.applyForce({ x: fx, y: -fy }, obj._physicsBody.getPosition());
                }
            },
            applyImpulse(ix, iy) {
                if (obj._physicsBody?.applyLinearImpulse) {
                    obj._physicsBody.applyLinearImpulse({ x: ix, y: -iy }, obj._physicsBody.getPosition());
                }
            },
            setVelocity(vx, vy) {
                if (obj._physicsBody?.setLinearVelocity) {
                    obj._physicsBody.setLinearVelocity({ x: vx, y: -vy });
                }
            },
            get velX() {
                return obj._physicsBody?.getLinearVelocity?.()?.x ?? 0;
            },
            get velY() {
                return -(obj._physicsBody?.getLinearVelocity?.()?.y ?? 0);
            },
        },

        // ── Object lookup ─────────────────────────────────────
        find(label) {
            const found = state.gameObjects.find(o => o.label === label);
            if (!found) return null;
            // Return a minimal proxy with transform only
            return {
                get x()   { return found.x  /  100; },
                get y()   { return -found.y /  100; },
                get name(){ return found.label; },
            };
        },

        // ── Math helpers ──────────────────────────────────────
        math: {
            lerp:    (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t)),
            clamp:   (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
            dist:    (x1, y1, x2, y2) => Math.sqrt((x2-x1)**2 + (y2-y1)**2),
            randInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
            rand:    (min, max) => Math.random() * (max - min) + min,
            sin:     Math.sin,
            cos:     Math.cos,
            abs:     Math.abs,
            round:   Math.round,
            floor:   Math.floor,
            ceil:    Math.ceil,
            PI:      Math.PI,
        },

        // ── Console ───────────────────────────────────────────
        log(...args) {
            _logConsole(`[${obj.label}] ${args.map(String).join(' ')}`, '#9bc');
        },
        warn(...args) {
            _logConsole(`[${obj.label}] ⚠ ${args.map(String).join(' ')}`, '#facc15');
        },

        // ── Time ──────────────────────────────────────────────
        get time() { return performance.now() / 1000; },
    };

    // Return the api AND internal input mutators
    return { api, _keys, _keysJustDown, _mouse };
}

// ── Script Instance ──────────────────────────────────────────
class ScriptInstance {
    constructor(obj, scriptName, code) {
        this.obj        = obj;
        this.name       = scriptName;
        this._started   = false;
        this._onStart   = null;
        this._onUpdate  = null;
        this._onStop    = null;
        this._onCollide = null;

        const { api, _keys, _keysJustDown, _mouse } = _buildSandbox(obj);
        this.api         = api;
        this._keys       = _keys;
        this._keysJustDown = _keysJustDown;
        this._mouse      = _mouse;

        this._compile(code, api);
    }

    _compile(code, api) {
        // Provide a clean set of event registration functions + math shorthands
        const registerFn = `
            let _onStart   = null;
            let _onUpdate  = null;
            let _onStop    = null;
            let _onCollide = null;

            function onStart(fn)         { _onStart   = fn; }
            function onUpdate(fn)        { _onUpdate  = fn; }
            function onStop(fn)          { _onStop    = fn; }
            function onCollision(fn)     { _onCollide = fn; }

            // Destructure the API so users write "x" instead of "api.x"
            const {
                translate, moveTo, lookAt, playAnimation, stopAnimation,
                find, log, warn, input, physics, math, visible, alpha,
            } = api;
            // Getters/setters can't be destructured, expose them as functions:
            const getX        = () => api.x;
            const setX        = (v) => { api.x = v; };
            const getY        = () => api.y;
            const setY        = (v) => { api.y = v; };
            const getRotation = () => api.rotation;
            const setRotation = (v) => { api.rotation = v; };
            const getScaleX   = () => api.scaleX;
            const setScaleX   = (v) => { api.scaleX = v; };
            const getScaleY   = () => api.scaleY;
            const setScaleY   = (v) => { api.scaleY = v; };
            const getTime     = () => api.time;
            const currentAnimation = () => api.currentAnimation;

            // Shorthand math
            const { lerp, clamp, dist, randInt, rand, sin, cos, abs, round, floor, ceil, PI } = math;
        `;

        const fullCode = registerFn + '\n' + code + `
            ;__reg = { _onStart, _onUpdate, _onStop, _onCollide };
        `;

        try {
            // eslint-disable-next-line no-new-func
            const fn = new Function('api', fullCode);
            const ctx = { __reg: null };
            fn.call(ctx, api);
            // Pull out registered callbacks
            if (ctx.__reg) {
                this._onStart   = ctx.__reg._onStart;
                this._onUpdate  = ctx.__reg._onUpdate;
                this._onStop    = ctx.__reg._onStop;
                this._onCollide = ctx.__reg._onCollide;
            }
        } catch (err) {
            _logConsole(`[Script "${this.name}" on "${this.obj.label}"] Compile error: ${err.message}`, '#f87171');
        }
    }

    start() {
        if (this._onStart) {
            try { this._onStart(); }
            catch (e) { _logConsole(`[Script "${this.name}"] onStart error: ${e.message}`, '#f87171'); }
        }
        this._started = true;
    }

    update(dt) {
        // Flush just-down keys after first tick sees them
        if (this._onUpdate) {
            try { this._onUpdate(dt); }
            catch (e) { _logConsole(`[Script "${this.name}"] onUpdate error: ${e.message}`, '#f87171'); }
        }
        this._keysJustDown.clear();
    }

    stop() {
        if (this._onStop) {
            try { this._onStop(); }
            catch (e) { _logConsole(`[Script "${this.name}"] onStop error: ${e.message}`, '#f87171'); }
        }
    }

    handleCollision(other) {
        if (this._onCollide) {
            const proxy = other ? { get x() { return other.x/100; }, get y() { return -other.y/100; }, name: other.label } : null;
            try { this._onCollide(proxy); }
            catch (e) { _logConsole(`[Script "${this.name}"] onCollision error: ${e.message}`, '#f87171'); }
        }
    }

    // Called by global keydown listener
    _handleKeyDown(key) {
        const k = key.toLowerCase();
        if (!this._keys.has(k)) this._keysJustDown.add(k);
        this._keys.add(k);
    }
    _handleKeyUp(key) {
        this._keys.delete(key.toLowerCase());
    }
    _handleMouseMove(x, y) {
        this._mouse.x = x;
        this._mouse.y = y;
    }
    _handleMouseDown() { this._mouse.down = true; }
    _handleMouseUp()   { this._mouse.down = false; }
}

// ── Global input relay ───────────────────────────────────────
function _onKeyDown(e) {
    for (const inst of _activeInstances) inst._handleKeyDown(e.key);
}
function _onKeyUp(e) {
    for (const inst of _activeInstances) inst._handleKeyUp(e.key);
}
function _onMouseMove(e) {
    const canvas = state.app?.view;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const inst of _activeInstances) inst._handleMouseMove(mx, my);
}
function _onMouseDown() { for (const i of _activeInstances) i._handleMouseDown(); }
function _onMouseUp()   { for (const i of _activeInstances) i._handleMouseUp();   }

// ── Start all scripts (called from enterPlayMode) ─────────────
export async function startScripts() {
    stopScripts(); // safety clear

    for (const obj of state.gameObjects) {
        if (!obj.scriptName) continue;
        try {
            const record = await loadScript(obj.scriptName);
            if (!record) {
                _logConsole(`[Scripting] Script "${obj.scriptName}" not found for "${obj.label}"`, '#facc15');
                continue;
            }
            const inst = new ScriptInstance(obj, obj.scriptName, record.code);
            _activeInstances.push(inst);
        } catch (e) {
            _logConsole(`[Scripting] Failed to load "${obj.scriptName}": ${e.message}`, '#f87171');
        }
    }

    if (_activeInstances.length === 0) return;

    // Start all
    for (const inst of _activeInstances) inst.start();

    // Bind global input
    window.addEventListener('keydown',   _onKeyDown);
    window.addEventListener('keyup',     _onKeyUp);
    window.addEventListener('mousemove', _onMouseMove);
    window.addEventListener('mousedown', _onMouseDown);
    window.addEventListener('mouseup',   _onMouseUp);

    // Ticker
    let _lastTime = performance.now();
    _tickerFn = () => {
        if (!state.isPlaying || state.isPaused) return;
        const now = performance.now();
        const dt  = Math.min((now - _lastTime) / 1000, 0.1); // cap dt at 0.1s
        _lastTime = now;
        for (const inst of _activeInstances) inst.update(dt);
    };
    state.app.ticker.add(_tickerFn);

    _logConsole(`▶ Scripts started (${_activeInstances.length} instance${_activeInstances.length !== 1 ? 's' : ''})`, '#4ade80');
}

// ── Stop all scripts (called from stopPlayMode) ───────────────
export function stopScripts() {
    for (const inst of _activeInstances) inst.stop();
    _activeInstances.length = 0;

    if (_tickerFn && state.app) {
        state.app.ticker.remove(_tickerFn);
        _tickerFn = null;
    }

    window.removeEventListener('keydown',   _onKeyDown);
    window.removeEventListener('keyup',     _onKeyUp);
    window.removeEventListener('mousemove', _onMouseMove);
    window.removeEventListener('mousedown', _onMouseDown);
    window.removeEventListener('mouseup',   _onMouseUp);
}

// ── Expose collision trigger (called from engine.physics.js) ──
export function triggerCollision(objA, objB) {
    for (const inst of _activeInstances) {
        if (inst.obj === objA) inst.handleCollision(objB);
        if (inst.obj === objB) inst.handleCollision(objA);
    }
}

// ── Helpers ───────────────────────────────────────────────────
function _logConsole(msg, color = '#e0e0e0') {
    const c = document.getElementById('console-output') || document.getElementById('tab-console');
    if (!c) return;
    const l = document.createElement('div');
    l.style.color = color;
    l.textContent = msg;
    c.appendChild(l);
    c.scrollTop = c.scrollHeight;
}

// ── Script Editor UI ─────────────────────────────────────────
export function openScriptEditor(obj, scriptName, initialCode = '') {
    document.getElementById('zengine-script-editor')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'zengine-script-editor';
    overlay.style.cssText = [
        'position:fixed;inset:0;z-index:100000;',
        'background:#0d0d14;display:flex;flex-direction:column;',
        'font-family:"Fira Code","Cascadia Code",monospace;',
    ].join('');

    // ── Header ──────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = [
        'display:flex;align-items:center;gap:10px;padding:10px 16px;',
        'background:#13131f;border-bottom:1px solid #2a2a3a;flex-shrink:0;',
    ].join('');
    header.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:18px;height:18px;flex-shrink:0;fill:none;stroke:#7cb9f0;stroke-width:2">
            <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
        </svg>
        <span style="color:#e0e0e0;font-weight:600;font-size:13px;">Script Editor</span>
        <span style="color:#555;font-size:11px;">—</span>
        <span style="color:#7cb9f0;font-size:12px;">${scriptName}.js</span>
        <span style="color:#555;font-size:11px;">→</span>
        <span style="color:#9bc;font-size:12px;">${obj.label}</span>
        <div style="flex:1;"></div>
        <div id="script-editor-status" style="font-size:11px;color:#555;margin-right:8px;"></div>
        <button id="btn-script-save" style="background:#1a3a5a;color:#7cb9f0;border:1px solid #2a5a8a;border-radius:4px;padding:5px 14px;cursor:pointer;font-size:12px;font-family:inherit;">
            Save
        </button>
        <button id="btn-script-close" style="background:#1e1e2e;color:#aaa;border:1px solid #2a2a3a;border-radius:4px;padding:5px 10px;cursor:pointer;font-size:12px;font-family:inherit;margin-left:4px;">
            ✕ Close
        </button>
    `;

    // ── API Reference Sidebar ────────────────────────────────
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex:1;min-height:0;';

    const sidebar = document.createElement('div');
    sidebar.style.cssText = [
        'width:220px;flex-shrink:0;background:#10101a;border-right:1px solid #1e1e2e;',
        'overflow-y:auto;font-size:10px;color:#7a7a9a;padding:10px 0;',
    ].join('');
    sidebar.innerHTML = `
        <div style="padding:0 12px 6px;color:#555;font-size:9px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">API Reference</div>

        <div class="api-group">
            <div class="api-group-title">Position</div>
            <div class="api-item"><span class="api-fn">getX()</span> / <span class="api-fn">setX(v)</span></div>
            <div class="api-item"><span class="api-fn">getY()</span> / <span class="api-fn">setY(v)</span></div>
            <div class="api-item"><span class="api-fn">translate(dx, dy)</span></div>
            <div class="api-item"><span class="api-fn">moveTo(x, y)</span></div>
            <div class="api-item"><span class="api-fn">lookAt(tx, ty)</span></div>
        </div>

        <div class="api-group">
            <div class="api-group-title">Rotation / Scale</div>
            <div class="api-item"><span class="api-fn">getRotation()</span> / <span class="api-fn">setRotation(deg)</span></div>
            <div class="api-item"><span class="api-fn">getScaleX()</span> / <span class="api-fn">setScaleX(v)</span></div>
            <div class="api-item"><span class="api-fn">getScaleY()</span> / <span class="api-fn">setScaleY(v)</span></div>
        </div>

        <div class="api-group">
            <div class="api-group-title">Visibility</div>
            <div class="api-item"><span class="api-fn">visible</span> — true/false</div>
            <div class="api-item"><span class="api-fn">alpha</span> — 0–1</div>
        </div>

        <div class="api-group">
            <div class="api-group-title">Input</div>
            <div class="api-item"><span class="api-fn">input.isKeyDown("w")</span></div>
            <div class="api-item"><span class="api-fn">input.isKeyJustDown("Space")</span></div>
            <div class="api-item"><span class="api-fn">input.mouseX / mouseY</span></div>
            <div class="api-item"><span class="api-fn">input.mouseDown</span></div>
        </div>

        <div class="api-group">
            <div class="api-group-title">Animation</div>
            <div class="api-item"><span class="api-fn">playAnimation("name")</span></div>
            <div class="api-item"><span class="api-fn">stopAnimation()</span></div>
            <div class="api-item"><span class="api-fn">currentAnimation()</span></div>
        </div>

        <div class="api-group">
            <div class="api-group-title">Physics</div>
            <div class="api-item"><span class="api-fn">physics.setVelocity(vx, vy)</span></div>
            <div class="api-item"><span class="api-fn">physics.applyForce(fx, fy)</span></div>
            <div class="api-item"><span class="api-fn">physics.applyImpulse(ix, iy)</span></div>
            <div class="api-item"><span class="api-fn">physics.velX / velY</span></div>
        </div>

        <div class="api-group">
            <div class="api-group-title">Scene</div>
            <div class="api-item"><span class="api-fn">find("label")</span> → obj</div>
            <div class="api-item"><span class="api-fn">getTime()</span> → seconds</div>
        </div>

        <div class="api-group">
            <div class="api-group-title">Math</div>
            <div class="api-item"><span class="api-fn">lerp(a, b, t)</span></div>
            <div class="api-item"><span class="api-fn">clamp(v, lo, hi)</span></div>
            <div class="api-item"><span class="api-fn">dist(x1,y1,x2,y2)</span></div>
            <div class="api-item"><span class="api-fn">rand(min, max)</span></div>
            <div class="api-item"><span class="api-fn">randInt(min, max)</span></div>
            <div class="api-item"><span class="api-fn">sin, cos, abs, round…</span></div>
        </div>

        <div class="api-group">
            <div class="api-group-title">Events</div>
            <div class="api-item"><span class="api-fn">onStart(fn)</span></div>
            <div class="api-item"><span class="api-fn">onUpdate(fn)</span> — dt in seconds</div>
            <div class="api-item"><span class="api-fn">onStop(fn)</span></div>
            <div class="api-item"><span class="api-fn">onCollision(fn)</span> — fn(other)</div>
        </div>

        <div class="api-group">
            <div class="api-group-title">Debug</div>
            <div class="api-item"><span class="api-fn">log(...args)</span></div>
            <div class="api-item"><span class="api-fn">warn(...args)</span></div>
        </div>

        <style>
            .api-group { padding: 6px 0 2px; border-top:1px solid #1a1a2a; }
            .api-group:first-child { border-top: none; }
            .api-group-title { padding: 3px 12px; color:#3a72a5; font-size:9px; font-weight:bold; text-transform:uppercase; letter-spacing:0.8px; }
            .api-item { padding: 1px 12px; line-height:1.6; color:#6a7a9a; }
            .api-fn { color: #7cb9f0; }
        </style>
    `;

    // ── Code Area ────────────────────────────────────────────
    const editorPane = document.createElement('div');
    editorPane.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0;';

    const lineNumbers = document.createElement('div');
    lineNumbers.id = 'script-line-numbers';
    lineNumbers.style.cssText = [
        'position:absolute;left:0;top:0;bottom:0;width:42px;',
        'background:#10101a;border-right:1px solid #1e1e2e;',
        'color:#3a3a5a;font-size:12px;line-height:1.6;text-align:right;',
        'padding:16px 6px 0 0;pointer-events:none;user-select:none;',
        'font-family:"Fira Code","Cascadia Code",monospace;overflow:hidden;',
    ].join('');

    const textarea = document.createElement('textarea');
    textarea.id = 'script-code-area';
    textarea.spellcheck = false;
    textarea.autocomplete = 'off';
    textarea.style.cssText = [
        'flex:1;width:100%;height:100%;',
        'background:transparent;color:#d4d4d4;',
        'border:none;outline:none;resize:none;',
        'font-family:"Fira Code","Cascadia Code",monospace;font-size:13px;line-height:1.6;',
        'padding:16px 16px 16px 56px;tab-size:2;',
        'caret-color:#7cb9f0;',
    ].join('');
    textarea.value = initialCode || _defaultScript(obj.label);

    const codeWrap = document.createElement('div');
    codeWrap.style.cssText = 'flex:1;position:relative;overflow:hidden;';
    codeWrap.appendChild(lineNumbers);
    codeWrap.appendChild(textarea);
    editorPane.appendChild(codeWrap);

    body.appendChild(sidebar);
    body.appendChild(editorPane);

    overlay.appendChild(header);
    overlay.appendChild(body);
    document.body.appendChild(overlay);

    // Line numbers
    function _updateLineNumbers() {
        const lines = textarea.value.split('\n').length;
        lineNumbers.innerHTML = Array.from({ length: lines }, (_, i) => `<div>${i + 1}</div>`).join('');
        // Sync scroll
        lineNumbers.scrollTop = textarea.scrollTop;
    }
    textarea.addEventListener('input',  _updateLineNumbers);
    textarea.addEventListener('scroll', () => { lineNumbers.scrollTop = textarea.scrollTop; });
    _updateLineNumbers();

    // Tab key inserts spaces
    textarea.addEventListener('keydown', e => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const s = textarea.selectionStart;
            const v = textarea.value;
            textarea.value = v.slice(0, s) + '  ' + v.slice(textarea.selectionEnd);
            textarea.selectionStart = textarea.selectionEnd = s + 2;
            _updateLineNumbers();
        }
    });

    // Dirty tracking
    let _dirty = false;
    const statusEl = header.querySelector('#script-editor-status');
    textarea.addEventListener('input', () => {
        if (!_dirty) { _dirty = true; statusEl.textContent = '● unsaved'; statusEl.style.color = '#facc15'; }
    });

    // Save
    async function _doSave() {
        await saveScript(scriptName, textarea.value);
        obj.scriptName = scriptName;
        _dirty = false;
        statusEl.textContent = '✓ saved';
        statusEl.style.color = '#4ade80';
        setTimeout(() => { if (!_dirty) statusEl.textContent = ''; }, 2000);
        _logConsole(`💾 Script "${scriptName}" saved`, '#4ade80');
    }

    header.querySelector('#btn-script-save').addEventListener('click', _doSave);
    header.querySelector('#btn-script-close').addEventListener('click', async () => {
        if (_dirty) {
            if (confirm('You have unsaved changes. Save before closing?')) await _doSave();
        }
        overlay.remove();
    });

    // Ctrl+S
    overlay.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); _doSave(); }
    });

    textarea.focus();
}

// ── Default script template ───────────────────────────────────
function _defaultScript(label) {
    return `// Script for: ${label}
// Runs only in Play Mode — edit mode is safe.

onStart(() => {
    // Called once when Play is pressed
    log("Hello from ${label}!");
});

onUpdate((dt) => {
    // Called every frame. dt = seconds since last frame.

    // Example: move with WASD
    const speed = 3;
    if (input.isKeyDown("w") || input.isKeyDown("ArrowUp"))    translate(0,  speed * dt);
    if (input.isKeyDown("s") || input.isKeyDown("ArrowDown"))  translate(0, -speed * dt);
    if (input.isKeyDown("a") || input.isKeyDown("ArrowLeft"))  translate(-speed * dt, 0);
    if (input.isKeyDown("d") || input.isKeyDown("ArrowRight")) translate( speed * dt, 0);
});

onStop(() => {
    // Called when Play is stopped
});

onCollision((other) => {
    // Called when this object collides with another
    // other.name, other.x, other.y
});
`;
}

// ── Create Script Flow ────────────────────────────────────────
export function promptCreateScript(obj) {
    const modal = _makeModal();
    modal.innerHTML = `
        <div style="padding:24px;min-width:320px;">
            <div style="color:#e0e0e0;font-weight:600;font-size:14px;margin-bottom:4px;">Create Script</div>
            <div style="color:#666;font-size:11px;margin-bottom:16px;">Enter a name for the new script file</div>
            <input id="script-name-input" type="text" placeholder="e.g. PlayerController"
                style="width:100%;background:#0d0d14;color:#e0e0e0;border:1px solid #3a72a5;border-radius:4px;padding:8px 10px;font-size:13px;outline:none;box-sizing:border-box;font-family:inherit;">
            <div id="script-name-error" style="color:#f87171;font-size:11px;margin-top:4px;min-height:14px;"></div>
            <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
                <button id="btn-script-modal-cancel" style="background:#1e1e2e;color:#aaa;border:1px solid #2a2a3a;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;">Cancel</button>
                <button id="btn-script-modal-create" style="background:#1a3a5a;color:#7cb9f0;border:1px solid #2a5a8a;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;">Create</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const input   = modal.querySelector('#script-name-input');
    const errEl   = modal.querySelector('#script-name-error');
    const btnOk   = modal.querySelector('#btn-script-modal-create');
    const btnCanc = modal.querySelector('#btn-script-modal-cancel');
    input.focus();

    btnCanc.onclick = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });

    btnOk.onclick = async () => {
        const raw  = input.value.trim();
        const name = raw.replace(/[^a-zA-Z0-9_\-]/g, '');
        if (!name) { errEl.textContent = 'Name cannot be empty'; return; }

        // Check for duplicate
        const existing = await listScripts();
        if (existing.find(s => s.name === name)) {
            errEl.textContent = `"${name}" already exists — use Load Script to attach it.`;
            return;
        }

        modal.remove();
        openScriptEditor(obj, name);
    };

    input.addEventListener('keydown', e => { if (e.key === 'Enter') btnOk.click(); });
}

// ── Load Script Flow ─────────────────────────────────────────
export async function promptLoadScript(obj) {
    const scripts = await listScripts();

    const modal = _makeModal();

    if (scripts.length === 0) {
        modal.innerHTML = `
            <div style="padding:24px;min-width:280px;text-align:center;">
                <div style="font-size:28px;margin-bottom:10px;">📄</div>
                <div style="color:#e0e0e0;font-weight:600;margin-bottom:6px;">No scripts yet</div>
                <div style="color:#666;font-size:11px;margin-bottom:16px;">Create a script first using "Create Script"</div>
                <button id="btn-no-scripts-close" style="background:#1e1e2e;color:#aaa;border:1px solid #2a2a3a;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;">Close</button>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#btn-no-scripts-close').onclick = () => modal.remove();
        return;
    }

    const listHtml = scripts.map(s => {
        const d = new Date(s.updatedAt);
        const ts = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        const isAttached = obj.scriptName === s.name;
        return `
            <div class="script-list-item${isAttached ? ' attached' : ''}" data-name="${s.name}"
                style="display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-radius:4px;transition:background .1s;margin:2px 0;background:${isAttached ? 'rgba(58,114,165,0.18)' : 'transparent'};">
                <svg viewBox="0 0 24 24" style="width:14px;height:14px;flex-shrink:0;fill:none;stroke:${isAttached ? '#7cb9f0' : '#555'};stroke-width:2">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                <div style="flex:1;min-width:0;">
                    <div style="color:${isAttached ? '#7cb9f0' : '#d4d4d4'};font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.name}${isAttached ? ' <span style="color:#4ade80;font-size:10px;font-weight:normal;">● attached</span>' : ''}</div>
                    <div style="color:#555;font-size:10px;">${ts}</div>
                </div>
                <div style="display:flex;gap:4px;">
                    <button class="btn-load-edit" data-name="${s.name}" style="background:#1a3a1a;color:#8f8;border:1px solid #2a4a2a;border-radius:3px;padding:3px 7px;font-size:10px;cursor:pointer;">Edit</button>
                    <button class="btn-load-attach" data-name="${s.name}" style="background:#1a3a5a;color:#7cb9f0;border:1px solid #2a5a8a;border-radius:3px;padding:3px 8px;font-size:10px;cursor:pointer;">Attach</button>
                </div>
            </div>
        `;
    }).join('');

    modal.innerHTML = `
        <div style="padding:20px;min-width:360px;max-height:70vh;display:flex;flex-direction:column;">
            <div style="color:#e0e0e0;font-weight:600;font-size:14px;margin-bottom:4px;">Load Script</div>
            <div style="color:#666;font-size:11px;margin-bottom:12px;">Choose a script to attach to <span style="color:#9bc;">${obj.label}</span></div>
            <div style="flex:1;overflow-y:auto;min-height:0;">${listHtml}</div>
            ${obj.scriptName ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #1e1e2e;display:flex;justify-content:space-between;align-items:center;">
                <span style="color:#666;font-size:11px;">Currently: <span style="color:#9bc;">${obj.scriptName}</span></span>
                <button id="btn-detach-script" style="background:#2a1a1a;color:#f87171;border:1px solid #3a2a2a;border-radius:3px;padding:4px 10px;font-size:11px;cursor:pointer;">Detach</button>
            </div>` : ''}
            <button id="btn-load-cancel" style="margin-top:12px;background:#1e1e2e;color:#aaa;border:1px solid #2a2a3a;border-radius:4px;padding:6px 0;cursor:pointer;font-size:12px;">Cancel</button>
        </div>
    `;
    document.body.appendChild(modal);

    // Hover
    modal.querySelectorAll('.script-list-item').forEach(el => {
        el.addEventListener('mouseenter', () => { if (!el.classList.contains('attached')) el.style.background = 'rgba(255,255,255,0.04)'; });
        el.addEventListener('mouseleave', () => { if (!el.classList.contains('attached')) el.style.background = 'transparent'; });
    });

    // Edit buttons
    modal.querySelectorAll('.btn-load-edit').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const name   = btn.dataset.name;
            const record = await loadScript(name);
            modal.remove();
            openScriptEditor(obj, name, record?.code ?? '');
        };
    });

    // Attach buttons
    modal.querySelectorAll('.btn-load-attach').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const name = btn.dataset.name;
            obj.scriptName = name;
            _logConsole(`📎 Script "${name}" attached to "${obj.label}"`, '#4ade80');
            modal.remove();
            // Refresh inspector to show badge
            import('./engine.ui.js').then(m => m.syncPixiToInspector());
        };
    });

    const detachBtn = modal.querySelector('#btn-detach-script');
    if (detachBtn) {
        detachBtn.onclick = () => {
            const old = obj.scriptName;
            obj.scriptName = null;
            _logConsole(`✂️ Script "${old}" detached from "${obj.label}"`, '#facc15');
            modal.remove();
            import('./engine.ui.js').then(m => m.syncPixiToInspector());
        };
    }

    modal.querySelector('#btn-load-cancel').onclick = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
}

// ── Modal helper ─────────────────────────────────────────────
function _makeModal() {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = [
        'position:fixed;inset:0;z-index:99999;',
        'background:rgba(0,0,0,0.7);',
        'display:flex;align-items:center;justify-content:center;',
    ].join('');
    const box = document.createElement('div');
    box.style.cssText = [
        'background:#13131f;border:1px solid #2a2a3a;border-radius:8px;',
        'box-shadow:0 24px 64px rgba(0,0,0,0.8);',
        'font-family:system-ui,sans-serif;',
    ].join('');
    backdrop.appendChild(box);

    // Return the box directly so callers set innerHTML on it
    // But we need backdrop in DOM — swap: inner is box, outer is backdrop
    // Return backdrop, and callers read backdrop.firstChild for the box? 
    // Simpler: just return backdrop and have callers .innerHTML the inner div
    // Actually simplest: return backdrop (which IS appended to body), innerHTML targets backdrop
    // Let's return backdrop but wrap properly:
    const wrapper = document.createElement('div');
    wrapper.style.cssText = backdrop.style.cssText;
    wrapper.appendChild(box);

    // Swap: let innerHTML be set on box. Return wrapper which gets appended.
    // We'll override innerHTML getter/setter to forward to box:
    Object.defineProperty(wrapper, 'innerHTML', {
        get: () => box.innerHTML,
        set: (v) => { box.innerHTML = v; },
    });
    wrapper.querySelector  = (sel) => box.querySelector(sel);
    wrapper.querySelectorAll = (sel) => box.querySelectorAll(sel);
    wrapper.addEventListener('click', e => { if (e.target === wrapper) wrapper.remove(); });

    return wrapper;
}
