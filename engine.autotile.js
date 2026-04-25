/* ============================================================
   Zengine — engine.autotile.js
   Auto-tile brush system: 16-tile (4×4 blob) neighbor-aware
   tilemap painter, integrated as a first-class scene object.

   Exported surface (contract with engine.core / engine.ui / engine.scenes):
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
 * 4-neighbor bitmask → slot index (0-15) in the brush tile array.
 * Bitmask bits:  N=1  E=2  S=4  W=8
 */
const BITMASK_TO_SLOT = {
     0: 15,  1: 11,  2: 12,  3:  6,
     4:  9,  5: 10,  6:  0,  7:  3,
     8: 14,  9:  8, 10: 13, 11:  7,
    12:  2, 13:  5, 14:  1, 15:  4,
};

// ─────────────────────────────────────────────────────────────
// Internal helpers
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
    g.beginFill(color);
    g.lineStyle(2, color);
    if (isY) g.drawRect(-1, -len, 2, len);
    else     g.drawRect(0, -1, len, 2);
    g.lineStyle(0);
    if (isY) { g.moveTo(-5, -len); g.lineTo(0, -len - 9); g.lineTo(5, -len); }
    else     { g.moveTo(len, -5);  g.lineTo(len + 9, 0);   g.lineTo(len, 5); }
    g.endFill();
    g.eventMode = 'static';
    return g;
}

function _makeSquare() {
    const g = new PIXI.Graphics();
    g.beginFill(0xFFFFFF, 0.4);
    g.drawRect(-7, -7, 14, 14);
    g.endFill();
    g.eventMode = 'static';
    g.cursor    = 'move';
    return g;
}

// ─────────────────────────────────────────────────────────────
// Wireframe helper drawn in editor space
// ─────────────────────────────────────────────────────────────

function _buildAutoTileHelper(container) {
    if (container._autoTileHelper) {
        container.removeChild(container._autoTileHelper);
        try { container._autoTileHelper.destroy(); } catch (_) {}
    }

    const d = container.autoTileData;
    const W = d.cols * d.tileW;
    const H = d.rows * d.tileH;

    const g = new PIXI.Graphics();
    g.lineStyle(1, 0x4ade80, 0.7);
    g.drawRect(0, 0, W, H);
    g.lineStyle(0.5, 0x4ade80, 0.18);
    for (let x = 1; x < d.cols; x++) {
        g.moveTo(x * d.tileW, 0); g.lineTo(x * d.tileW, H);
    }
    for (let y = 1; y < d.rows; y++) {
        g.moveTo(0, y * d.tileH); g.lineTo(W, y * d.tileH);
    }

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
// Sprite layer — rebuild from cell data + brush slots
// ─────────────────────────────────────────────────────────────

function _calcBitmask(d, col, row) {
    let m = 0;
    if (row > 0          && d.cells[(row - 1) * d.cols + col])         m += 1; // N
    if (col < d.cols - 1 && d.cells[row       * d.cols + (col + 1)])   m += 2; // E
    if (row < d.rows - 1 && d.cells[(row + 1) * d.cols + col])         m += 4; // S
    if (col > 0          && d.cells[row       * d.cols + (col - 1)])   m += 8; // W
    return m;
}

export function rebuildAutoTileSprites(container) {
    if (container._spriteLayer) {
        container.removeChild(container._spriteLayer);
        try { container._spriteLayer.destroy({ children: true }); } catch (_) {}
    }

    const layer = new PIXI.Container();
    container._spriteLayer = layer;

    // Insert just above the wireframe helper (index 1 if helper present, 0 otherwise)
    const insertIdx = container._autoTileHelper ? 1 : 0;
    container.addChildAt(layer, insertIdx);

    const d = container.autoTileData;
    for (let row = 0; row < d.rows; row++) {
        for (let col = 0; col < d.cols; col++) {
            if (!d.cells[row * d.cols + col]) continue;
            const mask    = _calcBitmask(d, col, row);
            const slotId  = BITMASK_TO_SLOT[mask] ?? 15;
            const dataURL = d.brushList[slotId];
            if (!dataURL) continue;

            const tex = PIXI.Texture.from(dataURL);
            const spr = new PIXI.Sprite(tex);
            spr.x     = col * d.tileW;
            spr.y     = row * d.tileH;
            spr.width  = d.tileW;
            spr.height = d.tileH;
            layer.addChild(spr);
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Public: create a new Auto-Tilemap object in the scene
// ─────────────────────────────────────────────────────────────

export function createAutoTilemap(x = 0, y = 0) {
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
        tileW:     TILE_SIZE,
        tileH:     TILE_SIZE,
        cols:      DEFAULT_COLS,
        rows:      DEFAULT_ROWS,
        brushList: new Array(16).fill(null),           // dataURLs per slot
        cells:     new Uint8Array(DEFAULT_COLS * DEFAULT_ROWS), // 1=filled
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
// Public: restore from a snapshot (scenes / copy-paste)
// ─────────────────────────────────────────────────────────────

export async function restoreAutoTilemap(s) {
    const obj  = createAutoTilemap(s.x, s.y);
    obj.label  = s.label;
    obj.unityZ = s.unityZ || 0;

    const td = s.autoTileData;
    obj.autoTileData = {
        tileW:     td.tileW     ?? TILE_SIZE,
        tileH:     td.tileH     ?? TILE_SIZE,
        cols:      td.cols      ?? DEFAULT_COLS,
        rows:      td.rows      ?? DEFAULT_ROWS,
        brushList: td.brushList ? td.brushList.slice() : new Array(16).fill(null),
        cells: td.cells instanceof Uint8Array
            ? td.cells
            : new Uint8Array(td.cells),
    };

    _buildAutoTileHelper(obj);
    rebuildAutoTileSprites(obj);
    return obj;
}

// ─────────────────────────────────────────────────────────────
// Public: inspector HTML (shown in right panel)
// ─────────────────────────────────────────────────────────────

export function buildAutoTileInspectorHTML(obj) {
    const d          = obj.autoTileData;
    const filled     = d.cells ? Array.from(d.cells).filter(Boolean).length : 0;
    const brushCount = (d.brushList || []).filter(Boolean).length;

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
          <span class="prop-label">Brush slots</span>
          <span style="color:#9bc;">${brushCount} / 16 filled</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Painted tiles</span>
          <span style="color:#9bc;">${filled}</span>
        </div>
        <button id="btn-open-autotile-editor"
          style="width:100%;background:#1a2a1a;border:1px solid #4ade80;color:#4ade80;
                 border-radius:4px;padding:6px;cursor:pointer;font-size:11px;margin-top:4px;
                 display:flex;align-items:center;justify-content:center;gap:6px;">
          <svg viewBox="0 0 24 24"
               style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Open Auto-Tile Editor
        </button>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// Public: open the full-screen editor modal
// ─────────────────────────────────────────────────────────────

export function openAutoTileEditor(obj) {
    document.getElementById('autotile-editor-panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'autotile-editor-panel';
    panel.style.cssText = [
        'position:fixed;inset:0;z-index:9999;',
        'display:flex;align-items:stretch;',
        'background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);',
    ].join('');

    const d = obj.autoTileData;

    panel.innerHTML = `
<div style="display:flex;width:100%;height:100%;overflow:hidden;font-family:sans-serif;font-size:13px;">

  <!-- ── LEFT: gallery + brush trainer ── -->
  <div style="width:300px;min-width:240px;background:#12121e;
              border-right:1px solid #1e1e38;display:flex;flex-direction:column;overflow:hidden;">

    <div style="padding:12px 14px 10px;border-bottom:1px solid #1e1e38;
                display:flex;align-items:center;justify-content:space-between;">
      <span style="color:#4ade80;font-weight:700;">Brush Trainer</span>
      <div style="display:flex;gap:6px;">
        <button id="at-upload-pieces" style="${_btn('#3b82f6')}">Upload Tiles</button>
        <button id="at-upload-sheet"  style="${_btn('#7c3aed')}">4×4 Sheet</button>
      </div>
    </div>

    <div style="padding:10px 14px 0;">
      <label style="color:#aaa;font-size:10px;font-weight:600;
                    text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px;">
        Brush Name
      </label>
      <input id="at-brush-name" type="text" value="Auto-Tile Brush"
        style="width:100%;box-sizing:border-box;background:#0a0a18;
               border:none;border-bottom:1px solid #4ade80;color:#e0e0e0;
               padding:4px 0;outline:none;font-size:13px;"/>
    </div>

    <div style="flex:1;overflow-y:auto;padding:10px 14px;">
      <div style="color:#888;font-size:10px;font-weight:600;text-transform:uppercase;
                  letter-spacing:.06em;margin-bottom:8px;">Gallery</div>
      <div id="at-gallery" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;"></div>
      <div id="at-gallery-empty" style="color:#444;font-size:11px;text-align:center;margin-top:16px;">
        Upload tile images to begin.
      </div>
    </div>

    <input id="at-file-pieces" type="file" multiple accept="image/*" style="display:none;">
    <input id="at-file-sheet"  type="file" accept="image/*"          style="display:none;">
  </div>

  <!-- ── MIDDLE: 16-slot editor ── -->
  <div style="width:320px;min-width:260px;background:#0d0d20;
              border-right:1px solid #1e1e38;display:flex;flex-direction:column;
              align-items:center;overflow-y:auto;padding:18px;">

    <div style="color:#4ade80;font-weight:700;font-size:14px;
                margin-bottom:12px;align-self:flex-start;">Tile Slot Editor</div>

    <!-- Mode toggle -->
    <div style="display:flex;gap:6px;margin-bottom:12px;align-self:flex-start;">
      <button id="at-mode-drag"  style="${_toolBtn(true)}">✦ Drag &amp; Drop</button>
      <button id="at-mode-erase" style="${_toolBtn(false)}">✕ Eraser</button>
    </div>

    <!-- 4-row slot grid -->
    <div id="at-slot-grid" style="display:flex;flex-direction:column;gap:6px;"></div>

    <button id="at-guide-toggle"
      style="margin-top:12px;${_btn('#444')}font-size:10px;align-self:flex-start;">
      Guides: ON
    </button>

    <div style="width:100%;margin-top:16px;display:flex;flex-direction:column;gap:6px;">
      <button id="at-go-draw"
        style="width:100%;${_btn('#4ade80')}color:#0a1a0a;font-weight:700;padding:9px;">
        ✓ Save &amp; Draw Map
      </button>
      <button id="at-autocomplete" style="width:100%;${_btn('#7c3aed')}">
        ⬆ Auto-Complete from 4×4 Sheet
      </button>
    </div>
  </div>

  <!-- ── RIGHT: map painter ── -->
  <div style="flex:1;background:#080814;display:flex;flex-direction:column;overflow:hidden;">

    <!-- Toolbar -->
    <div style="padding:9px 14px;border-bottom:1px solid #1e1e38;
                display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
      <span style="color:#4ade80;font-weight:700;">Map Painter</span>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <label style="color:#777;font-size:11px;">
          Cols <input id="at-cols" type="number" value="${d.cols}" min="5" max="80"
            style="width:42px;${_numInput()}">
        </label>
        <label style="color:#777;font-size:11px;">
          Rows <input id="at-rows" type="number" value="${d.rows}" min="5" max="60"
            style="width:42px;${_numInput()}">
        </label>
        <label style="color:#777;font-size:11px;">
          Tile <input id="at-tileW" type="number" value="${d.tileW}" min="8" max="128"
            style="width:42px;${_numInput()}">px
        </label>
        <button id="at-apply-size" style="${_btn('#3b82f6')}">Apply</button>
        <button id="at-clear-map"  style="${_btn('#ef4444')}">Clear</button>
        <button id="at-close"      style="${_btn('#555')}">✕ Close</button>
      </div>
    </div>

    <!-- Canvas area -->
    <div style="flex:1;overflow:auto;display:flex;
                justify-content:flex-start;align-items:flex-start;padding:20px;">
      <canvas id="at-map-canvas"
        style="cursor:crosshair;image-rendering:pixelated;
               box-shadow:0 0 0 1px #1e1e38,0 4px 20px #000a;"
        oncontextmenu="return false;"></canvas>
    </div>

    <div style="padding:5px 14px;color:#444;font-size:10px;flex-shrink:0;">
      Left-click: paint  •  Right-click: erase  •  Hold &amp; drag to paint continuously
    </div>
  </div>
</div>`;

    document.body.appendChild(panel);
    _wireEditor(panel, obj);
}

// ─────────────────────────────────────────────────────────────
// Editor wiring (all interactivity)
// ─────────────────────────────────────────────────────────────

/** 4×4 sheet column-major index → slot id (matching original brush file) */
const SHEET_TO_SLOT = [0, 1, 2, 9, 3, 4, 5, 10, 6, 7, 8, 11, 12, 13, 14, 15];

/** Visual slot layout: 4 rows × 4 cols */
const SLOT_LAYOUT = [
    [0,  1,  2,  9],
    [3,  4,  5, 10],
    [6,  7,  8, 11],
    [12, 13, 14, 15],
];

function _wireEditor(panel, obj) {
    const d = obj.autoTileData;

    // Working copies (only committed on Save/Close)
    let slots      = d.brushList.slice();
    let gallery    = slots.filter(Boolean).slice();
    let dragSrc    = null;
    let editorMode = 'drag';
    let guidesOn   = true;

    // Map state
    let mapCols = d.cols, mapRows = d.rows;
    let tileW   = d.tileW, tileH  = d.tileH;
    let cells   = d.cells ? new Uint8Array(d.cells) : new Uint8Array(mapCols * mapRows);
    let slotImgs = new Array(16).fill(null); // HTMLImageElements for canvas rendering

    // Canvas
    const mapCanvas = panel.querySelector('#at-map-canvas');
    const mapCtx    = mapCanvas.getContext('2d');
    let isDrawing = false, drawAction = 1;

    function resizeCanvas() {
        mapCanvas.width  = mapCols * tileW;
        mapCanvas.height = mapRows * tileH;
    }
    resizeCanvas();

    // ── canvas bitmask ──
    function bitmask(col, row) {
        let m = 0;
        if (row > 0          && cells[(row - 1) * mapCols + col])        m += 1;
        if (col < mapCols-1  && cells[row       * mapCols + (col + 1)])  m += 2;
        if (row < mapRows-1  && cells[(row + 1) * mapCols + col])        m += 4;
        if (col > 0          && cells[row       * mapCols + (col - 1)])  m += 8;
        return m;
    }

    // ── full map redraw ──
    function renderMap() {
        mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
        for (let r = 0; r < mapRows; r++) {
            for (let c = 0; c < mapCols; c++) {
                mapCtx.fillStyle = (r + c) % 2 === 0 ? '#0e0e1e' : '#0a0a18';
                mapCtx.fillRect(c * tileW, r * tileH, tileW, tileH);
                if (cells[r * mapCols + c]) {
                    const m   = bitmask(c, r);
                    const sid = BITMASK_TO_SLOT[m] ?? 15;
                    if (slotImgs[sid]) {
                        mapCtx.drawImage(slotImgs[sid], c * tileW, r * tileH, tileW, tileH);
                    } else {
                        mapCtx.fillStyle = 'rgba(74,222,128,0.3)';
                        mapCtx.fillRect(c * tileW, r * tileH, tileW, tileH);
                    }
                }
            }
        }
        if (guidesOn) {
            mapCtx.strokeStyle = 'rgba(74,222,128,0.1)';
            mapCtx.lineWidth   = 0.5;
            for (let c = 0; c <= mapCols; c++) {
                mapCtx.beginPath();
                mapCtx.moveTo(c * tileW, 0);
                mapCtx.lineTo(c * tileW, mapCanvas.height);
                mapCtx.stroke();
            }
            for (let r = 0; r <= mapRows; r++) {
                mapCtx.beginPath();
                mapCtx.moveTo(0, r * tileH);
                mapCtx.lineTo(mapCanvas.width, r * tileH);
                mapCtx.stroke();
            }
        }
    }

    // ── load slot images then re-render ──
    function loadSlotImages(cb) {
        slotImgs = new Array(16).fill(null);
        let pending = 0;
        slots.forEach((url, i) => {
            if (!url) return;
            pending++;
            const img = new Image();
            img.onload  = () => { slotImgs[i] = img; pending--; if (!pending) { cb?.(); renderMap(); } };
            img.onerror = () => {                     pending--; if (!pending) { cb?.(); renderMap(); } };
            img.src = url;
        });
        if (!pending) { cb?.(); renderMap(); }
    }

    // ── single-cell paint ──
    function paintCell(col, row, val) {
        if (col < 0 || col >= mapCols || row < 0 || row >= mapRows) return;
        const idx = row * mapCols + col;
        if (cells[idx] === val) return;
        cells[idx] = val;
        // Re-render self + orthogonal neighbors (bitmask may have changed)
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const r2 = row + dr, c2 = col + dc;
                if (r2 < 0 || r2 >= mapRows || c2 < 0 || c2 >= mapCols) continue;
                _renderCell(c2, r2);
            }
        }
    }

    function _renderCell(col, row) {
        const x = col * tileW, y = row * tileH;
        mapCtx.fillStyle = (row + col) % 2 === 0 ? '#0e0e1e' : '#0a0a18';
        mapCtx.fillRect(x, y, tileW, tileH);
        if (cells[row * mapCols + col]) {
            const m   = bitmask(col, row);
            const sid = BITMASK_TO_SLOT[m] ?? 15;
            if (slotImgs[sid]) {
                mapCtx.drawImage(slotImgs[sid], x, y, tileW, tileH);
            } else {
                mapCtx.fillStyle = 'rgba(74,222,128,0.3)';
                mapCtx.fillRect(x, y, tileW, tileH);
            }
        }
        if (guidesOn) {
            mapCtx.strokeStyle = 'rgba(74,222,128,0.1)';
            mapCtx.lineWidth   = 0.5;
            mapCtx.strokeRect(x, y, tileW, tileH);
        }
    }

    function getCell(e) {
        const rect  = mapCanvas.getBoundingClientRect();
        const scaleX = mapCanvas.width  / rect.width;
        const scaleY = mapCanvas.height / rect.height;
        return {
            col: Math.floor(((e.clientX - rect.left) * scaleX) / tileW),
            row: Math.floor(((e.clientY - rect.top)  * scaleY) / tileH),
        };
    }

    mapCanvas.addEventListener('mousedown', e => {
        isDrawing  = true;
        drawAction = e.button === 2 ? 0 : 1;
        const { col, row } = getCell(e);
        paintCell(col, row, drawAction);
    });
    const _mapMove = e => {
        if (!isDrawing) return;
        const { col, row } = getCell(e);
        paintCell(col, row, drawAction);
    };
    const _mapUp = () => { isDrawing = false; };
    window.addEventListener('mousemove', _mapMove);
    window.addEventListener('mouseup',   _mapUp);

    // ── slot grid ──
    const slotGrid = panel.querySelector('#at-slot-grid');

    function buildSlotGrid() {
        slotGrid.innerHTML = '';
        SLOT_LAYOUT.forEach(rowIds => {
            const rowEl = document.createElement('div');
            rowEl.style.cssText = 'display:flex;gap:6px;';
            rowIds.forEach(slotId => {
                const cell = document.createElement('div');
                cell.dataset.slot = slotId;
                cell.style.cssText = [
                    'width:58px;height:58px;',
                    `background:#0e0e1e;border:1px solid ${guidesOn ? '#1e1e38' : 'transparent'};`,
                    'border-radius:4px;position:relative;overflow:hidden;',
                    'cursor:pointer;box-sizing:border-box;flex-shrink:0;',
                ].join('');

                if (slots[slotId]) {
                    const img = document.createElement('img');
                    img.src = slots[slotId];
                    img.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block;pointer-events:none;';
                    cell.appendChild(img);

                    if (editorMode === 'drag') {
                        const clr = document.createElement('div');
                        clr.style.cssText = [
                            'display:none;position:absolute;top:0;right:0;',
                            'background:#ef4444;color:#fff;padding:3px 4px;',
                            'border-bottom-left-radius:3px;cursor:pointer;font-size:10px;line-height:1;',
                        ].join('');
                        clr.textContent = '✕';
                        clr.addEventListener('click', ev => {
                            ev.stopPropagation();
                            slots[slotId] = null;
                            slotImgs[slotId] = null;
                            buildSlotGrid();
                            renderMap();
                        });
                        cell.appendChild(clr);
                        cell.addEventListener('mouseenter', () => { clr.style.display = 'block'; });
                        cell.addEventListener('mouseleave', () => { clr.style.display = 'none'; });
                    }
                }

                const lbl = document.createElement('div');
                lbl.style.cssText = 'position:absolute;bottom:2px;left:3px;color:#333;font-size:8px;pointer-events:none;';
                lbl.textContent = `S${slotId}`;
                cell.appendChild(lbl);

                cell.addEventListener('dragover', e => {
                    if (editorMode !== 'drag') return;
                    e.preventDefault();
                    cell.style.boxShadow = 'inset 0 0 0 2px #3b82f6';
                });
                cell.addEventListener('dragleave', () => { cell.style.boxShadow = ''; });
                cell.addEventListener('drop', e => {
                    if (editorMode !== 'drag') return;
                    e.preventDefault();
                    cell.style.boxShadow = '';
                    const src = dragSrc || e.dataTransfer.getData('text/plain');
                    if (!src) return;
                    slots[slotId] = src;
                    const img = new Image();
                    img.onload = () => { slotImgs[slotId] = img; renderMap(); };
                    img.src = src;
                    buildSlotGrid();
                });

                rowEl.appendChild(cell);
            });
            slotGrid.appendChild(rowEl);
        });
    }

    buildSlotGrid();

    // ── gallery ──
    function addToGallery(dataURL) {
        if (!gallery.includes(dataURL)) gallery.push(dataURL);
        refreshGallery();
    }

    function refreshGallery() {
        const el    = panel.querySelector('#at-gallery');
        const empty = panel.querySelector('#at-gallery-empty');
        el.innerHTML = '';
        empty.style.display = gallery.length ? 'none' : '';
        gallery.forEach(url => {
            const item = document.createElement('div');
            item.draggable   = true;
            item.style.cssText = [
                'aspect-ratio:1;background:#0a0a18;',
                'border:1px solid #1e1e38;border-radius:3px;overflow:hidden;cursor:grab;',
            ].join('');
            const img = document.createElement('img');
            img.src = url;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;';
            item.appendChild(img);
            item.addEventListener('dragstart', e => {
                dragSrc = url;
                e.dataTransfer.setData('text/plain', url);
                e.dataTransfer.effectAllowed = 'copy';
            });
            item.addEventListener('dragend', () => { dragSrc = null; });
            el.appendChild(item);
        });
    }

    // Pre-fill gallery from existing slots
    slots.forEach(url => { if (url) addToGallery(url); });

    // ── upload pieces ──
    panel.querySelector('#at-upload-pieces').addEventListener('click', () => {
        panel.querySelector('#at-file-pieces').click();
    });
    panel.querySelector('#at-file-pieces').addEventListener('change', e => {
        Array.from(e.target.files).forEach(f => {
            if (!f.type.startsWith('image/')) return;
            const fr = new FileReader();
            fr.onload = ev => addToGallery(ev.target.result);
            fr.readAsDataURL(f);
        });
        e.target.value = '';
    });

    // ── upload 4×4 sheet ──
    function loadSheet(file) {
        const fr = new FileReader();
        fr.onload = ev => {
            const img = new Image();
            img.onload = () => {
                const slW = Math.floor(img.width  / 4);
                const slH = Math.floor(img.height / 4);
                const off = document.createElement('canvas');
                off.width = slW; off.height = slH;
                const ctx = off.getContext('2d');
                SHEET_TO_SLOT.forEach((slotId, idx) => {
                    const sx = (idx % 4) * slW;
                    const sy = Math.floor(idx / 4) * slH;
                    ctx.clearRect(0, 0, slW, slH);
                    ctx.drawImage(img, sx, sy, slW, slH, 0, 0, slW, slH);
                    const url = off.toDataURL('image/png');
                    slots[slotId] = url;
                    addToGallery(url);
                });
                buildSlotGrid();
                loadSlotImages(() => renderMap());
            };
            img.src = ev.target.result;
        };
        fr.readAsDataURL(file);
    }

    panel.querySelector('#at-upload-sheet').addEventListener('click', () => {
        panel.querySelector('#at-file-sheet').click();
    });
    panel.querySelector('#at-autocomplete').addEventListener('click', () => {
        panel.querySelector('#at-file-sheet').click();
    });
    panel.querySelector('#at-file-sheet').addEventListener('change', e => {
        const f = e.target.files[0];
        if (f) loadSheet(f);
        e.target.value = '';
    });

    // ── mode buttons ──
    const modeDragBtn  = panel.querySelector('#at-mode-drag');
    const modeEraseBtn = panel.querySelector('#at-mode-erase');

    function setMode(m) {
        editorMode = m;
        modeDragBtn.style.cssText  = _toolBtn(m === 'drag');
        modeEraseBtn.style.cssText = _toolBtn(m === 'erase');
        buildSlotGrid();
    }
    modeDragBtn.addEventListener('click',  () => setMode('drag'));
    modeEraseBtn.addEventListener('click', () => setMode('erase'));

    // ── guide toggle ──
    const guideBtn = panel.querySelector('#at-guide-toggle');
    guideBtn.addEventListener('click', () => {
        guidesOn = !guidesOn;
        guideBtn.textContent = `Guides: ${guidesOn ? 'ON' : 'OFF'}`;
        buildSlotGrid();
        renderMap();
    });

    // ── resize ──
    panel.querySelector('#at-apply-size').addEventListener('click', () => {
        const newCols  = Math.max(5, Math.min(80,  parseInt(panel.querySelector('#at-cols').value)  || mapCols));
        const newRows  = Math.max(5, Math.min(60,  parseInt(panel.querySelector('#at-rows').value)  || mapRows));
        const newTileW = Math.max(8, Math.min(128, parseInt(panel.querySelector('#at-tileW').value) || tileW));

        if (newCols !== mapCols || newRows !== mapRows) {
            const newCells = new Uint8Array(newCols * newRows);
            for (let r = 0; r < Math.min(mapRows, newRows); r++) {
                for (let c = 0; c < Math.min(mapCols, newCols); c++) {
                    newCells[r * newCols + c] = cells[r * mapCols + c];
                }
            }
            cells   = newCells;
            mapCols = newCols;
            mapRows = newRows;
        }
        tileW = newTileW;
        tileH = newTileW;
        resizeCanvas();
        renderMap();
    });

    // ── clear map ──
    panel.querySelector('#at-clear-map').addEventListener('click', () => {
        cells.fill(0);
        renderMap();
    });

    // ── save & close ──
    function save() {
        window.removeEventListener('mousemove', _mapMove);
        window.removeEventListener('mouseup',   _mapUp);
        obj.autoTileData.brushList = slots.slice();
        obj.autoTileData.cols      = mapCols;
        obj.autoTileData.rows      = mapRows;
        obj.autoTileData.tileW     = tileW;
        obj.autoTileData.tileH     = tileH;
        obj.autoTileData.cells     = new Uint8Array(cells);
        _buildAutoTileHelper(obj);
        rebuildAutoTileSprites(obj);
        import('./engine.ui.js').then(m => m.refreshHierarchy());
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
        panel.remove();
    }

    panel.querySelector('#at-go-draw').addEventListener('click', save);
    panel.querySelector('#at-close').addEventListener('click',   save);
    panel.addEventListener('mousedown', e => { if (e.target === panel) save(); });

    // ── initial render ──
    loadSlotImages();
}

// ─────────────────────────────────────────────────────────────
// Style micro-helpers
// ─────────────────────────────────────────────────────────────

function _btn(color) {
    return `background:${color}22;border:1px solid ${color}66;color:${color};
            border-radius:4px;padding:5px 10px;cursor:pointer;
            font-size:11px;font-weight:600;letter-spacing:.03em;`;
}

function _toolBtn(active) {
    return active
        ? `background:#162816;border:1px solid #4ade80;color:#4ade80;
           border-radius:4px;padding:5px 12px;cursor:pointer;
           font-size:11px;font-weight:700;`
        : `background:#0a0a18;border:1px solid #1e1e38;color:#555;
           border-radius:4px;padding:5px 12px;cursor:pointer;
           font-size:11px;font-weight:600;`;
}

function _numInput() {
    return `background:#0a0a18;border:1px solid #1e1e38;color:#e0e0e0;
            border-radius:3px;padding:2px 4px;font-size:11px;`;
}
