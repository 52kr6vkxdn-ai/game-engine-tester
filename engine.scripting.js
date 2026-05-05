/* ============================================================
   Zengine — engine.scripting.js
   Complete sandboxed scripting system.

   Key design:
   - `this.x`, `this.y`, `this.tag` for clarity — no ambiguity
   - scene variables (shared across all scripts in a scene)
   - global variables (persist across scene changes)
   - camera.follow(), camera.moveTo(), camera.position()
   - gotoScene(name/index), currentScene(), getSceneCount()
   - Overlap detection (AABB) for non-physics objects
   - Collision tracking: instant (onCollisionEnter) + continuous (onCollisionStay) + exit (onCollisionExit)
   - Gravity per object via this.gravity(x, y) in script
   - All APIs have clear `this.` prefixed names
   ============================================================ */

import { state } from './engine.state.js';

// ── Ace CDN ───────────────────────────────────────────────────
const ACE_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.2';

function _loadAce() {
    return new Promise(resolve => {
        if (window.ace) { resolve(window.ace); return; }
        const s = document.createElement('script');
        s.src = `${ACE_BASE}/ace.min.js`;
        s.onload = () => {
            const lt = document.createElement('script');
            lt.src = `${ACE_BASE}/ext-language_tools.min.js`;
            lt.onload = () => resolve(window.ace);
            document.head.appendChild(lt);
        };
        document.head.appendChild(s);
    });
}

// ── Script CRUD (state.scripts) ───────────────────────────────
export function saveScript(name, code) {
    const existing = state.scripts.find(s => s.name === name);
    if (existing) {
        existing.code      = code;
        existing.updatedAt = Date.now();
    } else {
        state.scripts.push({
            id: 'script_' + Date.now() + '_' + Math.random().toString(36).slice(2),
            name, code, updatedAt: Date.now(),
        });
    }
    refreshScriptPanel();
}

export function getScript(name) {
    return state.scripts.find(s => s.name === name) ?? null;
}

export function deleteScriptByName(name) {
    const idx = state.scripts.findIndex(s => s.name === name);
    if (idx !== -1) state.scripts.splice(idx, 1);
    refreshScriptPanel();
}

// ── Script Panel ──────────────────────────────────────────────
export function refreshScriptPanel() {
    const grid = document.getElementById('script-asset-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (state.scripts.length === 0) {
        const e = document.createElement('div');
        e.style.cssText = 'color:#505060;font-size:11px;padding:20px;text-align:center;width:100%;';
        e.textContent = 'No scripts yet';
        grid.appendChild(e);
        return;
    }

    const banner = document.createElement('div');
    banner.style.cssText = 'width:100%;padding:5px 10px;background:#080c12;border-bottom:1px solid #12192a;font-size:9px;color:#2a4a6a;line-height:1.6;';
    banner.innerHTML = '📎 <b style="color:#3a6a9a;">To use:</b> select a sprite → Inspector → Load Script';
    grid.appendChild(banner);

    const defaults    = state.scripts.filter(s => s.isDefault);
    const userScripts = state.scripts.filter(s => !s.isDefault);

    function addSection(label, color, bgColor, scripts) {
        if (!scripts.length) return;
        const hdr = document.createElement('div');
        hdr.style.cssText = `width:100%;padding:4px 10px;color:${color};font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;background:${bgColor};border-bottom:1px solid ${color}22;`;
        hdr.textContent = label;
        grid.appendChild(hdr);
        for (const script of scripts) grid.appendChild(_makeScriptCard(script, script.isDefault));
    }

    addSection('⭐ Built-in Scripts', '#3a7a3a', '#060d06', defaults);
    addSection('📝 My Scripts',       '#2a5a8a', '#06080d', userScripts);
}

function _makeScriptCard(script, isDefault) {
    const item = document.createElement('div');
    item.className = 'asset-item';
    item.style.cssText = 'cursor:pointer;position:relative;';
    const stroke = isDefault ? '#4ade80' : '#7cb9f0';
    const bg     = isDefault ? '#060d06' : '#06080d';
    const border = isDefault ? '#1a3a1a' : '#1a2a3a';
    item.innerHTML = `
        <div class="asset-thumb" style="background:${bg};border:1px solid ${border};position:relative;">
            <svg viewBox="0 0 24 24" style="width:26px;height:26px;fill:none;stroke:${stroke};stroke-width:1.5;">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            ${isDefault ? '<div style="position:absolute;bottom:1px;left:0;right:0;text-align:center;font-size:7px;color:#3a7a3a;font-weight:700;">BUILT-IN</div>' : ''}
        </div>
        <div class="asset-name" title="${script.name}.js">${script.name.length > 11 ? script.name.slice(0,10)+'…' : script.name}</div>
        ${!isDefault ? '<div class="script-del-btn" style="display:none;position:absolute;top:2px;right:2px;"><button style="background:rgba(24,6,6,.92);border:1px solid #3a1a1a;color:#f87171;border-radius:3px;padding:1px 4px;font-size:10px;cursor:pointer;">✕</button></div>' : ''}
    `;
    if (!isDefault) {
        item.addEventListener('mouseenter', () => item.querySelector('.script-del-btn').style.display = 'block');
        item.addEventListener('mouseleave', () => item.querySelector('.script-del-btn').style.display = 'none');
        item.querySelector('.script-del-btn button')?.addEventListener('click', e => {
            e.stopPropagation();
            if (confirm(`Delete script "${script.name}"?`)) deleteScriptByName(script.name);
        });
    }
    item.addEventListener('click', () => openScriptEditor(null, script.name, script.code));
    return item;
}

// ── Scene-level shared variables (reset on scene change) ──────
const _sceneVars  = {};
// ── Global variables (persist across scenes) ──────────────────
const _globalVars = {};

export function clearSceneVars()  { for (const k in _sceneVars)  delete _sceneVars[k];  }
export function clearGlobalVars() { for (const k in _globalVars) delete _globalVars[k]; }

// ── Camera API (wraps sceneContainer in play mode) ────────────
const _camera = {
    _followTarget: null,
    _smoothing:    6,

    /** Follow an object every frame. target = result of find() or findWithTag() */
    follow(target, smoothing = 6) {
        this._followTarget = target;
        this._smoothing    = smoothing;
    },
    /** Stop following */
    unfollow() { this._followTarget = null; },
    /** Instantly move camera to world position */
    moveTo(wx, wy) {
        this._followTarget = null;
        if (!state.sceneContainer) return;
        const sc    = state.sceneContainer;
        const scale = sc.scale.x;
        sc.x = window.innerWidth  / 2 - wx * 100 * scale;
        sc.y = window.innerHeight / 2 + wy * 100 * scale;
    },
    /** Get current camera centre in world units */
    get x() {
        if (!state.sceneContainer) return 0;
        const sc = state.sceneContainer;
        return (window.innerWidth / 2 - sc.x) / (sc.scale.x * 100);
    },
    get y() {
        if (!state.sceneContainer) return 0;
        const sc = state.sceneContainer;
        return (sc.y - window.innerHeight / 2) / (sc.scale.y * 100);
    },
    /** Shake the camera (amplitude in world units, duration in seconds) */
    shake(amplitude = 0.2, duration = 0.3) {
        _cameraShake.amplitude = amplitude;
        _cameraShake.duration  = duration;
        _cameraShake.elapsed   = 0;
    },
};

const _cameraShake = { amplitude: 0, duration: 0, elapsed: 0 };

function _updateCamera(dt) {
    if (!state.sceneContainer || !state.isPlaying) return;
    const sc    = state.sceneContainer;
    const scale = sc.scale.x;

    // Follow
    if (_camera._followTarget) {
        const t  = _camera._followTarget;
        const tx = window.innerWidth  / 2 - (t._ref ? t._ref.x : t.x * 100) * scale;
        const ty = window.innerHeight / 2 + (t._ref ? t._ref.y : -t.y * 100) * scale;
        const sm = Math.max(0, Math.min(1, _camera._smoothing * dt));
        sc.x += (tx - sc.x) * sm;
        sc.y += (ty - sc.y) * sm;
    }

    // Shake
    if (_cameraShake.elapsed < _cameraShake.duration) {
        _cameraShake.elapsed += dt;
        const t   = _cameraShake.elapsed / _cameraShake.duration;
        const amp = _cameraShake.amplitude * (1 - t) * 100 * scale;
        sc.x += (Math.random() - 0.5) * amp;
        sc.y += (Math.random() - 0.5) * amp;
    }
}

// ── Global message bus ────────────────────────────────────────
const _tagRegistry   = new Map();
const _groupRegistry = new Map();

function _registerInstance(inst) {
    const tag   = inst.obj._scriptTag;
    const group = inst.obj._scriptGroup;
    if (tag) {
        if (!_tagRegistry.has(tag))   _tagRegistry.set(tag, new Set());
        _tagRegistry.get(tag).add(inst);
    }
    if (group) {
        if (!_groupRegistry.has(group)) _groupRegistry.set(group, new Set());
        _groupRegistry.get(group).add(inst);
    }
}

function _clearRegistries() { _tagRegistry.clear(); _groupRegistry.clear(); }

function _deliverMsg(inst, msg, data) {
    const handler = inst._messageHandlers?.get(msg);
    if (!handler) return;
    try { handler(data); }
    catch (e) { _logConsole(`[Script "${inst.name}"] onMessage "${msg}": ${e.message}`, '#f87171'); }
}

function _sendMessageToTag(tag, msg, data) {
    const set = _tagRegistry.get(tag);
    if (!set || set.size === 0) return;
    const [first] = set;
    _deliverMsg(first, msg, data);
}
function _broadcastToTag(tag, msg, data)    { const s = _tagRegistry.get(tag);   if (s) for (const i of s) _deliverMsg(i, msg, data); }
function _broadcastToGroup(grp, msg, data)  { const s = _groupRegistry.get(grp); if (s) for (const i of s) _deliverMsg(i, msg, data); }
function _broadcastGlobal(msg, data)        { for (const i of _instances) _deliverMsg(i, msg, data); }

// ── Overlap (AABB) detection for non-physics objects ──────────
function _getAABB(obj) {
    const hw = (obj.spriteGraphic?.width  ?? obj._bounds?.width  ?? 100) / 2;
    const hh = (obj.spriteGraphic?.height ?? obj._bounds?.height ?? 100) / 2;
    const sx  = Math.abs(obj.scale?.x ?? 1);
    const sy  = Math.abs(obj.scale?.y ?? 1);
    return {
        left:   obj.x - hw * sx,
        right:  obj.x + hw * sx,
        top:    obj.y - hh * sy,
        bottom: obj.y + hh * sy,
    };
}

function _aabbOverlap(a, b) {
    const ba = _getAABB(a);
    const bb = _getAABB(b);
    return ba.right > bb.left && ba.left < bb.right &&
           ba.bottom > bb.top && ba.top  < bb.bottom;
}

function _isOverlapping(objA, objB) {
    if (!objA || !objB) return false;
    return _aabbOverlap(objA, objB);
}

// ── Sandbox API builder ───────────────────────────────────────
function _buildSandbox(obj, instRef) {
    const _keys         = new Set();
    const _keysJustDown = new Set();
    const _keysJustUp   = new Set();
    const _mouse        = { x: 0, y: 0, down: false, justDown: false, justUp: false };

    // Per-object velocity — integrated each frame
    const _vel = { x: 0, y: 0 };
    // Per-object manual gravity (script can call this.gravity(0, 9.8))
    const _grav = { x: 0, y: 0 };

    const api = {

        // ── IDENTITY ─────────────────────────────────────────
        /** This object's name/label */
        get name()  { return obj.label; },

        /** This object's tag (used for messaging and findWithTag) */
        get tag()   { return obj._scriptTag  ?? ''; },
        set tag(v)  { obj._scriptTag = String(v); if (instRef[0]) _registerInstance(instRef[0]); },

        /** This object's group */
        get group() { return obj._scriptGroup ?? ''; },
        set group(v){ obj._scriptGroup = String(v); if (instRef[0]) _registerInstance(instRef[0]); },

        // ── POSITION — this.x, this.y ─────────────────────────
        /** World X position of this object */
        get x()  { return  obj.x  / 100; },
        set x(v) { obj.x  =  v * 100; },
        /** World Y position of this object */
        get y()  { return -obj.y  / 100; },
        set y(v) { obj.y  = -v * 100; },

        // ── VELOCITY ─────────────────────────────────────────
        /** Horizontal velocity in world units/second (auto-applied each frame) */
        get velocityX()  { return _vel.x; },
        set velocityX(v) { _vel.x = v; },
        /** Vertical velocity in world units/second (auto-applied each frame) */
        get velocityY()  { return _vel.y; },
        set velocityY(v) { _vel.y = v; },
        /** Short alias for velocityX */
        get vx()  { return _vel.x; },
        set vx(v) { _vel.x = v; },
        /** Short alias for velocityY */
        get vy()  { return _vel.y; },
        set vy(v) { _vel.y = v; },

        /** Set both velocity components at once */
        setVelocity(vx, vy) { _vel.x = vx; _vel.y = vy; },
        /** Stop all movement */
        stopMovement() { _vel.x = 0; _vel.y = 0; },
        /** Bounce velocityX (e.g. hit a wall) */
        bounceX() { _vel.x = -_vel.x; },
        /** Bounce velocityY (e.g. hit a floor) */
        bounceY() { _vel.y = -_vel.y; },

        // ── MANUAL GRAVITY ────────────────────────────────────
        /**
         * Apply manual gravity to this object (world units/s²).
         * Call inside onUpdate — it's additive per frame.
         * Example: this.gravity(0, -9.8)  ← falls downward
         */
        gravity(gx, gy) { _grav.x = gx ?? 0; _grav.y = gy ?? 0; },

        // ── INTERNAL vel/grav for runtime ─────────────────────
        _vel,
        _grav,

        // ── ROTATION / SCALE ─────────────────────────────────
        /** This object's rotation in degrees */
        get rotation()   { return -(obj.rotation * 180 / Math.PI); },
        set rotation(v)  { obj.rotation = -(v * Math.PI / 180); },
        get scaleX()     { return obj.scale?.x ?? 1; },
        set scaleX(v)    { if (obj.scale) obj.scale.x = v; },
        get scaleY()     { return obj.scale?.y ?? 1; },
        set scaleY(v)    { if (obj.scale) obj.scale.y = v; },
        /** Width in world units */
        get width()      { return (obj.spriteGraphic?.width  ?? 100) / 100; },
        /** Height in world units */
        get height()     { return (obj.spriteGraphic?.height ?? 100) / 100; },

        // ── DISPLAY ───────────────────────────────────────────
        get visible()    { return obj.visible; },
        set visible(v)   { obj.visible = !!v; },
        get alpha()      { return obj.alpha; },
        set alpha(v)     { obj.alpha = Math.max(0, Math.min(1, v)); },

        // ── MOVEMENT HELPERS ─────────────────────────────────
        /** Move by (dx, dy) world units this frame */
        move(dx, dy)      { obj.x += dx * 100; obj.y -= dy * 100; },
        translate(dx, dy) { obj.x += dx * 100; obj.y -= dy * 100; },
        /** Warp to exact position */
        moveTo(x, y)      { obj.x =  x * 100; obj.y = -y * 100; },
        /** Rotate to face a world point */
        lookAt(tx, ty) {
            obj.rotation = -Math.atan2(-((-ty*100) - obj.y), (tx*100) - obj.x);
        },
        /** Move forward along current rotation direction */
        moveForward(speed) {
            const r = -obj.rotation;
            obj.x += Math.cos(r) * speed * 100;
            obj.y -= Math.sin(r) * speed * 100;
        },
        flipX() { if (obj.scale) obj.scale.x *= -1; },
        flipY() { if (obj.scale) obj.scale.y *= -1; },

        // ── PHYSICS BODY ─────────────────────────────────────
        physics: {
            applyForce(fx, fy)   { obj._physicsBody?.applyForce?.({ x:fx, y:-fy }, obj._physicsBody.getPosition()); },
            applyImpulse(ix, iy) { obj._physicsBody?.applyLinearImpulse?.({ x:ix, y:-iy }, obj._physicsBody.getPosition()); },
            setVelocity(vx, vy)  { if (window.Matter && obj._physicsBody) window.Matter.Body.setVelocity(obj._physicsBody, { x:vx, y:-vy }); },
            get velX()  { return  obj._physicsBody?.getLinearVelocity?.()?.x ?? 0; },
            get velY()  { return -(obj._physicsBody?.getLinearVelocity?.()?.y ?? 0); },
            stop() {
                if (window.Matter && obj._physicsBody) {
                    window.Matter.Body.setVelocity(obj._physicsBody, { x:0, y:0 });
                }
            },
        },

        // ── ANIMATION ────────────────────────────────────────
        playAnimation(name) {
            const idx = obj.animations?.findIndex(a => a.name === name) ?? -1;
            if (idx >= 0) {
                obj.activeAnimIndex = idx;
                try { if (obj._runtimeSprite) obj._runtimeSprite.gotoAndPlay(0); } catch(_) {}
            }
        },
        stopAnimation()  { try { obj._runtimeSprite?.stop(); }    catch(_) {} },
        pauseAnimation() { try { obj._runtimeSprite?.stop(); }    catch(_) {} },
        get currentAnimation() { return obj.animations?.[obj.activeAnimIndex]?.name ?? ''; },

        // ── INPUT ────────────────────────────────────────────
        input: {
            isKeyDown:        k => _keys.has(k.toLowerCase()),
            isKeyJustDown:    k => _keysJustDown.has(k.toLowerCase()),
            isKeyJustUp:      k => _keysJustUp.has(k.toLowerCase()),
            get mouseX()      { return _mouse.x / 100; },
            get mouseY()      { return -_mouse.y / 100; },
            /** Mouse position in world units */
            get worldMouseX() { return _mouse.x / 100; },
            get worldMouseY() { return -_mouse.y / 100; },
            get mouseDown()   { return _mouse.down; },
            get mouseJustDown(){ return _mouse.justDown; },
            get mouseJustUp() { return _mouse.justUp; },
            /** Horizontal axis from A/D or arrow keys: -1, 0, or 1 */
            get axisH() {
                return ((_keys.has('d')||_keys.has('arrowright'))?1:0)
                      -((_keys.has('a')||_keys.has('arrowleft') )?1:0);
            },
            /** Vertical axis from W/S or arrow keys: -1, 0, or 1 */
            get axisV() {
                return ((_keys.has('w')||_keys.has('arrowup')   )?1:0)
                      -((_keys.has('s')||_keys.has('arrowdown')  )?1:0);
            },
        },

        // ── SCENE QUERIES ────────────────────────────────────
        /** Find an object by its exact label/name */
        find(label) {
            const f = state.gameObjects.find(o => o.label === label);
            return f ? _makeProxy(f) : null;
        },
        /** Find the FIRST object with a given tag */
        findWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set || !set.size) return null;
            const [first] = set;
            return _makeProxy(first.obj);
        },
        /** Find ALL objects with a given tag → array of proxies */
        findAllWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set) return [];
            return [...set].map(i => _makeProxy(i.obj));
        },
        /** Find ALL objects in a group → array of proxies */
        findAllInGroup(grp) {
            const set = _groupRegistry.get(grp);
            if (!set) return [];
            return [...set].map(i => _makeProxy(i.obj));
        },

        // ── OVERLAP DETECTION (no physics body needed) ───────
        /**
         * Check if this object overlaps another right now (AABB).
         * Works on any object — no physics body required.
         * Example: if (this.overlaps(this.find("Coin"))) { ... }
         */
        overlaps(other) {
            return _isOverlapping(obj, other?._ref ?? other);
        },
        /**
         * Check if this object overlaps any object with a given tag.
         * Returns the first overlapping object's proxy, or null.
         */
        overlapsTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set) return null;
            for (const inst of set) {
                if (inst.obj !== obj && _isOverlapping(obj, inst.obj)) return _makeProxy(inst.obj);
            }
            return null;
        },
        /**
         * Get ALL objects with tag that this object overlaps right now.
         */
        overlapsAllWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set) return [];
            const result = [];
            for (const inst of set) {
                if (inst.obj !== obj && _isOverlapping(obj, inst.obj)) result.push(_makeProxy(inst.obj));
            }
            return result;
        },

        // ── DESTROY ──────────────────────────────────────────
        destroySelf()     { obj._markedForDestroy = true; },
        destroy(other)    { if (other?._ref) other._ref._markedForDestroy = true; },

        // ── MESSAGING ────────────────────────────────────────
        /**
         * Send to FIRST object with this tag.
         * Example: this.sendMessage("Enemy", "takeDamage", 10)
         */
        sendMessage(tag, msg, data)      { _sendMessageToTag(String(tag), String(msg), data); },
        /**
         * Send to ALL objects with this tag.
         * Example: this.broadcast("Enemy", "freeze")
         */
        broadcast(tag, msg, data)        { _broadcastToTag(String(tag), String(msg), data); },
        /**
         * Send to all objects in a group.
         */
        broadcastGroup(grp, msg, data)   { _broadcastToGroup(String(grp), String(msg), data); },
        /**
         * Send to every scripted object in the scene.
         */
        broadcastAll(msg, data)          { _broadcastGlobal(String(msg), data); },

        // ── SCENE MANAGEMENT ─────────────────────────────────
        /**
         * Switch to a scene by name or index.
         * Example: this.gotoScene("Level2")  or  this.gotoScene(1)
         */
        gotoScene(nameOrIndex) {
            if (typeof nameOrIndex === 'number') {
                import('./engine.scenes.js').then(m => m.switchToScene(nameOrIndex));
            } else {
                const idx = state.scenes.findIndex(s => s.name === String(nameOrIndex));
                if (idx !== -1) import('./engine.scenes.js').then(m => m.switchToScene(idx));
                else _logConsole(`gotoScene: scene "${nameOrIndex}" not found`, '#f87171');
            }
        },
        /** Get the name of the current scene */
        get currentScene() { return state.scenes[state.activeSceneIndex]?.name ?? ''; },
        /** Get the index of the current scene */
        get currentSceneIndex() { return state.activeSceneIndex; },
        /** Get total number of scenes */
        get sceneCount() { return state.scenes.length; },
        /** Get the name of a scene by index */
        getSceneName(i) { return state.scenes[i]?.name ?? ''; },

        // ── CAMERA ───────────────────────────────────────────
        camera: _camera,

        // ── SCENE VARIABLES (shared across all scripts this scene) ──
        /**
         * Scene variables — shared between ALL scripts in the current scene.
         * Reset when switching scenes.
         * Example: this.sceneVar.score = 10;  log(this.sceneVar.score);
         */
        get sceneVar() { return _sceneVars; },

        // ── GLOBAL VARIABLES (persist across scenes) ─────────
        /**
         * Global variables — persist even when switching scenes.
         * Example: this.globalVar.totalCoins += 1;
         */
        get globalVar() { return _globalVars; },

        // ── TIME ─────────────────────────────────────────────
        /** Total seconds since Play was pressed */
        get time()    { return performance.now() / 1000; },
        get elapsed() { return performance.now() / 1000; },

        // ── MATH ─────────────────────────────────────────────
        math: {
            lerp:    (a,b,t)      => a + (b-a) * Math.max(0,Math.min(1,t)),
            clamp:   (v,lo,hi)    => Math.max(lo, Math.min(hi,v)),
            dist:    (x1,y1,x2,y2) => Math.sqrt((x2-x1)**2+(y2-y1)**2),
            rand:    (mn,mx)      => Math.random()*(mx-mn)+mn,
            randInt: (mn,mx)      => Math.floor(Math.random()*(mx-mn+1))+mn,
            sign:    v            => Math.sign(v),
            toRad:   d            => d * Math.PI / 180,
            toDeg:   r            => r * 180 / Math.PI,
            map:     (v,a1,b1,a2,b2) => a2 + (b2-a2)*((v-a1)/(b1-a1)),
            wrap:    (v,mn,mx)    => ((v-mn)%(mx-mn)+(mx-mn))%(mx-mn)+mn,
            sin:  Math.sin,  cos:  Math.cos,  tan:   Math.tan,
            abs:  Math.abs,  sqrt: Math.sqrt, pow:   Math.pow,
            atan2:Math.atan2,floor:Math.floor,ceil:  Math.ceil,
            round:Math.round,PI:   Math.PI,   max:   Math.max,  min: Math.min,
        },

        // ── DEBUG ─────────────────────────────────────────────
        log(...a)   { _logConsole(`[${obj.label}] ${a.map(String).join(' ')}`, '#9bc');    },
        warn(...a)  { _logConsole(`[${obj.label}] ⚠ ${a.map(String).join(' ')}`, '#facc15'); },
        error(...a) { _logConsole(`[${obj.label}] ✖ ${a.map(String).join(' ')}`, '#f87171'); },

        // ── PER-OBJECT STORE (lives only during play session) ─
        store: (() => {
            const d = {};
            return {
                set(k, v)   { d[k] = v; },
                get(k, def) { return k in d ? d[k] : def; },
                has(k)      { return k in d; },
                del(k)      { delete d[k]; },
            };
        })(),
    };

    return { api, _keys, _keysJustDown, _keysJustUp, _mouse };
}

// ── Object proxy (returned by find / findWithTag etc.) ────────
function _makeProxy(f) {
    return {
        _ref:         f,
        get name()    { return f.label; },
        get tag()     { return f._scriptTag   ?? ''; },
        get group()   { return f._scriptGroup ?? ''; },
        /** World X of the found object */
        get x()       { return  f.x  / 100; },
        /** World Y of the found object */
        get y()       { return -f.y  / 100; },
        get visible() { return f.visible; },
        set visible(v){ f.visible = !!v; },
        get alpha()   { return f.alpha; },
        set alpha(v)  { f.alpha = v; },
        /** Send a message directly to this specific object */
        sendMessage(msg, data) {
            const inst = _instances.find(i => i.obj === f);
            if (inst) _deliverMsg(inst, msg, data);
        },
    };
}

// ── Script Instance ───────────────────────────────────────────
class ScriptInstance {
    constructor(obj, name, code) {
        this.obj              = obj;
        this.name             = name;
        // All registered callbacks
        this._onStart         = null;
        this._onUpdate        = null;
        this._onStop          = null;
        this._onCollisionEnter= null;  // fired once when collision begins
        this._onCollisionStay = null;  // fired every frame while colliding
        this._onCollisionExit = null;  // fired once when collision ends
        this._onOverlapEnter  = null;  // AABB overlap starts
        this._onOverlapExit   = null;  // AABB overlap ends
        this._onVisible       = null;
        this._onHide          = null;
        this._onMouseClick    = null;
        this._onMouseEnter    = null;
        this._onMouseLeave    = null;
        this._messageHandlers = new Map();

        // Collision / overlap tracking
        this._activeCollisions = new Set(); // Set of other obj refs currently colliding
        this._activeOverlaps   = new Set(); // Set of other obj refs currently overlapping

        // instRef array so _buildSandbox can back-reference this instance
        const instRef = [null];
        const { api, _keys, _keysJustDown, _keysJustUp, _mouse } = _buildSandbox(obj, instRef);
        instRef[0]     = this;
        this.api       = api;
        this._keys     = _keys;
        this._keysJustDown  = _keysJustDown;
        this._keysJustUp    = _keysJustUp;
        this._mouse    = _mouse;
        this._compile(code, api);
    }

    _compile(code, api) {
        // ── The full scripting prelude — everything accessible in scripts ──
        const prelude = `
"use strict";
var _onStart=null, _onUpdate=null, _onStop=null;
var _onCollisionEnter=null, _onCollisionStay=null, _onCollisionExit=null;
var _onOverlapEnter=null, _onOverlapExit=null;
var _onVisible=null, _onHide=null, _onMouseClick=null, _onMouseEnter=null, _onMouseLeave=null;
var _msgHandlers = new Map();

// ═══════════════════════════════════════════════════════════════
// EVENT REGISTRATION
// Register functions to run at specific moments in the game loop.
// ═══════════════════════════════════════════════════════════════

/** Runs once when Play is pressed */
function onStart(fn)             { _onStart          = fn; }
/** Runs every frame. dt = seconds since last frame (use for smooth movement) */
function onUpdate(fn)            { _onUpdate         = fn; }
/** Runs once when Play is stopped */
function onStop(fn)              { _onStop           = fn; }
/** Runs once when this object begins touching another (physics) */
function onCollisionEnter(fn)    { _onCollisionEnter = fn; }
/** Runs every frame while this object is still touching another (physics) */
function onCollisionStay(fn)     { _onCollisionStay  = fn; }
/** Runs once when this object stops touching another (physics) */
function onCollisionExit(fn)     { _onCollisionExit  = fn; }
/** Runs once when this object's AABB begins overlapping another (no physics needed) */
function onOverlapEnter(fn)      { _onOverlapEnter   = fn; }
/** Runs once when this object's AABB stops overlapping another */
function onOverlapExit(fn)       { _onOverlapExit    = fn; }
/** Runs when this object becomes visible */
function onBecomeVisible(fn)     { _onVisible        = fn; }
/** Runs when this object becomes hidden */
function onBecomeHidden(fn)      { _onHide           = fn; }
/** Runs when this object is clicked */
function onMouseClick(fn)        { _onMouseClick     = fn; }
/** Runs when the mouse enters this object's area */
function onMouseEnter(fn)        { _onMouseEnter     = fn; }
/** Runs when the mouse leaves this object's area */
function onMouseLeave(fn)        { _onMouseLeave     = fn; }
/**
 * Runs when this object receives a message.
 * Example: onMessage("takeDamage", (amount) => { ... })
 */
function onMessage(msg, fn)      { _msgHandlers.set(String(msg), fn); }

// ═══════════════════════════════════════════════════════════════
// THIS OBJECT — use "this." prefix for clarity
// All of these refer to the object this script is attached to.
// ═══════════════════════════════════════════════════════════════
var self = api;  // "self" is a backup alias for "this"

// ── Position ──────────────────────────────────────────────────
/** this.x — world X position of this object */
function getX()        { return api.x; }
function setX(v)       { api.x = v; }
/** this.y — world Y position (positive = up) */
function getY()        { return api.y; }
function setY(v)       { api.y = v; }
/** Move by (dx, dy) world units */
function move(dx, dy)  { api.move(dx, dy); }
/** Same as move */
function translate(dx, dy) { api.move(dx, dy); }
/** Warp this object to exact position */
function moveTo(x, y)  { api.moveTo(x, y); }
/** Move in the direction this object is currently facing */
function moveForward(speed) { api.moveForward(speed); }
/** Rotate this object to face a world position */
function lookAt(tx, ty){ api.lookAt(tx, ty); }
function flipX()       { api.flipX(); }
function flipY()       { api.flipY(); }
/** Width of this object in world units */
function getWidth()    { return api.width; }
/** Height of this object in world units */
function getHeight()   { return api.height; }

// ── Rotation and scale ────────────────────────────────────────
/** this.rotation — degrees (clockwise positive) */
function getRotation()   { return api.rotation; }
function setRotation(v)  { api.rotation = v; }
/** this.scaleX / this.scaleY */
function getScaleX()     { return api.scaleX; }
function setScaleX(v)    { api.scaleX = v; }
function getScaleY()     { return api.scaleY; }
function setScaleY(v)    { api.scaleY = v; }

// ── Velocity (applied every frame automatically) ─────────────
/**
 * this.velocityX / vx — horizontal speed in world units/second.
 * Set this and the object moves that direction automatically.
 * Example: this.velocityX = 5;  // moves right at 5 units/sec
 */
var velocityX = 0;
var velocityY = 0;
var vx = 0;
var vy = 0;
function setVelocity(x, y)  { api.setVelocity(x, y); velocityX=x; vx=x; velocityY=y; vy=y; }
function stopMovement()     { api.stopMovement(); velocityX=0; vx=0; velocityY=0; vy=0; }
function bounceX()          { api.bounceX(); velocityX=api.velocityX; vx=velocityX; }
function bounceY()          { api.bounceY(); velocityY=api.velocityY; vy=velocityY; }

// ── Manual gravity ────────────────────────────────────────────
/**
 * Apply gravity to this object (world units/s²).
 * Call once in onStart to enable:
 *   this.gravity(0, -9.8)   ← falls downward every frame
 *   this.gravity(0, 0)      ← disable gravity
 */
function gravity(gx, gy) { api.gravity(gx, gy); }

// ── Display ───────────────────────────────────────────────────
function show()           { api.visible = true; }
function hide()           { api.visible = false; }
function getVisible()     { return api.visible; }
function setVisible(v)    { api.visible = v; }
function getAlpha()       { return api.alpha; }
function setAlpha(v)      { api.alpha = v; }
function fadeIn(t, dt)    { api.alpha = Math.min(1, api.alpha + dt/Math.max(0.001,t)); }
function fadeOut(t, dt)   { api.alpha = Math.max(0, api.alpha - dt/Math.max(0.001,t)); }

// ── Tag and group ─────────────────────────────────────────────
/**
 * this.tag — label for this object (used in findWithTag, sendMessage).
 * Set it in onStart:  setTag("player")
 */
function setTag(t)        { api.tag   = t; }
function getTag()         { return api.tag; }
function setGroup(g)      { api.group = g; }
function getGroup()       { return api.group; }

// ── Messaging ─────────────────────────────────────────────────
/**
 * Send a message to the FIRST object with this tag.
 * Example: sendMessage("Enemy", "takeDamage", 10)
 * On the receiving end: onMessage("takeDamage", (amount) => { ... })
 */
function sendMessage(tag, msg, data)      { api.sendMessage(tag, msg, data); }
/**
 * Send to ALL objects with this tag.
 * Example: broadcast("Enemy", "freeze")
 */
function broadcast(tag, msg, data)        { api.broadcast(tag, msg, data); }
/**
 * Send to all objects in a group.
 * Example: broadcastGroup("wave1", "explode")
 */
function broadcastGroup(grp, msg, data)   { api.broadcastGroup(grp, msg, data); }
/**
 * Send to EVERY scripted object in the scene.
 * Example: broadcastAll("gameOver")
 */
function broadcastAll(msg, data)          { api.broadcastAll(msg, data); }

// ── Finding other objects ─────────────────────────────────────
/**
 * Find an object by its exact name.
 * Returns an object proxy with .x, .y, .name, .sendMessage()
 * Example:  var player = find("Player");  log(player.x);
 */
function find(label)                { return api.find(label); }
/** Find the first object with a given tag */
function findWithTag(tag)           { return api.findWithTag(tag); }
/** Find ALL objects with a given tag — returns an array */
function findAllWithTag(tag)        { return api.findAllWithTag(tag); }
/** Find ALL objects in a group — returns an array */
function findAllInGroup(grp)        { return api.findAllInGroup(grp); }

// ── Overlap detection (no physics body needed) ────────────────
/**
 * Check if this object is overlapping another RIGHT NOW (AABB box check).
 * Does not need a physics body — works on any object.
 * Example: if (overlaps(find("Coin"))) { ... }
 */
function overlaps(other)            { return api.overlaps(other); }
/** Returns the first object with this tag that this object overlaps, or null */
function overlapsTag(tag)           { return api.overlapsTag(tag); }
/** Returns ALL objects with this tag that this object overlaps */
function overlapsAllWithTag(tag)    { return api.overlapsAllWithTag(tag); }

// ── Destroy ───────────────────────────────────────────────────
/** Remove this object from the scene */
function destroySelf()              { api.destroySelf(); }
/** Remove another object (pass a proxy from find/findWithTag) */
function destroy(other)             { api.destroy(other); }

// ── Scene management ──────────────────────────────────────────
/**
 * Switch to a different scene by name or index.
 * Example: gotoScene("Level2")  or  gotoScene(1)
 */
function gotoScene(nameOrIndex)     { api.gotoScene(nameOrIndex); }
/** Name of the current scene */
function currentScene()             { return api.currentScene; }
/** Index of the current scene (0-based) */
function currentSceneIndex()        { return api.currentSceneIndex; }
/** Total number of scenes */
function sceneCount()               { return api.sceneCount; }
/** Get scene name by index */
function getSceneName(i)            { return api.getSceneName(i); }

// ── Camera ────────────────────────────────────────────────────
/**
 * Make the camera follow an object smoothly.
 * Example:  cameraFollow(find("Player"))
 *           cameraFollow(find("Player"), 8)   ← faster smoothing
 */
function cameraFollow(target, smoothing)    { api.camera.follow(target, smoothing); }
/** Stop camera from following */
function cameraUnfollow()                   { api.camera.unfollow(); }
/** Move camera instantly to a world position */
function cameraMoveTo(wx, wy)              { api.camera.moveTo(wx, wy); }
/** Get camera X position in world units */
function getCameraX()                      { return api.camera.x; }
/** Get camera Y position in world units */
function getCameraY()                      { return api.camera.y; }
/** Shake the camera */
function cameraShake(amplitude, duration)  { api.camera.shake(amplitude, duration); }

// ── Animation ─────────────────────────────────────────────────
function playAnimation(name)  { api.playAnimation(name); }
function stopAnimation()      { api.stopAnimation(); }
function pauseAnimation()     { api.pauseAnimation(); }
function currentAnimation()   { return api.currentAnimation; }

// ── Physics body (Box2D/Matter.js) ────────────────────────────
var physics = api.physics;

// ── Input ─────────────────────────────────────────────────────
var input = api.input;
/** Is key currently held? Example: isKeyDown("w") or isKeyDown("ArrowLeft") */
function isKeyDown(k)         { return input.isKeyDown(k); }
/** Was key pressed for the first time this frame? */
function isKeyJustDown(k)     { return input.isKeyJustDown(k); }
/** Was key released this frame? */
function isKeyJustUp(k)       { return input.isKeyJustUp(k); }
/** Horizontal axis from A/D or arrow keys. Returns -1, 0, or 1 */
function axisH()              { return input.axisH; }
/** Vertical axis from W/S or arrow keys. Returns -1, 0, or 1 */
function axisV()              { return input.axisV; }
/** Mouse X in world units */
function mouseX()             { return input.worldMouseX; }
/** Mouse Y in world units */
function mouseY()             { return input.worldMouseY; }
/** Is mouse button held? */
function mouseDown()          { return input.mouseDown; }
/** Was mouse button clicked this frame? */
function mouseJustDown()      { return input.mouseJustDown; }

// ── Time ──────────────────────────────────────────────────────
/** Total seconds since Play was pressed */
function getTime()            { return api.time; }

// ── Shared variables ──────────────────────────────────────────
/**
 * sceneVar — variables shared between ALL scripts in the current scene.
 * Reset when you switch scenes.
 * Example:  sceneVar.score = 0;   sceneVar.score += 1;
 */
var sceneVar  = api.sceneVar;
/**
 * globalVar — variables that survive even when you switch scenes.
 * Example:  globalVar.totalDeaths += 1;
 */
var globalVar = api.globalVar;

// ── Per-script key/value store ────────────────────────────────
/** store — private to this script, reset on Play stop */
var store = api.store;

// ── Math helpers ──────────────────────────────────────────────
var math    = api.math;
var lerp    = math.lerp;
var clamp   = math.clamp;
var dist    = math.dist;
var rand    = math.rand;
var randInt = math.randInt;
var sign    = math.sign;
var toRad   = math.toRad;
var toDeg   = math.toDeg;
var mapRange= math.map;
var wrap    = math.wrap;
var sin     = math.sin;   var cos   = math.cos;   var tan   = math.tan;
var abs     = math.abs;   var sqrt  = math.sqrt;  var pow   = math.pow;
var atan2   = math.atan2; var floor = math.floor; var ceil  = math.ceil;
var round   = math.round; var PI    = math.PI;
var max     = math.max;   var min   = math.min;

// ── Debug ─────────────────────────────────────────────────────
/** Print to the console */
function log(...a)    { api.log(...a); }
/** Print a warning */
function warn(...a)   { api.warn(...a); }
/** Print an error */
function error(...a)  { api.error(...a); }
`;

        const postlude = `
;__out._onStart          = _onStart;
__out._onUpdate          = _onUpdate;
__out._onStop            = _onStop;
__out._onCollisionEnter  = _onCollisionEnter;
__out._onCollisionStay   = _onCollisionStay;
__out._onCollisionExit   = _onCollisionExit;
__out._onOverlapEnter    = _onOverlapEnter;
__out._onOverlapExit     = _onOverlapExit;
__out._onVisible         = _onVisible;
__out._onHide            = _onHide;
__out._onMouseClick      = _onMouseClick;
__out._onMouseEnter      = _onMouseEnter;
__out._onMouseLeave      = _onMouseLeave;
__out._msgHandlers       = _msgHandlers;
__out._initVX            = typeof velocityX !== 'undefined' ? velocityX : 0;
__out._initVY            = typeof velocityY !== 'undefined' ? velocityY : 0;
`;
        try {
            const fn = new Function('api', '__out', prelude + '\n' + code + '\n' + postlude); // eslint-disable-line no-new-func
            const out = {};
            fn(api, out);
            this._onStart         = out._onStart         ?? null;
            this._onUpdate        = out._onUpdate        ?? null;
            this._onStop          = out._onStop          ?? null;
            this._onCollisionEnter= out._onCollisionEnter ?? null;
            this._onCollisionStay = out._onCollisionStay  ?? null;
            this._onCollisionExit = out._onCollisionExit  ?? null;
            this._onOverlapEnter  = out._onOverlapEnter   ?? null;
            this._onOverlapExit   = out._onOverlapExit    ?? null;
            this._onVisible       = out._onVisible        ?? null;
            this._onHide          = out._onHide           ?? null;
            this._onMouseClick    = out._onMouseClick     ?? null;
            this._onMouseEnter    = out._onMouseEnter     ?? null;
            this._onMouseLeave    = out._onMouseLeave     ?? null;
            this._messageHandlers = out._msgHandlers      ?? new Map();
            // Apply initial velocity values from top-level declarations
            api._vel.x = out._initVX ?? 0;
            api._vel.y = out._initVY ?? 0;
        } catch (err) {
            _logConsole(`[Script "${this.name}" → "${this.obj.label}"] ✖ ${err.message}`, '#f87171');
        }
    }

    start() {
        if (!this._onStart) return;
        try { this._onStart(); }
        catch (e) { _logConsole(`[Script "${this.name}"] onStart: ${e.message}`, '#f87171'); }
    }

    update(dt) {
        // Auto-integrate velocity + gravity
        const vel  = this.api._vel;
        const grav = this.api._grav;

        // Apply gravity to velocity
        if (grav.x !== 0) vel.x += grav.x * dt;
        if (grav.y !== 0) vel.y += grav.y * dt;

        // Integrate velocity into position
        if (vel.x !== 0) this.obj.x +=  vel.x * dt * 100;
        if (vel.y !== 0) this.obj.y -= vel.y * dt * 100;

        if (this._onUpdate) {
            try { this._onUpdate(dt); }
            catch (e) { _logConsole(`[Script "${this.name}"] onUpdate: ${e.message}`, '#f87171'); }
        }

        // Destroy queue
        if (this.obj._markedForDestroy) _destroyObject(this.obj);

        // Clear per-frame input flags
        this._keysJustDown.clear();
        this._keysJustUp.clear();
        this._mouse.justDown = false;
        this._mouse.justUp   = false;
    }

    stop() {
        if (!this._onStop) return;
        try { this._onStop(); }
        catch (e) { _logConsole(`[Script "${this.name}"] onStop: ${e.message}`, '#f87171'); }
    }

    // ── Collision callbacks (physics — fired by engine.physics.js) ──
    handleCollisionEnter(other) {
        if (!other) return;
        this._activeCollisions.add(other);
        if (this._onCollisionEnter) {
            const proxy = _makeProxy(other);
            try { this._onCollisionEnter(proxy); }
            catch (e) { _logConsole(`[Script "${this.name}"] onCollisionEnter: ${e.message}`, '#f87171'); }
        }
    }

    handleCollisionStay(other) {
        if (this._onCollisionStay) {
            const proxy = _makeProxy(other);
            try { this._onCollisionStay(proxy); }
            catch (e) { _logConsole(`[Script "${this.name}"] onCollisionStay: ${e.message}`, '#f87171'); }
        }
    }

    handleCollisionExit(other) {
        this._activeCollisions.delete(other);
        if (this._onCollisionExit) {
            const proxy = _makeProxy(other);
            try { this._onCollisionExit(proxy); }
            catch (e) { _logConsole(`[Script "${this.name}"] onCollisionExit: ${e.message}`, '#f87171'); }
        }
    }

    // ── Overlap callbacks (AABB — fired by scripting runtime) ────────
    handleOverlapEnter(other) {
        this._activeOverlaps.add(other);
        if (this._onOverlapEnter) {
            const proxy = _makeProxy(other);
            try { this._onOverlapEnter(proxy); }
            catch (e) { _logConsole(`[Script "${this.name}"] onOverlapEnter: ${e.message}`, '#f87171'); }
        }
    }

    handleOverlapExit(other) {
        this._activeOverlaps.delete(other);
        if (this._onOverlapExit) {
            const proxy = _makeProxy(other);
            try { this._onOverlapExit(proxy); }
            catch (e) { _logConsole(`[Script "${this.name}"] onOverlapExit: ${e.message}`, '#f87171'); }
        }
    }

    _handleKeyDown(key) {
        const k = key.toLowerCase();
        if (!this._keys.has(k)) this._keysJustDown.add(k);
        this._keys.add(k);
    }
    _handleKeyUp(key) {
        const k = key.toLowerCase();
        this._keysJustUp.add(k);
        this._keys.delete(k);
    }
    _handleMouseMove(x, y) { this._mouse.x = x; this._mouse.y = y; }
    _handleMouseDown()     { this._mouse.down = true;  this._mouse.justDown = true; }
    _handleMouseUp()       { this._mouse.down = false; this._mouse.justUp   = true; }
}

// ── Object destroy helper ─────────────────────────────────────
function _destroyObject(obj) {
    obj.visible = false;
    try { state.sceneContainer?.removeChild(obj); } catch(_) {}
    const idx = state.gameObjects.indexOf(obj);
    if (idx !== -1) state.gameObjects.splice(idx, 1);
    obj._markedForDestroy = false;
}

// ── Runtime state ─────────────────────────────────────────────
const _instances = [];
let   _ticker    = null;

// ── Input event relay ─────────────────────────────────────────
function _kd(e) { for (const i of _instances) i._handleKeyDown(e.key); }
function _ku(e) { for (const i of _instances) i._handleKeyUp(e.key); }
function _mm(e) {
    const c = state.app?.view; if (!c) return;
    const r = c.getBoundingClientRect();
    for (const i of _instances) i._handleMouseMove(e.clientX - r.left, e.clientY - r.top);
}
function _md() { for (const i of _instances) i._handleMouseDown(); }
function _mu() { for (const i of _instances) i._handleMouseUp(); }

// ── Overlap check pass (runs every frame) ─────────────────────
function _runOverlapChecks() {
    // Only check instances that have overlap handlers
    const tracked = _instances.filter(i => i._onOverlapEnter || i._onOverlapExit);
    if (tracked.length === 0) return;

    for (const inst of tracked) {
        for (const other of _instances) {
            if (other === inst) continue;
            const wasOverlapping = inst._activeOverlaps.has(other.obj);
            const isNow = _isOverlapping(inst.obj, other.obj);
            if (isNow && !wasOverlapping)  inst.handleOverlapEnter(other.obj);
            if (!isNow && wasOverlapping)  inst.handleOverlapExit(other.obj);
        }
    }
}

// ── Continuous collision stay pass (runs every frame) ─────────
function _runCollisionStayChecks() {
    for (const inst of _instances) {
        if (!inst._onCollisionStay) continue;
        for (const otherObj of inst._activeCollisions) {
            inst.handleCollisionStay(otherObj);
        }
    }
}

// ── Start scripts (enterPlayMode) ─────────────────────────────
export function startScripts() {
    stopScripts();
    _clearRegistries();
    _camera._followTarget = null;

    let count = 0;
    for (const obj of state.gameObjects) {
        if (!obj.scriptName) continue;
        const rec = getScript(obj.scriptName);
        if (!rec) {
            _logConsole(`[Scripting] Script "${obj.scriptName}" not found for "${obj.label}"`, '#facc15');
            continue;
        }
        const inst = new ScriptInstance(obj, obj.scriptName, rec.code);
        _instances.push(inst);
        _registerInstance(inst);
        count++;
    }

    if (count === 0) return;

    // Fire onStart for all instances after all are registered
    // (so messaging and findWithTag work in onStart)
    for (const i of _instances) i.start();

    window.addEventListener('keydown',   _kd);
    window.addEventListener('keyup',     _ku);
    window.addEventListener('mousemove', _mm);
    window.addEventListener('mousedown', _md);
    window.addEventListener('mouseup',   _mu);

    let _last = performance.now();
    _ticker = () => {
        if (!state.isPlaying || state.isPaused) return;
        const now = performance.now();
        const dt  = Math.min((now - _last) / 1000, 0.1);
        _last = now;

        _updateCamera(dt);
        _runOverlapChecks();
        _runCollisionStayChecks();

        const snap = [..._instances];
        for (const i of snap) {
            if (!state.gameObjects.includes(i.obj)) continue;
            i.update(dt);
        }
    };
    state.app.ticker.add(_ticker);
    _logConsole(`▶ Scripts: ${count} instance${count!==1?'s':''} running`, '#4ade80');
}

// ── Stop scripts (stopPlayMode) ───────────────────────────────
export function stopScripts() {
    for (const i of _instances) i.stop();
    _instances.length = 0;
    _clearRegistries();
    _camera._followTarget = null;
    clearSceneVars();
    if (_ticker && state.app) { state.app.ticker.remove(_ticker); _ticker = null; }
    window.removeEventListener('keydown',   _kd);
    window.removeEventListener('keyup',     _ku);
    window.removeEventListener('mousemove', _mm);
    window.removeEventListener('mousedown', _md);
    window.removeEventListener('mouseup',   _mu);
}

// ── Collision bridge (called from engine.physics.js) ──────────
export function triggerCollision(objA, objB) {
    for (const i of _instances) {
        if (i.obj === objA) i.handleCollisionEnter(objB);
        if (i.obj === objB) i.handleCollisionEnter(objA);
    }
}

// ── Collision exit bridge (called from engine.physics.js) ─────
export function triggerCollisionEnd(objA, objB) {
    for (const i of _instances) {
        if (i.obj === objA) i.handleCollisionExit(objB);
        if (i.obj === objB) i.handleCollisionExit(objA);
    }
}


// ── Ace autocomplete — only the allowed scripting API ─────────
const COMPLETIONS = [
    // Events
    { n:'onStart',           m:'● event',     v:"onStart(() => {\n  \n});" },
    { n:'onUpdate',          m:'● event',     v:"onUpdate((dt) => {\n  \n});" },
    { n:'onStop',            m:'● event',     v:"onStop(() => {\n  \n});" },
    { n:'onCollisionEnter',  m:'● event',     v:"onCollisionEnter((other) => {\n  // other.name, other.x, other.y\n});" },
    { n:'onCollisionStay',   m:'● event',     v:"onCollisionStay((other) => {\n  \n});" },
    { n:'onCollisionExit',   m:'● event',     v:"onCollisionExit((other) => {\n  \n});" },
    { n:'onOverlapEnter',    m:'● event',     v:"onOverlapEnter((other) => {\n  \n});" },
    { n:'onOverlapExit',     m:'● event',     v:"onOverlapExit((other) => {\n  \n});" },
    { n:'onMessage',         m:'● event',     v:"onMessage('${1:messageName}', (data) => {\n  \n});" },
    { n:'onBecomeVisible',   m:'● event',     v:"onBecomeVisible(() => {\n  \n});" },
    { n:'onBecomeHidden',    m:'● event',     v:"onBecomeHidden(() => {\n  \n});" },
    { n:'onMouseClick',      m:'● event',     v:"onMouseClick(() => {\n  \n});" },
    { n:'onMouseEnter',      m:'● event',     v:"onMouseEnter(() => {\n  \n});" },
    { n:'onMouseLeave',      m:'● event',     v:"onMouseLeave(() => {\n  \n});" },
    // this.x / this.y position
    { n:'getX',              m:'↔ position',  v:'getX()' },
    { n:'setX',              m:'↔ position',  v:'setX(${1:value})' },
    { n:'getY',              m:'↔ position',  v:'getY()' },
    { n:'setY',              m:'↔ position',  v:'setY(${1:value})' },
    { n:'moveTo',            m:'↔ position',  v:'moveTo(${1:x}, ${2:y})' },
    { n:'move',              m:'↔ position',  v:'move(${1:dx}, ${2:dy})' },
    { n:'moveForward',       m:'↔ position',  v:'moveForward(${1:speed})' },
    { n:'lookAt',            m:'↔ position',  v:'lookAt(${1:tx}, ${2:ty})' },
    { n:'flipX',             m:'↔ position',  v:'flipX()' },
    { n:'flipY',             m:'↔ position',  v:'flipY()' },
    // Velocity
    { n:'velocityX',         m:'⚡ velocity',  v:'velocityX' },
    { n:'velocityY',         m:'⚡ velocity',  v:'velocityY' },
    { n:'vx',                m:'⚡ velocity',  v:'vx' },
    { n:'vy',                m:'⚡ velocity',  v:'vy' },
    { n:'setVelocity',       m:'⚡ velocity',  v:'setVelocity(${1:vx}, ${2:vy})' },
    { n:'stopMovement',      m:'⚡ velocity',  v:'stopMovement()' },
    { n:'bounceX',           m:'⚡ velocity',  v:'bounceX()' },
    { n:'bounceY',           m:'⚡ velocity',  v:'bounceY()' },
    // Gravity
    { n:'gravity',           m:'↓ gravity',   v:'gravity(${1:0}, ${2:-9.8})' },
    // Rotation / Scale
    { n:'getRotation',       m:'↻ rotation',  v:'getRotation()' },
    { n:'setRotation',       m:'↻ rotation',  v:'setRotation(${1:degrees})' },
    { n:'getScaleX',         m:'⤡ scale',     v:'getScaleX()' },
    { n:'setScaleX',         m:'⤡ scale',     v:'setScaleX(${1:value})' },
    { n:'getScaleY',         m:'⤡ scale',     v:'getScaleY()' },
    { n:'setScaleY',         m:'⤡ scale',     v:'setScaleY(${1:value})' },
    // Display
    { n:'show',              m:'👁 display',   v:'show()' },
    { n:'hide',              m:'👁 display',   v:'hide()' },
    { n:'setVisible',        m:'👁 display',   v:'setVisible(${1:true})' },
    { n:'getAlpha',          m:'👁 display',   v:'getAlpha()' },
    { n:'setAlpha',          m:'👁 display',   v:'setAlpha(${1:1})' },
    { n:'fadeIn',            m:'👁 display',   v:'fadeIn(${1:duration}, dt)' },
    { n:'fadeOut',           m:'👁 display',   v:'fadeOut(${1:duration}, dt)' },
    // Tag / Group
    { n:'setTag',            m:'🏷 tag',       v:"setTag('${1:myTag}')" },
    { n:'getTag',            m:'🏷 tag',       v:'getTag()' },
    { n:'setGroup',          m:'🏷 group',     v:"setGroup('${1:myGroup}')" },
    { n:'getGroup',          m:'🏷 group',     v:'getGroup()' },
    // Messaging
    { n:'sendMessage',       m:'📨 message',   v:"sendMessage('${1:tag}', '${2:message}', ${3:data})" },
    { n:'broadcast',         m:'📨 message',   v:"broadcast('${1:tag}', '${2:message}')" },
    { n:'broadcastGroup',    m:'📨 message',   v:"broadcastGroup('${1:group}', '${2:message}')" },
    { n:'broadcastAll',      m:'📨 message',   v:"broadcastAll('${1:message}')" },
    // Finding objects
    { n:'find',              m:'🔍 find',      v:"find('${1:label}')" },
    { n:'findWithTag',       m:'🔍 find',      v:"findWithTag('${1:tag}')" },
    { n:'findAllWithTag',    m:'🔍 find',      v:"findAllWithTag('${1:tag}')" },
    { n:'findAllInGroup',    m:'🔍 find',      v:"findAllInGroup('${1:group}')" },
    // Overlap
    { n:'overlaps',          m:'⬡ overlap',    v:'overlaps(${1:other})' },
    { n:'overlapsTag',       m:'⬡ overlap',    v:"overlapsTag('${1:tag}')" },
    { n:'overlapsAllWithTag',m:'⬡ overlap',    v:"overlapsAllWithTag('${1:tag}')" },
    // Destroy
    { n:'destroySelf',       m:'💥 destroy',   v:'destroySelf()' },
    { n:'destroy',           m:'💥 destroy',   v:'destroy(${1:other})' },
    // Scene
    { n:'gotoScene',         m:'🎬 scene',     v:"gotoScene('${1:SceneName}')" },
    { n:'currentScene',      m:'🎬 scene',     v:'currentScene()' },
    { n:'currentSceneIndex', m:'🎬 scene',     v:'currentSceneIndex()' },
    { n:'sceneCount',        m:'🎬 scene',     v:'sceneCount()' },
    { n:'getSceneName',      m:'🎬 scene',     v:'getSceneName(${1:index})' },
    // Camera
    { n:'cameraFollow',      m:'📷 camera',    v:'cameraFollow(find("${1:Player}"), ${2:6})' },
    { n:'cameraUnfollow',    m:'📷 camera',    v:'cameraUnfollow()' },
    { n:'cameraMoveTo',      m:'📷 camera',    v:'cameraMoveTo(${1:x}, ${2:y})' },
    { n:'getCameraX',        m:'📷 camera',    v:'getCameraX()' },
    { n:'getCameraY',        m:'📷 camera',    v:'getCameraY()' },
    { n:'cameraShake',       m:'📷 camera',    v:'cameraShake(${1:0.2}, ${2:0.3})' },
    // Input
    { n:'isKeyDown',         m:'🎮 input',     v:"isKeyDown('${1:w}')" },
    { n:'isKeyJustDown',     m:'🎮 input',     v:"isKeyJustDown('${1:Space}')" },
    { n:'isKeyJustUp',       m:'🎮 input',     v:"isKeyJustUp('${1:w}')" },
    { n:'axisH',             m:'🎮 input',     v:'axisH()' },
    { n:'axisV',             m:'🎮 input',     v:'axisV()' },
    { n:'mouseX',            m:'🎮 input',     v:'mouseX()' },
    { n:'mouseY',            m:'🎮 input',     v:'mouseY()' },
    { n:'mouseDown',         m:'🎮 input',     v:'mouseDown()' },
    { n:'mouseJustDown',     m:'🎮 input',     v:'mouseJustDown()' },
    // Animation
    { n:'playAnimation',     m:'▶ anim',      v:"playAnimation('${1:name}')" },
    { n:'stopAnimation',     m:'▶ anim',      v:'stopAnimation()' },
    { n:'currentAnimation',  m:'▶ anim',      v:'currentAnimation()' },
    // Physics body
    { n:'physics.setVelocity',  m:'⚙ physics', v:'physics.setVelocity(${1:vx}, ${2:vy})' },
    { n:'physics.applyForce',   m:'⚙ physics', v:'physics.applyForce(${1:fx}, ${2:fy})' },
    { n:'physics.applyImpulse', m:'⚙ physics', v:'physics.applyImpulse(${1:ix}, ${2:iy})' },
    { n:'physics.velX',         m:'⚙ physics', v:'physics.velX' },
    { n:'physics.velY',         m:'⚙ physics', v:'physics.velY' },
    { n:'physics.stop',         m:'⚙ physics', v:'physics.stop()' },
    // Shared variables
    { n:'sceneVar',          m:'📦 vars',      v:'sceneVar.${1:myVar}' },
    { n:'globalVar',         m:'📦 vars',      v:'globalVar.${1:myVar}' },
    { n:'store.set',         m:'📦 vars',      v:"store.set('${1:key}', ${2:value})" },
    { n:'store.get',         m:'📦 vars',      v:"store.get('${1:key}', ${2:default})" },
    // Time
    { n:'getTime',           m:'⏱ time',      v:'getTime()' },
    // Math
    { n:'lerp',              m:'∑ math',      v:'lerp(${1:a}, ${2:b}, ${3:t})' },
    { n:'clamp',             m:'∑ math',      v:'clamp(${1:v}, ${2:min}, ${3:max})' },
    { n:'dist',              m:'∑ math',      v:'dist(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})' },
    { n:'rand',              m:'∑ math',      v:'rand(${1:min}, ${2:max})' },
    { n:'randInt',           m:'∑ math',      v:'randInt(${1:min}, ${2:max})' },
    { n:'sign',              m:'∑ math',      v:'sign(${1:v})' },
    { n:'toRad',             m:'∑ math',      v:'toRad(${1:degrees})' },
    { n:'toDeg',             m:'∑ math',      v:'toDeg(${1:radians})' },
    { n:'mapRange',          m:'∑ math',      v:'mapRange(${1:v}, ${2:a1}, ${3:b1}, ${4:a2}, ${5:b2})' },
    { n:'sin',               m:'∑ math',      v:'sin(${1:a})' },
    { n:'cos',               m:'∑ math',      v:'cos(${1:a})' },
    { n:'abs',               m:'∑ math',      v:'abs(${1:v})' },
    { n:'sqrt',              m:'∑ math',      v:'sqrt(${1:v})' },
    { n:'PI',                m:'∑ math',      v:'PI' },
    { n:'floor',             m:'∑ math',      v:'floor(${1:v})' },
    { n:'ceil',              m:'∑ math',      v:'ceil(${1:v})' },
    { n:'round',             m:'∑ math',      v:'round(${1:v})' },
    { n:'max',               m:'∑ math',      v:'max(${1:a}, ${2:b})' },
    { n:'min',               m:'∑ math',      v:'min(${1:a}, ${2:b})' },
    // Debug
    { n:'log',               m:'🐛 debug',    v:'log(${1:value})' },
    { n:'warn',              m:'🐛 debug',    v:'warn(${1:value})' },
    { n:'error',             m:'🐛 debug',    v:'error(${1:value})' },
].map(c => ({ caption:c.n, value:c.v, meta:c.m, score:950 }));


// ── Script Editor (Ace-powered) ───────────────────────────────
export async function openScriptEditor(obj, scriptName, initialCode) {
    document.getElementById('zengine-script-editor')?.remove();

    if (initialCode === undefined || initialCode === null) {
        initialCode = getScript(scriptName)?.code ?? _defaultScript(scriptName);
    }

    const ace = await _loadAce();
    ace.config.set('basePath', ACE_BASE);

    const overlay = document.createElement('div');
    overlay.id = 'zengine-script-editor';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#0b0d14;display:flex;flex-direction:column;font-family:system-ui,sans-serif;';

    const canDetach = !!obj && !!obj.scriptName && obj.scriptName === scriptName;
    const objLabel  = obj?.label ?? '';

    overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 14px;background:#0d0f1a;border-bottom:1px solid #1a1d2e;flex-shrink:0;user-select:none;">
            <svg viewBox="0 0 24 24" style="width:15px;height:15px;flex-shrink:0;fill:none;stroke:#7cb9f0;stroke-width:2.5;"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            <span style="color:#7cb9f0;font-weight:700;font-size:13px;">${scriptName}.js</span>
            ${obj ? `<span style="color:#252535;">│</span><span style="color:#5a7a9a;font-size:11px;">attached to: <b style="color:#9bc;">${objLabel}</b></span>` : ''}
            <div style="flex:1;"></div>
            <span id="se-status" style="font-size:11px;transition:color .2s;margin-right:6px;"></span>
            <button id="se-save"   style="${_bs('#0f2540','#7cb9f0','#1e4a7a')}">Save <kbd style="opacity:.4;font-size:9px;">Ctrl+S</kbd></button>
            ${canDetach ? `<button id="se-detach" style="${_bs('#200a0a','#f87171','#3a1515')}margin-left:4px;">Detach</button>` : ''}
            <button id="se-close"  style="${_bs('#0f1018','#666','#1a1d28')}margin-left:4px;">✕</button>
        </div>
        <div style="display:flex;flex:1;min-height:0;">
            <div style="flex:1;position:relative;min-width:0;">
                <div id="se-ace" style="position:absolute;inset:0;"></div>
            </div>
            <div style="width:212px;flex-shrink:0;background:#080a11;border-left:1px solid #131525;overflow-y:auto;">
                ${_sidebarHTML()}
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const editor = ace.edit('se-ace');
    editor.setTheme('ace/theme/tomorrow_night');
    editor.session.setMode('ace/mode/javascript');
    editor.setValue(initialCode, -1);
    editor.setOptions({
        enableBasicAutocompletion: true,
        enableSnippets:            true,
        enableLiveAutocompletion:  true,
        showPrintMargin:           false,
        fontSize:                  '13px',
        fontFamily:                '"Fira Code","Cascadia Code","Consolas",monospace',
        tabSize:                   2,
        useSoftTabs:               true,
        highlightActiveLine:       true,
        displayIndentGuides:       true,
        scrollPastEnd:             0.3,
    });

    const langTools = ace.require('ace/ext/language_tools');
    langTools.addCompleter({
        getCompletions(_ed, _sess, _pos, prefix, cb) {
            const lp = prefix.toLowerCase();
            cb(null, !lp ? COMPLETIONS : COMPLETIONS.filter(c => c.caption.toLowerCase().startsWith(lp)));
        },
    });

    let _dirty = false;
    const statusEl = overlay.querySelector('#se-status');
    editor.on('change', () => {
        if (!_dirty) { _dirty = true; statusEl.textContent = '● unsaved'; statusEl.style.color = '#facc15'; }
    });

    async function _doSave() {
        saveScript(scriptName, editor.getValue());
        if (obj) obj.scriptName = scriptName;
        _dirty = false;
        statusEl.textContent = '✓ saved'; statusEl.style.color = '#4ade80';
        setTimeout(() => { if (!_dirty) statusEl.textContent = ''; }, 2000);
        _logConsole(`💾 Script "${scriptName}" saved`, '#4ade80');
        import('./engine.ui.js').then(m => m.syncPixiToInspector());
    }

    overlay.querySelector('#se-save').addEventListener('click', _doSave);
    overlay.querySelector('#se-close').addEventListener('click', async () => {
        if (_dirty && !confirm('Unsaved changes — save before closing?')) { overlay.remove(); return; }
        if (_dirty) await _doSave();
        overlay.remove();
    });
    overlay.querySelector('#se-detach')?.addEventListener('click', () => {
        if (obj) { obj.scriptName = null; _logConsole(`✂️ Script detached from "${obj.label}"`, '#facc15'); import('./engine.ui.js').then(m => m.syncPixiToInspector()); }
        overlay.remove();
    });

    editor.commands.addCommand({ name:'save', bindKey:{win:'Ctrl-S',mac:'Command-S'}, exec:_doSave });
    editor.focus();
}

// ── Create Script prompt ──────────────────────────────────────
export function promptCreateScript(obj) {
    const modal = _modal();
    modal.innerHTML = `
        <div style="padding:22px;min-width:330px;">
            <div style="color:#e0e0e0;font-weight:700;font-size:14px;margin-bottom:4px;">Create Script</div>
            <div style="color:#555;font-size:11px;margin-bottom:14px;">Enter a name for the new script</div>
            <input id="sn-input" type="text" placeholder="e.g. PlayerController" autocomplete="off"
                style="width:100%;box-sizing:border-box;background:#0d0d14;color:#e0e0e0;border:1px solid #3a72a5;border-radius:4px;padding:7px 10px;font-size:13px;outline:none;font-family:monospace;">
            <div id="sn-err" style="color:#f87171;font-size:11px;margin-top:4px;min-height:14px;"></div>
            <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
                <button id="sn-cancel" style="${_bs('#0f1018','#888','#1a1d28')}">Cancel</button>
                <button id="sn-ok"     style="${_bs('#0f2540','#7cb9f0','#1e4a7a')}">Create</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const inp = modal.querySelector('#sn-input');
    const err = modal.querySelector('#sn-err');
    inp.focus();
    modal.querySelector('#sn-cancel').onclick = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
    modal.querySelector('#sn-ok').onclick = () => {
        const name = inp.value.trim().replace(/[^a-zA-Z0-9_\-]/g, '');
        if (!name) { err.textContent = 'Name is required'; return; }
        if (state.scripts.find(s => s.name === name)) { err.textContent = `"${name}" already exists`; return; }
        modal.remove();
        openScriptEditor(obj, name, _defaultScript(name));
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') modal.querySelector('#sn-ok').click(); });
}

// ── Load / Attach Script prompt ───────────────────────────────
export function promptLoadScript(obj) {
    const modal = _modal();
    if (state.scripts.length === 0) {
        modal.innerHTML = `
            <div style="padding:24px;min-width:280px;text-align:center;">
                <div style="font-size:26px;margin-bottom:8px;">📄</div>
                <div style="color:#e0e0e0;font-weight:600;margin-bottom:6px;">No scripts yet</div>
                <div style="color:#555;font-size:11px;margin-bottom:14px;">Use "Create Script" to write your first script</div>
                <button id="sn-close" style="${_bs('#0f1018','#aaa','#1a1d28')}">Close</button>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#sn-close').onclick = () => modal.remove();
        return;
    }

    const rows = state.scripts.map(s => {
        const attached = obj.scriptName === s.name;
        const ts = new Date(s.updatedAt).toLocaleDateString();
        return `
            <div class="sl-row" data-name="${s.name}"
                style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:4px;margin:2px 0;
                background:${attached ? 'rgba(58,114,165,.15)' : 'transparent'};">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;flex-shrink:0;fill:none;stroke:${attached?'#7cb9f0':'#383850'};stroke-width:2;">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                <div style="flex:1;min-width:0;">
                    <div style="color:${attached?'#7cb9f0':'#ccc'};font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        ${s.name}${attached ? ' <span style="color:#4ade80;font-size:10px;font-weight:400;">● attached</span>' : ''}
                        ${s.isDefault ? ' <span style="color:#4ade80;font-size:9px;font-weight:400;">BUILT-IN</span>' : ''}
                    </div>
                    <div style="color:#383850;font-size:10px;">${ts}</div>
                </div>
                <button class="sl-edit"   data-name="${s.name}" style="${_bs('#0d200d','#8f8','#1e3a1e','3px')}font-size:10px;padding:3px 8px;">Edit</button>
                <button class="sl-attach" data-name="${s.name}" style="${_bs('#0f2540','#7cb9f0','#1e4a7a','3px')}font-size:10px;padding:3px 8px;">${attached ? '✓' : 'Attach'}</button>
            </div>
        `;
    }).join('');

    modal.innerHTML = `
        <div style="padding:18px;min-width:380px;max-height:70vh;display:flex;flex-direction:column;">
            <div style="color:#e0e0e0;font-weight:700;font-size:14px;margin-bottom:3px;">Load Script</div>
            <div style="color:#444;font-size:11px;margin-bottom:10px;">Attach a script to <span style="color:#9bc;">${obj.label}</span></div>
            <div style="flex:1;overflow-y:auto;">${rows}</div>
            ${obj.scriptName ? `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #1a1a28;display:flex;justify-content:space-between;align-items:center;">
                <span style="color:#444;font-size:11px;">Attached: <span style="color:#9bc;">${obj.scriptName}</span></span>
                <button id="sl-detach" style="${_bs('#1a0808','#f87171','#3a1818','3px')}font-size:10px;padding:3px 10px;">Detach</button>
            </div>` : ''}
            <button id="sl-cancel" style="margin-top:10px;${_bs('#0f1018','#888','#1a1d28')}width:100%;text-align:center;">Cancel</button>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll('.sl-row').forEach(r => {
        r.addEventListener('mouseenter', () => { if (!r.style.background.includes('165')) r.style.background = 'rgba(255,255,255,.04)'; });
        r.addEventListener('mouseleave', () => { if (!r.style.background.includes('165')) r.style.background = 'transparent'; });
    });
    modal.querySelectorAll('.sl-edit').forEach(b => {
        b.onclick = e => {
            e.stopPropagation();
            const rec = getScript(b.dataset.name);
            modal.remove();
            openScriptEditor(obj, b.dataset.name, rec?.code ?? '');
        };
    });
    modal.querySelectorAll('.sl-attach').forEach(b => {
        b.onclick = e => {
            e.stopPropagation();
            obj.scriptName = b.dataset.name;
            _logConsole(`📎 "${b.dataset.name}" attached to "${obj.label}"`, '#4ade80');
            modal.remove();
            import('./engine.ui.js').then(m => m.syncPixiToInspector());
        };
    });
    modal.querySelector('#sl-detach')?.addEventListener('click', () => {
        const old = obj.scriptName; obj.scriptName = null;
        _logConsole(`✂️ "${old}" detached from "${obj.label}"`, '#facc15');
        modal.remove();
        import('./engine.ui.js').then(m => m.syncPixiToInspector());
    });
    modal.querySelector('#sl-cancel').onclick = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
}

// ── Shared helpers ────────────────────────────────────────────
function _bs(bg, color, border, radius='4px') {
    return `background:${bg};color:${color};border:1px solid ${border};border-radius:${radius};padding:5px 12px;cursor:pointer;font-family:inherit;font-size:12px;`;
}

function _modal() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#0d0f1a;border:1px solid #1e2038;border-radius:8px;box-shadow:0 24px 64px rgba(0,0,0,.9);font-family:system-ui,sans-serif;';
    wrap.appendChild(box);
    Object.defineProperty(wrap,'innerHTML',{ get:()=>box.innerHTML, set:v=>{ box.innerHTML=v; } });
    wrap.querySelector    = s => box.querySelector(s);
    wrap.querySelectorAll = s => box.querySelectorAll(s);
    wrap.addEventListener('click', e => { if (e.target===wrap) wrap.remove(); });
    return wrap;
}

function _sidebarHTML() {
    const G = [
        ['Events',         ['onStart(fn)', 'onUpdate(fn)', 'onStop(fn)', 'onCollisionEnter(fn)', 'onCollisionStay(fn)', 'onCollisionExit(fn)', 'onOverlapEnter(fn)', 'onOverlapExit(fn)', 'onMessage("msg",fn)', 'onMouseClick(fn)']],
        ['this.position',  ['getX() / setX(v)', 'getY() / setY(v)', 'moveTo(x, y)', 'move(dx, dy)', 'moveForward(speed)', 'lookAt(tx, ty)', 'flipX() / flipY()']],
        ['this.velocity',  ['velocityX / vx', 'velocityY / vy', 'setVelocity(vx,vy)', 'stopMovement()', 'bounceX() / bounceY()']],
        ['this.gravity',   ['gravity(gx, gy)', '  0,-9.8 = fall down', '  0, 9.8 = float up']],
        ['Rotation/Scale', ['getRotation()', 'setRotation(deg)', 'getScaleX/Y()', 'setScaleX/Y(v)']],
        ['Display',        ['show() / hide()', 'setVisible(v)', 'getAlpha() / setAlpha(v)', 'fadeIn(t, dt)', 'fadeOut(t, dt)']],
        ['Tag & Group',    ['setTag("name") / getTag()', 'setGroup("name") / getGroup()']],
        ['Messaging',      ['sendMessage(tag, msg, data)', 'broadcast(tag, msg)', 'broadcastGroup(grp, msg)', 'broadcastAll(msg)', 'onMessage("msg", fn)']],
        ['Find objects',   ['find("label")', 'findWithTag("tag")', 'findAllWithTag("tag")', 'findAllInGroup("grp")']],
        ['Overlap (AABB)', ['overlaps(other)', 'overlapsTag("tag")', 'overlapsAllWithTag("tag")', 'onOverlapEnter(fn)', 'onOverlapExit(fn)']],
        ['Destroy',        ['destroySelf()', 'destroy(other)']],
        ['Scene',          ['gotoScene("Name")', 'currentScene()', 'currentSceneIndex()', 'sceneCount()', 'getSceneName(i)']],
        ['Camera',         ['cameraFollow(obj, smooth)', 'cameraUnfollow()', 'cameraMoveTo(x, y)', 'getCameraX/Y()', 'cameraShake(amp, dur)']],
        ['Input',          ['isKeyDown("w")', 'isKeyJustDown("Space")', 'isKeyJustUp("w")', 'axisH() → -1/0/1', 'axisV() → -1/0/1', 'mouseX() / mouseY()', 'mouseDown() / mouseJustDown()']],
        ['Animation',      ['playAnimation("name")', 'stopAnimation()', 'currentAnimation()']],
        ['Physics body',   ['physics.setVelocity(vx,vy)', 'physics.applyForce(fx,fy)', 'physics.stop()', 'physics.velX / velY']],
        ['Shared vars',    ['sceneVar.myVar (scene-wide)', 'globalVar.myVar (across scenes)', 'store.set/get (private)']],
        ['Time',           ['getTime() → seconds']],
        ['Math',           ['lerp / clamp / dist', 'rand / randInt / sign', 'toRad / toDeg / mapRange', 'sin / cos / abs / sqrt', 'PI / floor / ceil / round', 'max / min']],
        ['Debug',          ['log(...)', 'warn(...)', 'error(...)']],
    ];
    return `<style>
        .se-g  { padding:5px 0 2px; border-top:1px solid #0f111c; }
        .se-g:first-child { border-top:none; }
        .se-gt { padding:4px 10px 2px; color:#1e4a7a; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:1px; }
        .se-gi { padding:1px 10px; color:#2a3a4a; font-size:10px; line-height:1.7; font-family:monospace; }
        .se-gi:hover { color:#5a8aaa; cursor:default; }
    </style>` + G.map(([t,items]) => `
        <div class="se-g">
            <div class="se-gt">${t}</div>
            ${items.map(i=>`<div class="se-gi">${i}</div>`).join('')}
        </div>
    `).join('');
}

function _defaultScript(name) {
    return `// ================================================================
// Script: ${name}
// Runs only in Play Mode — the editor is always safe.
//
// Quick reference:
//   getX() / setX(v)     — this object's X position
//   getY() / setY(v)     — this object's Y position
//   velocityX / vx       — horizontal speed (units/sec, auto-applied)
//   velocityY / vy       — vertical speed
//   gravity(0, -9.8)     — apply gravity each frame
//   setTag("player")     — tag this object for findWithTag()
//   sendMessage(tag, msg, data)  — send a message to another object
//   gotoScene("Level2")  — switch to a different scene
//   cameraFollow(find("Player"))  — make camera follow an object
//   overlapsTag("Coin")  — check overlap without needing physics
// ================================================================


onStart(() => {
  // Runs once when Play is pressed.
  // Good place to set tags, groups, and initial values.

  setTag("${name.toLowerCase()}");
  log("${name} started!");

  // Example: enable gravity for this object
  // gravity(0, -9.8);

  // Example: make camera follow this object
  // cameraFollow(find("${name}"), 6);
});


onUpdate((dt) => {
  // Runs every frame. dt = seconds since the last frame.
  // Always multiply movement by dt for smooth, frame-rate-independent motion.

  // ── Move with keyboard ────────────────────────────────────────
  const speed = 5;
  move(axisH() * speed * dt,   // A/D or Left/Right arrow
       axisV() * speed * dt);  // W/S or Up/Down arrow

  // ── Or use velocity (automatically applied every frame) ───────
  // velocityX = axisH() * speed;
  // velocityY = axisV() * speed;

  // ── Check overlap (no physics body needed) ────────────────────
  // var coin = overlapsTag("coin");
  // if (coin) {
  //   log("Collected: " + coin.name);
  //   destroy(coin);
  //   sceneVar.score = (sceneVar.score || 0) + 1;
  // }

});


onStop(() => {
  // Runs once when Play is stopped.
  // Clean up anything you need to reset.
  log("${name} stopped.");
});


onCollisionEnter((other) => {
  // Runs the MOMENT this object touches another (physics body required).
  // other.name  — name of the object we hit
  // other.x, other.y  — its position
  if (other) {
    log("Touched: " + other.name);
  }
});


onCollisionStay((other) => {
  // Runs EVERY FRAME while touching another object.
  // Useful for continuous effects like sliding or damage over time.
});


onCollisionExit((other) => {
  // Runs the MOMENT this object stops touching another.
  if (other) {
    log("Stopped touching: " + other.name);
  }
});


onOverlapEnter((other) => {
  // Like onCollisionEnter but works WITHOUT a physics body (pure AABB).
  // Great for trigger zones, pickups, checkpoints.
  if (other) {
    log("Overlapped: " + other.name);
  }
});


onMessage("takeDamage", (amount) => {
  // Called when another script does:  sendMessage("${name.toLowerCase()}", "takeDamage", 10)
  log("Took " + amount + " damage!");
});
`;
}

function _logConsole(msg, color = '#e0e0e0') {
    const level = color === '#f87171' ? 'error' : color === '#facc15' ? 'warn' : color === '#4ade80' ? 'system' : 'log';
    import('./engine.console.js').then(m => m.engineLog(msg, level));
}
