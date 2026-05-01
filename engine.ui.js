/* ============================================================
   Zengine — engine.ui.js
   Inspector, hierarchy, asset panel, menus, resize handles.
   ============================================================ */

import { state, PIXELS_PER_UNIT } from './engine.state.js';

let els = null;

// Track currently selected audio source
let _selectedAudioSource = null;

// ── Cache DOM ─────────────────────────────────────────────────
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

// ── PIXI → Inspector ─────────────────────────────────────────
export function syncPixiToInspector() {
    if (!els) return;
    const go = state.gameObject;

    // Light section toggle
    const lightSection = document.getElementById('inspector-light-section');
    const spriteSection = document.getElementById('inspector-sprite-section');
    const animSection   = document.getElementById('inspector-anim-section');
    const pfSection     = document.getElementById('inspector-prefab-section');
    const transformSection = document.getElementById('inspector-transform-section');

    if (!go) {
        ['px','py','pz','rz','sx','sy'].forEach(k => { if(els[k]) els[k].value = ''; });
        if (els.objName) els.objName.value = '';
        if (pfSection)        pfSection.style.display        = 'none';
        if (lightSection)     lightSection.style.display     = 'none';
        if (spriteSection)    spriteSection.style.display    = 'none';
        if (animSection)      animSection.style.display      = 'none';
        if (transformSection) transformSection.style.display = 'none';
        const lightMount = document.getElementById('light-inspector-mount');
        if (lightMount) lightMount.innerHTML = '';
        // Show scene settings panel
        refreshSceneSettingsPanel();
        return;
    }

    // Deselect audio source when game object is selected
    if (_selectedAudioSource) {
        for (const s of state.audioSources) {
            if (s._container) s._container.alpha = 1.0;
        }
        _selectedAudioSource       = null;
        state._selectedAudioSource = null;
    }

    // Hide scene settings panel when object selected
    const scenePanel = document.getElementById('scene-settings-panel');
    if (scenePanel) scenePanel.style.display = 'none';
    if (transformSection) transformSection.style.display = '';

    if (els.objName) els.objName.value = go.label || '';
    els.px.value = (go.x  /  PIXELS_PER_UNIT).toFixed(2);
    els.py.value = (-go.y /  PIXELS_PER_UNIT).toFixed(2);
    els.pz.value = (go.unityZ || 0).toFixed(2);

    if (go.isLight) {
        // Hide transform rotation/scale rows for lights
        const rotRow   = document.getElementById('transform-rot-row');
        const scaleRow = document.getElementById('transform-scale-row');
        if (rotRow)   rotRow.style.display   = 'none';
        if (scaleRow) scaleRow.style.display = 'none';
        if (spriteSection) spriteSection.style.display = 'none';
        if (animSection)   animSection.style.display   = 'none';
        if (pfSection)     pfSection.style.display      = 'none';
        const lightMount = document.getElementById('light-inspector-mount');
        if (lightMount) {
            import('./engine.lights.js').then(m => {
                lightMount.innerHTML = m.buildLightInspectorHTML(go);
                m.bindLightInspector(go);
            });
        }
        return;
    }

    if (go.isTilemap) {
        const rotRow   = document.getElementById('transform-rot-row');
        const scaleRow = document.getElementById('transform-scale-row');
        if (rotRow)   rotRow.style.display   = 'none';
        if (scaleRow) scaleRow.style.display = 'none';
        if (spriteSection) spriteSection.style.display = 'none';
        if (animSection)   animSection.style.display   = 'none';
        if (pfSection)     pfSection.style.display      = 'none';
        const lightMount = document.getElementById('light-inspector-mount');
        if (lightMount) {
            import('./engine.tilemap.js').then(m => {
                lightMount.innerHTML = m.buildTilemapInspectorHTML(go);
                document.getElementById('btn-open-tilemap-editor')?.addEventListener('click', () => {
                    m.openTilemapEditor(go);
                });
            });
        }
        return;
    }

    if (go.isAutoTilemap) {
        const rotRow   = document.getElementById('transform-rot-row');
        const scaleRow = document.getElementById('transform-scale-row');
        if (rotRow)   rotRow.style.display   = 'none';
        if (scaleRow) scaleRow.style.display = 'none';
        if (spriteSection) spriteSection.style.display = 'none';
        if (animSection)   animSection.style.display   = 'none';
        if (pfSection)     pfSection.style.display      = 'none';
        const lightMount = document.getElementById('light-inspector-mount');
        if (lightMount) {
            import('./engine.autotile.js').then(m => {
                lightMount.innerHTML = m.buildAutoTileInspectorHTML(go);
                document.getElementById('btn-open-autotile-editor')?.addEventListener('click', () => {
                    m.openAutoTileEditor(go);
                });
            });
        }
        return;
    }

    // Regular sprite object
    const rotRow   = document.getElementById('transform-rot-row');
    const scaleRow = document.getElementById('transform-scale-row');
    if (rotRow)   rotRow.style.display   = '';
    if (scaleRow) scaleRow.style.display = '';
    if (spriteSection) spriteSection.style.display = '';
    if (animSection)   animSection.style.display   = '';
    const lightMount = document.getElementById('light-inspector-mount');
    if (lightMount) {
        // Inject physics inspector at bottom of lightMount
        import('./engine.physics.js').then(m => {
            lightMount.innerHTML = m.buildPhysicsInspectorHTML(go);
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

    // Position applies to both sprites and lights
    go.x      = (parseFloat(els.px.value) || 0) *  PIXELS_PER_UNIT;
    go.y      = (parseFloat(els.py.value) || 0) * -PIXELS_PER_UNIT;
    const newZ = parseFloat(els.pz.value) || 0;
    const zChanged = newZ !== (go.unityZ || 0);
    go.unityZ = newZ;

    // Rotation and scale only for sprites (not lights or tilemaps)
    if (!go.isLight && !go.isTilemap && !go.isAutoTilemap) {
        const newRot = (parseFloat(els.rz?.value) || 0) * -Math.PI / 180;
        const newSX  = parseFloat(els.sx?.value) || 1;
        const newSY  = parseFloat(els.sy?.value) || 1;
        go.rotation  = newRot;
        go.scale.x   = newSX;
        go.scale.y   = newSY;
    }

    if (zChanged) import('./engine.objects.js').then(m => m.sortByZ());
}

// ── Scene Settings Panel (shown when nothing selected) ────────
export function refreshSceneSettingsPanel() {
    let panel = document.getElementById('scene-settings-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'scene-settings-panel';
        // Insert before inspector footer
        const footer = document.querySelector('.inspector-footer');
        const inspector = document.getElementById('panel-inspector');
        if (footer) {
            inspector.insertBefore(panel, footer);
        } else if (inspector) {
            inspector.appendChild(panel);
        }
    }
    panel.style.display = '';

    const ss = state.sceneSettings;
    const bgHex = '#' + (ss.bgColor & 0xFFFFFF).toString(16).padStart(6, '0');

    const presetInfo = {
        'landscape-desktop': '16:9 · 1280×720 — Desktop/landscape screens',
        'landscape-both':    '16:9 · 1280×720 — Desktop + landscape Android',
        'portrait':          '9:16 · 720×1280 — Mobile portrait',
        'automatic':         'Auto — Camera adapts to device orientation',
    };

    panel.innerHTML = `
<div class="component-block" style="border-left:3px solid #3A72A5; margin:0;">
  <div class="component-header" style="background:#12192a;">
    <svg viewBox="0 0 24 24" class="comp-icon" style="color:#5a9acd;">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M3 9h18M9 21V9"/>
    </svg>
    <span style="color:#8ab8d8;font-weight:600;">Scene Settings</span>
  </div>
  <div class="component-body" style="gap:8px;">
    <div class="prop-row">
      <span class="prop-label">Background</span>
      <input type="color" id="scene-bg-color" value="${bgHex}" style="width:44px;height:22px;border:none;border-radius:3px;cursor:pointer;padding:1px;">
    </div>
    <div class="prop-row">
      <span class="prop-label">Game Width</span>
      <input type="number" id="scene-game-w" value="${ss.gameWidth}" step="1" min="100"
        style="width:80px;background:#1a1a24;border:1px solid #2a3a4a;color:#d8d8e8;border-radius:3px;padding:2px 4px;font-size:11px;">
      <span style="color:#555;font-size:10px;margin-left:3px;">px</span>
    </div>
    <div class="prop-row">
      <span class="prop-label">Game Height</span>
      <input type="number" id="scene-game-h" value="${ss.gameHeight}" step="1" min="100"
        style="width:80px;background:#1a1a24;border:1px solid #2a3a4a;color:#d8d8e8;border-radius:3px;padding:2px 4px;font-size:11px;">
      <span style="color:#555;font-size:10px;margin-left:3px;">px</span>
    </div>
  </div>
</div>
<div class="component-block" style="border-left:3px solid #5a3a8a; margin:0;">
  <div class="component-header" style="background:#1a1230;">
    <svg viewBox="0 0 24 24" class="comp-icon" style="color:#9a6acd;">
      <rect x="2" y="4" width="20" height="16" rx="2"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
    <span style="color:#b89ad8;font-weight:600;">Camera / Resolution</span>
  </div>
  <div class="component-body" style="gap:8px;">
    <div class="prop-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
      <span class="prop-label">Preset</span>
      <select id="scene-cam-preset" style="width:100%;background:#1a1a24;border:1px solid #3a2a5a;color:#d8d8e8;border-radius:3px;padding:3px 6px;font-size:11px;">
        <option value="landscape-desktop"  ${ss.cameraPreset==='landscape-desktop'?'selected':''}>Landscape — Desktop (16:9)</option>
        <option value="landscape-both"     ${ss.cameraPreset==='landscape-both'?'selected':''}>Landscape — Desktop + Android</option>
        <option value="portrait"           ${ss.cameraPreset==='portrait'?'selected':''}>Portrait — Mobile (9:16)</option>
        <option value="automatic"          ${ss.cameraPreset==='automatic'?'selected':''}>Automatic (adapts to device)</option>
      </select>
    </div>
    <div id="scene-preset-info" style="color:#7a7a8a;font-size:10px;font-style:italic;padding:2px 0 0 0;">
      ${presetInfo[ss.cameraPreset] || ''}
    </div>
  </div>
</div>`;

    // Bind events
    const bgEl = panel.querySelector('#scene-bg-color');
    bgEl?.addEventListener('mousedown', () => import('./engine.history.js').then(m => m.pushUndo()));
    bgEl?.addEventListener('input', (e) => {
        const hex = parseInt(e.target.value.replace('#',''), 16);
        state.sceneSettings.bgColor = hex;
        if (state.app?.renderer) state.app.renderer.background.color = hex;
    });

    const wEl = panel.querySelector('#scene-game-w');
    const hEl = panel.querySelector('#scene-game-h');
    wEl?.addEventListener('focus', () => import('./engine.history.js').then(m => m.pushUndo()));
    hEl?.addEventListener('focus', () => import('./engine.history.js').then(m => m.pushUndo()));
    wEl?.addEventListener('change', () => {
        state.sceneSettings.gameWidth = Math.max(100, parseInt(wEl.value) || 1280);
        import('./engine.playmode.js').then(m => m.drawCameraBounds());
    });
    hEl?.addEventListener('change', () => {
        state.sceneSettings.gameHeight = Math.max(100, parseInt(hEl.value) || 720);
        import('./engine.playmode.js').then(m => m.drawCameraBounds());
    });

    const presetEl = panel.querySelector('#scene-cam-preset');
    const infoEl   = panel.querySelector('#scene-preset-info');
    presetEl?.addEventListener('change', () => {
        import('./engine.history.js').then(m => m.pushUndo());
        state.sceneSettings.cameraPreset = presetEl.value;
        if (infoEl) infoEl.textContent = presetInfo[presetEl.value] || '';
        // Auto-set recommended resolution
        if (presetEl.value === 'portrait') {
            state.sceneSettings.gameWidth  = 720;
            state.sceneSettings.gameHeight = 1280;
        } else if (presetEl.value === 'landscape-desktop' || presetEl.value === 'landscape-both') {
            state.sceneSettings.gameWidth  = 1280;
            state.sceneSettings.gameHeight = 720;
        }
        if (wEl) wEl.value = state.sceneSettings.gameWidth;
        if (hEl) hEl.value = state.sceneSettings.gameHeight;
        import('./engine.playmode.js').then(m => m.drawCameraBounds());
    });
}

// ── Audio Source selection ────────────────────────────────────
export function selectAudioSource(src) {
    _selectedAudioSource       = src;
    state._selectedAudioSource = src;

    // Deselect game object without triggering syncPixiToInspector
    if (state.gameObject) {
        const oldGizmo = state.gameObject._gizmoContainer;
        if (oldGizmo) oldGizmo.visible = false;
        state.gameObject     = null;
        state.gizmoContainer = null;
        state.grpTranslate   = null;
        state.grpRotate      = null;
        state.grpScale       = null;
        state._gizmoHandles  = null;
        state.spriteBox      = null;
    }

    // Highlight range circle
    _highlightAudioSource(src);

    refreshHierarchy();

    // Show audio inspector, hide all object sections
    const transformSection = document.getElementById('inspector-transform-section');
    const spriteSection    = document.getElementById('inspector-sprite-section');
    const animSection      = document.getElementById('inspector-anim-section');
    const pfSection        = document.getElementById('inspector-prefab-section');
    const lightMount       = document.getElementById('light-inspector-mount');
    if (transformSection) transformSection.style.display = 'none';
    if (spriteSection)    spriteSection.style.display    = 'none';
    if (animSection)      animSection.style.display      = 'none';
    if (pfSection)        pfSection.style.display        = 'none';

    const scenePanel = document.getElementById('scene-settings-panel');
    if (scenePanel) scenePanel.style.display = 'none';

    if (els?.objName) els.objName.value = src.label || '';
    if (els?.px) els.px.value = '';
    if (els?.py) els.py.value = '';

    if (lightMount) {
        import('./engine.audio.js').then(m => {
            lightMount.innerHTML = m.buildAudioInspectorHTML(src);
            m.bindAudioInspector(src);
        });
    }
}

export function deselectAudioSource() {
    // Restore alpha on audio sources
    for (const s of state.audioSources) {
        if (s._container) s._container.alpha = 1.0;
    }
    _selectedAudioSource       = null;
    state._selectedAudioSource = null;
    refreshHierarchy();
    syncPixiToInspector();
}

export function syncAudioSourceToInspector(src) {
    import('./engine.audio.js').then(m => m.syncAudioSourceToInspector(src));
}

function _highlightAudioSource(src) {
    // Dim all audio sources, highlight the selected one
    for (const s of state.audioSources) {
        if (s._container) s._container.alpha = s === src ? 1.0 : 0.5;
    }
}

// ── Instant prefab field propagation ─────────────────────────
// Only TINT propagates live to all instances. Rotation and scale
// are per-instance and never propagated automatically.
function _propagatePrefabField(sourceObj, field, value) {
    if (!sourceObj?.prefabId) return;
    if (field !== 'tint') return;   // guard: only tint propagates
    const prefabId = sourceObj.prefabId;

    // Update template tint
    const prefab = (state.prefabs || []).find(p => p.id === prefabId);
    if (prefab) prefab.tint = value;

    // Update every OTHER live instance immediately
    for (const obj of state.gameObjects) {
        if (obj === sourceObj || obj.prefabId !== prefabId) continue;
        if (obj.spriteGraphic?.tint !== undefined) obj.spriteGraphic.tint = value;
    }

    // Update scene snapshots (other scenes)
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
    const _pushU = () => import('./engine.history.js').then(m => m.pushUndo());
    ['px','py','pz','rz','sx','sy'].forEach(k => {
        if (!els[k]) return;
        // Push undo BEFORE edit starts (on focus)
        els[k].addEventListener('focus', _pushU);
        els[k].addEventListener('input', syncInspectorToPixi);
    });

    els.color.addEventListener('focus', _pushU);
    els.color.addEventListener('input', (e) => {
        const go = state.gameObject;
        if (!go) return;
        const hexStr = e.target.value.replace('#', '');
        const tintVal = parseInt(hexStr, 16);
        const sp = go.spriteGraphic;
        if (sp && sp.tint !== undefined) {
            sp.tint = tintVal;
        }
        // Instant prefab propagation — color updates all instances live
        _propagatePrefabField(go, 'tint', tintVal);
    });

    els.gizmoMode.addEventListener('change', (e) => setGizmoMode(e.target.value));

    els.btns.t.addEventListener('click', () => setGizmoMode('translate'));
    els.btns.r.addEventListener('click', () => setGizmoMode('rotate'));
    els.btns.s.addEventListener('click', () => setGizmoMode('scale'));
    els.btns.a.addEventListener('click', () => setGizmoMode('all'));

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
        });
    }
}

// ── Gizmo Mode ────────────────────────────────────────────────
export function setGizmoMode(mode) {
    state.gizmoMode = mode;

    // Apply to selected object only; lights always use translate-only gizmo
    for (const obj of state.gameObjects) {
        if (!obj._grpTranslate) continue;
        const isSelected = obj === state.gameObject;
        if (!isSelected) {
            obj._grpTranslate.visible = false;
            obj._grpRotate.visible    = false;
            obj._grpScale.visible     = false;
        } else if (obj.isLight) {
            // Lights: translate always visible, no rotate/scale gizmo
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
    els.gizmoMode.value = mode;
    els.btns.t.className = `tool-btn${mode === 'translate' ? ' active' : ''}`;
    els.btns.r.className = `tool-btn${mode === 'rotate'    ? ' active' : ''}`;
    els.btns.s.className = `tool-btn${mode === 'scale'     ? ' active' : ''}`;
    els.btns.a.className = `tool-btn${mode === 'all'       ? ' active' : ''}`;
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

        // Name (double-click to rename)
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
            };
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') inp.blur(); ev.stopPropagation(); });
        });

        const left = document.createElement('div');
        left.className = 'tree-item-left';

        // Icon
        if (obj.isLight) {
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

        // Z-order buttons
        const zBtns = document.createElement('div');
        zBtns.style.cssText = 'display:flex;gap:2px;flex-shrink:0;';
        const upBtn = _makeZBtn('↑', () => import('./engine.objects.js').then(m => m.moveObjectUp(obj)));
        const dnBtn = _makeZBtn('↓', () => import('./engine.objects.js').then(m => m.moveObjectDown(obj)));
        zBtns.appendChild(upBtn); zBtns.appendChild(dnBtn);
        item.appendChild(zBtns);

        item.addEventListener('click', () => import('./engine.objects.js').then(m => m.selectObject(obj)));
        // Double-click: open animation editor for sprites, not for lights
        if (!obj.isLight) {
            item.addEventListener('dblclick', () => {
                import('./engine.objects.js').then(m => m.selectObject(obj));
                import('./engine.animator.js').then(m => m.openAnimationEditor(obj));
            });
        }

        list.appendChild(item);
    }

    // ── Audio sources in hierarchy ────────────────────────────
    for (const src of state.audioSources) {
        const item = document.createElement('div');
        const isSel = src === _selectedAudioSource;
        item.className = 'tree-item' + (isSel ? ' selected' : '');
        item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:3px 8px;cursor:pointer;';

        const left = document.createElement('div');
        left.className = 'tree-item-left';

        // Speaker icon
        const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
        icon.setAttribute('viewBox','0 0 24 24');
        icon.style.cssText = 'width:13px;height:13px;fill:none;stroke:#5aabdd;stroke-width:2;flex-shrink:0;';
        icon.innerHTML = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
        left.appendChild(icon);

        const nameEl = document.createElement('span');
        nameEl.className = 'tree-item-name';
        nameEl.textContent = src.label || 'AudioSource';
        left.appendChild(nameEl);

        const badge = document.createElement('span');
        badge.className = 'tree-item-light-badge';
        badge.style.background = 'rgba(58,154,217,0.12)';
        badge.style.color = '#8dd4f8';
        badge.style.borderColor = 'rgba(58,154,217,0.3)';
        badge.textContent = '3D Audio';
        left.appendChild(badge);

        item.appendChild(left);

        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.style.cssText = 'background:transparent;border:none;color:#505060;font-size:11px;padding:2px 4px;cursor:pointer;border-radius:2px;';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            import('./engine.audio.js').then(m => m.removeAudioSource(src));
        });
        delBtn.addEventListener('mouseenter', () => delBtn.style.color = '#f88');
        delBtn.addEventListener('mouseleave', () => delBtn.style.color = '#505060');
        item.appendChild(delBtn);

        item.addEventListener('click', () => selectAudioSource(src));
        list.appendChild(item);
    }

    if (state.gameObjects.length === 0 && state.audioSources.length === 0) {
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
let _assetFilter = 'all'; // 'all' | 'sprite' | 'audio'

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

        if (asset.type === 'audio') {
            item.addEventListener('click', () => _showAudioInspector(asset));
        }

        grid.appendChild(item);
    }

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#505060;font-size:11px;padding:16px;font-style:italic;text-align:center;width:100%;';
        empty.textContent = _assetFilter === 'audio' ? 'No audio imported' : 'Import assets to get started';
        grid.appendChild(empty);
    }
}

function _showAudioInspector(asset) {
    // Show a toast notification since audio-inspector-bar is removed
    const existing = document.getElementById('audio-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'audio-toast';
    toast.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1a1a24;border:1px solid #3a3a48;color:#d8d8e8;border-radius:6px;padding:8px 16px;font-size:11px;z-index:9999;display:flex;align-items:center;gap:10px;box-shadow:0 4px 16px rgba(0,0,0,0.6);';
    toast.innerHTML = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:#3A72A5;stroke-width:2;flex-shrink:0;"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><span>${asset.name}</span><button onclick="document.getElementById('audio-toast')?.remove()" style="background:none;border:none;color:#666;cursor:pointer;font-size:14px;padding:0;line-height:1;">✕</button>`;
    document.body.appendChild(toast);
    setTimeout(() => toast?.remove(), 3000);
}

// ── Prefab Panel ──────────────────────────────────────────────
export function refreshPrefabPanel() {
    // Delegate to the canonical implementation in engine.prefabs.js
    import('./engine.prefabs.js').then(m => m.refreshPrefabPanel());
}

// ── Drop onto scene canvas ────────────────────────────────────
export function initSceneDrop() {
    const container = document.getElementById('pixi-container');
    if (!container) return;

    // Visual feedback when dragging prefab/asset over scene
    container.addEventListener('dragenter', (e) => {
        const hasPrefab = e.dataTransfer.types.includes('prefabid') || e.dataTransfer.types.includes('assetid');
        if (hasPrefab || e.dataTransfer.types.length) {
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

        // Convert page coords → scene-local coords
        const rect   = container.getBoundingClientRect();
        const px     = e.clientX - rect.left;
        const py     = e.clientY - rect.top;
        const global = new PIXI.Point(px, py);
        const local  = state.sceneContainer.toLocal(global);

        // ── Prefab drop ──────────────────────────────────────
        const prefabId = e.dataTransfer.getData('prefabId');
        if (prefabId) {
            const prefab = state.prefabs.find(p => p.id === prefabId);
            if (prefab && state.app) {
                import('./engine.history.js').then(({ pushUndo }) => pushUndo());
                import('./engine.prefabs.js').then(m => m.instantiatePrefab(prefab, local.x, local.y));
            }
            return;
        }

        // ── Asset drop ────────────────────────────────────────
        const assetId = e.dataTransfer.getData('assetId');
        if (!assetId) return;
        const asset = state.assets.find(a => a.id === assetId);
        if (!asset || !state.app) return;

        // Audio asset → create 3D audio source in scene
        if (asset.type === 'audio') {
            import('./engine.audio.js').then(m => m.createAudioSource(asset, local.x, local.y));
            return;
        }

        // Image asset → create sprite
        import('./engine.objects.js').then(m => {
            const obj = m.createImageObject(asset, local.x, local.y);
            if (obj && state._bindGizmoHandles) state._bindGizmoHandles(obj);
        });
    });
}
