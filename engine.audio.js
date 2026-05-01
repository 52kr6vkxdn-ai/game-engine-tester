/* ============================================================
   Zengine — engine.audio.js
   3D Spatial Audio Sources placed in the scene.
   - Drag audio asset from panel → scene → creates AudioSource
   - Shows range circle gizmo in editor
   - Inspector: volume, loop, range, falloff
   - Play mode: Web Audio PannerNode, positioned relative to camera
   ============================================================ */

import { state } from './engine.state.js';

// ── Web Audio context (shared) ────────────────────────────────
let _audioCtx = null;
function _getCtx() {
    if (!_audioCtx || _audioCtx.state === 'closed') {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    return _audioCtx;
}

// ── Play-mode audio nodes ─────────────────────────────────────
let _playNodes = [];   // { source, panner, obj }

// ── Decoded audio buffer cache ────────────────────────────────
const _bufferCache = new Map();  // assetId → AudioBuffer

async function _decodeAsset(asset) {
    if (_bufferCache.has(asset.id)) return _bufferCache.get(asset.id);
    const ctx = _getCtx();
    const b64 = asset.dataURL.split(',')[1];
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    try {
        const decoded = await ctx.decodeAudioData(buf);
        _bufferCache.set(asset.id, decoded);
        return decoded;
    } catch (e) {
        console.warn('Audio decode error:', e);
        return null;
    }
}

// ── Create an AudioSource object in the scene ─────────────────
export function createAudioSource(assetIdOrObj, x, y, audioProps, label) {
    const assetId = typeof assetIdOrObj === 'string' ? assetIdOrObj : assetIdOrObj?.id;
    const asset   = state.assets.find(a => a.id === assetId);

    const container = new PIXI.Container();
    container.x = x || 0;
    container.y = y || 0;
    container.isAudioSource = true;
    container.assetId  = assetId;
    container.unityZ   = 0;

    // Default audio properties
    container.audioProps = Object.assign({
        volume:  1.0,
        loop:    true,
        range:   300,       // pixels (3 units)
        falloff: 'linear',  // 'linear' | 'inverse' | 'exponential'
        autoPlay: true,
        muted:   false,
    }, audioProps || {});

    // Auto-name
    const baseName = asset ? asset.name.replace(/\.[^.]+$/, '') : 'AudioSource';
    let nameCandidate = baseName;
    let n = 2;
    while (state.gameObjects.find(o => o.label === nameCandidate)) nameCandidate = `${baseName} (${n++})`;
    container.label = label || nameCandidate;

    // Range circle in WORLD-SPACE (direct child, scales with camera zoom)
    const rangeCircle = new PIXI.Graphics();
    container._rangeCircle = rangeCircle;
    container.addChild(rangeCircle);
    _drawRangeCircle(container);

    // ── Gizmo container (constant screen size via ticker) ──
    const gizmoContainer = new PIXI.Container();
    container._gizmoContainer = gizmoContainer;
    container.addChild(gizmoContainer);

    // Audio icon
    const icon = new PIXI.Graphics();
    icon.beginFill(0x3A72A5, 0.9);
    icon.drawRoundedRect(-14, -14, 28, 28, 6);
    icon.endFill();
    icon.lineStyle(2, 0x7ab8e8, 1);
    icon.beginFill(0xffffff, 1);
    icon.drawPolygon([-5, -4, -5, 4, -2, 4, 3, 8, 3, -8, -2, -4]);
    icon.endFill();
    icon.lineStyle(1.5, 0x9bc8e8, 0.8);
    icon.arc(5, 0, 5, -0.7, 0.7);
    icon.lineStyle(1.5, 0x9bc8e8, 0.5);
    icon.arc(5, 0, 9, -0.9, 0.9);
    container._icon = icon;
    gizmoContainer.addChild(icon);

    // Name label
    const nameText = new PIXI.Text(container.label, {
        fontSize: 10, fill: 0x9bc8e8, fontFamily: 'monospace',
    });
    nameText.anchor.set(0.5, 0);
    nameText.y = 18;
    gizmoContainer.addChild(nameText);
    container._nameText = nameText;

    // ── Translate-only gizmo handles (same structure as lights) ─
    const grpTranslate = new PIXI.Container();
    const grpRotate    = new PIXI.Container(); grpRotate.visible = false;
    const grpScale     = new PIXI.Container(); grpScale.visible  = false;

    const transX = _makeGizmoLine(0xFF4F4B, false);
    const transY = _makeGizmoLine(0x8FC93A, true);
    const transC = _makeGizmoDot(0xFFFFFF);
    grpTranslate.addChild(transX, transY, transC);

    gizmoContainer.addChild(grpTranslate, grpRotate, grpScale);
    container._grpTranslate = grpTranslate;
    container._grpRotate    = grpRotate;
    container._grpScale     = grpScale;
    container._gizmoHandles = {
        transX, transY, transCenter: transC,
        scaleX: transX, scaleY: transY, scaleCenter: transC,
        rotRing: transC,
    };

    [transX, transY, transC].forEach(h => {
        h.on('pointerdown', e => e.stopPropagation());
    });

    // Make whole container selectable
    container.eventMode = 'static';
    container.cursor    = 'pointer';
    container.hitArea   = new PIXI.Circle(0, 0, 22);
    container.on('pointerdown', (e) => {
        if (state.isPlaying) { e.stopPropagation(); return; }
        if (e.button !== 0) return;
        import('./engine.objects.js').then(m => m.selectObject(container));
    });

    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);

    import('./engine.ui.js').then(m => {
        m.refreshHierarchy();
        m.syncPixiToInspector();
    });
    import('./engine.playmode.js').then(m => m.updateCameraBoundsIfVisible?.());

    if (state._bindGizmoHandles) state._bindGizmoHandles(container);

    return container;
}

// ── Draw range circle ─────────────────────────────────────────
export function _drawRangeCircle(obj) {
    const g = obj._rangeCircle;
    if (!g) return;
    g.clear();
    const r = obj.audioProps?.range ?? 300;
    g.lineStyle(1.5, 0x3A72A5, 0.35);
    g.drawCircle(0, 0, r);
    // Inner half-range ring
    g.lineStyle(1, 0x3A72A5, 0.15);
    g.drawCircle(0, 0, r * 0.5);
    // Tiny dot at center
    g.lineStyle(0);
    g.beginFill(0x3A72A5, 0.6);
    g.drawCircle(0, 0, 3);
    g.endFill();
}

// ── Build inspector HTML for an AudioSource ───────────────────
export function buildAudioSourceInspectorHTML(obj) {
    const p     = obj.audioProps;
    const asset = state.assets.find(a => a.id === obj.assetId);
    const name  = asset?.name || 'Unknown';
    return `
    <div class="component-block" style="border-left:3px solid #3A72A5;">
        <div class="component-header" style="background:#12202e;">
            <svg viewBox="0 0 24 24" class="comp-icon" style="color:#9bc;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            <span style="color:#9bc;font-weight:600;">Audio Source</span>
        </div>
        <div class="component-body" style="background:#0e1a24;">
            <div class="prop-row">
                <span class="prop-label" style="color:#7ab;">Clip</span>
                <span style="color:#9bc;font-size:10px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;" title="${name}">${name}</span>
            </div>
            <div class="prop-row">
                <span class="prop-label">Volume</span>
                <div style="display:flex;align-items:center;gap:6px;flex:1;">
                    <input type="range" id="as-volume" min="0" max="1" step="0.01" value="${p.volume}"
                           style="flex:1;accent-color:#3A72A5;">
                    <span id="as-volume-val" style="color:#fff;min-width:28px;font-size:10px;">${Math.round(p.volume*100)}%</span>
                </div>
            </div>
            <div class="prop-row">
                <span class="prop-label">Range</span>
                <div style="display:flex;align-items:center;gap:6px;flex:1;">
                    <input type="number" id="as-range" value="${p.range}" min="10" max="5000" step="10"
                           style="flex:1;background:#16161e;border:1px solid #2a3a48;color:#fff;border-radius:3px;padding:2px 6px;font-size:11px;">
                    <span style="color:#666;font-size:10px;">px</span>
                </div>
            </div>
            <div class="prop-row">
                <span class="prop-label">Falloff</span>
                <select id="as-falloff" style="flex:1;background:#16161e;border:1px solid #2a3a48;color:#ccc;border-radius:3px;padding:2px 4px;font-size:11px;">
                    <option value="linear" ${p.falloff==='linear'?'selected':''}>Linear</option>
                    <option value="inverse" ${p.falloff==='inverse'?'selected':''}>Inverse</option>
                    <option value="exponential" ${p.falloff==='exponential'?'selected':''}>Exponential</option>
                </select>
            </div>
            <div class="prop-row" style="gap:16px;">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" id="as-loop" ${p.loop?'checked':''} style="accent-color:#3A72A5;">
                    <span style="color:#ccc;font-size:11px;">Loop</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" id="as-autoplay" ${p.autoPlay?'checked':''} style="accent-color:#3A72A5;">
                    <span style="color:#ccc;font-size:11px;">Auto Play</span>
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" id="as-muted" ${p.muted?'checked':''} style="accent-color:#3A72A5;">
                    <span style="color:#ccc;font-size:11px;">Muted</span>
                </label>
            </div>
        </div>
    </div>`;
}

// ── Bind inspector events for AudioSource ─────────────────────
export function bindAudioSourceInspector(obj) {
    const vol   = document.getElementById('as-volume');
    const volV  = document.getElementById('as-volume-val');
    const range = document.getElementById('as-range');
    const fall  = document.getElementById('as-falloff');
    const loop  = document.getElementById('as-loop');
    const auto  = document.getElementById('as-autoplay');
    const muted = document.getElementById('as-muted');

    if (!vol) return;

    vol.addEventListener('input', () => {
        obj.audioProps.volume = parseFloat(vol.value);
        if (volV) volV.textContent = Math.round(obj.audioProps.volume * 100) + '%';
        import('./engine.history.js').then(({ pushUndoDebounced }) => pushUndoDebounced());
    });
    range.addEventListener('input', () => {
        obj.audioProps.range = parseFloat(range.value) || 300;
        _drawRangeCircle(obj);
        import('./engine.history.js').then(({ pushUndoDebounced }) => pushUndoDebounced());
    });
    fall.addEventListener('change', () => {
        obj.audioProps.falloff = fall.value;
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
    });
    loop.addEventListener('change', () => {
        obj.audioProps.loop = loop.checked;
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
    });
    auto.addEventListener('change', () => {
        obj.audioProps.autoPlay = auto.checked;
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
    });
    muted.addEventListener('change', () => {
        obj.audioProps.muted = muted.checked;
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
    });
}

// ── Start all audio sources in play mode ──────────────────────
export async function startPlayModeAudio() {
    stopPlayModeAudio();
    const ctx = _getCtx();

    for (const obj of state.gameObjects) {
        if (!obj.isAudioSource || obj.audioProps.muted) continue;
        const asset = state.assets.find(a => a.id === obj.assetId);
        if (!asset) continue;

        const buffer = await _decodeAsset(asset);
        if (!buffer) continue;

        // Create panner
        const panner = ctx.createPanner();
        panner.panningModel    = 'HRTF';
        panner.distanceModel   = obj.audioProps.falloff === 'inverse'      ? 'inverse'
                               : obj.audioProps.falloff === 'exponential'  ? 'exponential'
                               : 'linear';
        panner.refDistance     = 1;
        panner.maxDistance     = obj.audioProps.range;
        panner.rolloffFactor   = 1;

        const gainNode = ctx.createGain();
        gainNode.gain.value = obj.audioProps.volume;

        panner.connect(gainNode);
        gainNode.connect(ctx.destination);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop   = obj.audioProps.loop;
        source.connect(panner);
        source.start(0);

        _playNodes.push({ source, panner, gainNode, obj });
    }

    // Start update loop for positional audio
    _startPositionUpdater();
}

// ── Stop all play-mode audio ──────────────────────────────────
export function stopPlayModeAudio() {
    for (const node of _playNodes) {
        try { node.source.stop(); } catch (_) {}
    }
    _playNodes = [];
    _stopPositionUpdater();
}

// ── Positional updater ticker ─────────────────────────────────
let _posUpdateId = null;

function _startPositionUpdater() {
    _stopPositionUpdater();
    function update() {
        if (!state.isPlaying) { _stopPositionUpdater(); return; }
        const ctx = _audioCtx;
        if (!ctx) return;

        // Camera world position (origin of listener)
        const sc = state.sceneContainer;
        const camWorldX = -sc.x / sc.scale.x;
        const camWorldY = -sc.y / sc.scale.y;

        // Listener at origin
        if (ctx.listener.positionX) {
            ctx.listener.positionX.value = 0;
            ctx.listener.positionY.value = 0;
            ctx.listener.positionZ.value = 1;
        } else {
            ctx.listener.setPosition(0, 0, 1);
        }

        for (const node of _playNodes) {
            const obj = node.obj;
            // Position relative to camera, scaled by range
            const dx = (obj.x - camWorldX) / (obj.audioProps.range || 300);
            const dy = (obj.y - camWorldY) / (obj.audioProps.range || 300);
            const dz = 0;
            if (node.panner.positionX) {
                node.panner.positionX.value = dx;
                node.panner.positionY.value = -dy;
                node.panner.positionZ.value = dz + 0.5;
            } else {
                node.panner.setPosition(dx, -dy, dz + 0.5);
            }
            node.gainNode.gain.value = obj.audioProps.volume;
        }
        _posUpdateId = requestAnimationFrame(update);
    }
    _posUpdateId = requestAnimationFrame(update);
}

function _stopPositionUpdater() {
    if (_posUpdateId !== null) { cancelAnimationFrame(_posUpdateId); _posUpdateId = null; }
}

// ── Gizmo helper shapes ───────────────────────────────────────
function _makeGizmoLine(color, vertical) {
    const g = new PIXI.Graphics();
    g.lineStyle(2, color, 1);
    if (vertical) { g.moveTo(0, 0); g.lineTo(0, -40); }
    else           { g.moveTo(0, 0); g.lineTo( 40,  0); }
    g.endFill();
    // Arrow tip
    g.beginFill(color, 1);
    if (vertical) g.drawPolygon([-4,-36, 4,-36, 0,-44]);
    else          g.drawPolygon([36,-4, 36,4, 44,0]);
    g.endFill();
    g.eventMode = 'static';
    g.cursor    = vertical ? 'ns-resize' : 'ew-resize';
    g.hitArea   = vertical ? new PIXI.Rectangle(-6, -50, 12, 50)
                           : new PIXI.Rectangle(0, -6, 50, 12);
    return g;
}

function _makeGizmoDot(color) {
    const g = new PIXI.Graphics();
    g.beginFill(color, 0.8);
    g.lineStyle(1.5, 0x333, 0.5);
    g.drawRect(-6, -6, 12, 12);
    g.endFill();
    g.eventMode = 'static';
    g.cursor    = 'move';
    g.hitArea   = new PIXI.Rectangle(-8, -8, 16, 16);
    return g;
}

// ── Snapshot / restore helpers (used by project.js) ──────────
export function snapshotAudioSources() {
    return state.gameObjects
        .filter(o => o.isAudioSource)
        .map(o => ({
            isAudioSource: true,
            label:     o.label,
            assetId:   o.assetId,
            x: o.x, y: o.y, unityZ: o.unityZ || 0,
            audioProps: JSON.parse(JSON.stringify(o.audioProps)),
        }));
}
