/* ============================================================
   Zengine — engine.scripting.js
   Sandboxed JS scripting.  Scripts are stored in state.scripts
   (serialised with the project JSON, just like assets).
   Editor uses Ace for syntax highlighting + autocomplete.
   Scripts execute ONLY during Play Mode via a locked API.
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

// ── Script CRUD (state.scripts — saved with project) ─────────
export function saveScript(name, code) {
    const existing = state.scripts.find(s => s.name === name);
    if (existing) {
        existing.code      = code;
        existing.updatedAt = Date.now();
    } else {
        state.scripts.push({
            id:        'script_' + Date.now() + '_' + Math.random().toString(36).slice(2),
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
        empty.style.cssText = 'color:#505060;font-size:11px;padding:16px;font-style:italic;text-align:center;width:100%;';
        empty.textContent = 'No scripts yet — create one via the Inspector';
        grid.appendChild(empty);
        return;
    }

    for (const script of state.scripts) {
        const item = document.createElement('div');
        item.className = 'asset-item';
        item.style.cssText = 'cursor:pointer;position:relative;';

        const d  = new Date(script.updatedAt);
        const ts = d.toLocaleDateString();

        item.innerHTML = `
            <div class="asset-thumb" style="background:#0a0f1a;border:1px solid #1e3a5a;">
                <svg viewBox="0 0 24 24" style="width:26px;height:26px;fill:none;stroke:#7cb9f0;stroke-width:1.5;">
                    <polyline points="16 18 22 12 16 6"/>
                    <polyline points="8 6 2 12 8 18"/>
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

// ── Sandboxed API builder ─────────────────────────────────────
function _buildSandbox(obj) {
    const _keys         = new Set();
    const _keysJustDown = new Set();
    const _mouse        = { x: 0, y: 0, down: false };

    const api = {
        get x()          { return  obj.x  / 100; },
        set x(v)         { obj.x  =  v * 100; },
        get y()          { return -obj.y  / 100; },
        set y(v)         { obj.y  = -v * 100; },
        get rotation()   { return -(obj.rotation * 180 / Math.PI); },
        set rotation(v)  { obj.rotation = -(v * Math.PI / 180); },
        get scaleX()     { return obj.scale.x; },
        set scaleX(v)    { obj.scale.x = v; },
        get scaleY()     { return obj.scale.y; },
        set scaleY(v)    { obj.scale.y = v; },
        get visible()    { return obj.visible; },
        set visible(v)   { obj.visible = !!v; },
        get alpha()      { return obj.alpha; },
        set alpha(v)     { obj.alpha = Math.max(0, Math.min(1, v)); },

        translate(dx, dy) { obj.x += dx * 100; obj.y -= dy * 100; },
        moveTo(x, y)      { obj.x =  x * 100; obj.y = -y * 100; },
        lookAt(tx, ty) {
            const dx = tx * 100 - obj.x, dy = ty * 100 - obj.y;
            obj.rotation = -Math.atan2(-dy, dx);
        },

        input: {
            isKeyDown:     k => _keys.has(k.toLowerCase()),
            isKeyJustDown: k => _keysJustDown.has(k.toLowerCase()),
            get mouseX()    { return _mouse.x; },
            get mouseY()    { return _mouse.y; },
            get mouseDown() { return _mouse.down; },
        },

        playAnimation(name) {
            const idx = obj.animations?.findIndex(a => a.name === name) ?? -1;
            if (idx >= 0) {
                obj.activeAnimIndex = idx;
                try { if (obj._runtimeSprite) obj._runtimeSprite.gotoAndPlay(0); } catch(_) {}
            }
        },
        stopAnimation() { try { obj._runtimeSprite?.stop(); } catch(_) {} },
        get currentAnimation() { return obj.animations?.[obj.activeAnimIndex]?.name ?? ''; },

        physics: {
            applyForce(fx, fy)    { obj._physicsBody?.applyForce?.({ x:fx, y:-fy }, obj._physicsBody.getPosition()); },
            applyImpulse(ix, iy)  { obj._physicsBody?.applyLinearImpulse?.({ x:ix, y:-iy }, obj._physicsBody.getPosition()); },
            setVelocity(vx, vy)   { obj._physicsBody?.setLinearVelocity?.({ x:vx, y:-vy }); },
            get velX() { return  obj._physicsBody?.getLinearVelocity?.()?.x ?? 0; },
            get velY() { return -(obj._physicsBody?.getLinearVelocity?.()?.y ?? 0); },
        },

        find(label) {
            const f = state.gameObjects.find(o => o.label === label);
            if (!f) return null;
            return { get x(){ return f.x/100; }, get y(){ return -f.y/100; }, get name(){ return f.label; } };
        },

        math: {
            lerp:    (a,b,t) => a + (b-a) * Math.max(0,Math.min(1,t)),
            clamp:   (v,lo,hi) => Math.max(lo, Math.min(hi,v)),
            dist:    (x1,y1,x2,y2) => Math.sqrt((x2-x1)**2+(y2-y1)**2),
            rand:    (mn,mx) => Math.random()*(mx-mn)+mn,
            randInt: (mn,mx) => Math.floor(Math.random()*(mx-mn+1))+mn,
            sin:Math.sin, cos:Math.cos,   abs:Math.abs,
            round:Math.round, floor:Math.floor, ceil:Math.ceil,
            sqrt:Math.sqrt,   pow:Math.pow,    atan2:Math.atan2, PI:Math.PI,
        },

        log(...a)  { _logConsole(`[${obj.label}] ${a.map(String).join(' ')}`, '#9bc'); },
        warn(...a) { _logConsole(`[${obj.label}] ⚠ ${a.map(String).join(' ')}`, '#facc15'); },
        get time() { return performance.now() / 1000; },
    };

    return { api, _keys, _keysJustDown, _mouse };
}

// ── Script Instance ──────────────────────────────────────────
class ScriptInstance {
    constructor(obj, name, code) {
        this.obj            = obj;
        this.name           = name;
        this._onStart       = null;
        this._onUpdate      = null;
        this._onStop        = null;
        this._onCollide     = null;
        const { api, _keys, _keysJustDown, _mouse } = _buildSandbox(obj);
        this.api            = api;
        this._keys          = _keys;
        this._keysJustDown  = _keysJustDown;
        this._mouse         = _mouse;
        this._compile(code, api);
    }

    _compile(code, api) {
        const prelude = `
var _onStart=null,_onUpdate=null,_onStop=null,_onCollide=null;
function onStart(fn)     { _onStart   = fn; }
function onUpdate(fn)    { _onUpdate  = fn; }
function onStop(fn)      { _onStop    = fn; }
function onCollision(fn) { _onCollide = fn; }
var translate=api.translate.bind(api), moveTo=api.moveTo.bind(api), lookAt=api.lookAt.bind(api);
var playAnimation=api.playAnimation.bind(api), stopAnimation=api.stopAnimation.bind(api);
var find=api.find.bind(api), log=api.log.bind(api), warn=api.warn.bind(api);
var input=api.input, physics=api.physics, math=api.math;
var lerp=math.lerp,clamp=math.clamp,dist=math.dist,rand=math.rand,randInt=math.randInt;
var sin=math.sin,cos=math.cos,abs=math.abs,sqrt=math.sqrt,pow=math.pow,atan2=math.atan2,PI=math.PI;
var floor=math.floor,ceil=math.ceil,round=math.round;
function getX()          { return api.x; }
function setX(v)         { api.x = v; }
function getY()          { return api.y; }
function setY(v)         { api.y = v; }
function getRotation()   { return api.rotation; }
function setRotation(v)  { api.rotation = v; }
function getScaleX()     { return api.scaleX; }
function setScaleX(v)    { api.scaleX = v; }
function getScaleY()     { return api.scaleY; }
function setScaleY(v)    { api.scaleY = v; }
function getVisible()    { return api.visible; }
function setVisible(v)   { api.visible = v; }
function getAlpha()      { return api.alpha; }
function setAlpha(v)     { api.alpha = v; }
function getTime()       { return api.time; }
function currentAnimation() { return api.currentAnimation; }
`;
        try {
            const fn = new Function('api', '__out', prelude + '\n' + code + '\n;__out._onStart=_onStart;__out._onUpdate=_onUpdate;__out._onStop=_onStop;__out._onCollide=_onCollide;'); // eslint-disable-line no-new-func
            const out = {};
            fn(api, out);
            this._onStart   = out._onStart   ?? null;
            this._onUpdate  = out._onUpdate  ?? null;
            this._onStop    = out._onStop    ?? null;
            this._onCollide = out._onCollide ?? null;
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
        if (this._onUpdate) {
            try { this._onUpdate(dt); }
            catch (e) { _logConsole(`[Script "${this.name}"] onUpdate: ${e.message}`, '#f87171'); }
        }
        this._keysJustDown.clear();
    }

    stop() {
        if (!this._onStop) return;
        try { this._onStop(); }
        catch (e) { _logConsole(`[Script "${this.name}"] onStop: ${e.message}`, '#f87171'); }
    }

    handleCollision(other) {
        if (!this._onCollide) return;
        const proxy = other ? { get x(){ return other.x/100; }, get y(){ return -other.y/100; }, name: other.label } : null;
        try { this._onCollide(proxy); }
        catch (e) { _logConsole(`[Script "${this.name}"] onCollision: ${e.message}`, '#f87171'); }
    }

    _handleKeyDown(key) { const k=key.toLowerCase(); if(!this._keys.has(k))this._keysJustDown.add(k); this._keys.add(k); }
    _handleKeyUp(key)   { this._keys.delete(key.toLowerCase()); }
    _handleMouseMove(x, y) { this._mouse.x = x; this._mouse.y = y; }
    _handleMouseDown()  { this._mouse.down = true; }
    _handleMouseUp()    { this._mouse.down = false; }
}

// ── Global input relay ───────────────────────────────────────
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

// ── Start all scripts (enterPlayMode) ─────────────────────────
export function startScripts() {
    stopScripts();
    let count = 0;
    for (const obj of state.gameObjects) {
        if (!obj.scriptName) continue;
        const rec = getScript(obj.scriptName);
        if (!rec) { _logConsole(`[Scripting] Script "${obj.scriptName}" not found for "${obj.label}"`, '#facc15'); continue; }
        _instances.push(new ScriptInstance(obj, obj.scriptName, rec.code));
        count++;
    }
    if (count === 0) return;
    for (const i of _instances) i.start();
    window.addEventListener('keydown',   _kd);
    window.addEventListener('keyup',     _ku);
    window.addEventListener('mousemove', _mm);
    window.addEventListener('mousedown', _md);
    window.addEventListener('mouseup',   _mu);
    let _last = performance.now();
    _ticker = () => {
        if (!state.isPlaying || state.isPaused) return;
        const now = performance.now(), dt = Math.min((now-_last)/1000, 0.1);
        _last = now;
        for (const i of _instances) i.update(dt);
    };
    state.app.ticker.add(_ticker);
    _logConsole(`▶ Scripts: ${count} instance${count!==1?'s':''} running`, '#4ade80');
}

// ── Stop all scripts (stopPlayMode) ──────────────────────────
export function stopScripts() {
    for (const i of _instances) i.stop();
    _instances.length = 0;
    if (_ticker && state.app) { state.app.ticker.remove(_ticker); _ticker = null; }
    window.removeEventListener('keydown',   _kd);
    window.removeEventListener('keyup',     _ku);
    window.removeEventListener('mousemove', _mm);
    window.removeEventListener('mousedown', _md);
    window.removeEventListener('mouseup',   _mu);
}

export function triggerCollision(objA, objB) {
    for (const i of _instances) {
        if (i.obj === objA) i.handleCollision(objB);
        if (i.obj === objB) i.handleCollision(objA);
    }
}

// ── Ace autocomplete completions (allowed API only) ───────────
const COMPLETIONS = [
    // Events
    { n:'onStart',     m:'event',     v:'onStart(() => {\n  \n})' },
    { n:'onUpdate',    m:'event',     v:'onUpdate((dt) => {\n  \n})' },
    { n:'onStop',      m:'event',     v:'onStop(() => {\n  \n})' },
    { n:'onCollision', m:'event',     v:'onCollision((other) => {\n  \n})' },
    // Transform
    { n:'translate',   m:'transform', v:'translate(${1:dx}, ${2:dy})' },
    { n:'moveTo',      m:'transform', v:'moveTo(${1:x}, ${2:y})' },
    { n:'lookAt',      m:'transform', v:'lookAt(${1:tx}, ${2:ty})' },
    { n:'getX',        m:'transform', v:'getX()' },
    { n:'setX',        m:'transform', v:'setX(${1:v})' },
    { n:'getY',        m:'transform', v:'getY()' },
    { n:'setY',        m:'transform', v:'setY(${1:v})' },
    { n:'getRotation', m:'transform', v:'getRotation()' },
    { n:'setRotation', m:'transform', v:'setRotation(${1:deg})' },
    { n:'getScaleX',   m:'transform', v:'getScaleX()' },
    { n:'setScaleX',   m:'transform', v:'setScaleX(${1:v})' },
    { n:'getScaleY',   m:'transform', v:'getScaleY()' },
    { n:'setScaleY',   m:'transform', v:'setScaleY(${1:v})' },
    { n:'getVisible',  m:'display',   v:'getVisible()' },
    { n:'setVisible',  m:'display',   v:'setVisible(${1:true})' },
    { n:'getAlpha',    m:'display',   v:'getAlpha()' },
    { n:'setAlpha',    m:'display',   v:'setAlpha(${1:1})' },
    // Input
    { n:'input.isKeyDown',     m:'input', v:"input.isKeyDown('${1:w}')" },
    { n:'input.isKeyJustDown', m:'input', v:"input.isKeyJustDown('${1:Space}')" },
    { n:'input.mouseX',        m:'input', v:'input.mouseX' },
    { n:'input.mouseY',        m:'input', v:'input.mouseY' },
    { n:'input.mouseDown',     m:'input', v:'input.mouseDown' },
    // Animation
    { n:'playAnimation',    m:'animation', v:"playAnimation('${1:name}')" },
    { n:'stopAnimation',    m:'animation', v:'stopAnimation()' },
    { n:'currentAnimation', m:'animation', v:'currentAnimation()' },
    // Physics
    { n:'physics.setVelocity',  m:'physics', v:'physics.setVelocity(${1:vx}, ${2:vy})' },
    { n:'physics.applyForce',   m:'physics', v:'physics.applyForce(${1:fx}, ${2:fy})' },
    { n:'physics.applyImpulse', m:'physics', v:'physics.applyImpulse(${1:ix}, ${2:iy})' },
    { n:'physics.velX',         m:'physics', v:'physics.velX' },
    { n:'physics.velY',         m:'physics', v:'physics.velY' },
    // Scene
    { n:'find',    m:'scene', v:"find('${1:label}')" },
    { n:'getTime', m:'time',  v:'getTime()' },
    // Math
    { n:'lerp',    m:'math', v:'lerp(${1:a}, ${2:b}, ${3:t})' },
    { n:'clamp',   m:'math', v:'clamp(${1:v}, ${2:lo}, ${3:hi})' },
    { n:'dist',    m:'math', v:'dist(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})' },
    { n:'rand',    m:'math', v:'rand(${1:min}, ${2:max})' },
    { n:'randInt', m:'math', v:'randInt(${1:min}, ${2:max})' },
    { n:'sin',     m:'math', v:'sin(${1:a})' },
    { n:'cos',     m:'math', v:'cos(${1:a})' },
    { n:'abs',     m:'math', v:'abs(${1:v})' },
    { n:'sqrt',    m:'math', v:'sqrt(${1:v})' },
    { n:'atan2',   m:'math', v:'atan2(${1:y}, ${2:x})' },
    { n:'floor',   m:'math', v:'floor(${1:v})' },
    { n:'ceil',    m:'math', v:'ceil(${1:v})' },
    { n:'round',   m:'math', v:'round(${1:v})' },
    { n:'PI',      m:'math', v:'PI' },
    // Debug
    { n:'log',  m:'debug', v:'log(${1:value})' },
    { n:'warn', m:'debug', v:'warn(${1:value})' },
].map(c => ({ caption:c.n, value:c.v, meta:c.m, score:900 }));

// ── Script Editor (Ace-powered) ───────────────────────────────
export async function openScriptEditor(obj, scriptName, initialCode) {
    document.getElementById('zengine-script-editor')?.remove();

    if (initialCode === undefined || initialCode === null) {
        initialCode = getScript(scriptName)?.code ?? _defaultScript(scriptName);
    }

    const ace = await _loadAce();

    const overlay = document.createElement('div');
    overlay.id = 'zengine-script-editor';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#0b0d14;display:flex;flex-direction:column;font-family:system-ui,sans-serif;';

    const canDetach = !!obj && !!obj.scriptName && obj.scriptName === scriptName;
    const objectLabel = obj?.label ?? '';

    overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 14px;background:#0f1118;border-bottom:1px solid #1a1d2a;flex-shrink:0;">
            <svg viewBox="0 0 24 24" style="width:15px;height:15px;flex-shrink:0;fill:none;stroke:#7cb9f0;stroke-width:2.5;">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            <span style="color:#7cb9f0;font-weight:700;font-size:13px;">${scriptName}.js</span>
            ${obj ? `<span style="color:#2a2a3a;">│</span><span style="color:#7a8a9a;font-size:11px;">→ ${objectLabel}</span>` : ''}
            <div style="flex:1;"></div>
            <span id="se-status" style="font-size:11px;color:#2a4a2a;transition:color .2s;"></span>
            <button id="se-save"  style="${_bs('#0f2540','#7cb9f0','#1e4a7a')}font-size:12px;padding:4px 14px;">
                Save <kbd style="opacity:.4;font-size:9px;font-family:monospace;">Ctrl+S</kbd>
            </button>
            ${canDetach ? `<button id="se-detach" style="${_bs('#200a0a','#f87171','#3a1a1a')}font-size:12px;padding:4px 10px;">Detach</button>` : ''}
            <button id="se-close"  style="${_bs('#111218','#888','#1e2030')}font-size:12px;padding:4px 10px;">✕</button>
        </div>

        <div style="display:flex;flex:1;min-height:0;">
            <div style="flex:1;position:relative;min-width:0;">
                <div id="se-ace-container" style="position:absolute;inset:0;"></div>
            </div>
            <div style="width:196px;flex-shrink:0;background:#090b12;border-left:1px solid #141628;overflow-y:auto;font-size:10px;">
                ${_sidebarHTML()}
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // ── Init Ace ─────────────────────────────────────────────
    ace.config.set('basePath', ACE_BASE);
    const editor = ace.edit('se-ace-container');

    editor.setTheme('ace/theme/tomorrow_night');
    editor.session.setMode('ace/mode/javascript');
    editor.setValue(initialCode, -1);
    editor.setOptions({
        enableBasicAutocompletion: true,
        enableSnippets:            true,
        enableLiveAutocompletion:  true,
        showPrintMargin:           false,
        fontSize:                  '13px',
        fontFamily:                '"Fira Code", "Cascadia Code", "Consolas", monospace',
        tabSize:                   2,
        useSoftTabs:               true,
        highlightActiveLine:       true,
        displayIndentGuides:       true,
        scrollPastEnd:             0.3,
    });

    // Inject our custom completions (only allowed API — no global noise)
    const langTools = ace.require('ace/ext/language_tools');
    const customCompleter = {
        getCompletions(_ed, _sess, _pos, prefix, callback) {
            const lp = prefix.toLowerCase();
            callback(null, COMPLETIONS.filter(c =>
                !lp || c.caption.toLowerCase().startsWith(lp)
            ));
        },
    };
    langTools.addCompleter(customCompleter);

    // ── Dirty tracking ────────────────────────────────────────
    let _dirty = false;
    const statusEl = overlay.querySelector('#se-status');
    editor.on('change', () => {
        if (!_dirty) { _dirty = true; statusEl.textContent = '● unsaved'; statusEl.style.color = '#facc15'; }
    });

    async function _doSave() {
        const code = editor.getValue();
        saveScript(scriptName, code);
        if (obj) obj.scriptName = scriptName;
        _dirty = false;
        statusEl.textContent = '✓ saved';
        statusEl.style.color = '#4ade80';
        setTimeout(() => { if (!_dirty) statusEl.textContent = ''; }, 2000);
        _logConsole(`💾 Script "${scriptName}" saved`, '#4ade80');
        import('./engine.ui.js').then(m => m.syncPixiToInspector());
    }

    overlay.querySelector('#se-save').addEventListener('click', _doSave);

    overlay.querySelector('#se-close').addEventListener('click', async () => {
        if (_dirty) {
            if (!confirm('Unsaved changes — save before closing?')) { overlay.remove(); return; }
            await _doSave();
        }
        overlay.remove();
    });

    overlay.querySelector('#se-detach')?.addEventListener('click', () => {
        if (obj) {
            obj.scriptName = null;
            _logConsole(`✂️ Script detached from "${obj.label}"`, '#facc15');
            import('./engine.ui.js').then(m => m.syncPixiToInspector());
        }
        overlay.remove();
    });

    // Ctrl+S / Cmd+S
    editor.commands.addCommand({
        name: 'save',
        bindKey: { win:'Ctrl-S', mac:'Command-S' },
        exec: _doSave,
    });

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
                <button id="sn-cancel" style="${_bs('#111218','#888','#1e2030')}">Cancel</button>
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
                <button id="sn-close" style="${_bs('#111218','#aaa','#1e2030')}">Close</button>
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
                style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:4px;cursor:default;margin:2px 0;background:${attached ? 'rgba(58,114,165,.15)' : 'transparent'};">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;flex-shrink:0;fill:none;stroke:${attached ? '#7cb9f0':'#444'};stroke-width:2;">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                <div style="flex:1;min-width:0;">
                    <div style="color:${attached ? '#7cb9f0':'#ccc'};font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${s.name}${attached ? ' <span style="color:#4ade80;font-size:10px;font-weight:400;">● attached</span>' : ''}
                    </div>
                    <div style="color:#404050;font-size:10px;">${ts}</div>
                </div>
                <button class="sl-edit"   data-name="${s.name}" style="${_bs('#0d200d','#8f8','#1e3a1e','3px')}font-size:10px;padding:3px 8px;">Edit</button>
                <button class="sl-attach" data-name="${s.name}" style="${_bs('#0f2540','#7cb9f0','#1e4a7a','3px')}font-size:10px;padding:3px 8px;">${attached ? '✓' : 'Attach'}</button>
            </div>
        `;
    }).join('');

    modal.innerHTML = `
        <div style="padding:18px;min-width:360px;max-height:72vh;display:flex;flex-direction:column;">
            <div style="color:#e0e0e0;font-weight:700;font-size:14px;margin-bottom:3px;">Load Script</div>
            <div style="color:#555;font-size:11px;margin-bottom:10px;">Attach a script to <span style="color:#9bc;">${obj.label}</span></div>
            <div style="flex:1;overflow-y:auto;min-height:0;">${rows}</div>
            ${obj.scriptName ? `
            <div style="margin-top:10px;padding-top:8px;border-top:1px solid #1a1a28;display:flex;justify-content:space-between;align-items:center;">
                <span style="color:#444;font-size:11px;">Attached: <span style="color:#9bc;">${obj.scriptName}</span></span>
                <button id="sl-detach" style="${_bs('#1c0a0a','#f87171','#3a1818','3px')}font-size:10px;padding:3px 10px;">Detach</button>
            </div>` : ''}
            <button id="sl-cancel" style="margin-top:10px;${_bs('#111218','#888','#1e2030')}width:100%;text-align:center;">Cancel</button>
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
    return `background:${bg};color:${color};border:1px solid ${border};border-radius:${radius};padding:5px 12px;cursor:pointer;font-family:inherit;`;
}

function _modal() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#0f1118;border:1px solid #1e2030;border-radius:8px;box-shadow:0 24px 64px rgba(0,0,0,.9);font-family:system-ui,sans-serif;';
    wrap.appendChild(box);
    Object.defineProperty(wrap,'innerHTML',{get:()=>box.innerHTML,set:v=>{box.innerHTML=v;}});
    wrap.querySelector    = s => box.querySelector(s);
    wrap.querySelectorAll = s => box.querySelectorAll(s);
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
    return wrap;
}

function _sidebarHTML() {
    const G = [
        ['Events',    ['onStart(fn)','onUpdate(fn)','onStop(fn)','onCollision(fn)']],
        ['Position',  ['getX() / setX(v)','getY() / setY(v)','translate(dx,dy)','moveTo(x,y)','lookAt(tx,ty)']],
        ['Rotation',  ['getRotation()','setRotation(deg)']],
        ['Scale',     ['getScaleX/Y()','setScaleX/Y(v)']],
        ['Display',   ['getVisible()/setVisible(v)','getAlpha()/setAlpha(v)']],
        ['Input',     ['input.isKeyDown("w")','input.isKeyJustDown("Space")','input.mouseX / mouseY','input.mouseDown']],
        ['Animation', ['playAnimation("name")','stopAnimation()','currentAnimation()']],
        ['Physics',   ['physics.setVelocity(vx,vy)','physics.applyForce(fx,fy)','physics.applyImpulse(ix,iy)','physics.velX / velY']],
        ['Scene',     ['find("label") → obj','getTime() → seconds']],
        ['Math',      ['lerp / clamp / dist','rand / randInt','sin / cos / abs','sqrt / pow / atan2','PI / floor / ceil / round']],
        ['Debug',     ['log(...args)','warn(...args)']],
    ];
    return `<style>
        .se-g { padding:5px 0 2px; border-top:1px solid #12141e; }
        .se-g:first-child { border-top:none; }
        .se-gt { padding:3px 10px; color:#2a5a8a; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.8px; }
        .se-gi { padding:1px 10px; color:#3a4a5a; font-size:10px; line-height:1.65; font-family:monospace; }
    </style>` + G.map(([t,items]) => `
        <div class="se-g">
            <div class="se-gt">${t}</div>
            ${items.map(i=>`<div class="se-gi">${i}</div>`).join('')}
        </div>
    `).join('');
}

function _defaultScript(name) {
    return `// Script: ${name}
// Runs only in Play Mode — edit mode is always safe.

onStart(() => {
  // Called once when Play is pressed
  log("${name} started!");
});

onUpdate((dt) => {
  // dt = seconds since last frame

  // Example: move with WASD
  const speed = 3;
  if (input.isKeyDown("w") || input.isKeyDown("arrowup"))    translate(0,  speed * dt);
  if (input.isKeyDown("s") || input.isKeyDown("arrowdown"))  translate(0, -speed * dt);
  if (input.isKeyDown("a") || input.isKeyDown("arrowleft"))  translate(-speed * dt, 0);
  if (input.isKeyDown("d") || input.isKeyDown("arrowright")) translate( speed * dt, 0);
});

onStop(() => {
  // Called when Play is stopped
});

onCollision((other) => {
  if (other) log("Collided with: " + other.name);
});
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
