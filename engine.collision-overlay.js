/* ============================================================
   Zengine — engine.collision-overlay.js
   Draws collision shape overlays on every physics-enabled object
   in the editor viewport.  Works as a PIXI ticker so it stays
   in sync when objects are moved/scaled/rotated.

   Public API
   ──────────
   initCollisionOverlay()   — call once after PIXI is ready
   refreshCollisionOverlay()— redraw everything now
   setCollisionVisible(v)   — show / hide all overlays
   ============================================================ */

import { state } from './engine.state.js';

// ── Module-level PIXI.Graphics layer ─────────────────────────
let _layer      = null;   // PIXI.Graphics  — lives above sceneContainer
let _ticker     = null;   // PIXI.Ticker callback ref
let _visible    = false;

// ─────────────────────────────────────────────────────────────
// Init — must be called after state.app is ready
// ─────────────────────────────────────────────────────────────
export function initCollisionOverlay() {
    if (_layer) return;
    if (!state.app) return;

    _layer = new PIXI.Graphics();
    _layer.zIndex = 9999;
    _layer.visible = false;
    state.app.stage.addChild(_layer);

    // Redraw every frame so it tracks object movement
    _ticker = () => {
        if (_visible && !state.isPlaying) _redrawAll();
    };
    state.app.ticker.add(_ticker);
}

// ─────────────────────────────────────────────────────────────
// Show / Hide
// ─────────────────────────────────────────────────────────────
export function setCollisionVisible(v) {
    _visible = v;
    state.showCollision = v;
    if (_layer) {
        _layer.visible = v;
        if (v) _redrawAll();
        else   _layer.clear();
    }
    // Update toolbar badge
    const badge = document.getElementById('collision-toggle-badge');
    const btn   = document.getElementById('btn-collision-toggle');
    if (badge) badge.style.display = v ? 'block' : 'none';
    if (btn)   btn.classList.toggle('active', v);
}

export function refreshCollisionOverlay() {
    if (_visible && _layer) _redrawAll();
}

// ─────────────────────────────────────────────────────────────
// Core draw — loops over all game objects
// ─────────────────────────────────────────────────────────────
function _redrawAll() {
    if (!_layer) return;
    _layer.clear();
    if (!state.sceneContainer) return;

    // We draw in stage-space (not world-space), so we need the
    // sceneContainer's world transform.
    const sc = state.sceneContainer;

    for (const obj of state.gameObjects) {
        _drawObjectCollision(obj, sc);
    }
}

function _drawObjectCollision(obj, sc) {
    // ── Tilemap ──────────────────────────────────────────
    if (obj.isTilemap && obj.tilemapData) {
        _drawTilemapCollision(obj, sc);
        return;
    }
    if (obj.isAutoTilemap && obj.autoTileData) {
        _drawAutoTilemapCollision(obj, sc);
        return;
    }

    // ── Regular sprite ───────────────────────────────────
    const type = obj.physicsBody ?? 'none';
    if (type === 'none') return;   // no physics → nothing to show

    const shape = obj.physicsShape ?? 'box';
    const sx    = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy    = Math.abs(obj.scale?.y ?? 1) || 1;

    // Compute raw (unscaled) pixel size
    const raw = _rawSize(obj);
    const w   = raw.w * sx;
    const h   = raw.h * sy;

    // World position (with scene container transform applied)
    const wx  = sc.x + obj.x * sc.scale.x;
    const wy  = sc.y + obj.y * sc.scale.y;
    const wsx = sx   * sc.scale.x;
    const wsy = sy   * sc.scale.y;
    const rot = obj.rotation ?? 0;

    // Colour by body type
    const col = _bodyColor(type);

    _layer.lineStyle(1.5, col, 0.85);
    _layer.beginFill(col, 0.10);

    if (shape === 'circle') {
        const r = Math.max(Math.min(w, h) / 2, 2) * sc.scale.x;
        _drawRotatedCircle(wx, wy, r, rot);
    } else if ((shape === 'polygon') && _hasPolygon(obj)) {
        const poly = _getPolygon(obj);
        _drawPolygon(wx, wy, poly, wsx, wsy, rot);
    } else {
        // Box (default)
        _drawRotatedRect(wx, wy, w * sc.scale.x, h * sc.scale.y, rot);
    }

    _layer.endFill();

    // Origin dot
    _layer.lineStyle(0);
    _layer.beginFill(col, 0.9);
    _layer.drawCircle(wx, wy, 2.5);
    _layer.endFill();
}

// ─────────────────────────────────────────────────────────────
// Tilemap helpers
// ─────────────────────────────────────────────────────────────
function _drawTilemapCollision(obj, sc) {
    const td = obj.tilemapData;
    _layer.lineStyle(1, 0x38bdf8, 0.6);
    _layer.beginFill(0x38bdf8, 0.08);
    for (let r = 0; r < td.rows; r++) {
        for (let c = 0; c < td.cols; c++) {
            if (!td.tiles[r * td.cols + c]) continue;
            const wx = sc.x + (obj.x + c * td.tileW + td.tileW / 2) * sc.scale.x;
            const wy = sc.y + (obj.y + r * td.tileH + td.tileH / 2) * sc.scale.y;
            const tw = td.tileW * sc.scale.x;
            const th = td.tileH * sc.scale.y;
            _layer.drawRect(wx - tw/2, wy - th/2, tw, th);
        }
    }
    _layer.endFill();
}

function _drawAutoTilemapCollision(obj, sc) {
    const d = obj.autoTileData;
    _layer.lineStyle(1, 0x38bdf8, 0.6);
    _layer.beginFill(0x38bdf8, 0.08);
    for (let r = 0; r < d.rows; r++) {
        for (let c = 0; c < d.cols; c++) {
            const v = d.cells[r * d.cols + c];
            if (!(Array.isArray(v) ? v.length : v)) continue;
            const wx = sc.x + (obj.x + c * d.tileW + d.tileW / 2) * sc.scale.x;
            const wy = sc.y + (obj.y + r * d.tileH + d.tileH / 2) * sc.scale.y;
            const tw = d.tileW * sc.scale.x;
            const th = d.tileH * sc.scale.y;
            _layer.drawRect(wx - tw/2, wy - th/2, tw, th);
        }
    }
    _layer.endFill();
}

// ─────────────────────────────────────────────────────────────
// Shape draw helpers
// ─────────────────────────────────────────────────────────────
function _drawRotatedRect(cx, cy, w, h, angle) {
    if (Math.abs(angle) < 0.001) {
        _layer.drawRect(cx - w/2, cy - h/2, w, h);
        return;
    }
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const hw  = w/2, hh = h/2;
    const corners = [
        { x: -hw, y: -hh }, { x: hw, y: -hh },
        { x: hw, y:  hh }, { x: -hw, y: hh },
    ];
    const pts = corners.map(p => ({
        x: cx + p.x * cos - p.y * sin,
        y: cy + p.x * sin + p.y * cos,
    }));
    _layer.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _layer.lineTo(pts[i].x, pts[i].y);
    _layer.closePath();
}

function _drawRotatedCircle(cx, cy, r, angle) {
    // Circle doesn't rotate visually, but we draw a cross indicator for orientation
    _layer.drawCircle(cx, cy, r);
    // Orientation line
    const ex = cx + Math.cos(angle) * r;
    const ey = cy + Math.sin(angle) * r;
    _layer.moveTo(cx, cy);
    _layer.lineTo(ex, ey);
}

function _drawPolygon(cx, cy, poly, wsx, wsy, angle) {
    if (!poly || poly.length < 3) return;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const pts = poly.map(p => {
        const lx = p.x * wsx;
        const ly = p.y * wsy;
        return {
            x: cx + lx * cos - ly * sin,
            y: cy + lx * sin + ly * cos,
        };
    });
    _layer.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _layer.lineTo(pts[i].x, pts[i].y);
    _layer.closePath();
    // Vertex dots
    _layer.lineStyle(0);
    _layer.beginFill(0xa78bfa, 0.9);
    pts.forEach(p => _layer.drawCircle(p.x, p.y, 2));
    _layer.endFill();
    _layer.lineStyle(1.5, _bodyColor('polygon'), 0.85);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function _bodyColor(type) {
    switch (type) {
        case 'static':    return 0x4ade80;
        case 'dynamic':   return 0x60a5fa;
        case 'kinematic': return 0xfacc15;
        case 'polygon':   return 0xa78bfa;
        default:          return 0x94a3b8;
    }
}

function _rawSize(obj) {
    const src = obj.spriteGraphic || obj._runtimeSprite;
    if (src?.texture?.orig) return { w: src.texture.orig.width,  h: src.texture.orig.height };
    if (src?.texture?.width) return { w: src.texture.width,       h: src.texture.height };
    const sx = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy = Math.abs(obj.scale?.y ?? 1) || 1;
    if (src?.width && src?.height) return { w: src.width / sx,  h: src.height / sy };
    return { w: 40, h: 40 };
}

function _hasPolygon(obj) {
    const map = obj.physicsPolygons;
    if (!map) return !!(obj.physicsPolygon?.length >= 3);
    const anim    = obj.animations?.[obj.activeAnimIndex ?? 0];
    const frameId = anim?.frames?.[0]?.id;
    if (frameId && Array.isArray(map[frameId]) && map[frameId].length >= 3) return true;
    return Array.isArray(map.shared) && map.shared.length >= 3;
}

function _getPolygon(obj) {
    const map = obj.physicsPolygons;
    if (!map) return obj.physicsPolygon || null;
    const anim    = obj.animations?.[obj.activeAnimIndex ?? 0];
    const frameId = anim?.frames?.[0]?.id;
    if (frameId && Array.isArray(map[frameId]) && map[frameId].length >= 3) return map[frameId];
    return map.shared || null;
}
