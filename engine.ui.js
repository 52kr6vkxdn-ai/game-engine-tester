/* ============================================================
   Zengine — engine.ui.js
   Inspector, hierarchy, asset panel, menus, resize handles.
   ============================================================ */

import { state, PIXELS_PER_UNIT } from './engine.state.js';

let els = null;

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
        if (pfSection) pfSection.style.display = 'none';
        if (lightSection) lightSection.style.display = 'none';
        // Clear the dynamic light/fog mount and restore row visibility
        const lightMount = document.getElementById('light-inspector-mount');
        if (lightMount) lightMount.innerHTML = '';
        const rotRow   = document.getElementById('transform-rot-row');
        const scaleRow = document.getElementById('transform-scale-row');
        if (rotRow)   rotRow.style.display   = '';
        if (scaleRow) scaleRow.style.display = '';
        if (spriteSection) spriteSection.style.display = '';
        if (animSection)   animSection.style.display   = '';
        return;
    }

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

    if (go.isFog) {
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
                lightMount.innerHTML = m.buildFogInspectorHTML(go);
                m.bindFogInspector(go);
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

    if (go.isTerrain) {
        const rotRow   = document.getElementById('transform-rot-row');
        const scaleRow = document.getElementById('transform-scale-row');
        if (rotRow)   rotRow.style.display   = 'none';
        if (scaleRow) scaleRow.style.display = 'none';
        if (spriteSection) spriteSection.style.display = 'none';
        if (animSection)   animSection.style.display   = 'none';
        if (pfSection)     pfSection.style.display      = 'none';
        const lightMount = document.getElementById('light-inspector-mount');
        if (lightMount) {
            import('./engine.terrain.js').then(m => {
                lightMount.innerHTML = m.buildTerrainInspectorHTML(go);
                document.getElementById('btn-open-terrain-brush')?.addEventListener('click', () => m.openTerrainEditor(go));
                document.getElementById('btn-open-brush-setup')?.addEventListener('click',  () => m.openBrushSetup(go));
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
    if (lightMount) lightMount.innerHTML = '';

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
    if (!go.isLight && !go.isTilemap && !go.isFog && !go.isTerrain) {
        const newRot = (parseFloat(els.rz?.value) || 0) * -Math.PI / 180;
        const newSX  = parseFloat(els.sx?.value) || 1;
        const newSY  = parseFloat(els.sy?.value) || 1;
        go.rotation  = newRot;
        go.scale.x   = newSX;
        go.scale.y   = newSY;
    }

    if (zChanged) import('./engine.objects.js').then(m => m.sortByZ());
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
    ['px','py','pz','rz','sx','sy'].forEach(k => {
        els[k].addEventListener('input', syncInspectorToPixi);
    });

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
        } else if (obj.isFog) {
            const span = document.createElement('span');
            span.style.cssText = 'font-size:12px;flex-shrink:0;';
            span.textContent = '🌫';
            left.appendChild(span);
        } else if (obj.isTerrain) {
            const span = document.createElement('span');
            span.style.cssText = 'font-size:12px;flex-shrink:0;';
            span.textContent = '⛰';
            left.appendChild(span);
        } else {
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
        if (obj.isFog) {
            const badge = document.createElement('span');
            badge.className = 'tree-item-light-badge';
            badge.style.background   = 'rgba(163,184,216,0.12)';
            badge.style.color        = '#a3b8d8';
            badge.style.borderColor  = 'rgba(163,184,216,0.3)';
            badge.textContent = 'fog';
            left.appendChild(badge);
        }
        if (obj.isTerrain) {
            const badge = document.createElement('span');
            badge.className = 'tree-item-light-badge';
            badge.style.background  = 'rgba(74,222,128,0.10)';
            badge.style.color       = '#4ade80';
            badge.style.borderColor = 'rgba(74,222,128,0.25)';
            badge.textContent = `terrain`;
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
        // Double-click: open animation editor for sprites only (not lights, fog, tilemaps, terrain)
        if (!obj.isLight && !obj.isFog && !obj.isTilemap && !obj.isTerrain) {
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

        // ── Asset drop (image only — skip audio) ─────────────
        const assetId = e.dataTransfer.getData('assetId');
        if (!assetId) return;
        const asset = state.assets.find(a => a.id === assetId);
        if (!asset || !state.app || asset.type === 'audio') return;

        import('./engine.objects.js').then(m => {
            const obj = m.createImageObject(asset, local.x, local.y);
            if (obj && state._bindGizmoHandles) state._bindGizmoHandles(obj);
        });
    });
}
