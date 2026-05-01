/* ============================================================
   Zengine — engine.history.js
   Undo / Redo — full scene snapshots + debounced number-input
   tracking so every inspector tweak is undoable.
   ============================================================ */

import { state } from './engine.state.js';

const MAX_HISTORY = 50;

// ── Debounce timer for number-input changes ───────────────────
let _inputDebounceTimer = null;
const INPUT_DEBOUNCE_MS = 400;

// ── Capture current scene state ───────────────────────────────
function _captureScene() {
    return {
        objects: state.gameObjects.map(obj => {
            if (obj.isAudioSource) {
                return {
                    isAudioSource: true,
                    label:   obj.label,
                    assetId: obj.assetId,
                    x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    audioProps: JSON.parse(JSON.stringify(obj.audioProps || {})),
                };
            }
            if (obj.isLight) {
                return {
                    isLight: true, lightType: obj.lightType,
                    label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    lightProps: JSON.parse(JSON.stringify(obj.lightProps)),
                };
            }
            if (obj.isTilemap) {
                return {
                    isTilemap: true, label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    tilemapData: { ...obj.tilemapData, tiles: Array.from(obj.tilemapData.tiles) },
                };
            }
            if (obj.isAutoTilemap) {
                const td = obj.autoTileData;
                return {
                    isAutoTilemap: true, label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    autoTileData: {
                        ...td,
                        cells:        Array.from(td.cells),
                        brushList:    td.brushList.slice(),
                        activeBrushIds: (td.activeBrushIds || []).slice(),
                    },
                };
            }
            return {
                label: obj.label, isImage: obj.isImage, assetId: obj.assetId,
                prefabId: obj.prefabId || null,
                x: obj.x, y: obj.y, scaleX: obj.scale.x, scaleY: obj.scale.y,
                rotation: obj.rotation, unityZ: obj.unityZ || 0,
                tint: obj.spriteGraphic?.tint ?? 0xFFFFFF,
                animations: obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
                activeAnimIndex: obj.activeAnimIndex || 0,
                physicsBody:              obj.physicsBody             ?? 'none',
                physicsShape:             obj.physicsShape            ?? 'box',
                physicsFriction:          obj.physicsFriction         ?? 0.3,
                physicsRestitution:       obj.physicsRestitution      ?? 0.1,
                physicsDensity:           obj.physicsDensity          ?? 0.001,
                physicsGravityScale:      obj.physicsGravityScale     ?? 1,
                physicsLinearDamping:     obj.physicsLinearDamping    ?? 0,
                physicsAngularDamping:    obj.physicsAngularDamping   ?? 0,
                physicsFixedRotation:     !!obj.physicsFixedRotation,
                physicsIsSensor:          !!obj.physicsIsSensor,
                physicsCollisionCategory: obj.physicsCollisionCategory ?? 1,
                physicsCollisionMask:     obj.physicsCollisionMask    ?? 0xFFFFFFFF,
                physicsSize:      obj.physicsSize     ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
                physicsPolygon:   obj.physicsPolygon  ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
                physicsPolygons:  obj.physicsPolygons ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
                _polyUnit:           obj._polyUnit || null,
                _collisionShapeInit: !!obj._collisionShapeInit,
                visible: obj.visible !== false,
                alpha:   obj.alpha   ?? 1,
            };
        }),
        camX:      state.sceneContainer?.x       ?? 0,
        camY:      state.sceneContainer?.y       ?? 0,
        camScaleX: state.sceneContainer?.scale.x ?? 1,
        camScaleY: state.sceneContainer?.scale.y ?? 1,
        selectedLabel: state.gameObject?.label ?? null,
        sceneSettings: JSON.parse(JSON.stringify(state.sceneSettings)),
    };
}

// ── Push a checkpoint BEFORE a change ────────────────────────
export function pushUndo() {
    if (state.isPlaying || state._applyingHistory) return;
    const snap = _captureScene();
    state.undoStack.push(snap);
    if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
    state.redoStack = [];
    _updateUndoButtons();
}

// ── Debounced push — for number inputs (position, scale, etc.) ─
// Cancels any pending push and schedules a new one after a quiet period.
export function pushUndoDebounced() {
    if (state.isPlaying || state._applyingHistory) return;
    if (_inputDebounceTimer) clearTimeout(_inputDebounceTimer);
    _inputDebounceTimer = setTimeout(() => {
        _inputDebounceTimer = null;
        pushUndo();
    }, INPUT_DEBOUNCE_MS);
}

// ── Flush any pending debounced push immediately ──────────────
export function flushUndoDebounce() {
    if (_inputDebounceTimer) {
        clearTimeout(_inputDebounceTimer);
        _inputDebounceTimer = null;
        pushUndo();
    }
}

// ── Undo ─────────────────────────────────────────────────────
export function undo() {
    if (state.isPlaying) return;
    flushUndoDebounce();
    if (state.undoStack.length === 0) return;

    state.redoStack.push(_captureScene());
    const snap = state.undoStack.pop();
    _applyScene(snap);
    _updateUndoButtons();
}

// ── Redo ─────────────────────────────────────────────────────
export function redo() {
    if (state.isPlaying) return;
    flushUndoDebounce();
    if (state.redoStack.length === 0) return;

    state.undoStack.push(_captureScene());
    const snap = state.redoStack.pop();
    _applyScene(snap);
    _updateUndoButtons();
}

// ── Apply a snapshot to the live scene ───────────────────────
function _applyScene(snap) {
    state._applyingHistory = true;

    // Clear existing objects
    for (const obj of state.gameObjects) {
        state.sceneContainer.removeChild(obj);
        try { obj.destroy({ children: true }); } catch (_) {}
    }
    state.gameObjects    = [];
    state.gameObject     = null;
    state.gizmoContainer = null;
    state.grpTranslate   = null;
    state.grpRotate      = null;
    state.grpScale       = null;
    state._gizmoHandles  = null;
    state.spriteBox      = null;

    // Restore camera
    if (state.sceneContainer) {
        state.sceneContainer.x       = snap.camX      ?? state.app.screen.width  / 2;
        state.sceneContainer.y       = snap.camY      ?? state.app.screen.height / 2;
        state.sceneContainer.scale.x = snap.camScaleX ?? 1;
        state.sceneContainer.scale.y = snap.camScaleY ?? 1;
    }

    // Restore scene settings
    if (snap.sceneSettings) {
        Object.assign(state.sceneSettings, snap.sceneSettings);
        // Apply bg color
        if (state.app) state.app.renderer.background.color = snap.sceneSettings.bgColor;
        import('./engine.ui.js').then(m => m.syncSceneSettingsToUI?.());
    }

    // Rebuild grid
    import('./engine.renderer.js').then(m => m.drawGrid());

    // Restore objects
    const restoreAll = snap.objects.map(s => {
        if (s.isAudioSource) {
            return import('./engine.audio.js').then(({ createAudioSource }) => {
                createAudioSource(s.assetId, s.x, s.y, s.audioProps, s.label);
            });
        }
        if (s.isLight) {
            return import('./engine.lights.js').then(({ createLight, _buildLightHelper }) => {
                const obj = createLight(s.lightType, s.x, s.y);
                if (!obj) return;
                obj.label = s.label; obj.unityZ = s.unityZ || 0;
                obj.lightProps = JSON.parse(JSON.stringify(s.lightProps));
                _buildLightHelper(obj);
            });
        }
        if (s.isTilemap) {
            return import('./engine.tilemap.js').then(({ restoreTilemap }) => restoreTilemap(s));
        }
        if (s.isAutoTilemap) {
            return import('./engine.autotile.js').then(({ restoreAutoTilemap }) => restoreAutoTilemap(s));
        }
        return import('./engine.objects.js').then(({ createImageObject }) => {
            if (!s.isImage || !s.assetId) return;
            const asset = state.assets.find(a => a.id === s.assetId);
            if (!asset) return;
            const obj = createImageObject(asset, s.x, s.y);
            if (!obj) return;
            obj.label = s.label; obj.scale.x = s.scaleX; obj.scale.y = s.scaleY;
            obj.rotation = s.rotation; obj.unityZ = s.unityZ; obj.prefabId = s.prefabId || null;
            if (obj.spriteGraphic?.tint !== undefined) obj.spriteGraphic.tint = s.tint;
            if (s.animations?.length) { obj.animations = JSON.parse(JSON.stringify(s.animations)); obj.activeAnimIndex = s.activeAnimIndex || 0; }
            // Physics
            const pf = ['physicsBody','physicsShape','physicsFriction','physicsRestitution','physicsDensity',
                         'physicsGravityScale','physicsLinearDamping','physicsAngularDamping',
                         'physicsFixedRotation','physicsIsSensor','physicsCollisionCategory','physicsCollisionMask',
                         '_polyUnit','_collisionShapeInit','visible','alpha'];
            pf.forEach(k => { if (s[k] !== undefined) obj[k] = s[k]; });
            if (s.physicsSize)     obj.physicsSize     = JSON.parse(JSON.stringify(s.physicsSize));
            if (s.physicsPolygon)  obj.physicsPolygon  = JSON.parse(JSON.stringify(s.physicsPolygon));
            if (s.physicsPolygons) obj.physicsPolygons = JSON.parse(JSON.stringify(s.physicsPolygons));
            if (state._bindGizmoHandles) state._bindGizmoHandles(obj);
        });
    });

    Promise.all(restoreAll).then(() => {
        import('./engine.objects.js').then(({ selectObject }) => {
            const target = snap.selectedLabel
                ? state.gameObjects.find(o => o.label === snap.selectedLabel)
                : null;
            if (target) selectObject(target);
            else {
                import('./engine.ui.js').then(m => {
                    m.syncPixiToInspector();
                    m.refreshHierarchy();
                });
            }
            state._applyingHistory = false;
        });
    });
}

// ── Update toolbar undo/redo button states ────────────────────
function _updateUndoButtons() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.style.opacity = state.undoStack.length ? '1' : '0.35';
    if (redoBtn) redoBtn.style.opacity = state.redoStack.length ? '1' : '0.35';
}

export { _updateUndoButtons as updateUndoButtons };
