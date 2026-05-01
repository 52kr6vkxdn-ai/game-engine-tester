/* ============================================================
   Zengine — engine.ui.js
   Inspector, hierarchy, asset panel, menus, resize handles.
   ============================================================ */

import { state, PIXELS_PER_UNIT } from './engine.state.js';

let els = null;

// ── Cache DOM ──────────────────────────────────────────────────
export function cacheInspectorElements() {
    els = {
        px: document.getElementById('inp-pos-x'),
        py: document.getElementById('inp-pos-y'),
        pz: document.getElementById('inp-pos-z'),
        rz: document.getElementById('inp-rot-z'),
        sx: document.getElementById('inp-scale-x'),
        sy: document.getElementById('inp-scale-y'),
        color:     document.getElementById('inp-color'),
        gizmoMode: document.getElementById('select-gizmo-mode'),
        objName:   document.getElementById('inp-obj-name'),
        btns: {
            t: document.getElementById('btn-tool-translate'),
            r: document.getElementById('btn-tool-rotate'),
            s: document.getElementById('btn-tool-scale'),
            a: document.getElementById('btn-tool-all'),
        },
    };
}

// ── Show/hide inspector sections ──────────────────────────────
function _showSections(flags) {
    const ids = {
        transform: 'inspector-transform-section',
        sprite:    'inspector-sprite-section',
        anim:      'inspector-anim-section',
        prefab:    'inspector-prefab-section',
        light:     'light-inspector-mount',
        scene:     'inspector-scene-settings',
    };
    for (const [key, id] of Object.entries(ids)) {
        const el = document.getElementById(id);
        if (el) el.style.display = (flags[key] ?? false) ? '' : 'none';
    }
    // Also reset rot/scale rows
    const rotRow   = document.getElementById('transform-rot-row');
    const scaleRow = document.getElementById('transform-scale-row');
    if (rotRow)   rotRow.style.display   = (flags.rotRow   ?? true) ? '' : 'none';
    if (scaleRow) scaleRow.style.display = (flags.scaleRow ?? true) ? '' : 'none';
}

// ── PIXI → Inspector ──────────────────────────────────────────
export function syncPixiToInspector() {
    if (!els) return;
    const go = state.gameObject;

    // ── No selection → Scene Settings ────────────────────
    if (!go) {
        _showSections({ scene: true });
        if (els.objName) { els.objName.value = ''; els.objName.placeholder = 'Scene Settings'; }
        syncSceneSettingsToUI();
        return;
    }

    // Hide scene settings
    _showSections({ transform: false, sprite: false, anim: false, light: false, scene: false });

    if (els.objName) els.objName.value = go.label || '';
    els.px.value = (go.x  /  PIXELS_PER_UNIT).toFixed(2);
    els.py.value = (-go.y /  PIXELS_PER_UNIT).toFixed(2);
    els.pz.value = (go.unityZ || 0).toFixed(2);

    // ── AudioSource ───────────────────────────────────────
    if (go.isAudioSource) {
        _showSections({ transform: true, rotRow: false, scaleRow: false });
        const mount = document.getElementById('light-inspector-mount');
        if (mount) {
            mount.style.display = '';
            import('./engine.audio.js').then(m => {
                mount.innerHTML = m.buildAudioSourceInspectorHTML(go);
                m.bindAudioSourceInspector(go);
            });
        }
        return;
    }

    // ── Light ─────────────────────────────────────────────
    if (go.isLight) {
        _showSections({ transform: true, rotRow: false, scaleRow: false });
        const mount = document.getElementById('light-inspector-mount');
        if (mount) {
            mount.style.display = '';
            import('./engine.lights.js').then(m => {
                mount.innerHTML = m.buildLightInspectorHTML(go);
                m.bindLightInspector(go);
            });
        }
        return;
    }

    // ── Tilemap ───────────────────────────────────────────
    if (go.isTilemap) {
        _showSections({ transform: true, rotRow: false, scaleRow: false });
        const mount = document.getElementById('light-inspector-mount');
        if (mount) {
            mount.style.display = '';
            import('./engine.tilemap.js').then(m => {
                mount.innerHTML = m.buildTilemapInspectorHTML(go);
                document.getElementById('btn-open-tilemap-editor')?.addEventListener('click', () => m.openTilemapEditor(go));
            });
        }
        return;
    }

    // ── AutoTilemap ───────────────────────────────────────
    if (go.isAutoTilemap) {
        _showSections({ transform: true, rotRow: false, scaleRow: false });
        const mount = document.getElementById('light-inspector-mount');
        if (mount) {
            mount.style.display = '';
            import('./engine.autotile.js').then(m => {
                mount.innerHTML = m.buildAutoTileInspectorHTML(go);
                document.getElementById('btn-open-autotile-editor')?.addEventListener('click', () => m.openAutoTileEditor(go));
            });
        }
        return;
    }

    // ── Regular sprite ────────────────────────────────────
    _showSections({ transform: true, sprite: true, anim: true, light: true });
    const mount = document.getElementById('light-inspector-mount');
    if (mount) {
        mount.style.display = '';
        import('./engine.physics.js').then(m => {
            mount.innerHTML = m.buildPhysicsInspectorHTML(go);
            m.bindPhysicsInspector(go);
        });
    }

    let deg = (go.rotation * 180 / Math.PI) % 360;
    if (deg < 0) deg += 360;
    els.rz.value = (-deg).toFixed(1);
    els.sx.value = go.scale.x.toFixed(2);
    els.sy.value = go.scale.y.toFixed(2);

    if (els.color && go.spriteGraphic !== undefined) {
        let tint = go.spriteGraphic?.tint;
        if (typeof tint === 'number') {
            const hex = '#' + (tint & 0xFFFFFF).toString(16).padStart(6, '0');
            els.color.value = hex;
        } else {
            els.color.value = '#ffffff';
        }
    }

    const animSummary = document.getElementById('inspector-anim-summary');
    if (animSummary) {
        const anims = go.animations;
        if (anims?.length) {
            const totalFrames = anims.reduce((s, a) => s + (a.frames?.length || 0), 0);
            animSummary.style.color = '#8f8';
            animSummary.textContent = `${anims.length} clip${anims.length > 1 ? 's' : ''} · ${totalFrames} frame${totalFrames !== 1 ? 's' : ''}`;
        } else {
            animSummary.style.color = '#555';
            animSummary.textContent = 'No animations';
        }
    }

    const pfSection = document.getElementById('inspector-prefab-section');
    if (pfSection) {
        if (go.prefabId) {
            const prefab = state.prefabs.find(p => p.id === go.prefabId);
            pfSection.style.display = '';
            const nameEl = document.getElementById('inspector-prefab-name');
            if (nameEl) nameEl.textContent = prefab ? prefab.name : 'Unknown Prefab';
        } else {
            pfSection.style.display = 'none';
        }
    }
}

// ── Inspector → PIXI ─────────────────────────────────────────
export function syncInspectorToPixi() {
    if (!els) return;
    const go = state.gameObject;
    if (!go) return;

    go.x      = (parseFloat(els.px.value) || 0) *  PIXELS_PER_UNIT;
    go.y      = (parseFloat(els.py.value) || 0) * -PIXELS_PER_UNIT;
    const newZ = parseFloat(els.pz.value) || 0;
    const zChanged = newZ !== (go.unityZ || 0);
    go.unityZ = newZ;

    if (!go.isLight && !go.isTilemap && !go.isAutoTilemap && !go.isAudioSource) {
        const newRot = (parseFloat(els.rz?.value) || 0) * -Math.PI / 180;
        const newSX  = parseFloat(els.sx?.value) || 1;
        const newSY  = parseFloat(els.sy?.value) || 1;
        go.rotation  = newRot;
        go.scale.x   = newSX;
        go.scale.y   = newSY;
    }

    if (go.isAudioSource) {
        import('./engine.audio.js').then(m => m._drawRangeCircle?.(go));
    }

    if (zChanged) import('./engine.objects.js').then(m => m.sortByZ());

    import('./engine.playmode.js').then(m => m.updateCameraBoundsIfVisible?.());
}

// ── Scene Settings → UI ───────────────────────────────────────
export function syncSceneSettingsToUI() {
    const el = document.getElementById('inspector-scene-settings');
    if (!el) return;
    const s = state.sceneSettings;
    const bgHex = '#' + (s.bgColor & 0xFFFFFF).toString(16).padStart(6, '0');

    el.innerHTML = `
    <div class="component-block" style="border-left:3px solid #555;">
        <div class="component-header" style="background:#1a1a20;">
            <svg viewBox="0 0 24 24" class="comp-icon"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
            <span style="color:#ccd;font-weight:600;">Scene Settings</span>
        </div>
        <div class="component-body">
            <div class="prop-row">
                <span class="prop-label">Background</span>
                <input type="color" id="scene-bg-color" value="${bgHex}" style="width:48px;height:22px;border:none;border-radius:3px;cursor:pointer;background:none;">
            </div>
            <div class="prop-row">
                <span class="prop-label">Width</span>
                <input type="number" id="scene-width" value="${s.width}" min="100" max="7680" step="1"
                       style="flex:1;background:#16161e;border:1px solid #2a3a48;color:#fff;border-radius:3px;padding:2px 6px;font-size:11px;">
                <span style="color:#555;font-size:10px;margin-left:4px;">px</span>
            </div>
            <div class="prop-row">
                <span class="prop-label">Height</span>
                <input type="number" id="scene-height" value="${s.height}" min="100" max="4320" step="1"
                       style="flex:1;background:#16161e;border:1px solid #2a3a48;color:#fff;border-radius:3px;padding:2px 6px;font-size:11px;">
                <span style="color:#555;font-size:10px;margin-left:4px;">px</span>
            </div>
            <div class="prop-row">
                <span class="prop-label" style="white-space:nowrap;">Camera Mode</span>
                <select id="scene-camera-mode" style="flex:1;background:#16161e;border:1px solid #2a3a48;color:#ccc;border-radius:3px;padding:2px 4px;font-size:11px;">
                    <option value="landscape" ${s.cameraMode==='landscape'?'selected':''}>Landscape (Desktop)</option>
                    <option value="portrait"  ${s.cameraMode==='portrait' ?'selected':''}>Portrait (Mobile)</option>
                    <option value="adaptive"  ${s.cameraMode==='adaptive' ?'selected':''}>Adaptive (Auto-rotate)</option>
                    <option value="auto"      ${s.cameraMode==='auto'     ?'selected':''}>Fill Screen (No bars)</option>
                </select>
            </div>
            <div id="scene-camera-mode-hint" style="font-size:10px;color:#666;padding:4px 0 2px 0;line-height:1.5;"></div>
            <div class="prop-row" style="margin-top:6px;">
                <span class="prop-label">Ratio</span>
                <span id="scene-ratio-display" style="color:#9bc;font-size:10px;font-family:monospace;"></span>
            </div>
            <div style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;">
                <button class="scene-preset-btn" data-w="1920" data-h="1080">1920×1080</button>
                <button class="scene-preset-btn" data-w="1280" data-h="720">1280×720</button>
                <button class="scene-preset-btn" data-w="1366" data-h="768">1366×768</button>
                <button class="scene-preset-btn" data-w="1080" data-h="1920">1080×1920</button>
                <button class="scene-preset-btn" data-w="720"  data-h="1280">720×1280</button>
                <button class="scene-preset-btn" data-w="2560" data-h="1440">2560×1440</button>
            </div>
        </div>
    </div>`;

    _updateSceneModeHint();
    _updateSceneRatioDisplay();

    // Bind events
    document.getElementById('scene-bg-color')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value.replace('#',''), 16);
        state.sceneSettings.bgColor = val;
        if (state.app) state.app.renderer.background.color = val;
        import('./engine.history.js').then(({ pushUndoDebounced }) => pushUndoDebounced());
    });

    const wInput = document.getElementById('scene-width');
    const hInput = document.getElementById('scene-height');
    wInput?.addEventListener('input', () => {
        state.sceneSettings.width = parseInt(wInput.value) || 1280;
        _updateSceneRatioDisplay();
        import('./engine.renderer.js').then(m => m.drawGrid());
        import('./engine.history.js').then(({ pushUndoDebounced }) => pushUndoDebounced());
    });
    hInput?.addEventListener('input', () => {
        state.sceneSettings.height = parseInt(hInput.value) || 720;
        _updateSceneRatioDisplay();
        import('./engine.renderer.js').then(m => m.drawGrid());
        import('./engine.history.js').then(({ pushUndoDebounced }) => pushUndoDebounced());
    });

    document.getElementById('scene-camera-mode')?.addEventListener('change', (e) => {
        state.sceneSettings.cameraMode = e.target.value;
        _updateSceneModeHint();
        import('./engine.renderer.js').then(m => m.drawGrid());
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
    });

    el.querySelectorAll('.scene-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const w = parseInt(btn.dataset.w);
            const h = parseInt(btn.dataset.h);
            state.sceneSettings.width  = w;
            state.sceneSettings.height = h;
            const wEl = document.getElementById('scene-width');
            const hEl = document.getElementById('scene-height');
            if (wEl) wEl.value = w;
            if (hEl) hEl.value = h;
            // Auto-set mode based on orientation
            if (w >= h && state.sceneSettings.cameraMode === 'portrait') {
                state.sceneSettings.cameraMode = 'landscape';
                const mEl = document.getElementById('scene-camera-mode');
                if (mEl) mEl.value = 'landscape';
            } else if (h > w && state.sceneSettings.cameraMode === 'landscape') {
                state.sceneSettings.cameraMode = 'portrait';
                const mEl = document.getElementById('scene-camera-mode');
                if (mEl) mEl.value = 'portrait';
            }
            _updateSceneRatioDisplay();
            _updateSceneModeHint();
            import('./engine.renderer.js').then(m => m.drawGrid());
            import('./engine.history.js').then(({ pushUndo }) => pushUndo());
        });
    });
}

function _updateSceneModeHint() {
    const el = document.getElementById('scene-camera-mode-hint');
    if (!el) return;
    const hints = {
        landscape: 'Pillarboxes on tall screens. Ideal for desktop games.',
        portrait:  'Letterboxes on wide screens. Ideal for mobile portrait.',
        adaptive:  'Maintains ratio; auto-rotates content on mobile. No black bars when orientation matches.',
        auto:      'Always fills the screen — content may be cropped on mismatched screens.',
    };
    el.textContent = hints[state.sceneSettings.cameraMode] || '';
}

function _updateSceneRatioDisplay() {
    const el = document.getElementById('scene-ratio-display');
    if (!el) return;
    const w = state.sceneSettings.width;
    const h = state.sceneSettings.height;
    const g = _gcd(w, h);
    el.textContent = `${w/g}:${h/g}  (${w}×${h})`;
}

function _gcd(a, b) { return b === 0 ? a : _gcd(b, a % b); }

// ── Instant prefab field propagation ─────────────────────────
function _propagatePrefabField(sourceObj, field, value) {
    if (!sourceObj?.prefabId) return;
    if (field !== 'tint') return;
    const prefabId = sourceObj.prefabId;
    const prefab = (state.prefabs || []).find(p => p.id === prefabId);
    if (prefab) prefab.tint = value;
    for (const obj of state.gameObjects) {
        if (obj === sourceObj || obj.prefabId !== prefabId) continue;
        if (obj.spriteGraphic?.tint !== undefined) obj.spriteGraphic.tint = value;
    }
    for (const scene of (state.scenes || [])) {
        if (!scene.snapshot?.objects) continue;
        for (const s of scene.snapshot.objects) {
            if (s.prefabId !== prefabId) continue;
            s.tint = value;
        }
    }
}

// ── Inspector Listeners ───────────────────────────────────────
export function initInspectorListeners() {
    if (!els) return;

    // Debounced undo: push undo 400ms after last number input change
    ['px','py','pz','rz','sx','sy'].forEach(k => {
        if (!els[k]) return;
        // Push an immediate snapshot BEFORE the first change in a series
        els[k].addEventListener('focus', () => {
            import('./engine.history.js').then(({ pushUndo }) => pushUndo());
        });
        els[k].addEventListener('input', () => {
            syncInspectorToPixi();
            import('./engine.history.js').then(({ pushUndoDebounced }) => pushUndoDebounced());
        });
    });

    els.color?.addEventListener('input', (e) => {
        const go = state.gameObject;
        if (!go) return;
        const hexStr  = e.target.value.replace('#', '');
        const tintVal = parseInt(hexStr, 16);
        const sp = go.spriteGraphic;
        if (sp && sp.tint !== undefined) sp.tint = tintVal;
        _propagatePrefabField(go, 'tint', tintVal);
        import('./engine.history.js').then(({ pushUndoDebounced }) => pushUndoDebounced());
    });

    els.gizmoMode?.addEventListener('change', (e) => setGizmoMode(e.target.value));

    els.btns.t?.addEventListener('click', () => setGizmoMode('translate'));
    els.btns.r?.addEventListener('click', () => setGizmoMode('rotate'));
    els.btns.s?.addEventListener('click', () => setGizmoMode('scale'));
    els.btns.a?.addEventListener('click', () => setGizmoMode('all'));

    if (els.objName) {
        els.objName.addEventListener('change', (e) => {
            if (!state.gameObject) return;
            const newName = e.target.value.trim() || state.gameObject.label;
            const conflict = state.gameObjects.find(o => o !== state.gameObject && o.label === newName);
            if (conflict) {
                let i = 2;
                while (state.gameObjects.find(o => o !== state.gameObject && o.label === `${newName} (${i})`)) i++;
                state.gameObject.label = `${newName} (${i})`;
            } else {
                state.gameObject.label = newName;
            }
            els.objName.value = state.gameObject.label;
            refreshHierarchy();
            import('./engine.history.js').then(({ pushUndo }) => pushUndo());
        });
    }
}

// ── Gizmo Mode ────────────────────────────────────────────────
export function setGizmoMode(mode) {
    state.gizmoMode = mode;

    for (const obj of state.gameObjects) {
        if (!obj._grpTranslate) continue;
        const isSelected = obj === state.gameObject;
        if (!isSelected) {
            obj._grpTranslate.visible = false;
            obj._grpRotate.visible    = false;
            obj._grpScale.visible     = false;
        } else if (obj.isLight || obj.isAudioSource) {
            obj._grpTranslate.visible = true;
            obj._grpRotate.visible    = false;
            obj._grpScale.visible     = false;
        } else {
            obj._grpTranslate.visible = mode === 'translate' || mode === 'all';
            obj._grpRotate.visible    = mode === 'rotate'    || mode === 'all';
            obj._grpScale.visible     = mode === 'scale'     || mode === 'all';
        }
    }

    if (!els) return;
    if (els.gizmoMode) els.gizmoMode.value = mode;
    if (els.btns.t) els.btns.t.className = `tool-btn${mode === 'translate' ? ' active' : ''}`;
    if (els.btns.r) els.btns.r.className = `tool-btn${mode === 'rotate'    ? ' active' : ''}`;
    if (els.btns.s) els.btns.s.className = `tool-btn${mode === 'scale'     ? ' active' : ''}`;
    if (els.btns.a) els.btns.a.className = `tool-btn${mode === 'all'       ? ' active' : ''}`;
}

// ── Hierarchy Panel ───────────────────────────────────────────
export function refreshHierarchy() {
    const list = document.getElementById('hierarchy-list');
    if (!list) return;

    list.innerHTML = '';

    for (const obj of state.gameObjects) {
        const item = document.createElement('div');
        item.className = 'tree-item' + (obj === state.gameObject ? ' selected' : '');
        item.dataset.objId = state.gameObjects.indexOf(obj);
        item.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding: 3px 8px; cursor:pointer;';

        const nameEl = document.createElement('span');
        nameEl.className = 'tree-item-name';
        nameEl.textContent = obj.label || 'Object';
        nameEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const inp = document.createElement('input');
            inp.type  = 'text';
            inp.value = obj.label || '';
            inp.style.cssText = 'background:#16161e;border:1px solid #3A72A5;color:#fff;font-size:11px;padding:0 4px;width:100%;border-radius:3px;outline:none;';
            nameEl.replaceWith(inp);
            inp.focus(); inp.select();
            const commit = () => {
                const newName = inp.value.trim() || obj.label;
                const conflict = state.gameObjects.find(o => o !== obj && o.label === newName);
                if (conflict) {
                    let i = 2;
                    while (state.gameObjects.find(o => o !== obj && o.label === `${newName} (${i})`)) i++;
                    obj.label = `${newName} (${i})`;
                } else {
                    obj.label = newName;
                }
                refreshHierarchy();
                if (obj === state.gameObject && els?.objName) els.objName.value = obj.label;
                import('./engine.history.js').then(({ pushUndo }) => pushUndo());
            };
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') inp.blur(); ev.stopPropagation(); });
        });

        const left = document.createElement('div');
        left.className = 'tree-item-left';

        // Icon per type
        if (obj.isAudioSource) {
            const span = document.createElement('span');
            span.style.cssText = 'font-size:12px;flex-shrink:0;';
            span.textContent = '🔊';
            left.appendChild(span);
        } else if (obj.isLight) {
            const iconMap = { point:'💡', spot:'🔦', directional:'☀️', area:'▭' };
            const span = document.createElement('span');
            span.style.cssText = 'font-size:12px;flex-shrink:0;';
            span.textContent = iconMap[obj.lightType] || '💡';
            left.appendChild(span);
        } else if (obj.isTilemap) {
            const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
            icon.setAttribute('viewBox','0 0 24 24');
            icon.style.cssText='width:14px;height:14px;fill:none;stroke:#4ade80;stroke-width:2;flex-shrink:0;';
            icon.innerHTML='<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>';
            left.appendChild(icon);
        } else if (obj.isAutoTilemap) {
            const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
            icon.setAttribute('viewBox','0 0 24 24');
            icon.style.cssText='width:14px;height:14px;fill:none;stroke:#4ade80;stroke-width:2;flex-shrink:0;';
            icon.innerHTML='<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/><circle cx="12" cy="12" r="2" fill="#4ade80" stroke="none"/>';
            left.appendChild(icon);
        } else {
            const idleAnim  = obj.animations?.find(a => a.isIdle) || obj.animations?.[obj.activeAnimIndex || 0];
            const idleFrame = idleAnim?.frames?.[0]?.dataURL;
            if (idleFrame) {
                const thumb = document.createElement('img');
                thumb.src = idleFrame;
                thumb.style.cssText = 'width:15px;height:15px;object-fit:contain;flex-shrink:0;border-radius:2px;background:#111;';
                left.appendChild(thumb);
            } else {
                const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
                icon.setAttribute('viewBox','0 0 24 24');
                icon.style.cssText='width:13px;height:13px;fill:none;stroke:#666;stroke-width:2;flex-shrink:0;';
                icon.innerHTML='<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="#666"/><path d="M21 15l-5-5L5 21"/>';
                left.appendChild(icon);
            }
        }
        left.appendChild(nameEl);

        // Badges
        if (obj.isAudioSource) {
            const badge = document.createElement('span');
            badge.className = 'tree-item-light-badge';
            badge.style.cssText = 'background:rgba(58,114,165,0.15);color:#9bc;border-color:rgba(58,114,165,0.4);';
            badge.textContent = 'audio';
            left.appendChild(badge);
        }
        if (obj.isLight) {
            const badge = document.createElement('span');
            badge.className = 'tree-item-light-badge';
            badge.textContent = obj.lightType;
            left.appendChild(badge);
        }
        if (obj.isTilemap) {
            const badge = document.createElement('span');
            badge.className = 'tree-item-light-badge';
            badge.style.background = 'rgba(74,222,128,0.12)';
            badge.style.color = '#4ade80';
            badge.style.borderColor = 'rgba(74,222,128,0.3)';
            badge.textContent = `${obj.tilemapData.cols}×${obj.tilemapData.rows}`;
            left.appendChild(badge);
        }
        if (obj.isAutoTilemap) {
            const badge = document.createElement('span');
            badge.className = 'tree-item-light-badge';
            badge.style.background = 'rgba(74,222,128,0.12)';
            badge.style.color = '#4ade80';
            badge.style.borderColor = 'rgba(74,222,128,0.3)';
            badge.textContent = `auto ${obj.autoTileData.cols}×${obj.autoTileData.rows}`;
            left.appendChild(badge);
        }
        item.appendChild(left);

        // Z-order buttons (not for audio sources)
        if (!obj.isAudioSource) {
            const zBtns = document.createElement('div');
            zBtns.style.cssText = 'display:flex;gap:2px;flex-shrink:0;';
            const upBtn = _makeZBtn('↑', () => import('./engine.objects.js').then(m => m.moveObjectUp(obj)));
            const dnBtn = _makeZBtn('↓', () => import('./engine.objects.js').then(m => m.moveObjectDown(obj)));
            zBtns.appendChild(upBtn); zBtns.appendChild(dnBtn);
            item.appendChild(zBtns);
        }

        item.addEventListener('click', () => import('./engine.objects.js').then(m => m.selectObject(obj)));
        if (!obj.isLight && !obj.isAudioSource) {
            item.addEventListener('dblclick', () => {
                import('./engine.objects.js').then(m => m.selectObject(obj));
                import('./engine.animator.js').then(m => m.openAnimationEditor(obj));
            });
        }

        list.appendChild(item);
    }

    if (state.gameObjects.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#505060;font-size:11px;padding:16px;text-align:center;font-style:italic;';
        empty.textContent = 'Empty scene';
        list.appendChild(empty);
    }
}

function _makeZBtn(label, cb) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = 'background:transparent;border:none;color:#505060;font-size:11px;padding:2px 3px;cursor:pointer;border-radius:2px;line-height:1;';
    btn.addEventListener('click', e => { e.stopPropagation(); cb(); });
    btn.addEventListener('mouseenter', () => btn.style.color = '#9bc');
    btn.addEventListener('mouseleave', () => btn.style.color = '#505060');
    return btn;
}

// ── Asset Panel ───────────────────────────────────────────────
let _assetFilter = 'all';

export function setAssetFilter(filter) {
    _assetFilter = filter;
    refreshAssetPanel();
}

export function refreshAssetPanel() {
    const grid = document.getElementById('asset-grid');
    if (!grid) return;

    grid.innerHTML = '';

    const filtered = state.assets.filter(a => {
        if (_assetFilter === 'sprite') return a.type !== 'audio';
        if (_assetFilter === 'audio')  return a.type === 'audio';
        return true;
    });

    for (const asset of filtered) {
        const item = document.createElement('div');
        item.className = 'asset-item';
        item.draggable = true;
        item.dataset.assetId = asset.id;

        const thumb = document.createElement('div');
        thumb.className = 'asset-thumb';
        if (asset.type === 'audio') {
            thumb.innerHTML = '<svg viewBox="0 0 24 24" style="width:28px;height:28px;fill:none;stroke:#3A72A5;stroke-width:1.5;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
        } else {
            const img = document.createElement('img');
            img.src = asset.dataURL;
            thumb.appendChild(img);
        }
        item.appendChild(thumb);

        const name = document.createElement('div');
        name.className = 'asset-name';
        name.textContent = asset.name.length > 11 ? asset.name.slice(0, 10) + '…' : asset.name;
        name.title = asset.name;
        item.appendChild(name);

        item.addEventListener('dragstart', e => {
            e.dataTransfer.setData('assetId', asset.id);
            e.dataTransfer.effectAllowed = 'copy';
        });

        grid.appendChild(item);
    }

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#505060;font-size:11px;padding:16px;font-style:italic;text-align:center;width:100%;';
        empty.textContent = _assetFilter === 'audio' ? 'No audio imported — drag .mp3 .wav .ogg here or use Import' : 'Import assets to get started';
        grid.appendChild(empty);
    }
}

// ── Prefab Panel ──────────────────────────────────────────────
export function refreshPrefabPanel() {
    import('./engine.prefabs.js').then(m => m.refreshPrefabPanel());
}

// ── Drop onto scene canvas ────────────────────────────────────
export function initSceneDrop() {
    const container = document.getElementById('pixi-container');
    if (!container) return;

    container.addEventListener('dragenter', (e) => {
        if (e.dataTransfer.types.length) {
            container.style.outline = '2px dashed #3A72A5';
            container.style.outlineOffset = '-2px';
        }
    });
    container.addEventListener('dragleave', (e) => {
        if (!container.contains(e.relatedTarget)) {
            container.style.outline = '';
            container.style.outlineOffset = '';
        }
    });
    container.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });

    container.addEventListener('drop', (e) => {
        e.preventDefault();
        container.style.outline = '';
        container.style.outlineOffset = '';

        const rect   = container.getBoundingClientRect();
        const px     = e.clientX - rect.left;
        const py     = e.clientY - rect.top;
        const global = new PIXI.Point(px, py);
        const local  = state.sceneContainer.toLocal(global);

        // ── Prefab drop ──────────────────────────────────
        const prefabId = e.dataTransfer.getData('prefabId');
        if (prefabId) {
            const prefab = state.prefabs.find(p => p.id === prefabId);
            if (prefab && state.app) {
                import('./engine.history.js').then(({ pushUndo }) => pushUndo());
                import('./engine.prefabs.js').then(m => m.instantiatePrefab(prefab, local.x, local.y));
            }
            return;
        }

        // ── Asset drop ────────────────────────────────────
        const assetId = e.dataTransfer.getData('assetId');
        if (!assetId) return;
        const asset = state.assets.find(a => a.id === assetId);
        if (!asset || !state.app) return;

        if (asset.type === 'audio') {
            // Create a 3D audio source in the scene
            import('./engine.history.js').then(({ pushUndo }) => pushUndo());
            import('./engine.audio.js').then(m => m.createAudioSource(asset.id, local.x, local.y));
            return;
        }

        // Image drop
        import('./engine.objects.js').then(m => {
            const obj = m.createImageObject(asset, local.x, local.y);
            if (obj && state._bindGizmoHandles) state._bindGizmoHandles(obj);
        });
    });
}
