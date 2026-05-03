/* ============================================================
   Zengine — engine.scripting.js
   Sandboxed scripting with:
     • velocity (vx, vy) with auto-integration
     • tag / group system
     • messaging (sendMessage / onMessage)
     • rich beginner-friendly API
     • Ace editor with restricted autocomplete
   Scripts only run in Play Mode.
   Stored in state.scripts (saved with project JSON).
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

// ── Script CRUD (state.scripts — saved with project JSON) ─────
export function saveScript(name, code) {
    const existing = state.scripts.find(s => s.name === name);
    if (existing) {
        existing.code = code;
        existing.updatedAt = Date.now();
    } else {
        state.scripts.push({
            id: 'script_' + Date.now() + '_' + Math.random().toString(36).slice(2),
            name,
            code,
            updatedAt: Date.now(),
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

// ── Script Panel (Scripts folder in asset panel) ──────────────
export function refreshScriptPanel() {
    const grid = document.getElementById('script-asset-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (state.scripts.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#505060;font-size:11px;padding:20px;font-style:italic;text-align:center;width:100%;';
        empty.textContent = 'No scripts yet — create one via the Inspector';
        grid.appendChild(empty);
        return;
    }

    for (const script of state.scripts) {
        const item = document.createElement('div');
        item.className = 'asset-item';
        item.style.cssText = 'cursor:pointer;position:relative;';
        item.innerHTML = `
            <div class="asset-thumb" style="background:#0a0f1a;border:1px solid #1e3a5a;">
                <svg viewBox="0 0 24 24" style="width:26px;height:26px;fill:none;stroke:#7cb9f0;stroke-width:1.5;">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
            </div>
            <div class="asset-name" title="${script.name}.js">${script.name.length > 11 ? script.name.slice(0,10)+'…' : script.name}</div>
            <div class="script-del-btn" style="display:none;position:absolute;top:2px;right:2px;">
                <button title="Delete" style="background:rgba(24,6,6,.92);border:1px solid #3a1a1a;color:#f87171;border-radius:3px;padding:1px 4px;font-size:10px;cursor:pointer;line-height:1.4;">✕</button>
            </div>
        `;
        item.addEventListener('mouseenter', () => item.querySelector('.script-del-btn').style.display = 'block');
        item.addEventListener('mouseleave', () => item.querySelector('.script-del-btn').style.display = 'none');
        item.querySelector('.script-del-btn button').addEventListener('click', e => {
            e.stopPropagation();
            if (confirm(`Delete script "${script.name}"?`)) deleteScriptByName(script.name);
        });
        item.addEventListener('click', () => openScriptEditor(null, script.name, script.code));
        grid.appendChild(item);
    }
}

// ── Global message bus (tag/group messaging) ──────────────────
// Maps  tagOrGroup → Set of ScriptInstance
const _tagRegistry   = new Map(); // tag → Set<ScriptInstance>
const _groupRegistry = new Map(); // group → Set<ScriptInstance>

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

function _clearRegistries() {
    _tagRegistry.clear();
    _groupRegistry.clear();
}

// Deliver a message to a single ScriptInstance
function _deliverMsg(inst, msg, data) {
    const handler = inst._messageHandlers?.get(msg);
    if (!handler) return;
    try { handler(data); }
    catch (e) { _logConsole(`[Script "${inst.name}"] onMessage "${msg}": ${e.message}`, '#f87171'); }
}

// ── Send message helpers (called from inside sandbox) ─────────
function _sendMessageToTag(tag, msg, data) {
    const set = _tagRegistry.get(tag);
    if (!set || set.size === 0) return;
    // Send to first instance only
    const [first] = set;
    _deliverMsg(first, msg, data);
}

function _broadcastToTag(tag, msg, data) {
    const set = _tagRegistry.get(tag);
    if (!set) return;
    for (const inst of set) _deliverMsg(inst, msg, data);
}

function _broadcastToGroup(group, msg, data) {
    const set = _groupRegistry.get(group);
    if (!set) return;
    for (const inst of set) _deliverMsg(inst, msg, data);
}

function _broadcastGlobal(msg, data) {
    for (const inst of _instances) _deliverMsg(inst, msg, data);
}

// ── Sandboxed API builder ─────────────────────────────────────
function _buildSandbox(obj, inst) {
    // inst reference is set after construction — passed by ref wrapper
    const _keys         = new Set();
    const _keysJustDown = new Set();
    const _keysJustUp   = new Set();
    const _mouse        = { x: 0, y: 0, down: false, justDown: false, justUp: false };
    const _touches      = [];

    // Velocity — auto-integrated in update
    let _vx = 0, _vy = 0;
    let _gravity = 0;  // optional per-object gravity override

    const api = {

        // ── IDENTITY ──────────────────────────────────────────
        get name()  { return obj.label; },
        get tag()   { return obj._scriptTag  ?? ''; },
        set tag(v)  {
            obj._scriptTag = String(v);
            if (inst) _registerInstance(inst);
        },
        get group() { return obj._scriptGroup ?? ''; },
        set group(v) {
            obj._scriptGroup = String(v);
            if (inst) _registerInstance(inst);
        },

        // ── POSITION ─────────────────────────────────────────
        get x()     { return  obj.x  / 100; },
        set x(v)    { obj.x  =  v * 100; },
        get y()     { return -obj.y  / 100; },
        set y(v)    { obj.y  = -v * 100; },

        // ── VELOCITY (auto-integrated each frame) ─────────────
        get velocityX()  { return _vx; },
        set velocityX(v) { _vx = v; },
        get velocityY()  { return _vy; },
        set velocityY(v) { _vy = v; },
        // Short aliases
        get vx()  { return _vx; },
        set vx(v) { _vx = v; },
        get vy()  { return _vy; },
        set vy(v) { _vy = v; },

        // ── ROTATION / SCALE ──────────────────────────────────
        get rotation()   { return -(obj.rotation * 180 / Math.PI); },
        set rotation(v)  { obj.rotation = -(v * Math.PI / 180); },
        get scaleX()     { return obj.scale.x; },
        set scaleX(v)    { obj.scale.x = v; },
        get scaleY()     { return obj.scale.y; },
        set scaleY(v)    { obj.scale.y = v; },
        get width()      { return (obj.spriteGraphic?.width  ?? obj.width  ?? 0) / Math.abs(obj.scale.x); },
        get height()     { return (obj.spriteGraphic?.height ?? obj.height ?? 0) / Math.abs(obj.scale.y); },

        // ── DISPLAY ───────────────────────────────────────────
        get visible()    { return obj.visible; },
        set visible(v)   { obj.visible = !!v; },
        get alpha()      { return obj.alpha; },
        set alpha(v)     { obj.alpha = Math.max(0, Math.min(1, v)); },

        // ── MOVEMENT HELPERS ──────────────────────────────────
        /** Move by (dx, dy) world units */
        move(dx, dy)     { obj.x += dx * 100; obj.y -= dy * 100; },
        /** Same as move — alias */
        translate(dx, dy){ obj.x += dx * 100; obj.y -= dy * 100; },
        /** Warp to exact position */
        moveTo(x, y)     { obj.x =  x * 100; obj.y = -y * 100; },
        /** Rotate to face a point */
        lookAt(tx, ty) {
            const dx = tx*100 - obj.x, dy = ty*100 - obj.y;
            obj.rotation = -Math.atan2(-dy, dx);
        },
        /** Move forward along current rotation */
        moveForward(speed) {
            const r = -obj.rotation;
            obj.x += Math.cos(r) * speed * 100;
            obj.y -= Math.sin(r) * speed * 100;
        },
        /** Instantly flip horizontal */
        flipX() { obj.scale.x *= -1; },
        /** Instantly flip vertical */
        flipY() { obj.scale.y *= -1; },
        /** Bounce velocityX off a wall */
        bounceX() { _vx = -_vx; },
        /** Bounce velocityY off a floor/ceiling */
        bounceY() { _vy = -_vy; },

        // ── PHYSICS BODY (Box2D) ──────────────────────────────
        physics: {
            applyForce(fx, fy)   { obj._physicsBody?.applyForce?.({ x:fx, y:-fy }, obj._physicsBody.getPosition()); },
            applyImpulse(ix, iy) { obj._physicsBody?.applyLinearImpulse?.({ x:ix, y:-iy }, obj._physicsBody.getPosition()); },
            setVelocity(vx, vy)  { obj._physicsBody?.setLinearVelocity?.({ x:vx, y:-vy }); },
            get velX()  { return  obj._physicsBody?.getLinearVelocity?.()?.x ?? 0; },
            get velY()  { return -(obj._physicsBody?.getLinearVelocity?.()?.y ?? 0); },
            stop()      { obj._physicsBody?.setLinearVelocity?.({ x:0, y:0 }); },
        },

        // ── ANIMATION ─────────────────────────────────────────
        playAnimation(name) {
            const idx = obj.animations?.findIndex(a => a.name === name) ?? -1;
            if (idx >= 0) {
                obj.activeAnimIndex = idx;
                try { if (obj._runtimeSprite) obj._runtimeSprite.gotoAndPlay(0); } catch(_) {}
            }
        },
        stopAnimation() { try { obj._runtimeSprite?.stop(); } catch(_) {} },
        pauseAnimation(){ try { obj._runtimeSprite?.stop(); } catch(_) {} },
        get currentAnimation() { return obj.animations?.[obj.activeAnimIndex]?.name ?? ''; },

        // ── INPUT — KEYBOARD ─────────────────────────────────
        input: {
            /** Is key currently held? */
            isKeyDown:     k => _keys.has(k.toLowerCase()),
            /** Was key pressed this frame only? */
            isKeyJustDown: k => _keysJustDown.has(k.toLowerCase()),
            /** Was key released this frame only? */
            isKeyJustUp:   k => _keysJustUp.has(k.toLowerCase()),
            // Mouse
            get mouseX()     { return _mouse.x; },
            get mouseY()     { return _mouse.y; },
            get mouseDown()  { return _mouse.down; },
            get mouseJustDown() { return _mouse.justDown; },
            get mouseJustUp()   { return _mouse.justUp; },
            // Axis helpers (WASD + arrows)
            get axisH() {
                const r = (_keys.has('d')||_keys.has('arrowright')) ? 1 : 0;
                const l = (_keys.has('a')||_keys.has('arrowleft'))  ? 1 : 0;
                return r - l;
            },
            get axisV() {
                const u = (_keys.has('w')||_keys.has('arrowup'))   ? 1 : 0;
                const d = (_keys.has('s')||_keys.has('arrowdown')) ? 1 : 0;
                return u - d;
            },
        },

        // ── SCENE / FIND ─────────────────────────────────────
        /** Find an object by its label */
        find(label) {
            const f = state.gameObjects.find(o => o.label === label);
            if (!f) return null;
            return _makeObjProxy(f);
        },
        /** Find all objects with a given tag */
        findAllWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set || set.size === 0) return [];
            return [...set].map(i => _makeObjProxy(i.obj));
        },
        /** Find first object with a given tag */
        findWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set || set.size === 0) return null;
            const [first] = set;
            return _makeObjProxy(first.obj);
        },
        /** Find all objects in a group */
        findAllInGroup(group) {
            const set = _groupRegistry.get(group);
            if (!set || set.size === 0) return [];
            return [...set].map(i => _makeObjProxy(i.obj));
        },
        /** Destroy / remove this object from the scene */
        destroySelf() {
            obj.visible = false;
            obj._markedForDestroy = true;
        },
        /** Destroy another object */
        destroy(other) {
            if (other?._ref) {
                other._ref.visible = false;
                other._ref._markedForDestroy = true;
            }
        },

        // ── MESSAGING ─────────────────────────────────────────
        /**
         * Send a message to the FIRST object that has the given tag.
         * sendMessage("Enemy", "takeDamage", 10)
         */
        sendMessage(tag, message, data) {
            _sendMessageToTag(String(tag), String(message), data);
        },
        /**
         * Broadcast a message to ALL objects with the given tag.
         * broadcast("Enemy", "freeze")
         */
        broadcast(tag, message, data) {
            _broadcastToTag(String(tag), String(message), data);
        },
        /**
         * Broadcast a message to ALL objects in a group.
         * broadcastGroup("enemies", "die")
         */
        broadcastGroup(group, message, data) {
            _broadcastToGroup(String(group), String(message), data);
        },
        /**
         * Broadcast a message to EVERY script in the scene.
         * broadcastAll("gameOver")
         */
        broadcastAll(message, data) {
            _broadcastGlobal(String(message), data);
        },

        // ── TIME ─────────────────────────────────────────────
        /** Total seconds since Play was pressed */
        get time()       { return performance.now() / 1000; },
        /** Seconds since Play was pressed (same as time) */
        get elapsed()    { return performance.now() / 1000; },

        // ── MATH ─────────────────────────────────────────────
        math: {
            lerp:    (a,b,t)         => a + (b-a) * Math.max(0,Math.min(1,t)),
            clamp:   (v,lo,hi)       => Math.max(lo, Math.min(hi,v)),
            dist:    (x1,y1,x2,y2)  => Math.sqrt((x2-x1)**2+(y2-y1)**2),
            rand:    (mn,mx)         => Math.random()*(mx-mn)+mn,
            randInt: (mn,mx)         => Math.floor(Math.random()*(mx-mn+1))+mn,
            sign:    v               => Math.sign(v),
            sin:  Math.sin,   cos:  Math.cos,   tan:  Math.tan,
            abs:  Math.abs,   sqrt: Math.sqrt,   pow:  Math.pow,
            atan2:Math.atan2, floor:Math.floor,  ceil: Math.ceil,
            round:Math.round, PI:   Math.PI,
            /** Convert degrees to radians */
            toRad: d => d * Math.PI / 180,
            /** Convert radians to degrees */
            toDeg: r => r * 180 / Math.PI,
            /** Linear map from one range to another */
            map: (v,a1,b1,a2,b2) => a2 + (b2-a2) * ((v-a1)/(b1-a1)),
            /** Wrap a value between min and max */
            wrap: (v,mn,mx) => ((v-mn) % (mx-mn) + (mx-mn)) % (mx-mn) + mn,
        },

        // ── DEBUG ─────────────────────────────────────────────
        log(...a)  { _logConsole(`[${obj.label}] ${a.map(String).join(' ')}`, '#9bc'); },
        warn(...a) { _logConsole(`[${obj.label}] ⚠ ${a.map(String).join(' ')}`, '#facc15'); },
        error(...a){ _logConsole(`[${obj.label}] ✖ ${a.map(String).join(' ')}`, '#f87171'); },

        // ── STORAGE (simple key/value per-session) ────────────
        store: {
            _data: {},
            set(k, v)  { this._data[k] = v; },
            get(k, def){ return Object.prototype.hasOwnProperty.call(this._data,k) ? this._data[k] : def; },
            has(k)     { return Object.prototype.hasOwnProperty.call(this._data, k); },
            del(k)     { delete this._data[k]; },
        },

        // Internal velocity state exposed for auto-integration
        _velRef: { get vx(){ return _vx; }, set vx(v){ _vx=v; },
                   get vy(){ return _vy; }, set vy(v){ _vy=v; } },
    };

    return { api, _keys, _keysJustDown, _keysJustUp, _mouse };
}

// ── Minimal read-only proxy for a found object ────────────────
function _makeObjProxy(f) {
    return {
        _ref:         f,
        get name()    { return f.label; },
        get tag()     { return f._scriptTag   ?? ''; },
        get group()   { return f._scriptGroup ?? ''; },
        get x()       { return  f.x  / 100; },
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
        this._onStart         = null;
        this._onUpdate        = null;
        this._onStop          = null;
        this._onCollide       = null;
        this._onVisible       = null;
        this._onHide          = null;
        this._onMouseEnter    = null;
        this._onMouseLeave    = null;
        this._onMouseClick    = null;
        this._messageHandlers = new Map();

        const { api, _keys, _keysJustDown, _keysJustUp, _mouse } = _buildSandbox(obj, this);
        this.api          = api;
        this._keys        = _keys;
        this._keysJustDown= _keysJustDown;
        this._keysJustUp  = _keysJustUp;
        this._mouse       = _mouse;

        this._compile(code, api);
    }

    _compile(code, api) {
        /* ── Prelude: everything the user can call ── */
        const prelude = `
"use strict";
var _onStart=null,_onUpdate=null,_onStop=null,_onCollide=null;
var _onVisible=null,_onHide=null,_onMouseEnter=null,_onMouseLeave=null,_onMouseClick=null;
var _msgHandlers=new Map();

// ── Event registration ───────────────────────────────────
/** Called once when Play starts */
function onStart(fn)          { _onStart        = fn; }
/** Called every frame — dt is seconds since last frame */
function onUpdate(fn)         { _onUpdate       = fn; }
/** Called when Play stops */
function onStop(fn)           { _onStop         = fn; }
/** Called when this object physically collides with another */
function onCollision(fn)      { _onCollide      = fn; }
/** Called when this object becomes visible */
function onBecomeVisible(fn)  { _onVisible      = fn; }
/** Called when this object becomes hidden */
function onBecomeHidden(fn)   { _onHide         = fn; }
/** Called when the mouse enters this object's area */
function onMouseEnter(fn)     { _onMouseEnter   = fn; }
/** Called when the mouse leaves this object's area */
function onMouseLeave(fn)     { _onMouseLeave   = fn; }
/** Called when this object is clicked */
function onMouseClick(fn)     { _onMouseClick   = fn; }
/**
 * Called when this object receives a message.
 * onMessage("takeDamage", (amount) => { ... })
 */
function onMessage(msg, fn)   { _msgHandlers.set(String(msg), fn); }

// ── Position & size ──────────────────────────────────────
function getX()          { return api.x; }
function setX(v)         { api.x = v; }
function getY()          { return api.y; }
function setY(v)         { api.y = v; }
/** Instantly move to (x, y) */
function moveTo(x, y)    { api.moveTo(x, y); }
/** Move by (dx, dy) relative to current position */
function move(dx, dy)    { api.move(dx, dy); }
/** Same as move */
function translate(dx,dy){ api.move(dx, dy); }
/** Step forward along current rotation direction */
function moveForward(spd){ api.moveForward(spd); }
/** Make this object face a target position */
function lookAt(tx, ty)  { api.lookAt(tx, ty); }
function flipX()         { api.flipX(); }
function flipY()         { api.flipY(); }
function getWidth()      { return api.width; }
function getHeight()     { return api.height; }

// ── Rotation & scale ─────────────────────────────────────
function getRotation()   { return api.rotation; }
function setRotation(v)  { api.rotation = v; }
function getScaleX()     { return api.scaleX; }
function setScaleX(v)    { api.scaleX = v; }
function getScaleY()     { return api.scaleY; }
function setScaleY(v)    { api.scaleY = v; }

// ── Velocity (auto-applied each frame) ───────────────────
/** Current horizontal speed (world units per second) */
var velocityX   = 0;
/** Current vertical speed (world units per second) */
var velocityY   = 0;
/** Short alias for velocityX */
var vx = 0;
/** Short alias for velocityY */
var vy = 0;
/** Bounce velocityX (multiply by -1) */
function bounceX()       { api.bounceX(); velocityX=api.vx; vx=velocityX; }
/** Bounce velocityY (multiply by -1) */
function bounceY()       { api.bounceY(); velocityY=api.vy; vy=velocityY; }

// ── Display ───────────────────────────────────────────────
function getVisible()    { return api.visible; }
function setVisible(v)   { api.visible = v; }
function show()          { api.visible = true; }
function hide()          { api.visible = false; }
function getAlpha()      { return api.alpha; }
function setAlpha(v)     { api.alpha = v; }
function fadeIn(t,dt)    { api.alpha = Math.min(1, api.alpha + dt/Math.max(0.001,t)); }
function fadeOut(t,dt)   { api.alpha = Math.max(0, api.alpha - dt/Math.max(0.001,t)); }

// ── Tag & Group ───────────────────────────────────────────
/** Set this object's tag (used for messaging / findWithTag) */
function setTag(t)       { api.tag   = t; }
/** Set this object's group (used for broadcastGroup) */
function setGroup(g)     { api.group = g; }
/** Get this object's tag */
function getTag()        { return api.tag; }
/** Get this object's group */
function getGroup()      { return api.group; }

// ── Messaging ─────────────────────────────────────────────
/**
 * Send a message to the FIRST object with this tag.
 * sendMessage("Enemy", "takeDamage", 10)
 */
function sendMessage(tag, msg, data)       { api.sendMessage(tag, msg, data); }
/**
 * Send a message to ALL objects with this tag.
 * broadcast("Enemy", "freeze")
 */
function broadcast(tag, msg, data)         { api.broadcast(tag, msg, data); }
/**
 * Send a message to ALL objects in a group.
 * broadcastGroup("enemies", "explode")
 */
function broadcastGroup(group, msg, data)  { api.broadcastGroup(group, msg, data); }
/**
 * Send a message to EVERY object in the scene.
 * broadcastAll("gameOver")
 */
function broadcastAll(msg, data)           { api.broadcastAll(msg, data); }

// ── Animation ─────────────────────────────────────────────
function playAnimation(name)  { api.playAnimation(name); }
function stopAnimation()      { api.stopAnimation(); }
function pauseAnimation()     { api.pauseAnimation(); }
function currentAnimation()   { return api.currentAnimation; }

// ── Physics (Box2D body) ──────────────────────────────────
var physics = api.physics;

// ── Scene queries ─────────────────────────────────────────
/** Find an object by its exact name/label */
function find(label)                { return api.find(label); }
/** Find the first object with this tag */
function findWithTag(tag)           { return api.findWithTag(tag); }
/** Find ALL objects with this tag — returns array */
function findAllWithTag(tag)        { return api.findAllWithTag(tag); }
/** Find ALL objects in a group — returns array */
function findAllInGroup(group)      { return api.findAllInGroup(group); }
/** Remove this object from the scene */
function destroySelf()              { api.destroySelf(); }
/** Remove another object (pass the result of find/findWithTag) */
function destroy(other)             { api.destroy(other); }

// ── Input ─────────────────────────────────────────────────
var input = api.input;
/** Is this key currently held? e.g. isKeyDown("w") */
function isKeyDown(k)    { return input.isKeyDown(k); }
/** Was this key pressed THIS frame? */
function isKeyJustDown(k){ return input.isKeyJustDown(k); }
/** Was this key released THIS frame? */
function isKeyJustUp(k)  { return input.isKeyJustUp(k); }
/** Horizontal axis from A/D or arrow keys. Returns -1, 0, or 1 */
function axisH()         { return input.axisH; }
/** Vertical axis from W/S or arrow keys. Returns -1, 0, or 1 */
function axisV()         { return input.axisV; }

// ── Math helpers ──────────────────────────────────────────
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
var sin     = math.sin;
var cos     = math.cos;
var tan     = math.tan;
var abs     = math.abs;
var sqrt    = math.sqrt;
var pow     = math.pow;
var atan2   = math.atan2;
var floor   = math.floor;
var ceil    = math.ceil;
var round   = math.round;
var PI      = math.PI;

// ── Time ──────────────────────────────────────────────────
/** Seconds since Play started */
function getTime()       { return api.time; }

// ── Debug ─────────────────────────────────────────────────
/** Print a message to the console */
function log(...a)       { api.log(...a); }
/** Print a warning to the console */
function warn(...a)      { api.warn(...a); }
/** Print an error to the console */
function error(...a)     { api.error(...a); }

// ── Per-script key/value store (resets each Play session) ─
var store   = api.store;
`;

        const postlude = `
;__out._onStart       = _onStart;
__out._onUpdate       = _onUpdate;
__out._onStop         = _onStop;
__out._onCollide      = _onCollide;
__out._onVisible      = _onVisible;
__out._onHide         = _onHide;
__out._onMouseEnter   = _onMouseEnter;
__out._onMouseLeave   = _onMouseLeave;
__out._onMouseClick   = _onMouseClick;
__out._msgHandlers    = _msgHandlers;
__out._velocityX      = typeof velocityX !== 'undefined' ? velocityX : 0;
__out._velocityY      = typeof velocityY !== 'undefined' ? velocityY : 0;
`;

        try {
            const fn = new Function('api', '__out', prelude + '\n' + code + '\n' + postlude); // eslint-disable-line no-new-func
            const out = {};
            fn(api, out);
            this._onStart        = out._onStart       ?? null;
            this._onUpdate       = out._onUpdate      ?? null;
            this._onStop         = out._onStop        ?? null;
            this._onCollide      = out._onCollide     ?? null;
            this._onVisible      = out._onVisible     ?? null;
            this._onHide         = out._onHide        ?? null;
            this._onMouseEnter   = out._onMouseEnter  ?? null;
            this._onMouseLeave   = out._onMouseLeave  ?? null;
            this._onMouseClick   = out._onMouseClick  ?? null;
            this._messageHandlers= out._msgHandlers   ?? new Map();
            // Initialise velocity from any top-level var declarations
            api._velRef.vx = out._velocityX ?? 0;
            api._velRef.vy = out._velocityY ?? 0;
        } catch (err) {
            _logConsole(`[Script "${this.name}" → "${this.obj.label}"] ✖ Compile error: ${err.message}`, '#f87171');
        }
    }

    start() {
        if (!this._onStart) return;
        try { this._onStart(); }
        catch (e) { _logConsole(`[Script "${this.name}"] onStart: ${e.message}`, '#f87171'); }
    }

    update(dt) {
        // Auto-integrate velocity into position
        const vx = this.api._velRef.vx;
        const vy = this.api._velRef.vy;
        if (vx !== 0) this.obj.x +=  vx * dt * 100;
        if (vy !== 0) this.obj.y -= vy * dt * 100;

        if (this._onUpdate) {
            try { this._onUpdate(dt); }
            catch (e) { _logConsole(`[Script "${this.name}"] onUpdate: ${e.message}`, '#f87171'); }
        }

        // Handle destroy queue
        if (this.obj._markedForDestroy) {
            _destroyObject(this.obj);
        }

        // Clear per-frame flags
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

    handleCollision(other) {
        if (!this._onCollide) return;
        const proxy = other ? _makeObjProxy(other) : null;
        try { this._onCollide(proxy); }
        catch (e) { _logConsole(`[Script "${this.name}"] onCollision: ${e.message}`, '#f87171'); }
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
    _handleMouseDown() { this._mouse.down = true;  this._mouse.justDown = true; }
    _handleMouseUp()   { this._mouse.down = false; this._mouse.justUp   = true; }
}

// ── Destroy helper ────────────────────────────────────────────
function _destroyObject(obj) {
    obj.visible = false;
    try { state.sceneContainer?.removeChild(obj); } catch(_) {}
    const idx = state.gameObjects.indexOf(obj);
    if (idx !== -1) state.gameObjects.splice(idx, 1);
}

// ── Active instances + global input relay ─────────────────────
const _instances = [];
let   _ticker    = null;

function _kd(e) { for (const i of _instances) i._handleKeyDown(e.key); }
function _ku(e) { for (const i of _instances) i._handleKeyUp(e.key); }
function _mm(e) {
    const c = state.app?.view; if (!c) return;
    const r = c.getBoundingClientRect();
    for (const i of _instances) i._handleMouseMove(e.clientX-r.left, e.clientY-r.top);
}
function _md() { for (const i of _instances) i._handleMouseDown(); }
function _mu() { for (const i of _instances) i._handleMouseUp(); }

// ── Start scripts (called from enterPlayMode) ─────────────────
export function startScripts() {
    stopScripts();
    _clearRegistries();

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
        // Register tag/group
        _registerInstance(inst);
        count++;
    }

    if (count === 0) return;

    // Start all after all are compiled (so messaging works in onStart)
    for (const i of _instances) i.start();

    // Input listeners
    window.addEventListener('keydown',   _kd);
    window.addEventListener('keyup',     _ku);
    window.addEventListener('mousemove', _mm);
    window.addEventListener('mousedown', _md);
    window.addEventListener('mouseup',   _mu);

    // Game loop ticker
    let _last = performance.now();
    _ticker = () => {
        if (!state.isPlaying || state.isPaused) return;
        const now = performance.now();
        const dt  = Math.min((now - _last) / 1000, 0.1);
        _last = now;
        // Snapshot to avoid mutation issues during iteration
        const snap = [..._instances];
        for (const i of snap) {
            if (!state.gameObjects.includes(i.obj)) continue; // already destroyed
            i.update(dt);
        }
    };
    state.app.ticker.add(_ticker);
    _logConsole(`▶ Scripts: ${count} instance${count!==1?'s':''} running`, '#4ade80');
}

// ── Stop scripts (called from stopPlayMode) ───────────────────
export function stopScripts() {
    for (const i of _instances) i.stop();
    _instances.length = 0;
    _clearRegistries();
    if (_ticker && state.app) { state.app.ticker.remove(_ticker); _ticker = null; }
    window.removeEventListener('keydown',   _kd);
    window.removeEventListener('keyup',     _ku);
    window.removeEventListener('mousemove', _mm);
    window.removeEventListener('mousedown', _md);
    window.removeEventListener('mouseup',   _mu);
}

// ── External: physics collision bridge ───────────────────────
export function triggerCollision(objA, objB) {
    for (const i of _instances) {
        if (i.obj === objA) i.handleCollision(objB);
        if (i.obj === objB) i.handleCollision(objA);
    }
}

// ── Ace autocomplete (allowed API only) ──────────────────────
const COMPLETIONS = [
    // Events
    { n:'onStart',           m:'● event',    v:"onStart(() => {\n  \n});" },
    { n:'onUpdate',          m:'● event',    v:"onUpdate((dt) => {\n  \n});" },
    { n:'onStop',            m:'● event',    v:"onStop(() => {\n  \n});" },
    { n:'onCollision',       m:'● event',    v:"onCollision((other) => {\n  \n});" },
    { n:'onMessage',         m:'● event',    v:"onMessage('${1:messageName}', (data) => {\n  \n});" },
    { n:'onBecomeVisible',   m:'● event',    v:"onBecomeVisible(() => {\n  \n});" },
    { n:'onBecomeHidden',    m:'● event',    v:"onBecomeHidden(() => {\n  \n});" },
    { n:'onMouseEnter',      m:'● event',    v:"onMouseEnter(() => {\n  \n});" },
    { n:'onMouseLeave',      m:'● event',    v:"onMouseLeave(() => {\n  \n});" },
    { n:'onMouseClick',      m:'● event',    v:"onMouseClick(() => {\n  \n});" },
    // Position
    { n:'moveTo',            m:'↔ move',     v:'moveTo(${1:x}, ${2:y})' },
    { n:'move',              m:'↔ move',     v:'move(${1:dx}, ${2:dy})' },
    { n:'moveForward',       m:'↔ move',     v:'moveForward(${1:speed})' },
    { n:'lookAt',            m:'↔ move',     v:'lookAt(${1:tx}, ${2:ty})' },
    { n:'flipX',             m:'↔ move',     v:'flipX()' },
    { n:'flipY',             m:'↔ move',     v:'flipY()' },
    { n:'getX',              m:'↔ move',     v:'getX()' },
    { n:'setX',              m:'↔ move',     v:'setX(${1:value})' },
    { n:'getY',              m:'↔ move',     v:'getY()' },
    { n:'setY',              m:'↔ move',     v:'setY(${1:value})' },
    // Velocity
    { n:'velocityX',         m:'⚡ velocity', v:'velocityX' },
    { n:'velocityY',         m:'⚡ velocity', v:'velocityY' },
    { n:'vx',                m:'⚡ velocity', v:'vx' },
    { n:'vy',                m:'⚡ velocity', v:'vy' },
    { n:'bounceX',           m:'⚡ velocity', v:'bounceX()' },
    { n:'bounceY',           m:'⚡ velocity', v:'bounceY()' },
    // Rotation / Scale
    { n:'getRotation',       m:'↻ rotation', v:'getRotation()' },
    { n:'setRotation',       m:'↻ rotation', v:'setRotation(${1:degrees})' },
    { n:'getScaleX',         m:'⤡ scale',    v:'getScaleX()' },
    { n:'setScaleX',         m:'⤡ scale',    v:'setScaleX(${1:value})' },
    { n:'getScaleY',         m:'⤡ scale',    v:'getScaleY()' },
    { n:'setScaleY',         m:'⤡ scale',    v:'setScaleY(${1:value})' },
    // Display
    { n:'show',              m:'👁 display',  v:'show()' },
    { n:'hide',              m:'👁 display',  v:'hide()' },
    { n:'getVisible',        m:'👁 display',  v:'getVisible()' },
    { n:'setVisible',        m:'👁 display',  v:'setVisible(${1:true})' },
    { n:'getAlpha',          m:'👁 display',  v:'getAlpha()' },
    { n:'setAlpha',          m:'👁 display',  v:'setAlpha(${1:1})' },
    { n:'fadeIn',            m:'👁 display',  v:'fadeIn(${1:duration}, dt)' },
    { n:'fadeOut',           m:'👁 display',  v:'fadeOut(${1:duration}, dt)' },
    // Tag / Group
    { n:'setTag',            m:'🏷 tag',      v:"setTag('${1:myTag}')" },
    { n:'getTag',            m:'🏷 tag',      v:'getTag()' },
    { n:'setGroup',          m:'🏷 group',    v:"setGroup('${1:myGroup}')" },
    { n:'getGroup',          m:'🏷 group',    v:'getGroup()' },
    // Messaging
    { n:'sendMessage',       m:'📨 message',  v:"sendMessage('${1:tag}', '${2:message}', ${3:data})" },
    { n:'broadcast',         m:'📨 message',  v:"broadcast('${1:tag}', '${2:message}')" },
    { n:'broadcastGroup',    m:'📨 message',  v:"broadcastGroup('${1:group}', '${2:message}')" },
    { n:'broadcastAll',      m:'📨 message',  v:"broadcastAll('${1:message}')" },
    // Input
    { n:'isKeyDown',         m:'🎮 input',    v:"isKeyDown('${1:w}')" },
    { n:'isKeyJustDown',     m:'🎮 input',    v:"isKeyJustDown('${1:Space}')" },
    { n:'isKeyJustUp',       m:'🎮 input',    v:"isKeyJustUp('${1:Space}')" },
    { n:'axisH',             m:'🎮 input',    v:'axisH()' },
    { n:'axisV',             m:'🎮 input',    v:'axisV()' },
    { n:'input.mouseX',      m:'🎮 input',    v:'input.mouseX' },
    { n:'input.mouseY',      m:'🎮 input',    v:'input.mouseY' },
    { n:'input.mouseDown',   m:'🎮 input',    v:'input.mouseDown' },
    { n:'input.mouseJustDown',m:'🎮 input',   v:'input.mouseJustDown' },
    // Animation
    { n:'playAnimation',     m:'▶ anim',     v:"playAnimation('${1:name}')" },
    { n:'stopAnimation',     m:'▶ anim',     v:'stopAnimation()' },
    { n:'currentAnimation',  m:'▶ anim',     v:'currentAnimation()' },
    // Physics
    { n:'physics.setVelocity',  m:'⚙ physics', v:'physics.setVelocity(${1:vx}, ${2:vy})' },
    { n:'physics.applyForce',   m:'⚙ physics', v:'physics.applyForce(${1:fx}, ${2:fy})' },
    { n:'physics.applyImpulse', m:'⚙ physics', v:'physics.applyImpulse(${1:ix}, ${2:iy})' },
    { n:'physics.velX',         m:'⚙ physics', v:'physics.velX' },
    { n:'physics.velY',         m:'⚙ physics', v:'physics.velY' },
    { n:'physics.stop',         m:'⚙ physics', v:'physics.stop()' },
    // Scene
    { n:'find',              m:'🔍 scene',    v:"find('${1:label}')" },
    { n:'findWithTag',       m:'🔍 scene',    v:"findWithTag('${1:tag}')" },
    { n:'findAllWithTag',    m:'🔍 scene',    v:"findAllWithTag('${1:tag}')" },
    { n:'findAllInGroup',    m:'🔍 scene',    v:"findAllInGroup('${1:group}')" },
    { n:'destroySelf',       m:'🔍 scene',    v:'destroySelf()' },
    { n:'destroy',           m:'🔍 scene',    v:'destroy(${1:other})' },
    // Time
    { n:'getTime',           m:'⏱ time',     v:'getTime()' },
    // Math
    { n:'lerp',              m:'∑ math',     v:'lerp(${1:a}, ${2:b}, ${3:t})' },
    { n:'clamp',             m:'∑ math',     v:'clamp(${1:v}, ${2:min}, ${3:max})' },
    { n:'dist',              m:'∑ math',     v:'dist(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})' },
    { n:'rand',              m:'∑ math',     v:'rand(${1:min}, ${2:max})' },
    { n:'randInt',           m:'∑ math',     v:'randInt(${1:min}, ${2:max})' },
    { n:'sign',              m:'∑ math',     v:'sign(${1:v})' },
    { n:'mapRange',          m:'∑ math',     v:'mapRange(${1:v}, ${2:a1}, ${3:b1}, ${4:a2}, ${5:b2})' },
    { n:'wrap',              m:'∑ math',     v:'wrap(${1:v}, ${2:min}, ${3:max})' },
    { n:'sin',               m:'∑ math',     v:'sin(${1:angle})' },
    { n:'cos',               m:'∑ math',     v:'cos(${1:angle})' },
    { n:'abs',               m:'∑ math',     v:'abs(${1:v})' },
    { n:'sqrt',              m:'∑ math',     v:'sqrt(${1:v})' },
    { n:'PI',                m:'∑ math',     v:'PI' },
    { n:'floor',             m:'∑ math',     v:'floor(${1:v})' },
    { n:'ceil',              m:'∑ math',     v:'ceil(${1:v})' },
    { n:'round',             m:'∑ math',     v:'round(${1:v})' },
    { n:'toRad',             m:'∑ math',     v:'toRad(${1:degrees})' },
    { n:'toDeg',             m:'∑ math',     v:'toDeg(${1:radians})' },
    // Debug
    { n:'log',               m:'🐛 debug',   v:'log(${1:value})' },
    { n:'warn',              m:'🐛 debug',   v:'warn(${1:value})' },
    { n:'error',             m:'🐛 debug',   v:'error(${1:value})' },
    // Store
    { n:'store.set',         m:'💾 store',   v:"store.set('${1:key}', ${2:value})" },
    { n:'store.get',         m:'💾 store',   v:"store.get('${1:key}', ${2:default})" },
    { n:'store.has',         m:'💾 store',   v:"store.has('${1:key}')" },
].map(c => ({ caption:c.n, value:c.v, meta:c.m, score:950 }));

// ── Script Editor ─────────────────────────────────────────────
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

    const canDetach  = !!obj && !!obj.scriptName && obj.scriptName === scriptName;
    const objLabel   = obj?.label ?? '';

    overlay.innerHTML = `
        <!-- Header -->
        <div style="display:flex;align-items:center;gap:10px;padding:7px 14px;background:#0d0f1a;border-bottom:1px solid #1a1d2e;flex-shrink:0;user-select:none;">
            <svg viewBox="0 0 24 24" style="width:15px;height:15px;flex-shrink:0;fill:none;stroke:#7cb9f0;stroke-width:2.5;">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            <span style="color:#7cb9f0;font-weight:700;font-size:13px;">${scriptName}.js</span>
            ${obj ? `<span style="color:#252535;">│</span><span style="color:#5a7a9a;font-size:11px;">attached to: <b style="color:#9bc;">${objLabel}</b></span>` : ''}
            <div style="flex:1;"></div>
            <span id="se-status" style="font-size:11px;transition:color .2s;margin-right:6px;"></span>
            <button id="se-save"   style="${_bs('#0f2540','#7cb9f0','#1e4a7a')}">Save <kbd style="opacity:.4;font-size:9px;">Ctrl+S</kbd></button>
            ${canDetach ? `<button id="se-detach" style="${_bs('#200a0a','#f87171','#3a1515')}margin-left:4px;">Detach</button>` : ''}
            <button id="se-close"  style="${_bs('#0f1018','#666','#1a1d28')}margin-left:4px;">✕</button>
        </div>

        <!-- Body -->
        <div style="display:flex;flex:1;min-height:0;">
            <!-- Ace Editor -->
            <div style="flex:1;position:relative;min-width:0;">
                <div id="se-ace" style="position:absolute;inset:0;"></div>
            </div>
            <!-- Sidebar -->
            <div style="width:208px;flex-shrink:0;background:#080a11;border-left:1px solid #131525;overflow-y:auto;">
                ${_sidebarHTML()}
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Init Ace editor
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

    // Custom autocomplete — only allowed API
    const langTools = ace.require('ace/ext/language_tools');
    langTools.addCompleter({
        getCompletions(_ed, _sess, _pos, prefix, cb) {
            const lp = prefix.toLowerCase();
            cb(null, !lp ? COMPLETIONS : COMPLETIONS.filter(c => c.caption.toLowerCase().startsWith(lp)));
        },
    });

    // Dirty tracking
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
            <div style="color:#555;font-size:11px;margin-bottom:14px;">Enter a name for the new script file</div>
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
                style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:4px;margin:2px 0;background:${attached ? 'rgba(58,114,165,.15)' : 'transparent'};">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;flex-shrink:0;fill:none;stroke:${attached ? '#7cb9f0':'#383850'};stroke-width:2;">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                <div style="flex:1;min-width:0;">
                    <div style="color:${attached ? '#7cb9f0':'#ccc'};font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        ${s.name}${attached ? ' <span style="color:#4ade80;font-size:10px;font-weight:400;">● attached</span>' : ''}
                    </div>
                    <div style="color:#383850;font-size:10px;">${ts}</div>
                </div>
                <button class="sl-edit"   data-name="${s.name}" style="${_bs('#0d200d','#8f8','#1e3a1e','3px')}font-size:10px;padding:3px 8px;">Edit</button>
                <button class="sl-attach" data-name="${s.name}" style="${_bs('#0f2540','#7cb9f0','#1e4a7a','3px')}font-size:10px;padding:3px 8px;">${attached ? '✓ Attached' : 'Attach'}</button>
            </div>
        `;
    }).join('');

    modal.innerHTML = `
        <div style="padding:18px;min-width:380px;max-height:70vh;display:flex;flex-direction:column;">
            <div style="color:#e0e0e0;font-weight:700;font-size:14px;margin-bottom:3px;">Load Script</div>
            <div style="color:#444;font-size:11px;margin-bottom:10px;">Attach a script to <span style="color:#9bc;">${obj.label}</span></div>
            <div style="flex:1;overflow-y:auto;">${rows}</div>
            ${obj.scriptName ? `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #181828;display:flex;justify-content:space-between;align-items:center;">
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

// ── Helpers ───────────────────────────────────────────────────
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
        ['Events',    ['onStart(fn)', 'onUpdate(fn)', 'onStop(fn)', 'onCollision(fn)', 'onMessage("msg", fn)', 'onBecomeVisible(fn)', 'onBecomeHidden(fn)', 'onMouseClick(fn)']],
        ['Position',  ['moveTo(x, y)', 'move(dx, dy)', 'moveForward(speed)', 'lookAt(tx, ty)', 'getX() / setX(v)', 'getY() / setY(v)', 'flipX() / flipY()']],
        ['Velocity',  ['velocityX / vx', 'velocityY / vy', 'bounceX() / bounceY()']],
        ['Rotation',  ['getRotation()', 'setRotation(deg)']],
        ['Scale',     ['getScaleX/Y()', 'setScaleX/Y(v)']],
        ['Display',   ['show() / hide()', 'setVisible(v)', 'getAlpha() / setAlpha(v)', 'fadeIn(t, dt)', 'fadeOut(t, dt)']],
        ['Tag & Group',['setTag("name")', 'getTag()', 'setGroup("name")', 'getGroup()']],
        ['Messaging', ['sendMessage(tag, msg, data)', 'broadcast(tag, msg)', 'broadcastGroup(grp, msg)', 'broadcastAll(msg)', 'onMessage("msg", fn)']],
        ['Input',     ['isKeyDown("w")', 'isKeyJustDown("Space")', 'isKeyJustUp("w")', 'axisH() → -1/0/1', 'axisV() → -1/0/1', 'input.mouseX / mouseY', 'input.mouseDown']],
        ['Animation', ['playAnimation("name")', 'stopAnimation()', 'currentAnimation()']],
        ['Physics',   ['physics.setVelocity(vx,vy)', 'physics.applyForce(fx,fy)', 'physics.applyImpulse(ix,iy)', 'physics.velX / velY', 'physics.stop()']],
        ['Scene',     ['find("label")', 'findWithTag("tag")', 'findAllWithTag("tag")', 'findAllInGroup("grp")', 'destroySelf()', 'destroy(other)']],
        ['Time',      ['getTime() → seconds']],
        ['Math',      ['lerp(a,b,t)', 'clamp(v,lo,hi)', 'dist(x1,y1,x2,y2)', 'rand(min,max)', 'randInt(min,max)', 'sign(v)', 'mapRange(v,…)', 'wrap(v,min,max)', 'toRad(deg) / toDeg(rad)', 'sin/cos/abs/sqrt/PI…']],
        ['Debug',     ['log(...)', 'warn(...)', 'error(...)']],
        ['Store',     ["store.set('key', value)", "store.get('key', default)", "store.has('key')"]],
    ];
    return `<style>
        .se-g  { padding:5px 0 2px; border-top:1px solid #0f111c; }
        .se-g:first-child { border-top:none; }
        .se-gt { padding:4px 10px 2px; color:#1e4a7a; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:1px; }
        .se-gi { padding:1px 10px; color:#2a3a4a; font-size:10px; line-height:1.7; font-family:monospace; }
        .se-gi:hover { color:#5a8aaa; }
    </style>` + G.map(([t,items]) => `
        <div class="se-g">
            <div class="se-gt">${t}</div>
            ${items.map(i=>`<div class="se-gi">${i}</div>`).join('')}
        </div>
    `).join('');
}

// ── Default script template ───────────────────────────────────
function _defaultScript(name) {
    return `// ============================================================
// Script: ${name}
// This script runs only while the game is in Play Mode.
// ============================================================


// ── Setup: runs once when Play is pressed ────────────────────
onStart(() => {

  // Give this object a tag so other scripts can find it
  setTag("player");

  // Optionally assign to a group
  // setGroup("enemies");

  log("${name} is ready!");

});


// ── Every frame: dt = seconds since the last frame ───────────
onUpdate((dt) => {

  // ── Move with keyboard ─────────────────────────────────────
  const speed = 4;                  // world units per second
  move(axisH() * speed * dt,        // left/right: A,D or arrows
       axisV() * speed * dt);       // up/down:    W,S or arrows

  // ── Or use velocity (applied automatically each frame) ─────
  // velocityX = 3;   // moves right at 3 units/sec forever
  // velocityY = 0;

  // ── Jump example ───────────────────────────────────────────
  // if (isKeyJustDown("Space")) {
  //   velocityY = 8;
  // }

  // ── Rotate to face the mouse ───────────────────────────────
  // lookAt(input.mouseX / 100, -input.mouseY / 100);

});


// ── Cleanup: runs once when Play is stopped ──────────────────
onStop(() => {

  log("${name} stopped.");

});


// ── Collision: called when this object hits another ──────────
onCollision((other) => {

  // 'other' has: other.name, other.x, other.y, other.tag
  if (other) {
    log("Hit: " + other.name);
  }

});


// ── Messages: other scripts can send messages to this one ────
onMessage("takeDamage", (amount) => {

  log("Ouch! Took " + amount + " damage");

});

// ── How to send a message to another object: ─────────────────
// sendMessage("Enemy", "takeDamage", 10);   // first with tag
// broadcast("Enemy", "freeze");             // all with tag
// broadcastAll("gameOver");                 // everyone
`;
}

function _logConsole(msg, color = '#e0e0e0') {
    const c = document.getElementById('console-output') || document.getElementById('tab-console');
    if (!c) return;
    const l = document.createElement('div');
    l.style.color = color;
    l.textContent = msg;
    c.appendChild(l);
    c.scrollTop = c.scrollHeight;
}
