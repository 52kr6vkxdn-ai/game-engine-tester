/* ============================================================
   Zengine — engine.autotile.js
   Auto-tile brush system: 16-tile (4×4 blob) neighbor-aware
   tilemap painter, integrated as a first-class scene object.

   Multi-brush: each AutoTilemap can reference named brushes
   stored in state.tilesetBrushes (shared registry).

   Exported surface:
     createAutoTilemap(x?, y?)       → PIXI.Container
     restoreAutoTilemap(snapshot)    → Promise<PIXI.Container>
     buildAutoTileInspectorHTML(obj) → string
     openAutoTileEditor(obj)         → void
     rebuildAutoTileSprites(obj)     → void
   ============================================================ */

import { state } from './engine.state.js';

// ── Constants ─────────────────────────────────────────────────
const TILE_SIZE    = 40;
const DEFAULT_COLS = 20;
const DEFAULT_ROWS = 15;

/**
 * 4-neighbor bitmask → slot index (0-15).
 * Bits: N=1  E=2  S=4  W=8
 */
const BITMASK_TO_SLOT = {
     0: 15,  1: 11,  2: 12,  3:  6,
     4:  9,  5: 10,  6:  0,  7:  3,
     8: 14,  9:  8, 10: 13, 11:  7,
    12:  2, 13:  5, 14:  1, 15:  4,
};

// Layout for the 16-slot visual grid (4 rows × 4 cols)
const SLOT_LAYOUT = [
    [0,  1,  2,  9],
    [3,  4,  5, 10],
    [6,  7,  8, 11],
    [12, 13, 14, 15],
];

// 4×4 sheet left-to-right-top-to-bottom index → slot id
const SHEET_TO_SLOT = [0, 1, 2, 9, 3, 4, 5, 10, 6, 7, 8, 11, 12, 13, 14, 15];

// ─────────────────────────────────────────────────────────────
// Brush registry helpers (state.tilesetBrushes)
// ─────────────────────────────────────────────────────────────

function _ensureBrushRegistry() {
    if (!Array.isArray(state.tilesetBrushes)) state.tilesetBrushes = [];
}

function _newBrush(name = 'New Brush') {
    _ensureBrushRegistry();
    const id = 'brush_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const brush = { id, name, tiles: new Array(16).fill(null) };
    state.tilesetBrushes.push(brush);
    return brush;
}

function _getBrush(id) {
    _ensureBrushRegistry();
    return state.tilesetBrushes.find(b => b.id === id) || null;
}

// ─────────────────────────────────────────────────────────────
// Internal PIXI helpers
// ─────────────────────────────────────────────────────────────

function _uniqueName(base) {
    const existing = new Set(state.gameObjects.map(o => o.label));
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
}

function _attachTranslateGizmo(container) {
    const gc = new PIXI.Container();
    container.addChild(gc);
    container._gizmoContainer = gc;

    const g1 = _makeAxisLine(0xFF4F4B, 50, false);
    const g2 = _makeAxisLine(0x8FC93A, 50, true);
    const g3 = _makeSquare();

    const grpT = new PIXI.Container(); grpT.addChild(g1, g2, g3);
    const grpR = new PIXI.Container(); grpR.visible = false;
    const grpS = new PIXI.Container(); grpS.visible = false;

    container._grpTranslate = grpT;
    container._grpRotate    = grpR;
    container._grpScale     = grpS;
    gc.addChild(grpT, grpR, grpS);

    container._gizmoHandles = {
        transX: g1, transY: g2, transCenter: g3,
        scaleX: g1, scaleY: g2, scaleCenter: g3,
        rotRing: g3,
    };
    [g1, g2, g3].forEach(h => h.on('pointerdown', e => e.stopPropagation()));
}

function _makeAxisLine(color, len, isY) {
    const g = new PIXI.Graphics();
    g.beginFill(color); g.lineStyle(2, color);
    if (isY) g.drawRect(-1, -len, 2, len); else g.drawRect(0, -1, len, 2);
    g.lineStyle(0);
    if (isY) { g.moveTo(-5, -len); g.lineTo(0, -len - 9); g.lineTo(5, -len); }
    else     { g.moveTo(len, -5);  g.lineTo(len + 9, 0);   g.lineTo(len, 5); }
    g.endFill(); g.eventMode = 'static'; return g;
}

function _makeSquare() {
    const g = new PIXI.Graphics();
    g.beginFill(0xFFFFFF, 0.4); g.drawRect(-7, -7, 14, 14); g.endFill();
    g.eventMode = 'static'; g.cursor = 'move'; return g;
}

// ─────────────────────────────────────────────────────────────
// Wireframe helper (editor only, hidden in play mode)
// ─────────────────────────────────────────────────────────────

function _buildAutoTileHelper(container) {
    if (container._autoTileHelper) {
        container.removeChild(container._autoTileHelper);
        try { container._autoTileHelper.destroy(); } catch (_) {}
    }

    const d = container.autoTileData;
    const W = d.cols * d.tileW, H = d.rows * d.tileH;

    const g = new PIXI.Graphics();
    g.lineStyle(1, 0x4ade80, 0.7);
    g.drawRect(0, 0, W, H);
    g.lineStyle(0.5, 0x4ade80, 0.18);
    for (let x = 1; x < d.cols; x++) { g.moveTo(x * d.tileW, 0); g.lineTo(x * d.tileW, H); }
    for (let y = 1; y < d.rows; y++) { g.moveTo(0, y * d.tileH); g.lineTo(W, y * d.tileH); }

    const lbl = new PIXI.Text(`Auto-Tile  ${d.cols}×${d.rows}`, {
        fontSize: 11, fill: 0x4ade80, fontFamily: 'sans-serif',
    });
    lbl.alpha = 0.65; lbl.x = 4; lbl.y = 2;

    const helper = new PIXI.Container();
    helper.addChild(g, lbl);
    helper.isHelper = true;
    container._autoTileHelper = helper;
    container.addChildAt(helper, 0);
}

// ─────────────────────────────────────────────────────────────
// Sprite layer
// ─────────────────────────────────────────────────────────────

function _calcBitmask(d, col, row) {
    let m = 0;
    if (row > 0          && d.cells[(row - 1) * d.cols + col])        m += 1;
    if (col < d.cols - 1 && d.cells[row       * d.cols + (col + 1)]) m += 2;
    if (row < d.rows - 1 && d.cells[(row + 1) * d.cols + col])        m += 4;
    if (col > 0          && d.cells[row       * d.cols + (col - 1)]) m += 8;
    return m;
}

export function rebuildAutoTileSprites(container) {
    if (container._spriteLayer) {
        container.removeChild(container._spriteLayer);
        try { container._spriteLayer.destroy({ children: true }); } catch (_) {}
    }

    const layer = new PIXI.Container();
    container._spriteLayer = layer;
    container.addChildAt(layer, container._autoTileHelper ? 1 : 0);

    const d = container.autoTileData;

    // Resolve active brushList: inline OR from registry (multi-brush merge)
    const brushList = _resolveBrushList(d);

    for (let row = 0; row < d.rows; row++) {
        for (let col = 0; col < d.cols; col++) {
            const cellVal = d.cells[row * d.cols + col];
            if (!cellVal) continue;

            // cellVal can be 1 (default brush) or a brushId string for multi-brush
            const slotDataURLs = typeof cellVal === 'string'
                ? (_getBrush(cellVal)?.tiles || brushList)
                : brushList;

            const mask    = _calcBitmask(d, col, row);
            const slotId  = BITMASK_TO_SLOT[mask] ?? 15;
            const dataURL = slotDataURLs[slotId];
            if (!dataURL) continue;

            const tex = PIXI.Texture.from(dataURL);
            const spr = new PIXI.Sprite(tex);
            spr.x = col * d.tileW; spr.y = row * d.tileH;
            spr.width = d.tileW;   spr.height = d.tileH;
            layer.addChild(spr);
        }
    }
}

/**
 * Build a merged brushList from the autoTileData.
 * If activeBrushIds is set, merges those brushes in order (later ones override).
 * Falls back to inline brushList.
 */
function _resolveBrushList(d) {
    if (d.activeBrushIds && d.activeBrushIds.length) {
        const merged = new Array(16).fill(null);
        for (const bid of d.activeBrushIds) {
            const b = _getBrush(bid);
            if (!b) continue;
            b.tiles.forEach((url, i) => { if (url) merged[i] = url; });
        }
        return merged;
    }
    return d.brushList || new Array(16).fill(null);
}

// ─────────────────────────────────────────────────────────────
// Public: create
// ─────────────────────────────────────────────────────────────

export function createAutoTilemap(x = 0, y = 0) {
    _ensureBrushRegistry();
    const label = _uniqueName('Auto-Tile');

    const container = new PIXI.Container();
    container.x = x; container.y = y;
    container.isAutoTilemap   = true;
    container.isTilemap       = false;
    container.isLight         = false;
    container.isImage         = false;
    container.label           = label;
    container.unityZ          = 0;
    container.animations      = [];
    container.activeAnimIndex = 0;

    container.autoTileData = {
        tileW:         TILE_SIZE,
        tileH:         TILE_SIZE,
        cols:          DEFAULT_COLS,
        rows:          DEFAULT_ROWS,
        brushList:     new Array(16).fill(null), // legacy inline slots
        activeBrushIds: [],                       // ids from state.tilesetBrushes
        cells:         new Uint8Array(DEFAULT_COLS * DEFAULT_ROWS),
    };

    _buildAutoTileHelper(container);
    _attachTranslateGizmo(container);
    if (state._bindGizmoHandles) state._bindGizmoHandles(container);

    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);

    container.eventMode = 'static';
    container.cursor    = 'pointer';
    container.on('pointerdown', e => {
        if (state.isPlaying) { e.stopPropagation(); return; }
        if (e.button !== 0) return;
        import('./engine.objects.js').then(m => m.selectObject(container));
    });

    import('./engine.objects.js').then(m => m.selectObject(container));
    import('./engine.ui.js').then(m => m.refreshHierarchy());
    return container;
}

// ─────────────────────────────────────────────────────────────
// Public: restore from snapshot
// ─────────────────────────────────────────────────────────────

export async function restoreAutoTilemap(s) {
    _ensureBrushRegistry();
    const obj = createAutoTilemap(s.x, s.y);
    obj.label  = s.label;
    obj.unityZ = s.unityZ || 0;

    const td = s.autoTileData;
    obj.autoTileData = {
        tileW:          td.tileW     ?? TILE_SIZE,
        tileH:          td.tileH     ?? TILE_SIZE,
        cols:           td.cols      ?? DEFAULT_COLS,
        rows:           td.rows      ?? DEFAULT_ROWS,
        brushList:      td.brushList ? td.brushList.slice() : new Array(16).fill(null),
        activeBrushIds: td.activeBrushIds ? td.activeBrushIds.slice() : [],
        cells: td.cells instanceof Uint8Array
            ? new Uint8Array(td.cells)
            : new Uint8Array(td.cells),
    };

    _buildAutoTileHelper(obj);
    rebuildAutoTileSprites(obj);
    return obj;
}

// ─────────────────────────────────────────────────────────────
// Public: inspector HTML
// ─────────────────────────────────────────────────────────────

export function buildAutoTileInspectorHTML(obj) {
    _ensureBrushRegistry();
    const d          = obj.autoTileData;
    const filled     = d.cells ? Array.from(d.cells).filter(Boolean).length : 0;
    const activeIds  = d.activeBrushIds || [];
    const brushCount = activeIds.length
        ? activeIds.length + ' brush' + (activeIds.length > 1 ? 'es' : '') + ' active'
        : ((d.brushList || []).filter(Boolean).length + ' / 16 inline slots');

    return `
    <div class="component-block" id="inspector-autotile-section">
      <div class="component-header">
        <svg viewBox="0 0 24 24" class="comp-icon"
             style="color:#4ade80;fill:none;stroke:currentColor;stroke-width:2;">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>
          <circle cx="12" cy="12" r="2" fill="#4ade80" stroke="none"/>
        </svg>
        <span style="font-weight:600;color:#4ade80;">Auto-Tile</span>
      </div>
      <div class="component-body" style="display:flex;flex-direction:column;gap:5px;">
        <div class="prop-row">
          <span class="prop-label">Grid</span>
          <span style="color:#9bc;">${d.cols} × ${d.rows} tiles</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Tile size</span>
          <span style="color:#9bc;">${d.tileW} × ${d.tileH} px</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Brushes</span>
          <span style="color:#9bc;font-size:10px;">${brushCount}</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Painted</span>
          <span style="color:#9bc;">${filled} tiles</span>
        </div>
        <button id="btn-open-autotile-editor"
          style="width:100%;background:#1a2a1a;border:1px solid #4ade80;color:#4ade80;
                 border-radius:4px;padding:6px;cursor:pointer;font-size:11px;margin-top:4px;
                 display:flex;align-items:center;justify-content:center;gap:6px;">
          <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Open Auto-Tile Editor
        </button>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// Public: full-screen editor
// ─────────────────────────────────────────────────────────────

export function openAutoTileEditor(obj) {
    _ensureBrushRegistry();
    document.getElementById('autotile-editor-panel')?.remove();

    const d = obj.autoTileData;
    if (!Array.isArray(d.activeBrushIds)) d.activeBrushIds = [];

    const panel = document.createElement('div');
    panel.id = 'autotile-editor-panel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);font-family:sans-serif;font-size:13px;';

    panel.innerHTML = `
<div style="display:flex;width:100%;height:100%;overflow:hidden;">

  <!-- ── PANEL A: Brush Manager ── -->
  <div id="at-brush-manager" style="width:240px;min-width:200px;background:#0e0e1c;border-right:1px solid #1e1e38;display:flex;flex-direction:column;overflow:hidden;">
    <div style="padding:10px 12px 8px;border-bottom:1px solid #1e1e38;display:flex;align-items:center;justify-content:space-between;">
      <span style="color:#4ade80;font-weight:700;font-size:13px;">Brush Library</span>
      <button id="at-new-brush" style="${_bs('#4ade80')}font-size:11px;">+ New</button>
    </div>
    <div id="at-brush-list" style="flex:1;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:4px;"></div>
    <div style="padding:8px 10px;border-top:1px solid #1e1e38;">
      <div style="color:#555;font-size:9px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Active on this tilemap</div>
      <div id="at-active-brush-list" style="display:flex;flex-direction:column;gap:3px;"></div>
    </div>
  </div>

  <!-- ── PANEL B: Slot Editor ── -->
  <div id="at-slot-panel" style="width:310px;min-width:260px;background:#0d0d1e;border-right:1px solid #1e1e38;display:flex;flex-direction:column;overflow:hidden;">
    <div style="padding:10px 12px 8px;border-bottom:1px solid #1e1e38;">
      <span style="color:#4ade80;font-weight:700;font-size:13px;">Slot Editor</span>
      <div id="at-editing-brush-name" style="color:#888;font-size:10px;margin-top:2px;">Select a brush →</div>
    </div>

    <!-- Gallery -->
    <div style="padding:8px 10px 4px;">
      <div style="display:flex;gap:5px;margin-bottom:6px;">
        <button id="at-upload-pieces" style="${_bs('#3b82f6')}flex:1;">Upload Tiles</button>
        <button id="at-upload-sheet"  style="${_bs('#7c3aed')}flex:1;">4×4 Sheet</button>
      </div>
      <div id="at-gallery" style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;max-height:100px;overflow-y:auto;"></div>
      <div id="at-gallery-empty" style="color:#444;font-size:10px;text-align:center;padding:8px 0;">Upload images to fill slots.</div>
    </div>

    <!-- Mode toggle -->
    <div style="padding:0 10px 6px;display:flex;gap:5px;">
      <button id="at-mode-drag"  style="${_toolBtn(true)}flex:1;">✦ Drag</button>
      <button id="at-mode-erase" style="${_toolBtn(false)}flex:1;">✕ Erase Pixels</button>
    </div>

    <!-- 16-slot grid -->
    <div style="flex:1;overflow-y:auto;padding:8px 10px;">
      <div id="at-slot-grid" style="display:flex;flex-direction:column;gap:5px;"></div>
    </div>

    <div style="padding:8px 10px;border-top:1px solid #1e1e38;display:flex;flex-direction:column;gap:5px;">
      <button id="at-guide-toggle" style="${_bs('#444')}font-size:10px;text-align:left;">Guides: ON</button>
    </div>

    <input id="at-file-pieces" type="file" multiple accept="image/*" style="display:none;">
    <input id="at-file-sheet"  type="file" accept="image/*"          style="display:none;">
  </div>

  <!-- ── PANEL C: Map Painter ── -->
  <div style="flex:1;background:#08080f;display:flex;flex-direction:column;overflow:hidden;">

    <!-- Toolbar -->
    <div style="padding:8px 12px;border-bottom:1px solid #1e1e38;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;flex-wrap:wrap;gap:6px;">
      <span style="color:#4ade80;font-weight:700;">Map Painter</span>
      <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">
        <!-- Paint brush selector -->
        <label style="color:#777;font-size:11px;">Paint with:
          <select id="at-paint-brush" style="${_sel()}width:110px;">
            <option value="">— default —</option>
          </select>
        </label>
        <!-- Map draw mode -->
        <button id="at-map-paint"  style="${_toolBtn(true)}">✏ Paint</button>
        <button id="at-map-erase"  style="${_toolBtn(false)}">✕ Erase Tiles</button>
        <span style="color:#333;font-size:11px;">|</span>
        <label style="color:#777;font-size:11px;">Cols <input id="at-cols" type="number" value="${d.cols}" min="5" max="80" style="width:40px;${_ni()}"></label>
        <label style="color:#777;font-size:11px;">Rows <input id="at-rows" type="number" value="${d.rows}" min="5" max="60" style="width:40px;${_ni()}"></label>
        <label style="color:#777;font-size:11px;">Tile <input id="at-tileW" type="number" value="${d.tileW}" min="8" max="128" style="width:40px;${_ni()}">px</label>
        <button id="at-apply-size" style="${_bs('#3b82f6')}">Apply</button>
        <button id="at-clear-map"  style="${_bs('#ef4444')}">Clear</button>
        <button id="at-close"      style="${_bs('#555')}">✕ Close</button>
      </div>
    </div>

    <!-- Canvas -->
    <div style="flex:1;overflow:auto;display:flex;justify-content:flex-start;align-items:flex-start;padding:16px;">
      <canvas id="at-map-canvas"
        style="cursor:crosshair;image-rendering:pixelated;box-shadow:0 0 0 1px #1e1e38,0 4px 24px #000c;"
        oncontextmenu="return false;"></canvas>
    </div>

    <div style="padding:4px 12px;color:#333;font-size:10px;flex-shrink:0;">
      Left-click: paint  •  Right-click: erase tiles  •  Hold &amp; drag  •  Use the Brush Library to add/switch brushes
    </div>
  </div>
</div>`;

    document.body.appendChild(panel);
    _wireEditor(panel, obj);
}

// ─────────────────────────────────────────────────────────────
// Editor wiring
// ─────────────────────────────────────────────────────────────

function _wireEditor(panel, obj) {
    const d = obj.autoTileData;

    // ── State ──
    let activeBrushId  = null;           // which brush is being edited in slot panel
    let slotEditorMode = 'drag';         // 'drag' | 'erase'
    let mapDrawMode    = 'paint';        // 'paint' | 'erase'
    let paintBrushId   = '';             // '' = default/merged, or a specific brush id
    let guidesOn       = true;
    let gallery        = [];             // dataURLs for current slot-editor
    let dragSrc        = null;

    // ── Slot eraser state ──
    let isSlotErasing   = false;
    let eraseCanvas     = null;
    let eraseCtx        = null;
    let eraseLast       = { x: 0, y: 0 };
    let eraseSlotId     = -1;
    let eraseBrushRef   = null;

    // ── Map canvas ──
    const mapCanvas   = panel.querySelector('#at-map-canvas');
    const mapCtx      = mapCanvas.getContext('2d');
    let mapCols = d.cols, mapRows = d.rows;
    let tileW = d.tileW, tileH = d.tileH;
    let cells   = d.cells ? new Uint8Array(d.cells) : new Uint8Array(mapCols * mapRows);
    let isMapDrawing  = false;
    let mapDrawAction = 1;
    let slotImgCache  = {};   // brushId_slotId → HTMLImageElement

    function resizeCanvas() {
        mapCanvas.width  = mapCols * tileW;
        mapCanvas.height = mapRows * tileH;
    }
    resizeCanvas();

    // ── Canvas bitmask ──
    function bitmask(col, row) {
        let m = 0;
        if (row > 0         && cells[(row-1)*mapCols+col])   m += 1;
        if (col < mapCols-1 && cells[row*mapCols+(col+1)])   m += 2;
        if (row < mapRows-1 && cells[(row+1)*mapCols+col])   m += 4;
        if (col > 0         && cells[row*mapCols+(col-1)])   m += 8;
        return m;
    }

    function _getActiveTiles() {
        // Merge all active brushes into a 16-slot array for the canvas
        const ids  = d.activeBrushIds && d.activeBrushIds.length ? d.activeBrushIds : [];
        if (!ids.length) return d.brushList || new Array(16).fill(null);
        const merged = new Array(16).fill(null);
        for (const bid of ids) {
            const b = _getBrush(bid);
            if (!b) continue;
            b.tiles.forEach((url, i) => { if (url) merged[i] = url; });
        }
        return merged;
    }

    function _getImgForCell(col, row) {
        const cellVal = cells[row * mapCols + col];
        if (!cellVal) return null;

        // Determine which brush tiles to use
        let tiles;
        const bid = paintBrushId || (typeof cellVal === 'string' ? cellVal : null);
        if (bid && bid !== '') {
            const b = _getBrush(bid);
            tiles = b ? b.tiles : _getActiveTiles();
        } else {
            tiles = _getActiveTiles();
        }

        const mask   = bitmask(col, row);
        const slotId = BITMASK_TO_SLOT[mask] ?? 15;
        const url    = tiles[slotId];
        if (!url) return null;

        const cacheKey = (bid || 'default') + '_' + slotId;
        if (slotImgCache[cacheKey]) return slotImgCache[cacheKey];

        // Kick off async load; return null this frame, re-render when done
        const img = new Image();
        img.onload = () => { slotImgCache[cacheKey] = img; renderMap(); };
        img.src = url;
        slotImgCache[cacheKey] = null;
        return null;
    }

    function renderMap() {
        mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
        for (let r = 0; r < mapRows; r++) {
            for (let c = 0; c < mapCols; c++) {
                // Checker bg
                mapCtx.fillStyle = (r+c)%2===0 ? '#0c0c1a' : '#090916';
                mapCtx.fillRect(c*tileW, r*tileH, tileW, tileH);

                if (cells[r*mapCols+c]) {
                    const img = _getImgForCell(c, r);
                    if (img) {
                        mapCtx.drawImage(img, c*tileW, r*tileH, tileW, tileH);
                    } else {
                        mapCtx.fillStyle = 'rgba(74,222,128,0.25)';
                        mapCtx.fillRect(c*tileW, r*tileH, tileW, tileH);
                    }
                }
            }
        }
        if (guidesOn) {
            mapCtx.strokeStyle = 'rgba(74,222,128,0.08)';
            mapCtx.lineWidth   = 0.5;
            for (let c = 0; c <= mapCols; c++) { mapCtx.beginPath(); mapCtx.moveTo(c*tileW,0); mapCtx.lineTo(c*tileW,mapCanvas.height); mapCtx.stroke(); }
            for (let r = 0; r <= mapRows; r++) { mapCtx.beginPath(); mapCtx.moveTo(0,r*tileH); mapCtx.lineTo(mapCanvas.width,r*tileH); mapCtx.stroke(); }
        }
    }

    function _renderCell(col, row) {
        const x = col*tileW, y = row*tileH;
        mapCtx.fillStyle = (row+col)%2===0 ? '#0c0c1a' : '#090916';
        mapCtx.fillRect(x, y, tileW, tileH);
        if (cells[row*mapCols+col]) {
            const img = _getImgForCell(col, row);
            if (img) mapCtx.drawImage(img, x, y, tileW, tileH);
            else { mapCtx.fillStyle='rgba(74,222,128,0.25)'; mapCtx.fillRect(x,y,tileW,tileH); }
        }
        if (guidesOn) { mapCtx.strokeStyle='rgba(74,222,128,0.08)'; mapCtx.lineWidth=0.5; mapCtx.strokeRect(x,y,tileW,tileH); }
    }

    function paintCell(col, row, val) {
        if (col<0||col>=mapCols||row<0||row>=mapRows) return;
        const idx = row*mapCols+col;
        const newVal = (val && paintBrushId) ? paintBrushId : val;
        if (cells[idx] === newVal) return;
        cells[idx] = newVal;
        for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++) {
            const r2=row+dr,c2=col+dc;
            if (r2>=0&&r2<mapRows&&c2>=0&&c2<mapCols) _renderCell(c2,r2);
        }
    }

    function getCell(e) {
        const rect=mapCanvas.getBoundingClientRect();
        const sx=mapCanvas.width/rect.width, sy=mapCanvas.height/rect.height;
        return { col:Math.floor(((e.clientX-rect.left)*sx)/tileW), row:Math.floor(((e.clientY-rect.top)*sy)/tileH) };
    }

    mapCanvas.addEventListener('mousedown', e => {
        isMapDrawing = true;
        mapDrawAction = (e.button===2||mapDrawMode==='erase') ? 0 : 1;
        const {col,row}=getCell(e); paintCell(col,row,mapDrawAction);
    });
    const _onMapMove = e => { if(!isMapDrawing)return; const {col,row}=getCell(e); paintCell(col,row,mapDrawAction); };
    const _onMapUp   = () => { isMapDrawing=false; };
    window.addEventListener('mousemove', _onMapMove);
    window.addEventListener('mouseup',   _onMapUp);
    mapCanvas.addEventListener('contextmenu', e => e.preventDefault());

    // ── Map draw mode buttons ──
    const mapPaintBtn = panel.querySelector('#at-map-paint');
    const mapEraseBtn = panel.querySelector('#at-map-erase');
    function setMapMode(m) {
        mapDrawMode = m;
        mapPaintBtn.style.cssText = _toolBtn(m==='paint') + 'flex:none;';
        mapEraseBtn.style.cssText = _toolBtn(m==='erase') + 'flex:none;';
    }
    mapPaintBtn.addEventListener('click', () => setMapMode('paint'));
    mapEraseBtn.addEventListener('click', () => setMapMode('erase'));

    // ── Paint-brush selector ──
    function rebuildPaintBrushSelector() {
        const sel = panel.querySelector('#at-paint-brush');
        sel.innerHTML = '<option value="">— default (merged) —</option>';
        _ensureBrushRegistry();
        state.tilesetBrushes.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id;
            opt.textContent = b.name;
            if (b.id === paintBrushId) opt.selected = true;
            sel.appendChild(opt);
        });
    }
    panel.querySelector('#at-paint-brush').addEventListener('change', e => {
        paintBrushId = e.target.value;
    });

    // ── Brush library ──
    function rebuildBrushList() {
        _ensureBrushRegistry();
        const listEl   = panel.querySelector('#at-brush-list');
        const activeEl = panel.querySelector('#at-active-brush-list');
        listEl.innerHTML = '';
        activeEl.innerHTML = '';

        state.tilesetBrushes.forEach(b => {
            const item = document.createElement('div');
            item.style.cssText = `display:flex;align-items:center;gap:5px;padding:5px 6px;border-radius:4px;cursor:pointer;border:1px solid ${activeBrushId===b.id?'#4ade80':'#1e1e38'};background:${activeBrushId===b.id?'#162816':'#111'};`;

            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'flex:1;color:#ddd;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            nameSpan.textContent   = b.name;

            const editBtn = document.createElement('button');
            editBtn.textContent  = '✏';
            editBtn.title        = 'Edit slots';
            editBtn.style.cssText= `${_bs('#4ade80')}padding:2px 5px;font-size:10px;`;
            editBtn.addEventListener('click', ev => { ev.stopPropagation(); setActiveBrush(b.id); });

            const delBtn = document.createElement('button');
            delBtn.textContent   = '🗑';
            delBtn.title         = 'Delete brush';
            delBtn.style.cssText = `${_bs('#ef4444')}padding:2px 5px;font-size:10px;`;
            delBtn.addEventListener('click', ev => {
                ev.stopPropagation();
                if (!confirm(`Delete brush "${b.name}"?`)) return;
                const idx = state.tilesetBrushes.indexOf(b);
                if (idx >= 0) state.tilesetBrushes.splice(idx, 1);
                const ai = (d.activeBrushIds||[]).indexOf(b.id);
                if (ai >= 0) d.activeBrushIds.splice(ai, 1);
                if (activeBrushId === b.id) { activeBrushId = null; gallery = []; buildSlotGrid(null); }
                rebuildBrushList();
                rebuildPaintBrushSelector();
                slotImgCache = {};
                renderMap();
            });

            item.appendChild(nameSpan);
            item.appendChild(editBtn);
            item.appendChild(delBtn);
            item.addEventListener('click', () => setActiveBrush(b.id));
            listEl.appendChild(item);

            // Active-on-tilemap section
            const isActive = (d.activeBrushIds||[]).includes(b.id);
            const aItem = document.createElement('div');
            aItem.style.cssText = 'display:flex;align-items:center;gap:4px;';
            const chk = document.createElement('input');
            chk.type    = 'checkbox';
            chk.checked = isActive;
            chk.style.cssText = 'accent-color:#4ade80;cursor:pointer;';
            chk.addEventListener('change', () => {
                if (!d.activeBrushIds) d.activeBrushIds = [];
                if (chk.checked) {
                    if (!d.activeBrushIds.includes(b.id)) d.activeBrushIds.push(b.id);
                } else {
                    const i = d.activeBrushIds.indexOf(b.id);
                    if (i>=0) d.activeBrushIds.splice(i,1);
                }
                slotImgCache = {};
                renderMap();
            });
            const aLbl = document.createElement('label');
            aLbl.style.cssText = 'color:#aaa;font-size:10px;cursor:pointer;';
            aLbl.textContent   = b.name;
            aLbl.prepend(chk);
            activeEl.appendChild(aLbl);
        });

        if (!state.tilesetBrushes.length) {
            listEl.innerHTML = '<div style="color:#444;font-size:10px;text-align:center;padding:10px;">No brushes yet. Click + New.</div>';
        }

        rebuildPaintBrushSelector();
    }

    // ── New brush button ──
    panel.querySelector('#at-new-brush').addEventListener('click', () => {
        const name = prompt('Brush name:', 'New Brush');
        if (!name) return;
        const b = _newBrush(name);
        // Auto-activate on this tilemap
        if (!d.activeBrushIds) d.activeBrushIds = [];
        d.activeBrushIds.push(b.id);
        rebuildBrushList();
        setActiveBrush(b.id);
    });

    // ── Set active brush for slot editing ──
    function setActiveBrush(id) {
        activeBrushId = id;
        const b = _getBrush(id);
        if (!b) return;
        panel.querySelector('#at-editing-brush-name').textContent = `Editing: ${b.name}`;
        // Rebuild gallery from this brush's filled slots
        gallery = b.tiles.filter(Boolean);
        buildSlotGrid(b);
        refreshGallery();
        rebuildBrushList();
    }

    // ── Slot grid ──
    function buildSlotGrid(brush) {
        const slotGrid = panel.querySelector('#at-slot-grid');
        slotGrid.innerHTML = '';
        if (!brush) {
            slotGrid.innerHTML = '<div style="color:#444;font-size:11px;text-align:center;padding:16px;">Select or create a brush to edit its slots.</div>';
            return;
        }

        SLOT_LAYOUT.forEach(rowIds => {
            const rowEl = document.createElement('div');
            rowEl.style.cssText = 'display:flex;gap:5px;';
            rowIds.forEach(slotId => {
                const cell = document.createElement('div');
                cell.dataset.slot = slotId;
                cell.style.cssText = [
                    'width:54px;height:54px;',
                    `background:#0c0c1a;border:1px solid ${guidesOn?'#1e1e38':'transparent'};`,
                    'border-radius:3px;position:relative;overflow:hidden;cursor:pointer;box-sizing:border-box;flex-shrink:0;',
                ].join('');

                if (brush.tiles[slotId]) {
                    // Show the tile image (use a canvas for pixel-erasing)
                    const cvs = document.createElement('canvas');
                    const img = new Image();
                    img.onload = () => {
                        cvs.width  = img.width  || 64;
                        cvs.height = img.height || 64;
                        cvs.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block;';
                        cvs.getContext('2d').drawImage(img, 0, 0);
                        cell.insertBefore(cvs, cell.firstChild);
                    };
                    img.src = brush.tiles[slotId];

                    // Clear button (drag mode only)
                    if (slotEditorMode === 'drag') {
                        const clr = document.createElement('div');
                        clr.style.cssText='display:none;position:absolute;top:0;right:0;background:#ef4444;color:#fff;padding:2px 4px;border-bottom-left-radius:3px;cursor:pointer;font-size:9px;line-height:1;';
                        clr.textContent='✕';
                        clr.addEventListener('click', ev => {
                            ev.stopPropagation();
                            brush.tiles[slotId] = null;
                            // Invalidate cache for this slot
                            Object.keys(slotImgCache).forEach(k => { if (k.endsWith('_'+slotId)) delete slotImgCache[k]; });
                            buildSlotGrid(brush);
                            renderMap();
                        });
                        cell.appendChild(clr);
                        cell.addEventListener('mouseenter', ()=>{ clr.style.display='block'; });
                        cell.addEventListener('mouseleave', ()=>{ clr.style.display='none'; });
                    }
                }

                const lbl = document.createElement('div');
                lbl.style.cssText='position:absolute;bottom:1px;left:2px;color:#333;font-size:7px;pointer-events:none;';
                lbl.textContent=`S${slotId}`;
                cell.appendChild(lbl);

                // Drag-over target
                cell.addEventListener('dragover', e => {
                    if (slotEditorMode !== 'drag') return;
                    e.preventDefault();
                    cell.style.boxShadow = 'inset 0 0 0 2px #3b82f6';
                });
                cell.addEventListener('dragleave', () => { cell.style.boxShadow=''; });
                cell.addEventListener('drop', e => {
                    if (slotEditorMode !== 'drag') return;
                    e.preventDefault();
                    cell.style.boxShadow = '';
                    const src = dragSrc || e.dataTransfer.getData('text/plain');
                    if (!src || !brush) return;
                    brush.tiles[slotId] = src;
                    // Invalidate cache
                    Object.keys(slotImgCache).forEach(k => { if (k.endsWith('_'+slotId)) delete slotImgCache[k]; });
                    buildSlotGrid(brush);
                    renderMap();
                });

                // ── PIXEL ERASER on slot canvas ──
                cell.addEventListener('mousedown', e => {
                    if (slotEditorMode !== 'erase') return;
                    const cvs = cell.querySelector('canvas');
                    if (!cvs) return;
                    e.preventDefault();
                    isSlotErasing  = true;
                    eraseCanvas    = cvs;
                    eraseCtx       = cvs.getContext('2d');
                    eraseSlotId    = slotId;
                    eraseBrushRef  = brush;
                    eraseCtx.globalCompositeOperation = 'destination-out';
                    eraseCtx.lineWidth   = Math.max(4, cvs.width / 6);
                    eraseCtx.lineCap     = 'round';
                    eraseCtx.lineJoin    = 'round';
                    const pos = _canvasLocalPos(cvs, e);
                    eraseLast = pos;
                    eraseCtx.beginPath();
                    eraseCtx.arc(pos.x, pos.y, eraseCtx.lineWidth/2, 0, Math.PI*2);
                    eraseCtx.fill();
                });
                cell.addEventListener('touchstart', e => {
                    if (slotEditorMode !== 'erase') return;
                    const cvs = cell.querySelector('canvas');
                    if (!cvs) return;
                    e.preventDefault();
                    isSlotErasing = true;
                    eraseCanvas   = cvs;
                    eraseCtx      = cvs.getContext('2d');
                    eraseSlotId   = slotId;
                    eraseBrushRef = brush;
                    eraseCtx.globalCompositeOperation = 'destination-out';
                    eraseCtx.lineWidth = Math.max(4, cvs.width/6);
                    eraseCtx.lineCap = 'round'; eraseCtx.lineJoin = 'round';
                    const pos = _canvasLocalPos(cvs, e);
                    eraseLast = pos;
                    eraseCtx.beginPath(); eraseCtx.arc(pos.x,pos.y,eraseCtx.lineWidth/2,0,Math.PI*2); eraseCtx.fill();
                }, { passive: false });

                rowEl.appendChild(cell);
            });
            slotGrid.appendChild(rowEl);
        });
    }

    // Pixel erase move & end (global)
    const _onEraseMove = e => {
        if (!isSlotErasing || !eraseCanvas) return;
        e.preventDefault();
        const pos = _canvasLocalPos(eraseCanvas, e);
        eraseCtx.beginPath();
        eraseCtx.moveTo(eraseLast.x, eraseLast.y);
        eraseCtx.lineTo(pos.x, pos.y);
        eraseCtx.stroke();
        eraseLast = pos;
    };
    const _onEraseEnd = () => {
        if (!isSlotErasing || !eraseCanvas) return;
        isSlotErasing = false;
        // Commit the edited canvas back to the brush as a new dataURL
        if (eraseBrushRef && eraseSlotId >= 0) {
            const newUrl = eraseCanvas.toDataURL('image/png');
            eraseBrushRef.tiles[eraseSlotId] = newUrl;
            // Invalidate cache for this slot so map re-renders with updated texture
            Object.keys(slotImgCache).forEach(k => { if (k.endsWith('_'+eraseSlotId)) delete slotImgCache[k]; });
            renderMap();
        }
        eraseCanvas = null; eraseCtx = null; eraseSlotId = -1; eraseBrushRef = null;
    };
    window.addEventListener('mousemove',  _onEraseMove);
    window.addEventListener('touchmove',  _onEraseMove, { passive: false });
    window.addEventListener('mouseup',    _onEraseEnd);
    window.addEventListener('touchend',   _onEraseEnd);

    function _canvasLocalPos(cvs, e) {
        const rect = cvs.getBoundingClientRect();
        const sx = cvs.width / rect.width, sy = cvs.height / rect.height;
        const src = e.touches ? e.touches[0] : e;
        return { x: (src.clientX - rect.left)*sx, y: (src.clientY - rect.top)*sy };
    }

    // ── Gallery ──
    function addToGallery(url) {
        if (!gallery.includes(url)) gallery.push(url);
        refreshGallery();
    }
    function refreshGallery() {
        const el    = panel.querySelector('#at-gallery');
        const empty = panel.querySelector('#at-gallery-empty');
        el.innerHTML = '';
        empty.style.display = gallery.length ? 'none' : '';
        gallery.forEach(url => {
            const item = document.createElement('div');
            item.draggable = true;
            item.style.cssText = 'aspect-ratio:1;background:#090916;border:1px solid #1e1e38;border-radius:3px;overflow:hidden;cursor:grab;';
            const img = document.createElement('img');
            img.src = url; img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;';
            item.appendChild(img);
            item.addEventListener('dragstart', e => { dragSrc=url; e.dataTransfer.setData('text/plain',url); e.dataTransfer.effectAllowed='copy'; });
            item.addEventListener('dragend',   () => { dragSrc=null; });
            el.appendChild(item);
        });
    }

    // ── Upload pieces ──
    panel.querySelector('#at-upload-pieces').addEventListener('click', () => panel.querySelector('#at-file-pieces').click());
    panel.querySelector('#at-file-pieces').addEventListener('change', e => {
        const brush = activeBrushId ? _getBrush(activeBrushId) : null;
        Array.from(e.target.files).forEach(f => {
            if (!f.type.startsWith('image/')) return;
            const fr = new FileReader();
            fr.onload = ev => {
                addToGallery(ev.target.result);
                // Auto-fill next empty slot if a brush is active
                if (brush) {
                    const empty = brush.tiles.findIndex(t => !t);
                    if (empty >= 0) {
                        brush.tiles[empty] = ev.target.result;
                        Object.keys(slotImgCache).forEach(k=>{ if(k.endsWith('_'+empty)) delete slotImgCache[k]; });
                        buildSlotGrid(brush);
                        renderMap();
                    }
                }
            };
            fr.readAsDataURL(f);
        });
        e.target.value = '';
    });

    // ── Upload 4×4 sheet ──
    function loadSheet(file) {
        const brush = activeBrushId ? _getBrush(activeBrushId) : null;
        if (!brush) { alert('Create or select a brush first.'); return; }
        const fr = new FileReader();
        fr.onload = ev => {
            const img = new Image();
            img.onload = () => {
                const slW = Math.floor(img.width/4), slH = Math.floor(img.height/4);
                const off = document.createElement('canvas');
                off.width=slW; off.height=slH;
                const ctx = off.getContext('2d');
                SHEET_TO_SLOT.forEach((slotId, idx) => {
                    const sx=(idx%4)*slW, sy=Math.floor(idx/4)*slH;
                    ctx.clearRect(0,0,slW,slH);
                    ctx.drawImage(img,sx,sy,slW,slH,0,0,slW,slH);
                    const url=off.toDataURL('image/png');
                    brush.tiles[slotId]=url;
                    addToGallery(url);
                    Object.keys(slotImgCache).forEach(k=>{ if(k.endsWith('_'+slotId)) delete slotImgCache[k]; });
                });
                buildSlotGrid(brush);
                slotImgCache={};
                renderMap();
            };
            img.src=ev.target.result;
        };
        fr.readAsDataURL(file);
    }
    panel.querySelector('#at-upload-sheet').addEventListener('click',  () => panel.querySelector('#at-file-sheet').click());
    panel.querySelector('#at-file-sheet').addEventListener('change',  e => { const f=e.target.files[0]; if(f) loadSheet(f); e.target.value=''; });

    // ── Slot editor mode buttons ──
    const modeDragBtn  = panel.querySelector('#at-mode-drag');
    const modeEraseBtn = panel.querySelector('#at-mode-erase');
    function setSlotMode(m) {
        slotEditorMode = m;
        modeDragBtn.style.cssText  = _toolBtn(m==='drag')  + 'flex:1;';
        modeEraseBtn.style.cssText = _toolBtn(m==='erase') + 'flex:1;';
        const brush = activeBrushId ? _getBrush(activeBrushId) : null;
        buildSlotGrid(brush);
    }
    modeDragBtn.addEventListener('click',  () => setSlotMode('drag'));
    modeEraseBtn.addEventListener('click', () => setSlotMode('erase'));

    // ── Guide toggle ──
    const guideBtn = panel.querySelector('#at-guide-toggle');
    guideBtn.addEventListener('click', () => {
        guidesOn = !guidesOn;
        guideBtn.textContent = `Guides: ${guidesOn?'ON':'OFF'}`;
        const brush = activeBrushId ? _getBrush(activeBrushId) : null;
        buildSlotGrid(brush);
        renderMap();
    });

    // ── Resize ──
    panel.querySelector('#at-apply-size').addEventListener('click', () => {
        const nc = Math.max(5,Math.min(80, parseInt(panel.querySelector('#at-cols').value)||mapCols));
        const nr = Math.max(5,Math.min(60, parseInt(panel.querySelector('#at-rows').value)||mapRows));
        const nt = Math.max(8,Math.min(128,parseInt(panel.querySelector('#at-tileW').value)||tileW));
        if (nc!==mapCols||nr!==mapRows) {
            const nc2 = new Uint8Array(nc*nr);
            for (let r=0;r<Math.min(mapRows,nr);r++) for (let c=0;c<Math.min(mapCols,nc);c++) nc2[r*nc+c]=cells[r*mapCols+c];
            cells=nc2; mapCols=nc; mapRows=nr;
        }
        tileW=nt; tileH=nt;
        resizeCanvas(); renderMap();
    });

    // ── Clear map ──
    panel.querySelector('#at-clear-map').addEventListener('click', () => { cells.fill(0); renderMap(); });

    // ── Save & close ──
    function save() {
        window.removeEventListener('mousemove', _onMapMove);
        window.removeEventListener('mouseup',   _onMapUp);
        window.removeEventListener('mousemove', _onEraseMove);
        window.removeEventListener('touchmove', _onEraseMove);
        window.removeEventListener('mouseup',   _onEraseEnd);
        window.removeEventListener('touchend',  _onEraseEnd);

        // Inline brushList: merge all active brushes for backward compatibility
        d.brushList      = _resolveBrushList(d);
        d.cols           = mapCols;
        d.rows           = mapRows;
        d.tileW          = tileW;
        d.tileH          = tileH;
        d.cells          = new Uint8Array(cells);

        _buildAutoTileHelper(obj);
        rebuildAutoTileSprites(obj);
        import('./engine.ui.js').then(m => { m.refreshHierarchy(); m.syncPixiToInspector(); });
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
        panel.remove();
    }

    panel.querySelector('#at-close').addEventListener('click', save);
    panel.addEventListener('mousedown', e => { if (e.target===panel) save(); });

    // ── Init ──
    rebuildBrushList();
    renderMap();
}

// ─────────────────────────────────────────────────────────────
// Style micro-helpers
// ─────────────────────────────────────────────────────────────

function _bs(color) {
    return `background:${color}22;border:1px solid ${color}55;color:${color};
            border-radius:3px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:600;`;
}

function _toolBtn(active) {
    return active
        ? `background:#162816;border:1px solid #4ade80;color:#4ade80;border-radius:3px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:700;`
        : `background:#0a0a18;border:1px solid #1e1e38;color:#555;border-radius:3px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:600;`;
}

function _ni() {
    return `background:#0a0a18;border:1px solid #1e1e38;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;`;
}

function _sel() {
    return `background:#0a0a18;border:1px solid #1e1e38;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;`;
}
