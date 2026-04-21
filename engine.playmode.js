/* Zengine — engine.playmode.js v3 */
import { state } from './engine.state.js';

export const GAME_WIDTH  = 1280;
export const GAME_HEIGHT = 720;

export function enterPlayMode() {
    if (state.isPlaying) return;
    state._playSnapshot = _snapshotScene();
    state.isPlaying = true;
    state.isPaused  = false;
    _hideEditorUI();
    _expandCanvasGameCamera();   // use game camera, not editor camera
    _hideAllGizmosAndGrid();
    _deselect();
    _blockEditorInput(true);     // block selection, scroll, zoom
    _showPlayOverlay();
    _startFPSCounter();
    // Start animating all objects
    import('./engine.playmode.js').then(m => m.startRuntimeAnimations());
    _logConsole('▶ Play Mode — Space or ■ to stop', '#4ade80');
}

export function pausePlayMode() {
    if (!state.isPlaying) return;
    state.isPaused = !state.isPaused;
    _updatePlayButtons();
    const o = document.getElementById('play-pause-overlay');
    if (o) o.style.display = state.isPaused ? 'flex' : 'none';
    // Freeze/unfreeze animated sprites
    for (const obj of state.gameObjects) {
        if (obj._runtimeSprite) {
            if (state.isPaused) obj._runtimeSprite.stop();
            else                obj._runtimeSprite.play();
        }
    }
    _logConsole(state.isPaused ? '⏸ Paused' : '▶ Resumed', '#facc15');
}

export function stopPlayMode() {
    if (!state.isPlaying) return;
    state.isPlaying = false;
    state.isPaused  = false;
    _stopFPSCounter();
    _removePlayOverlay();
    // Stop all runtime animations before restoring scene
    stopRuntimeAnimations();
    _blockEditorInput(false);    // restore input
    _showEditorUI();
    // Store snapshot ref now — _restoreScene will clear state._playSnapshot
    const snap = state._playSnapshot;
    state._playSnapshot = null;
    _restoreCanvas(snap);
    _updatePlayButtons();
    if (snap) _restoreScene(snap);
    _logConsole('■ Stopped — scene restored', '#f87171');
}

/* ── Camera Bounds Overlay (editor only) ── */
export function drawCameraBounds() {
    document.getElementById('camera-bounds-overlay')?.remove();
    if (state.isPlaying) return;
    const pixiEl = document.getElementById('pixi-container');
    if (!pixiEl || !state.app) return;

    const bounds = document.createElement('div');
    bounds.id = 'camera-bounds-overlay';
    bounds.style.cssText = 'position:absolute;pointer-events:none;z-index:10;border:2px solid rgba(255,200,60,0.7);border-radius:1px;';
    _positionCameraBounds(bounds);
    pixiEl.style.position = 'relative';
    pixiEl.appendChild(bounds);

    const lbl = document.createElement('div');
    lbl.style.cssText = 'position:absolute;top:-18px;left:0;color:rgba(255,200,60,0.8);font-size:9px;font-family:monospace;pointer-events:none;white-space:nowrap;';
    lbl.textContent = `CAMERA  ${GAME_WIDTH} × ${GAME_HEIGHT}`;
    bounds.appendChild(lbl);

    // Corner decorations
    ['tl','tr','bl','br'].forEach(corner => {
        const c = document.createElement('div');
        const isR = corner.includes('r'), isB = corner.includes('b');
        c.style.cssText = `position:absolute;width:10px;height:10px;
            ${isB?'bottom:-2px':'top:-2px'};${isR?'right:-2px':'left:-2px'};
            border-${isB?'top':'bottom'}:2px solid rgba(255,200,60,1);
            border-${isR?'left':'right'}:2px solid rgba(255,200,60,1);`;
        bounds.appendChild(c);
    });
}

function _positionCameraBounds(el) {
    if (!state.sceneContainer) return;
    const sc  = state.sceneContainer;
    const tlx = sc.x + (-GAME_WIDTH/2) * sc.scale.x;
    const tly = sc.y + (-GAME_HEIGHT/2) * sc.scale.y;
    const w   = GAME_WIDTH  * sc.scale.x;
    const h   = GAME_HEIGHT * sc.scale.y;
    el.style.left   = tlx + 'px';
    el.style.top    = tly + 'px';
    el.style.width  = w + 'px';
    el.style.height = h + 'px';
}

export function updateCameraBoundsIfVisible() {
    if (state.isPlaying) return;
    const el = document.getElementById('camera-bounds-overlay');
    if (el) _positionCameraBounds(el);
}

/* ── Canvas expand using GAME CAMERA (not editor camera) ── */
function _expandCanvasGameCamera() {
    const el = document.getElementById('pixi-container');
    if (!el) return;
    el.dataset.origStyle = el.getAttribute('style') || '';
    el.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:9000!important;background:#000;';

    if (state.app && state.sceneContainer) {
        const sw = window.innerWidth;
        const sh = window.innerHeight;
        state.app.renderer.resize(sw, sh);

        // Snap to game camera: center world-origin at screen center,
        // scale so GAME_WIDTH/HEIGHT fits the screen (letterbox)
        const scaleX = sw / GAME_WIDTH;
        const scaleY = sh / GAME_HEIGHT;
        const gameCamScale = Math.min(scaleX, scaleY); // letterbox

        state.sceneContainer.scale.set(gameCamScale);
        state.sceneContainer.x = sw / 2;
        state.sceneContainer.y = sh / 2;
    }
}

/* ── Block/unblock all editor interaction during play ── */
function _blockEditorInput(block) {
    const canvas = state.app?.view;
    if (!canvas) return;
    if (block) {
        // Overlay a transparent div that eats all pointer events on the canvas
        let blocker = document.getElementById('play-input-blocker');
        if (!blocker) {
            blocker = document.createElement('div');
            blocker.id = 'play-input-blocker';
            blocker.style.cssText = 'position:fixed;inset:0;z-index:8999;cursor:default;';
            // Block wheel (zoom) and pointer (selection) but allow clicks to propagate to play-mode-bar
            blocker.addEventListener('wheel',       e => e.stopPropagation(), { passive: false });
            blocker.addEventListener('pointerdown', e => {
                // Allow clicks that reach play-mode-bar (z-index 9999 — above blocker)
                e.stopPropagation();
            });
            blocker.addEventListener('contextmenu', e => e.preventDefault());
            document.body.appendChild(blocker);
        }
        // Also freeze sceneContainer so middle-mouse pan won't move camera
        state._playModeCamLocked = true;
    } else {
        document.getElementById('play-input-blocker')?.remove();
        state._playModeCamLocked = false;
    }
}

/* ── Canvas expand/restore (legacy, no longer used for enter — kept for restore) ── */
function _expandCanvas() {
    const el = document.getElementById('pixi-container');
    if (!el) return;
    el.dataset.origStyle = el.getAttribute('style') || '';
    el.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:9000!important;background:#000;';
    if (state.app) {
        state.app.renderer.resize(window.innerWidth, window.innerHeight);
        if (state.sceneContainer) {
            state.sceneContainer.x = window.innerWidth  / 2;
            state.sceneContainer.y = window.innerHeight / 2;
        }
    }
}

function _restoreCanvas(snap) {
    const el = document.getElementById('pixi-container');
    if (!el) return;
    el.setAttribute('style', el.dataset.origStyle || '');
    delete el.dataset.origStyle;
    setTimeout(() => {
        if (!state.app) return;
        const rect = el.getBoundingClientRect();
        if (rect.width && rect.height) state.app.renderer.resize(rect.width, rect.height);
        // Restore editor camera from snapshot (pos + zoom)
        if (snap && state.sceneContainer) {
            state.sceneContainer.x       = snap.camX;
            state.sceneContainer.y       = snap.camY;
            state.sceneContainer.scale.x = snap.camScaleX;
            state.sceneContainer.scale.y = snap.camScaleY;
        } else if (state.sceneContainer) {
            state.sceneContainer.x = rect.width  / 2;
            state.sceneContainer.y = rect.height / 2;
        }
        // Restore grid visibility
        if (state.gridGraphics) state.gridGraphics.visible = true;
        import('./engine.renderer.js').then(m => m.drawGrid());
        import('./engine.playmode.js').then(m => m.drawCameraBounds());
    }, 80);
}

/* ── Hide/show editor UI ── */
const HIDE_SELECTORS = ['.menu-bar','#panel-left','#panel-right','#panel-bottom','.toolbar'];

function _hideEditorUI() {
    HIDE_SELECTORS.forEach(sel =>
        document.querySelectorAll(sel).forEach(el => {
            el.dataset.pmHidden = '1';
            el.style.display = 'none';
        })
    );
    document.getElementById('camera-bounds-overlay')?.remove();

    const bar = document.createElement('div');
    bar.id = 'play-mode-bar';
    bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;gap:4px;background:rgba(10,16,24,0.85);backdrop-filter:blur(8px);border:1px solid #3A72A5;border-radius:6px;padding:6px 10px;box-shadow:0 4px 24px rgba(0,0,0,0.7);';
    bar.innerHTML = `
        <button id="pm-play"  style="background:rgba(74,222,128,0.15);border:1px solid #4ade80;color:#4ade80;border-radius:4px;padding:6px 16px;cursor:pointer;font-size:12px;font-weight:bold;letter-spacing:0.5px;">▶ PLAYING</button>
        <button id="pm-pause" title="Pause (P)" style="background:rgba(250,204,21,0.1);border:1px solid #facc15;color:#facc15;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:13px;">⏸</button>
        <button id="pm-stop"  title="Stop (Space / Esc)" style="background:rgba(248,113,113,0.1);border:1px solid #f87171;color:#f87171;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;">■ Stop</button>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#pm-pause').onclick = () => pausePlayMode();
    bar.querySelector('#pm-stop').onclick  = () => stopPlayMode();
}

function _showEditorUI() {
    document.querySelectorAll('[data-pm-hidden]').forEach(el => {
        el.style.display = '';
        delete el.dataset.pmHidden;
    });
    document.getElementById('play-mode-bar')?.remove();
}

/* ── Gizmos + grid ── */
function _hideAllGizmosAndGrid() {
    state.gameObjects.forEach(obj => {
        if (obj._gizmoContainer) obj._gizmoContainer.visible = false;
        // Hide light helpers in play mode
        if (obj.isLight && obj._lightHelper) obj._lightHelper.visible = false;
    });
    if (state.gridGraphics) state.gridGraphics.visible = false;
    if (state.spriteBox)    state.spriteBox.visible    = false;
}

function _showGrid() {
    if (state.gridGraphics) state.gridGraphics.visible = true;
}

function _deselect() {
    if (state.gameObject) {
        const gc = state.gameObject._gizmoContainer;
        if (gc) gc.visible = false;
    }
    state.gameObject = null;
}

/* ── Play overlays ── */
function _showPlayOverlay() {
    const pause = document.createElement('div');
    pause.id = 'play-pause-overlay';
    pause.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;flex-direction:column;gap:16px;';
    pause.innerHTML = '<div style="font-size:64px;color:rgba(250,204,21,0.9);filter:drop-shadow(0 0 24px #facc15);">⏸</div><div style="color:#facc15;font-size:20px;letter-spacing:4px;font-weight:bold;">PAUSED</div><div style="color:#555;font-size:11px;">Press ⏸ to resume</div>';
    document.body.appendChild(pause);

    const stats = document.createElement('div');
    stats.id = 'play-stats-bar';
    stats.style.cssText = 'position:fixed;bottom:14px;right:18px;z-index:9999;color:rgba(74,222,128,0.7);font-family:monospace;font-size:11px;text-align:right;pointer-events:none;line-height:1.7;text-shadow:0 1px 4px rgba(0,0,0,0.8);';
    document.body.appendChild(stats);

    const res = document.createElement('div');
    res.id = 'play-res-label';
    res.style.cssText = 'position:fixed;bottom:14px;left:18px;z-index:9999;color:rgba(255,255,255,0.2);font-family:monospace;font-size:10px;pointer-events:none;';
    res.textContent = `${GAME_WIDTH}×${GAME_HEIGHT}  ·  PREVIEW MODE`;
    document.body.appendChild(res);
}

function _removePlayOverlay() {
    ['play-pause-overlay','play-stats-bar','play-res-label'].forEach(id => document.getElementById(id)?.remove());
}

/* ── FPS counter ── */
let _fpsInt = null;
function _startFPSCounter() {
    _stopFPSCounter();
    _fpsInt = setInterval(() => {
        const bar = document.getElementById('play-stats-bar');
        if (!bar || !state.app) return;
        const fps  = Math.round(state.app.ticker.FPS);
        const col  = fps >= 55 ? '#4ade80' : fps >= 30 ? '#facc15' : '#f87171';
        const objs = state.gameObjects.length;
        bar.innerHTML = `<div style="color:${col}">${fps} FPS</div><div style="color:rgba(255,255,255,0.3)">${objs} obj</div>`;
    }, 250);
}
function _stopFPSCounter() { if (_fpsInt) { clearInterval(_fpsInt); _fpsInt = null; } }

/* ── Button states ── */
function _updatePlayButtons() {
    const pmPause = document.getElementById('pm-pause');
    const pmPlay  = document.getElementById('pm-play');
    if (pmPause) { pmPause.textContent = state.isPaused ? '▶' : '⏸'; }
    if (pmPlay)  {
        pmPlay.textContent = state.isPaused ? '⏸ PAUSED' : '▶ PLAYING';
        pmPlay.style.color = state.isPaused ? '#facc15' : '#4ade80';
        pmPlay.style.borderColor = state.isPaused ? '#facc15' : '#4ade80';
    }
    ['btn-play','btn-pause','btn-stop'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', false);
    });
    const pb = document.getElementById('btn-play');
    if (pb) pb.classList.toggle('active', state.isPlaying && !state.isPaused);
}

/* ── Snapshot / restore ── */
function _snapshotScene() {
    return {
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
                prefabId: obj.prefabId || null, x: obj.x, y: obj.y,
                scaleX: obj.scale.x, scaleY: obj.scale.y, rotation: obj.rotation, unityZ: obj.unityZ || 0,
                tint: obj.spriteGraphic?.tint ?? 0xFFFFFF,
                animations: obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
                activeAnimIndex: obj.activeAnimIndex || 0,
            };
        }),
        camX: state.sceneContainer?.x ?? 0, camY: state.sceneContainer?.y ?? 0,
        camScaleX: state.sceneContainer?.scale.x ?? 1, camScaleY: state.sceneContainer?.scale.y ?? 1,
        selectedLabel: state.gameObject?.label ?? null,
    };
}

function _restoreScene(snap) {
    for (const obj of state.gameObjects) {
        state.sceneContainer?.removeChild(obj);
        try { obj.destroy({ children: true }); } catch(_) {}
    }
    state.gameObjects = []; state.gameObject = null; state.gizmoContainer = null;
    if (state.sceneContainer) {
        state.sceneContainer.x = snap.camX; state.sceneContainer.y = snap.camY;
        state.sceneContainer.scale.x = snap.camScaleX; state.sceneContainer.scale.y = snap.camScaleY;
    }

    const restorePromises = snap.objects.map(s => {
        if (s.isLight) {
            return import('./engine.lights.js').then(({ createLight, _buildLightHelper }) => {
                const obj = createLight(s.lightType, s.x, s.y);
                if (!obj) return null;
                obj.label = s.label; obj.unityZ = s.unityZ || 0;
                obj.lightProps = JSON.parse(JSON.stringify(s.lightProps));
                _buildLightHelper(obj);
                return obj;
            });
        }
        return import('./engine.objects.js').then(({ createImageObject, selectObject }) => {
            if (s.isImage && s.assetId) {
                const asset = state.assets.find(a => a.id === s.assetId);
                if (!asset) return null;
                const obj = createImageObject(asset, s.x, s.y);
                if (!obj) return null;
                obj.label = s.label; obj.scale.x = s.scaleX; obj.scale.y = s.scaleY;
                obj.rotation = s.rotation; obj.unityZ = s.unityZ; obj.prefabId = s.prefabId || null;
                if (obj.spriteGraphic?.tint !== undefined) obj.spriteGraphic.tint = s.tint;
                if (s.animations?.length) { obj.animations = JSON.parse(JSON.stringify(s.animations)); obj.activeAnimIndex = s.activeAnimIndex || 0; }
                if (state._bindGizmoHandles) state._bindGizmoHandles(obj);
                return obj;
            }
            return null;
        });
    });

    Promise.all(restorePromises).then(() => {
        import('./engine.objects.js').then(({ selectObject }) => {
            const target = snap.selectedLabel ? state.gameObjects.find(o => o.label === snap.selectedLabel) : null;
            if (target) selectObject(target);
            else import('./engine.ui.js').then(m => { m.syncPixiToInspector(); m.refreshHierarchy(); });
        });
    });
}

function _logConsole(msg,color='#e0e0e0'){
    const c=document.getElementById('console-output')||document.getElementById('tab-console');if(!c)return;
    const l=document.createElement('div');l.style.color=color;l.textContent=msg;
    c.appendChild(l);c.scrollTop=c.scrollHeight;
}

/* ============================================================
   🎮 SURPRISE: Mini Runtime — plays object animations in Play Mode
   Objects with animations actually animate when you press Play.
   Uses PIXI.AnimatedSprite for smooth frame playback.
   ============================================================ */

export function startRuntimeAnimations() {
    for (const obj of state.gameObjects) {
        if (obj.isLight) { obj.visible = false; continue; } // lights invisible in play
        obj.visible = true;
        _playObjectIdleAnim(obj);
    }
    _startCulling();
}

export function stopRuntimeAnimations() {
    _stopCulling();
    for (const obj of state.gameObjects) {
        _stopObjectAnim(obj);
        obj.visible = true;
        // Restore light helpers
        if (obj.isLight && obj._lightHelper) obj._lightHelper.visible = true;
    }
}

/* ── Camera Culling ─────────────────────────────────────────── */
let _cullTicker = null;

function _startCulling() {
    _stopCulling();
    _cullTicker = () => {
        if (!state.isPlaying || !state.app || !state.sceneContainer) return;
        const sc = state.sceneContainer;
        const hw = GAME_WIDTH  / 2;
        const hh = GAME_HEIGHT / 2;
        // Camera edges in screen space
        const camLeft   = sc.x - hw * sc.scale.x;
        const camRight  = sc.x + hw * sc.scale.x;
        const camTop    = sc.y - hh * sc.scale.y;
        const camBottom = sc.y + hh * sc.scale.y;

        for (const obj of state.gameObjects) {
            if (obj.isLight) continue;
            const bounds = obj.getBounds();
            if (bounds.width < 1 || bounds.height < 1) continue;
            // Fully outside → hide
            if (bounds.right  < camLeft  || bounds.left   > camRight ||
                bounds.bottom < camTop   || bounds.top    > camBottom) {
                obj.visible = false;
                if (obj._cullMask) { obj.mask = null; }
            } else {
                obj.visible = true;
                // Partial clip → apply mask
                const fullyInside = bounds.left >= camLeft && bounds.right  <= camRight &&
                                    bounds.top  >= camTop  && bounds.bottom <= camBottom;
                if (!fullyInside) {
                    _applyBoundsMask(obj, sc, camLeft, camTop, camRight, camBottom);
                } else if (obj._cullMask) {
                    obj.mask = null;
                }
            }
        }
    };
    state.app.ticker.add(_cullTicker);
}

function _stopCulling() {
    if (_cullTicker && state.app) {
        try { state.app.ticker.remove(_cullTicker); } catch(_) {}
        _cullTicker = null;
    }
    for (const obj of state.gameObjects) {
        if (obj._cullMask) {
            obj.mask = null;
            try { obj._cullMask.destroy(); } catch(_) {}
            obj._cullMask = null;
        }
    }
}

function _applyBoundsMask(obj, sc, camLeft, camTop, camRight, camBottom) {
    const tl = sc.toLocal({ x: camLeft,  y: camTop    });
    const br = sc.toLocal({ x: camRight, y: camBottom  });
    if (!obj._cullMask) {
        obj._cullMask = new PIXI.Graphics();
        sc.addChildAt(obj._cullMask, 0);
    }
    const m = obj._cullMask;
    m.clear();
    m.beginFill(0xFFFFFF, 1);
    m.drawRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    m.endFill();
    obj.mask = m;
}

function _playObjectIdleAnim(obj) {
    if (!obj.animations?.length) return;

    // Find the active (or idle) animation
    const anim = obj.animations[obj.activeAnimIndex || 0] || obj.animations[0];
    if (!anim?.frames?.length) return;

    // Build PIXI AnimatedSprite
    const textures = anim.frames.map(f => {
        try { return PIXI.Texture.from(f.dataURL); }
        catch (_) { return PIXI.Texture.WHITE; }
    });

    if (textures.length === 0) return;

    // Remove old animated sprite
    if (obj._runtimeSprite) {
        obj.removeChild(obj._runtimeSprite);
        try { obj._runtimeSprite.destroy(); } catch (_) {}
        obj._runtimeSprite = null;
    }

    const as = new PIXI.AnimatedSprite(textures);
    as.animationSpeed = Math.max(0.01, (anim.fps || 12) / 60);
    as.loop           = anim.loop !== false;
    as.anchor.set(0.5);

    // Match size to existing spriteGraphic
    if (obj.spriteGraphic) {
        const sg = obj.spriteGraphic;
        as.width  = sg.width  || 100;
        as.height = sg.height || 100;
        as.tint   = sg.tint   ?? 0xFFFFFF;
        obj.removeChild(sg);
        obj._savedSpriteGraphic = sg;
    }

    obj.addChildAt(as, 0);
    obj._runtimeSprite = as;
    as.play();
}

function _stopObjectAnim(obj) {
    if (obj._runtimeSprite) {
        obj.removeChild(obj._runtimeSprite);
        try { obj._runtimeSprite.destroy(); } catch (_) {}
        obj._runtimeSprite = null;
    }
    // Restore original graphic
    if (obj._savedSpriteGraphic) {
        obj.addChildAt(obj._savedSpriteGraphic, 0);
        obj.spriteGraphic       = obj._savedSpriteGraphic;
        obj._savedSpriteGraphic = null;
    }
}
