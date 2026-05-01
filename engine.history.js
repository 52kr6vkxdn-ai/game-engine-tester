/* ============================================================
   Zengine — engine.history.js
   Undo / Redo support via full scene snapshots.
   Push a snapshot before any destructive edit; pop to undo.
   ============================================================ */

import { state } from './engine.state.js';

const MAX_HISTORY = 30;

// ── Capture current scene state ──────────────────────────────
function _captureScene() {
    return {
        objects: state.gameObjects.map(obj => {
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
            return {
                label: obj.label, isImage: obj.isImage, assetId: obj.assetId,
                prefabId: obj.prefabId || null,
                x: obj.x, y: obj.y, scaleX: obj.scale.x, scaleY: obj.scale.y,
                rotation: obj.rotation, unityZ: obj.unityZ || 0,
                tint: obj.spriteGraphic?.tint ?? 0xFFFFFF,
                animations: obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
                activeAnimIndex: obj.activeAnimIndex || 0,
            };
        }),
        camX:      state.sceneContainer?.x       ?? 0,
        camY:      state.sceneContainer?.y       ?? 0,
        camScaleX: state.sceneContainer?.scale.x ?? 1,
        camScaleY: state.sceneContainer?.scale.y ?? 1,
        selectedLabel: state.gameObject?.label ?? null,
    };
}

// ── Push a checkpoint BEFORE a change ────────────────────────
export function pushUndo() {
    if (state.isPlaying || state._applyingHistory) return;
    const snap = _captureScene();
    state.undoStack.push(snap);
    if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
    state.redoStack = []; // new edit clears redo
    _updateUndoButtons();
}

// ── Undo ─────────────────────────────────────────────────────
export function undo() {
    if (state.isPlaying) return;
    if (state.undoStack.length === 0) return;

    // Save current for redo
    state.redoStack.push(_captureScene());
    const snap = state.undoStack.pop();
    _applyScene(snap);
    _updateUndoButtons();
}

// ── Redo ─────────────────────────────────────────────────────
export function redo() {
    if (state.isPlaying) return;
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

    // Rebuild grid
    import('./engine.renderer.js').then(m => m.drawGrid());

    // Restore objects (sprites and lights)
    const restoreAll = snap.objects.map(s => {
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
            if (state._bindGizmoHandles) state._bindGizmoHandles(obj);
        });
    });
    Promise.all(restoreAll).then(() => {
        import('./engine.objects.js').then(({ selectObject }) => {
            // Re-select the previously selected object by name
            const target = snap.selectedLabel
                ? state.gameObjects.find(o => o.label === snap.selectedLabel)
                : state.gameObjects[state.gameObjects.length - 1];
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

// ── Update toolbar undo/redo button states ───────────────────
function _updateUndoButtons() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.style.opacity = state.undoStack.length ? '1' : '0.35';
    if (redoBtn) redoBtn.style.opacity = state.redoStack.length ? '1' : '0.35';
}

export { _updateUndoButtons as updateUndoButtons };
