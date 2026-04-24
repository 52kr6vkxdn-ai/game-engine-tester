/* ============================================================
   Zengine — engine.autotile.js
   AUTO-TILEMAP — entirely separate from engine.tilemap.js.

   Concept:
     * The user trains a "Brush" by uploading 16 small tile
       images (one per neighbor configuration). The trained
       brush lives in state.tilesetBrushes and is reusable
       across auto-tilemaps.
     * Painting on an Auto-Tilemap object marks each cell as
       "filled with brush X". On render, the engine looks at
       each cell's 4-neighbor mask (N/E/S/W) and picks the
       matching trained tile from the brush.

   Per Auto-Tilemap object:
     obj.isAutoTilemap = true
     obj.autoTileData = {
       tileW, tileH, cols, rows,
       cells:      Int16Array     // brush index into brushList, -1 = empty
       brushList:  string[]       // brush IDs referenced by this map
       filterMode: 'pixelated'|'smooth'
     }

   A trained brush:
     {
       id, name,
       type: '16-tile',
       tileW, tileH,
       tiles: Array<string|null>     // length 16, dataURL per neighbor mask
                                     // bit0=N, bit1=E, bit2=S, bit3=W
     }
   ============================================================ */

import { state } from './engine.state.js';

const SLOTS = 16;

// ── Object factory ───────────────────────────────────────────
export function createAutoTilemap(x = 0, y = 0) {
    const label = _uniqueName('AutoTilemap');

    const container = new PIXI.Container();
    container.x = x; container.y = y;
    container.isAutoTilemap = true;
    container.isTilemap = false;
    container.isLight   = false;
    container.isImage   = false;
    container.label     = label;
    container.unityZ    = 0;
    container.animations = [];
    container.activeAnimIndex = 0;

    container.autoTileData = {
        tileW: 32, tileH: 32,
        cols: 20, rows: 15,
        cells:      new Int16Array(20 * 15).fill(-1),
        brushList:  [],
        filterMode: 'smooth',
    };

    _buildHelper(container);
    _attachTranslateGizmo(container);
    if (state._bindGizmoHandles) state._bindGizmoHandles(container);

    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);

    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.on('pointerdown', e => {
        if (state.isPlaying) { e.stopPropagation(); return; }
        if (e.button !== 0) return;
        import('./engine.objects.js').then(m => m.selectObject(container));
    });

    import('./engine.objects.js').then(m => m.selectObject(container));
    import('./engine.ui.js').then(m => m.refreshHierarchy());

    return container;
}

function _migrate(d) {
    const len = d.cols * d.rows;
    if (!d.cells || d.cells.length !== len) {
        const nc = new Int16Array(len).fill(-1);
        if (d.cells) for (let i = 0; i < Math.min(len, d.cells.length); i++) nc[i] = d.cells[i];
        d.cells = nc;
    }
    if (!Array.isArray(d.brushList)) d.brushList = [];
    if (!d.filterMode) d.filterMode = 'smooth';
}

// ── Editor wireframe helper (in scene) ───────────────────────
function _buildHelper(container) {
    if (container._helper) {
        container.removeChild(container._helper);
        try { container._helper.destroy(); } catch(_) {}
    }
    const d = container.autoTileData;
    const g = new PIXI.Graphics();
    const W = d.cols * d.tileW;
    const H = d.rows * d.tileH;

    g.beginFill(0x14252a, 0.6); g.drawRect(0, 0, W, H); g.endFill();
    g.lineStyle(1, 0x4ade80, 0.20);
    for (let c = 0; c <= d.cols; c++) { g.moveTo(c * d.tileW, 0); g.lineTo(c * d.tileW, H); }
    for (let r = 0; r <= d.rows; r++) { g.moveTo(0, r * d.tileH); g.lineTo(W, r * d.tileH); }
    g.lineStyle(2, 0x4ade80, 0.7);
    g.drawRect(0, 0, W, H);
    const text = new PIXI.Text('AUTO TILEMAP', {
        fontFamily: 'monospace', fontSize: 10, fill: 0x4ade80, alpha: 0.55,
    });
    text.x = 4; text.y = 4;
    g.addChild(text);

    container._helper = g;
    container.addChildAt(g, 0);
    g.eventMode = 'none';
}

// ── Neighbor-mask computation ────────────────────────────────
function _mask(d, c, r) {
    const i = r * d.cols + c;
    const b = d.cells[i];
    if (b < 0) return 0;
    const same = (cc, rr) => {
        if (cc < 0 || cc >= d.cols || rr < 0 || rr >= d.rows) return true;
        return d.cells[rr * d.cols + cc] === b;
    };
    let m = 0;
    if (same(c,   r-1)) m |= 1;
    if (same(c+1, r  )) m |= 2;
    if (same(c,   r+1)) m |= 4;
    if (same(c-1, r  )) m |= 8;
    return m;
}

// Choose the best available trained slot for a mask
function _resolveSlot(brush, mask) {
    if (brush.tiles[mask]) return mask;
    for (let i = 0; i < 4; i++) {
        const m2 = mask & ~(1 << i);
        if (brush.tiles[m2]) return m2;
    }
    if (brush.tiles[15]) return 15;
    if (brush.tiles[0])  return 0;
    for (let i = 0; i < SLOTS; i++) if (brush.tiles[i]) return i;
    return -1;
}

// ── PIXI sprite cache for brush slot dataURLs ────────────────
const _texCache = new Map();
function _texFor(dataURL, smooth) {
    const key = (smooth ? 'L:' : 'N:') + dataURL.length + ':' + dataURL.slice(-32);
    let tex = _texCache.get(key);
    if (tex) return tex;
    tex = PIXI.Texture.from(dataURL);
    if (tex.baseTexture) {
        tex.baseTexture.scaleMode = smooth ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST;
    }
    _texCache.set(key, tex);
    return tex;
}

// ── Rebuild PIXI sprites for an auto-tilemap object ──────────
export function rebuildAutoTileSprites(container) {
    if (container._tileContainer) {
        container.removeChild(container._tileContainer);
        try { container._tileContainer.destroy({ children: true }); } catch(_) {}
    }
    const d = container.autoTileData;
    _migrate(d);
    const smooth = d.filterMode !== 'pixelated';
    const cell = new PIXI.Container();

    for (let i = 0; i < d.cells.length; i++) {
        const bIdx = d.cells[i];
        if (bIdx < 0) continue;
        const brushId = d.brushList[bIdx];
        const brush = state.tilesetBrushes.find(b => b.id === brushId);
        if (!brush) continue;
        const col = i % d.cols, row = Math.floor(i / d.cols);
        const slot = _resolveSlot(brush, _mask(d, col, row));
        if (slot < 0) continue;
        const tex = _texFor(brush.tiles[slot], smooth);
        const sp = new PIXI.Sprite(tex);
        sp.x = col * d.tileW; sp.y = row * d.tileH;
        sp.width = d.tileW; sp.height = d.tileH;
        cell.addChild(sp);
    }

    container._tileContainer = cell;
    const gizmoIdx = container.children.indexOf(container._gizmoContainer);
    if (gizmoIdx >= 0) container.addChildAt(cell, gizmoIdx);
    else container.addChild(cell);
}

// ============================================================
//                       EDITOR PANEL
// ============================================================
export function openAutoTileEditor(obj) {
    document.getElementById('at-editor')?.remove();
    _migrate(obj.autoTileData);

    const panel = document.createElement('div');
    panel.id = 'at-editor';
    panel.style.cssText = `
        position:fixed;inset:0;z-index:15000;background:rgba(0,0,0,0.92);
        display:flex;font-family:'Inter','Segoe UI',sans-serif;font-size:11px;color:#d8d8e8;
    `;

    panel.innerHTML = `
    <div style="display:flex;width:100%;height:100%;">

      <!-- LEFT: Brush trainer (matches the reference UI) -->
      <div style="width:380px;flex-shrink:0;background:#f4f6fa;color:#222;
                  border-right:1px solid #2e2e3a;display:flex;flex-direction:column;overflow:hidden;">
        <!-- Header -->
        <div style="padding:12px 16px;display:flex;align-items:center;gap:8px;flex-shrink:0;
                    border-bottom:1px solid #e0e3e9;">
          <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:#4ade80;stroke-width:2;">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
            <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
          </svg>
          <span style="font-weight:700;color:#222;">Auto Tile Brush Trainer</span>
          <div style="flex:1;"></div>
          <button id="at-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:18px;padding:2px 6px;">✕</button>
        </div>

        <div style="padding:14px 18px;overflow:auto;flex:1;">

          <!-- Brush selector -->
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:14px;">
            <select id="at-brush-select" style="flex:1;background:#fff;border:1px solid #cfd4dd;
                    color:#222;border-radius:4px;padding:7px;font-size:12px;outline:none;">
              <option value="">— Select brush —</option>
            </select>
            <button id="at-brush-new" title="New brush"
              style="background:#fff;border:1px solid #4ade80;color:#16a34a;
                     border-radius:4px;padding:6px 10px;font-size:12px;cursor:pointer;font-weight:600;">+ New</button>
            <button id="at-brush-delete" title="Delete brush"
              style="background:#fff;border:1px solid #e0a0a0;color:#b04040;
                     border-radius:4px;padding:6px 8px;font-size:12px;cursor:pointer;">🗑</button>
          </div>

          <div id="at-brush-form" style="display:none;">

            <!-- Brush Name -->
            <div style="margin-bottom:12px;">
              <label style="display:block;font-size:10px;color:#7a7e88;margin-bottom:4px;letter-spacing:.4px;">
                Brush Name
              </label>
              <input id="at-brush-name" type="text"
                     style="width:100%;background:transparent;border:none;border-bottom:1px solid #cfd4dd;
                            color:#222;padding:6px 0;font-size:14px;font-weight:600;outline:none;">
            </div>

            <!-- Tileset Type -->
            <div style="margin-bottom:18px;">
              <label style="display:block;font-size:10px;color:#7a7e88;margin-bottom:4px;letter-spacing:.4px;">
                Tileset Type
              </label>
              <select id="at-brush-type"
                      style="width:100%;background:transparent;border:none;border-bottom:1px solid #cfd4dd;
                             color:#222;padding:6px 0;font-size:14px;outline:none;">
                <option value="16-tile" selected>16 Tiles</option>
              </select>
            </div>

            <!-- Auto-Tile Spatial Layout -->
            <div style="margin-bottom:6px;">
              <div style="font-size:10px;color:#7a7e88;margin-bottom:8px;letter-spacing:.4px;font-weight:600;">TILE CONFIGURATIONS</div>

              <div style="display:flex;gap:8px;align-items:flex-start;">
                <!-- Vertical strip (left): top cap, pipe, bottom cap -->
                <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
                  <div style="font-size:8px;color:#9ba0aa;text-align:center;margin-bottom:2px;letter-spacing:.3px;">VERT</div>
                  <div class="at-thumb at-slot-cell" data-slot="1"  title="North only — bottom end cap"></div>
                  <div class="at-thumb at-slot-cell" data-slot="5"  title="North + South — vertical pipe"></div>
                  <div class="at-thumb at-slot-cell" data-slot="4"  title="South only — top end cap"></div>
                </div>

                <!-- 3x3 center grid: all 8 full neighbor combos -->
                <div style="flex:1;">
                  <div style="font-size:8px;color:#9ba0aa;text-align:center;margin-bottom:2px;letter-spacing:.3px;">NEIGHBORS (4-dir)</div>
                  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;">
                    <div class="at-thumb at-slot-cell" data-slot="9"  title="N+W — top-left inner corner"></div>
                    <div class="at-thumb at-slot-cell" data-slot="13" title="N+E+W — T top"></div>
                    <div class="at-thumb at-slot-cell" data-slot="11" title="N+E — top-right inner corner"></div>
                    <div class="at-thumb at-slot-cell" data-slot="12" title="S+W — T left"></div>
                    <div class="at-thumb at-slot-cell" data-slot="15" title="All 4 neighbors — cross / interior"></div>
                    <div class="at-thumb at-slot-cell" data-slot="14" title="S+E — T right"></div>
                    <div class="at-thumb at-slot-cell" data-slot="3"  title="N+E — bottom-left outer corner"></div>
                    <div class="at-thumb at-slot-cell" data-slot="7"  title="S+E+W — T bottom"></div>
                    <div class="at-thumb at-slot-cell" data-slot="6"  title="S+E — bottom-right outer corner"></div>
                  </div>
                </div>
              </div>

              <!-- Bottom row: horizontal strip + isolated tile -->
              <div style="display:flex;gap:8px;align-items:flex-end;margin-top:6px;">
                <!-- Horizontal strip -->
                <div style="flex:1;">
                  <div style="font-size:8px;color:#9ba0aa;text-align:center;margin-bottom:2px;letter-spacing:.3px;">HORIZONTAL</div>
                  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;">
                    <div class="at-thumb at-slot-cell" data-slot="2"  title="East only — left end cap"></div>
                    <div class="at-thumb at-slot-cell" data-slot="10" title="East + West — horizontal pipe"></div>
                    <div class="at-thumb at-slot-cell" data-slot="8"  title="West only — right end cap"></div>
                  </div>
                </div>
                <!-- Isolated / standalone -->
                <div style="flex-shrink:0;text-align:center;">
                  <div style="font-size:8px;color:#9ba0aa;margin-bottom:2px;letter-spacing:.3px;">ALONE</div>
                  <div class="at-thumb at-slot-cell" data-slot="0" title="No neighbors — standalone tile" style="width:52px;height:52px;"></div>
                </div>
              </div>
            </div>

            <div style="font-size:9px;color:#9ba0aa;margin-top:2px;margin-bottom:8px;text-align:center;">
              Click any cell to upload · Drag image files onto cells
            </div>

            <!-- Bulk upload button (still useful for ordering 1–15) -->
            <button id="at-upload-many"
              style="width:100%;background:#fff;border:1px solid #5fa8e0;color:#1d77c0;
                     border-radius:5px;padding:8px;font-size:11px;font-weight:600;letter-spacing:.5px;
                     cursor:pointer;margin-bottom:8px;">
              ⬆ BULK UPLOAD (order: slot 0 → 15)
            </button>

          </div>

          <div id="at-brush-empty" style="text-align:center;color:#9ba0aa;padding:24px 0;font-size:12px;">
            No brush selected.<br>Click <b>+ New</b> to create one.
          </div>
        </div>
      </div>

      <!-- MIDDLE: Brush Auto Tiler preview pane -->
      <div style="width:340px;flex-shrink:0;background:#f4f6fa;color:#222;
                  border-right:1px solid #2e2e3a;display:flex;flex-direction:column;overflow:hidden;">
        <div style="padding:14px 16px;background:#fff;margin:14px;border-radius:8px;
                    box-shadow:0 1px 4px rgba(0,0,0,.05);flex:1;overflow:auto;">
          <div style="display:flex;align-items:center;margin-bottom:10px;">
            <span style="font-weight:700;color:#222;">Brush Auto Tiler</span>
            <div style="flex:1;"></div>
            <button id="at-toggle-guides" style="background:none;border:none;color:#888;font-size:11px;cursor:pointer;
                                                 display:flex;align-items:center;gap:4px;">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
              </svg>
              <span id="at-guides-label">Tile guides OFF</span>
            </button>
          </div>

          <canvas id="at-preview"
                  style="display:block;width:100%;background:#cfd4dd;border-radius:4px;"></canvas>

          <button id="at-download-preview"
                  style="width:100%;margin-top:14px;background:#fff;border:1px solid #cfd4dd;color:#222;
                         border-radius:6px;padding:10px;font-size:11px;font-weight:600;letter-spacing:.6px;
                         cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
            ⬇  DOWNLOAD PREVIEW
          </button>
          <button id="at-upload-sheet"
                  style="width:100%;margin-top:8px;background:#fff;border:2px solid #5fa8e0;color:#1d77c0;
                         border-radius:6px;padding:10px;font-size:11px;font-weight:700;letter-spacing:.6px;
                         cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
            ⬆  UPLOAD BRUSH IMAGE
          </button>
        </div>
      </div>

      <!-- RIGHT: Map painter -->
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0e0e18;">
        <div style="padding:8px 14px;border-bottom:1px solid #1e1e2e;font-size:10px;color:#9ba0aa;
                    flex-shrink:0;display:flex;align-items:center;gap:10px;">
          <span style="font-weight:700;color:#4ade80;letter-spacing:.6px;">PAINT MAP</span>
          <span style="color:#3a3a48;">|</span>
          <span id="at-cursor-info" style="color:#7a7a90;">Hover over map to paint</span>

          <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <span style="color:#7a7a90;">Render</span>
            <select id="at-filter" style="background:#16161e;border:1px solid #3a3a48;color:#d8d8e8;
                    border-radius:3px;padding:3px 6px;font-size:10px;outline:none;">
              <option value="smooth">Smooth (curves)</option>
              <option value="pixelated">Pixelated</option>
            </select>
            <span style="color:#7a7a90;">Cols</span>
            <input id="at-cols" type="number" class="at-mini" min="1" max="512">
            <span style="color:#7a7a90;">Rows</span>
            <input id="at-rows" type="number" class="at-mini" min="1" max="512">
            <span style="color:#7a7a90;">Tile</span>
            <input id="at-tw" type="number" class="at-mini" min="4" max="512">
            <span style="color:#7a7a90;">×</span>
            <input id="at-th" type="number" class="at-mini" min="4" max="512">
            <button id="at-apply" style="background:#1e3050;border:1px solid #3A72A5;color:#7aabcc;
                    border-radius:3px;padding:3px 10px;font-size:10px;cursor:pointer;">Apply</button>

            <span style="color:#3a3a48;margin:0 4px;">|</span>
            <button class="at-tool tool-active" data-tool="paint" title="Paint (B)">🖌</button>
            <button class="at-tool" data-tool="erase" title="Erase (E)">⌫</button>
            <button class="at-tool" data-tool="fill"  title="Fill (F)">🪣</button>
            <button class="at-tool" data-tool="pick"  title="Pick (I)">🎯</button>
          </div>
        </div>

        <div style="flex:1;overflow:auto;padding:20px;display:flex;align-items:flex-start;justify-content:flex-start;">
          <div style="position:relative;display:inline-block;flex-shrink:0;">
            <canvas id="at-map" style="display:block;cursor:crosshair;"></canvas>
            <canvas id="at-map-ov" style="position:absolute;inset:0;pointer-events:none;"></canvas>
          </div>
        </div>

        <div style="padding:6px 14px;border-top:1px solid #1e1e2e;font-size:10px;color:#3a3a48;text-align:right;flex-shrink:0;">
          B=Paint  E=Erase  F=Fill  I=Pick  Ctrl+Z=Undo
        </div>
      </div>
    </div>

    <style>
      .at-thumb { aspect-ratio:1;background:#e6eaf0;border:1px dashed #c0c5d0;border-radius:4px;
                  cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden;
                  position:relative;min-width:0; }
      .at-thumb:hover { border-color:#5fa8e0;background:#ddeeff; }
      .at-thumb.at-drag-over { border-color:#4ade80;background:#d0f4e0;border-style:solid; }
      .at-thumb.at-has-img { border-style:solid;border-color:#8ac4f0; }
      .at-thumb img { width:100%;height:100%;object-fit:contain; }
      .at-thumb .at-slot-lbl { position:absolute;bottom:1px;right:3px;font-size:7px;color:#9ba0aa;
                                font-family:monospace;line-height:1;pointer-events:none; }
      .at-thumb .at-empty-dot { color:#c8cdd8;font-size:16px;line-height:1;pointer-events:none; }
      .at-thumb.empty .at-empty { color:#bcc1cc;font-size:9px; }
      .at-mini { width:48px;background:#16161e;border:1px solid #3a3a48;color:#d8d8e8;
                 border-radius:3px;padding:3px 4px;font-size:10px;outline:none;text-align:right; }
      .at-tool { background:#16161e;border:1px solid #2e2e3a;color:#9ba0aa;border-radius:3px;
                 width:28px;height:24px;font-size:13px;cursor:pointer;line-height:1; }
      .at-tool:hover { border-color:#4ade80;color:#4ade80; }
      .at-tool.tool-active { border-color:#4ade80;background:#16321e;color:#4ade80; }
      .pixelated { image-rendering:pixelated; }
    </style>
    `;
    document.body.appendChild(panel);
    _wireEditor(panel, obj);
}

function _wireEditor(panel, obj) {
    const d = obj.autoTileData;
    let activeBrushId = state.tilesetBrushes[0]?.id || null;
    let tool = 'paint';
    let isPainting = false;
    let guidesOn = false;
    const undoStack = [];
    const imgCache = new Map(); // brushId -> Array<HTMLImageElement|null>

    // ── References ───────────────────────────────────────────
    const $ = sel => panel.querySelector(sel);
    const map   = $('#at-map'),  mov  = $('#at-map-ov');
    const mctx  = map.getContext('2d');
    const moctx = mov.getContext('2d');
    const preview = $('#at-preview');
    const pctx = preview.getContext('2d');

    // Init render-mode/cols/rows fields
    $('#at-filter').value = d.filterMode;
    $('#at-cols').value = d.cols;
    $('#at-rows').value = d.rows;
    $('#at-tw').value   = d.tileW;
    $('#at-th').value   = d.tileH;

    // ── Close ────────────────────────────────────────────────
    $('#at-close').addEventListener('click', () => {
        rebuildAutoTileSprites(obj);
        _buildHelper(obj);
        import('./engine.ui.js').then(m => { m.syncPixiToInspector(); m.refreshHierarchy(); });
        panel.remove();
        window.removeEventListener('keydown', _onKey);
    });

    // ── Brush selector ───────────────────────────────────────
    const brushSel = $('#at-brush-select');
    function _populateBrushes() {
        brushSel.innerHTML = '<option value="">— Select brush —</option>';
        for (const b of state.tilesetBrushes) {
            const o = document.createElement('option');
            o.value = b.id; o.textContent = b.name;
            if (b.id === activeBrushId) o.selected = true;
            brushSel.appendChild(o);
        }
        _renderBrushForm();
    }
    brushSel.addEventListener('change', () => {
        activeBrushId = brushSel.value || null;
        _renderBrushForm();
    });

    $('#at-brush-new').addEventListener('click', () => {
        const name = prompt('Brush name:', 'TileBrush' + (state.tilesetBrushes.length + 1));
        if (!name) return;
        const id = 'brush_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
        state.tilesetBrushes.push({
            id, name, type: '16-tile',
            tileW: d.tileW, tileH: d.tileH,
            tiles: new Array(SLOTS).fill(null),
        });
        activeBrushId = id;
        _populateBrushes();
    });

    $('#at-brush-delete').addEventListener('click', () => {
        const brush = _getBrush(); if (!brush) return;
        if (!confirm(`Delete brush "${brush.name}"? This will erase its cells from this map.`)) return;
        const idx = d.brushList.indexOf(brush.id);
        if (idx >= 0) {
            for (let i = 0; i < d.cells.length; i++) {
                if (d.cells[i] === idx) d.cells[i] = -1;
                else if (d.cells[i] > idx) d.cells[i]--;
            }
            d.brushList.splice(idx, 1);
        }
        state.tilesetBrushes = state.tilesetBrushes.filter(b => b.id !== brush.id);
        activeBrushId = state.tilesetBrushes[0]?.id || null;
        _populateBrushes();
        _drawMap();
    });

    function _getBrush() {
        return state.tilesetBrushes.find(b => b.id === activeBrushId) || null;
    }

    // Pre-load images for a brush
    function _brushImgs(brush) {
        let imgs = imgCache.get(brush.id);
        if (!imgs || imgs.length !== SLOTS) { imgs = new Array(SLOTS).fill(null); imgCache.set(brush.id, imgs); }
        for (let i = 0; i < SLOTS; i++) {
            const url = brush.tiles[i];
            if (!url) { imgs[i] = null; continue; }
            if (!imgs[i] || imgs[i].dataset.src !== url) {
                const im = new Image();
                im.dataset.src = url;
                im.onload = () => { _drawMap(); _drawPreview(); };
                im.src = url;
                imgs[i] = im;
            }
        }
        return imgs;
    }

    // ── Brush form (right column of left panel) ──────────────
    function _renderBrushForm() {
        const brush = _getBrush();
        $('#at-brush-form').style.display  = brush ? 'block' : 'none';
        $('#at-brush-empty').style.display = brush ? 'none'  : 'block';
        if (!brush) { _drawPreview(); return; }

        $('#at-brush-name').value = brush.name;
        $('#at-brush-type').value = brush.type || '16-tile';

        // Populate the new spatial slot cells (at-slot-cell divs by data-slot)
        const sharp = d.filterMode === 'pixelated' ? 'pixelated' : '';
        panel.querySelectorAll('.at-slot-cell').forEach(cell => {
            const slotIdx = parseInt(cell.dataset.slot, 10);
            const hasImg  = !!brush.tiles[slotIdx];
            // Clear
            cell.innerHTML = '';
            cell.className = 'at-thumb at-slot-cell' + (hasImg ? ' at-has-img' : '');
            if (hasImg) {
                const img = document.createElement('img');
                img.src = brush.tiles[slotIdx];
                if (sharp) img.className = sharp;
                cell.appendChild(img);
            } else {
                const dot = document.createElement('span');
                dot.className = 'at-empty-dot';
                dot.textContent = '+';
                cell.appendChild(dot);
            }
            // Slot number label (bottom-right)
            const lbl = document.createElement('span');
            lbl.className = 'at-slot-lbl';
            lbl.textContent = slotIdx;
            cell.appendChild(lbl);
        });

        _brushImgs(brush);
        _drawPreview();
    }

    $('#at-brush-name').addEventListener('change', e => {
        const b = _getBrush(); if (!b) return;
        b.name = e.target.value || b.name;
        _populateBrushes();
    });

    // Wire click + drag-drop onto all at-slot-cell divs
    function _wireSlotCells() {
        panel.querySelectorAll('.at-slot-cell').forEach(cell => {
            const slotIdx = parseInt(cell.dataset.slot, 10);

            cell.addEventListener('click', () => {
                const brush = _getBrush(); if (!brush) return;
                _uploadOne(brush, slotIdx);
            });

            // Drag and drop support
            cell.addEventListener('dragover', e => {
                e.preventDefault();
                cell.classList.add('at-drag-over');
            });
            cell.addEventListener('dragleave', () => {
                cell.classList.remove('at-drag-over');
            });
            cell.addEventListener('drop', e => {
                e.preventDefault();
                cell.classList.remove('at-drag-over');
                const brush = _getBrush(); if (!brush) return;
                const file = e.dataTransfer?.files?.[0];
                if (!file || !file.type.startsWith('image/')) return;
                const fr = new FileReader();
                fr.onload = ev => {
                    brush.tiles[slotIdx] = ev.target.result;
                    imgCache.delete(brush.id);
                    _renderBrushForm();
                    _drawMap();
                };
                fr.readAsDataURL(file);
            });

            // Right-click to clear
            cell.addEventListener('contextmenu', e => {
                e.preventDefault();
                const brush = _getBrush(); if (!brush) return;
                if (!brush.tiles[slotIdx]) return;
                brush.tiles[slotIdx] = null;
                imgCache.delete(brush.id);
                _renderBrushForm();
                _drawMap();
            });
        });
    }
    _wireSlotCells();

    function _uploadOne(brush, slotIdx) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = e => {
            const f = e.target.files[0]; if (!f) return;
            const fr = new FileReader();
            fr.onload = ev => {
                brush.tiles[slotIdx] = ev.target.result;
                imgCache.delete(brush.id);
                _renderBrushForm();
                _drawMap();
            };
            fr.readAsDataURL(f);
        };
        inp.click();
    }

    // ── UPLOAD IMAGES (multi, bulk order slot 0→15) ─────────
    $('#at-upload-many').addEventListener('click', () => {
        const brush = _getBrush(); if (!brush) return;
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
        inp.onchange = async e => {
            const files = Array.from(e.target.files || [])
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            const max = Math.min(files.length, SLOTS);
            for (let i = 0; i < max; i++) {
                brush.tiles[i] = await new Promise(res => {
                    const fr = new FileReader();
                    fr.onload = ev => res(ev.target.result);
                    fr.readAsDataURL(files[i]);
                });
            }
            imgCache.delete(brush.id);
            _renderBrushForm();
            _drawMap();
        };
        inp.click();
    });

    // ── UPLOAD BRUSH IMAGE (single 4×4 sheet) ────────────────
    $('#at-upload-sheet').addEventListener('click', () => {
        const brush = _getBrush(); if (!brush) return;
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = e => {
            const f = e.target.files[0]; if (!f) return;
            const fr = new FileReader();
            fr.onload = ev => {
                const img = new Image();
                img.onload = () => {
                    const sw = Math.floor(img.width / 4);
                    const sh = Math.floor(img.height / 4);
                    for (let i = 0; i < SLOTS; i++) {
                        const sc = i % 4, sr = Math.floor(i / 4);
                        const cv = document.createElement('canvas');
                        cv.width = sw; cv.height = sh;
                        const cx = cv.getContext('2d');
                        cx.imageSmoothingEnabled = d.filterMode !== 'pixelated';
                        cx.drawImage(img, sc * sw, sr * sh, sw, sh, 0, 0, sw, sh);
                        brush.tiles[i] = cv.toDataURL('image/png');
                    }
                    brush.tileW = sw; brush.tileH = sh;
                    imgCache.delete(brush.id);
                    _renderBrushForm();
                    _drawMap();
                };
                img.src = ev.target.result;
            };
            fr.readAsDataURL(f);
        };
        inp.click();
    });

    // ── Toggle preview tile guides ───────────────────────────
    $('#at-toggle-guides').addEventListener('click', () => {
        guidesOn = !guidesOn;
        $('#at-guides-label').textContent = guidesOn ? 'Tile guides ON' : 'Tile guides OFF';
        _drawPreview();
    });

    // ── Download preview ─────────────────────────────────────
    $('#at-download-preview').addEventListener('click', () => {
        const url = preview.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = (_getBrush()?.name || 'brush') + '_preview.png';
        a.click();
    });

    // ── Brush preview canvas ─────────────────────────────────
    function _drawPreview() {
        const brush = _getBrush();
        // Use a small demo blob shape that exercises many neighbor configs
        const cells = [
            [0,1,1,1,0],
            [1,1,1,1,1],
            [1,1,1,1,1],
            [0,1,1,0,0],
        ];
        const rows = cells.length, cols = cells[0].length;
        const tw = (brush?.tileW) || d.tileW;
        const th = (brush?.tileH) || d.tileH;
        // Display target ~280px wide
        const cssW = 280;
        const scale = cssW / (cols * tw);
        preview.width  = cols * tw;
        preview.height = rows * th;
        preview.style.width  = (cols * tw * scale) + 'px';
        preview.style.height = (rows * th * scale) + 'px';
        preview.style.imageRendering = (d.filterMode === 'pixelated') ? 'pixelated' : 'auto';
        pctx.imageSmoothingEnabled = d.filterMode !== 'pixelated';

        pctx.fillStyle = '#cfd4dd';
        pctx.fillRect(0, 0, preview.width, preview.height);

        if (brush) {
            const imgs = _brushImgs(brush);
            const isFilled = (c, r) => (cells[r] && cells[r][c]) ? 1 : 0;
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    if (!isFilled(c, r)) continue;
                    let m = 0;
                    if (isFilled(c, r-1)) m |= 1;
                    if (isFilled(c+1, r)) m |= 2;
                    if (isFilled(c, r+1)) m |= 4;
                    if (isFilled(c-1, r)) m |= 8;
                    const slot = _resolveSlot(brush, m);
                    if (slot < 0) continue;
                    const im = imgs[slot];
                    if (im && im.complete) pctx.drawImage(im, c * tw, r * th, tw, th);
                }
            }
        }
        if (guidesOn) {
            pctx.strokeStyle = 'rgba(80,90,110,0.5)'; pctx.lineWidth = 1;
            pctx.beginPath();
            for (let c = 0; c <= cols; c++) { pctx.moveTo(c*tw, 0); pctx.lineTo(c*tw, preview.height); }
            for (let r = 0; r <= rows; r++) { pctx.moveTo(0, r*th); pctx.lineTo(preview.width, r*th); }
            pctx.stroke();
        }
    }

    // ── Map painter ──────────────────────────────────────────
    function _initMap() {
        map.width  = d.cols * d.tileW;
        map.height = d.rows * d.tileH;
        mov.width  = map.width;
        mov.height = map.height;
        const sharp = d.filterMode === 'pixelated';
        for (const cv of [map, mov]) cv.style.imageRendering = sharp ? 'pixelated' : 'auto';
        for (const cx of [mctx, moctx]) { cx.imageSmoothingEnabled = !sharp; cx.imageSmoothingQuality = 'high'; }
    }

    function _drawMap() {
        mctx.fillStyle = '#161a1f';
        mctx.fillRect(0, 0, map.width, map.height);

        for (let i = 0; i < d.cells.length; i++) {
            const bIdx = d.cells[i];
            if (bIdx < 0) continue;
            const brushId = d.brushList[bIdx];
            const brush = state.tilesetBrushes.find(b => b.id === brushId);
            if (!brush) continue;
            const col = i % d.cols, row = Math.floor(i / d.cols);
            const slot = _resolveSlot(brush, _mask(d, col, row));
            if (slot < 0) continue;
            const imgs = _brushImgs(brush);
            const im = imgs[slot];
            if (im && im.complete) {
                mctx.drawImage(im, col * d.tileW, row * d.tileH, d.tileW, d.tileH);
            }
        }

        mctx.strokeStyle = 'rgba(74,222,128,0.18)'; mctx.lineWidth = 0.5;
        mctx.beginPath();
        for (let c = 0; c <= d.cols; c++) { mctx.moveTo(c*d.tileW, 0); mctx.lineTo(c*d.tileW, map.height); }
        for (let r = 0; r <= d.rows; r++) { mctx.moveTo(0, r*d.tileH); mctx.lineTo(map.width, r*d.tileH); }
        mctx.stroke();
        mctx.strokeStyle = 'rgba(74,222,128,0.55)'; mctx.lineWidth = 2;
        mctx.strokeRect(0, 0, map.width, map.height);
    }

    function _getCell(e) {
        const rect = map.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (map.width  / rect.width);
        const my = (e.clientY - rect.top)  * (map.height / rect.height);
        return { c: Math.floor(mx / d.tileW), r: Math.floor(my / d.tileH) };
    }
    function _validCell(c, r) { return c >= 0 && c < d.cols && r >= 0 && r < d.rows; }

    function _ensureBrushIdx(brushId) {
        let idx = d.brushList.indexOf(brushId);
        if (idx < 0) { d.brushList.push(brushId); idx = d.brushList.length - 1; }
        return idx;
    }

    function _paintCell(c, r) {
        if (!_validCell(c, r)) return;
        const i = r * d.cols + c;
        if (tool === 'paint') {
            if (!activeBrushId) return;
            const idx = _ensureBrushIdx(activeBrushId);
            if (d.cells[i] === idx) return;
            d.cells[i] = idx;
        } else if (tool === 'erase') {
            if (d.cells[i] === -1) return;
            d.cells[i] = -1;
        }
        _drawMap();
    }

    function _fill(c, r) {
        if (!_validCell(c, r)) return;
        const target = d.cells[r * d.cols + c];
        const replaceIdx = tool === 'erase' ? -1
            : (activeBrushId ? _ensureBrushIdx(activeBrushId) : -1);
        if (target === replaceIdx) return;
        const queue = [[c, r]];
        const visited = new Uint8Array(d.cols * d.rows);
        while (queue.length) {
            const [cc, cr] = queue.shift();
            if (!_validCell(cc, cr)) continue;
            const idx = cr * d.cols + cc;
            if (visited[idx] || d.cells[idx] !== target) continue;
            visited[idx] = 1;
            d.cells[idx] = replaceIdx;
            queue.push([cc-1,cr],[cc+1,cr],[cc,cr-1],[cc,cr+1]);
        }
        _drawMap();
    }

    function _pushUndo() {
        undoStack.push({ cells: new Int16Array(d.cells), brushList: d.brushList.slice() });
        if (undoStack.length > 30) undoStack.shift();
    }
    function _undo() {
        if (!undoStack.length) return;
        const s = undoStack.pop();
        d.cells = s.cells; d.brushList = s.brushList;
        _drawMap();
    }

    map.addEventListener('mousedown', e => {
        const { c, r } = _getCell(e);
        if (!_validCell(c, r)) return;
        _pushUndo();
        if (tool === 'fill') { _fill(c, r); return; }
        if (tool === 'pick') {
            const idx = r * d.cols + c;
            if (d.cells[idx] >= 0) {
                activeBrushId = d.brushList[d.cells[idx]];
                brushSel.value = activeBrushId || '';
                _renderBrushForm();
            }
            setTool('paint'); return;
        }
        isPainting = true;
        _paintCell(c, r);
    });
    window.addEventListener('mouseup', () => { isPainting = false; });
    map.addEventListener('mousemove', e => {
        const { c, r } = _getCell(e);
        $('#at-cursor-info').textContent =
            _validCell(c, r) ? `Col ${c+1}, Row ${r+1}  (brush ${d.cells[r*d.cols+c]})` : '';
        moctx.clearRect(0, 0, map.width, map.height);
        if (_validCell(c, r)) {
            const brush = _getBrush();
            if (tool === 'paint' && brush) {
                const imgs = _brushImgs(brush);
                const slot = _resolveSlot(brush, 0);
                if (slot >= 0 && imgs[slot] && imgs[slot].complete) {
                    moctx.globalAlpha = 0.55;
                    moctx.drawImage(imgs[slot], c*d.tileW, r*d.tileH, d.tileW, d.tileH);
                    moctx.globalAlpha = 1;
                }
            }
            moctx.strokeStyle = '#facc15'; moctx.lineWidth = 2;
            moctx.strokeRect(c*d.tileW+1, r*d.tileH+1, d.tileW-2, d.tileH-2);
        }
        if (isPainting && (tool === 'paint' || tool === 'erase')) _paintCell(c, r);
    });
    map.addEventListener('mouseleave', () => {
        moctx.clearRect(0, 0, map.width, map.height);
        $('#at-cursor-info').textContent = '';
    });

    function setTool(t) {
        tool = t;
        panel.querySelectorAll('.at-tool').forEach(b => b.classList.toggle('tool-active', b.dataset.tool === t));
    }
    panel.querySelectorAll('.at-tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

    const _onKey = e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.key === 'b' || e.key === 'B') setTool('paint');
        if (e.key === 'e' || e.key === 'E') setTool('erase');
        if (e.key === 'f' || e.key === 'F') setTool('fill');
        if (e.key === 'i' || e.key === 'I') setTool('pick');
        if ((e.ctrlKey||e.metaKey) && e.key === 'z') { e.preventDefault(); _undo(); }
    };
    window.addEventListener('keydown', _onKey);

    // Apply settings (resize / render mode)
    $('#at-apply').addEventListener('click', () => {
        const nc = Math.max(1, parseInt($('#at-cols').value)||20);
        const nr = Math.max(1, parseInt($('#at-rows').value)||15);
        const tw = Math.max(4, parseInt($('#at-tw').value)||32);
        const th = Math.max(4, parseInt($('#at-th').value)||32);
        const fm = $('#at-filter').value;
        const newCells = new Int16Array(nc * nr).fill(-1);
        for (let r = 0; r < Math.min(nr, d.rows); r++) {
            for (let c = 0; c < Math.min(nc, d.cols); c++) {
                newCells[r*nc + c] = d.cells[r*d.cols + c];
            }
        }
        d.cols = nc; d.rows = nr; d.tileW = tw; d.tileH = th;
        d.cells = newCells; d.filterMode = fm;
        _initMap(); _drawMap(); _renderBrushForm();
    });

    // Init
    _initMap();
    _drawMap();
    _populateBrushes();
}

// ── Inspector HTML ───────────────────────────────────────────
export function buildAutoTileInspectorHTML(obj) {
    const d = obj.autoTileData; _migrate(d);
    return `
    <div class="component-block" id="inspector-autotile-section">
      <div class="component-header">
        <svg viewBox="0 0 24 24" class="comp-icon" style="color:#4ade80;">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>
          <circle cx="12" cy="12" r="2" fill="#4ade80"/>
        </svg>
        <span style="font-weight:600;color:#4ade80;">Auto Tilemap</span>
      </div>
      <div class="component-body" style="display:flex;flex-direction:column;gap:5px;">
        <div class="prop-row"><span class="prop-label">Size</span><span style="color:#9bc;">${d.cols} × ${d.rows} tiles</span></div>
        <div class="prop-row"><span class="prop-label">Tile size</span><span style="color:#9bc;">${d.tileW} × ${d.tileH} px</span></div>
        <div class="prop-row"><span class="prop-label">Render</span><span style="color:#9bc;">${d.filterMode}</span></div>
        <div class="prop-row"><span class="prop-label">Brushes used</span><span style="color:#9bc;">${(d.brushList||[]).length}</span></div>
        <button id="btn-open-autotile-editor" style="width:100%;background:#1a2a1a;border:1px solid #4ade80;color:#4ade80;
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

// ── Snapshot / restore ───────────────────────────────────────
export function snapshotAutoTilemap(obj) {
    const d = obj.autoTileData; _migrate(d);
    return {
        isAutoTilemap: true,
        label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
        autoTileData: {
            ...d,
            cells: Array.from(d.cells),
            brushList: d.brushList.slice(),
        },
    };
}
export async function restoreAutoTilemap(s) {
    const obj = createAutoTilemap(s.x, s.y);
    obj.label = s.label; obj.unityZ = s.unityZ || 0;
    const td = s.autoTileData;
    obj.autoTileData = {
        ...td,
        cells:     new Int16Array(td.cells || []),
        brushList: Array.isArray(td.brushList) ? td.brushList.slice() : [],
        filterMode: td.filterMode || 'smooth',
    };
    _migrate(obj.autoTileData);
    _buildHelper(obj);
    rebuildAutoTileSprites(obj);
    return obj;
}

// ── Helpers ──────────────────────────────────────────────────
function _uniqueName(base) {
    const existing = new Set(state.gameObjects.map(o => o.label));
    if (!existing.has(base)) return base;
    let i = 2; while (existing.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
}
function _attachTranslateGizmo(container) {
    const gizmoContainer = new PIXI.Container();
    container.addChild(gizmoContainer);
    container._gizmoContainer = gizmoContainer;
    const g1 = _makeAxisLine(0xFF4F4B, 50, false);
    const g2 = _makeAxisLine(0x8FC93A, 50, true);
    const g3 = _makeSquare();
    const grpT = new PIXI.Container(); grpT.addChild(g1, g2, g3);
    const grpR = new PIXI.Container(); grpR.visible = false;
    const grpS = new PIXI.Container(); grpS.visible = false;
    container._grpTranslate = grpT; container._grpRotate = grpR; container._grpScale = grpS;
    gizmoContainer.addChild(grpT, grpR, grpS);
    container._gizmoHandles = { transX:g1, transY:g2, transCenter:g3, scaleX:g1, scaleY:g2, scaleCenter:g3, rotRing:g3 };
    [g1, g2, g3].forEach(h => h.on('pointerdown', e => e.stopPropagation()));
}
function _makeAxisLine(color, len, isY) {
    const g = new PIXI.Graphics();
    g.beginFill(color); g.lineStyle(2, color);
    if (isY) g.drawRect(-1,-len,2,len); else g.drawRect(0,-1,len,2);
    g.lineStyle(0);
    if (isY) { g.moveTo(-5,-len); g.lineTo(0,-len-9); g.lineTo(5,-len); }
    else     { g.moveTo(len,-5);  g.lineTo(len+9,0);   g.lineTo(len,5); }
    g.endFill(); g.eventMode='static'; return g;
}
function _makeSquare() {
    const g = new PIXI.Graphics();
    g.beginFill(0xFFFFFF, 0.4); g.drawRect(-7,-7,14,14); g.endFill();
    g.eventMode='static'; g.cursor='move'; return g;
}
