/* ============================================================
   Zengine — engine.project.js
   Save / Load entire project as a single JSON file.
   Includes: all scenes, assets (as dataURLs), prefabs.
   ============================================================ */

import { state } from './engine.state.js';

const PROJECT_VERSION = 1;

// ── Save project to JSON file download ───────────────────────
export function saveProject() {
    // Snapshot the active scene first
    _saveActiveScene();

    const project = {
        version:     PROJECT_VERSION,
        name:        'ZengineProject',
        savedAt:     new Date().toISOString(),
        assets:      state.assets,
        prefabs:     state.prefabs,
        scenes:      state.scenes,
        activeScene: state.activeSceneIndex,
    };

    const json = JSON.stringify(project, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);

    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'zengine-project.json';
    a.click();
    URL.revokeObjectURL(url);

    _logConsole('💾 Project saved', '#4ade80');
}

// ── Load project from JSON file ──────────────────────────────
export function loadProject() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.json,application/json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const project = JSON.parse(ev.target.result);
                _applyProject(project);
            } catch (err) {
                alert('Failed to load project: ' + err.message);
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

// ── New (blank) project ──────────────────────────────────────
export function newProject() {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;

    // Clear all objects
    for (const obj of state.gameObjects) {
        state.sceneContainer?.removeChild(obj);
        try { obj.destroy({ children: true }); } catch (_) {}
    }
    state.gameObjects    = [];
    state.gameObject     = null;
    state.gizmoContainer = null;
    state.assets         = [];
    state.prefabs        = [];
    state.scenes         = [{ id: 'scene_1', name: 'Scene-1', snapshot: null }];
    state.activeSceneIndex = 0;

    import('./engine.renderer.js').then(m => m.drawGrid());
    import('./engine.ui.js').then(m => {
        m.syncPixiToInspector();
        m.refreshHierarchy();
        m.refreshAssetPanel();
        m.refreshPrefabPanel();
    });
    import('./engine.scenes.js').then(m => m.initScenes());
    _logConsole('🆕 New project created', '#9bc');
}

// ── Apply loaded project data ─────────────────────────────────
function _applyProject(project) {
    if (!project.version) {
        alert('Invalid project file.');
        return;
    }

    // Clear current scene
    for (const obj of state.gameObjects) {
        state.sceneContainer?.removeChild(obj);
        try { obj.destroy({ children: true }); } catch (_) {}
    }
    state.gameObjects    = [];
    state.gameObject     = null;
    state.gizmoContainer = null;

    // Restore globals
    state.assets   = project.assets  || [];
    state.prefabs  = project.prefabs || [];
    state.scenes   = project.scenes  || [{ id: 'scene_1', name: 'Scene-1', snapshot: null }];
    state.activeSceneIndex = project.activeScene ?? 0;

    // Reload active scene
    import('./engine.scenes.js').then(m => {
        m.initScenes();
        // initScenes resets to scene_1; we need to switch to the saved active
        if (project.activeScene > 0) m.switchToScene(project.activeScene);
    });

    import('./engine.ui.js').then(m => {
        m.refreshAssetPanel();
        m.refreshPrefabPanel();
    });

    _logConsole('📂 Project loaded: ' + (project.name || 'unknown'), '#4ade80');
}

// ── Snapshot active scene into state.scenes ──────────────────
function _saveActiveScene() {
    const idx   = state.activeSceneIndex;
    const scene = state.scenes[idx];
    if (!scene) return;

    scene.snapshot = {
        objects: state.gameObjects.map(obj => {
            if (obj.isLight) {
                return {
                    isLight: true, lightType: obj.lightType,
                    label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    lightProps: JSON.parse(JSON.stringify(obj.lightProps)),
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
    };
}

function _logConsole(msg, color = '#e0e0e0') {
    const cons = document.getElementById('console-output') || document.getElementById('tab-console');
    if (!cons) return;
    const line = document.createElement('div');
    line.style.color = color;
    line.textContent = msg;
    cons.appendChild(line);
    cons.scrollTop = cons.scrollHeight;
}
