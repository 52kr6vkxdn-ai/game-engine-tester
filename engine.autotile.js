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
        position:fixed;inset:0;z-index:15000;
        font-family:'Inter','Segoe UI',sans-serif;font-size:11px;
        display:flex;flex-direction:column;
    `;


    // ── Inject Tailwind + Lucide if not already present ─────────
    if (!document.getElementById('at-tailwind')) {
        const tw = document.createElement('script');
        tw.id = 'at-tailwind';
        tw.src = 'https://cdn.tailwindcss.com';
        document.head.appendChild(tw);
    }
    if (!document.getElementById('at-lucide')) {
        const lc = document.createElement('script');
        lc.id = 'at-lucide';
        lc.src = 'https://unpkg.com/lucide@latest';
        document.head.appendChild(lc);
    }

    // ── Inject scoped styles ─────────────────────────────────────
    if (!document.getElementById('at-editor-styles')) {
        const style = document.createElement('style');
        style.id = 'at-editor-styles';
        style.textContent = `
            #at-editor { background: #e8ecf1; }
            #at-editor .at-tile-block {
                border-top: 1px solid #9ca3af;
                border-left: 1px solid #9ca3af;
            }
            #at-editor .at-drop-target {
                border-bottom: 1px solid #9ca3af;
                border-right: 1px solid #9ca3af;
                background-color: #dce3ef;
                position: relative;
                box-sizing: border-box;
                overflow: hidden;
                touch-action: none;
            }
            #at-editor .at-mode-drag .at-drop-target.has-image { cursor: grab; }
            #at-editor .at-mode-drag .at-drop-target.has-image:active { cursor: grabbing; }
            #at-editor .at-mode-drag .at-drop-target.has-image:hover {
                box-shadow: inset 0 0 0 3px #3b82f6;
                filter: brightness(1.05);
            }
            #at-editor .at-mode-drag .at-drop-target.drag-over {
                filter: brightness(0.9);
                background-color: #bfdbfe;
                box-shadow: inset 0 0 0 3px #2563eb;
            }
            #at-editor .at-mode-drag .at-drop-target.has-image:hover .at-clear-btn { display: flex; }
            #at-editor .at-mode-erase .at-drop-target.has-image { cursor: crosshair; }
            #at-editor .at-mode-erase .at-drop-target.has-image:hover {
                box-shadow: inset 0 0 0 3px #ef4444;
            }
            #at-editor .at-mode-erase .at-clear-btn { display: none !important; }
            #at-editor #at-grid-container.guides-off .at-tile-block,
            #at-editor #at-grid-container.guides-off .at-drop-target {
                border-color: transparent;
            }
            #at-editor .at-clear-btn {
                display: none;
                position: absolute;
                top: 0; right: 0;
                background-color: #ef4444;
                color: white;
                padding: 4px;
                border-bottom-left-radius: 6px;
                z-index: 10;
                transition: background-color 0.1s;
                cursor: pointer;
                align-items: center;
                justify-content: center;
            }
            #at-editor .at-clear-btn:hover { background-color: #dc2626; }
            #at-editor #at-draw-canvas {
                cursor: none;
                image-rendering: pixelated;
                box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1),0 2px 4px -1px rgba(0,0,0,0.06);
                touch-action: none;
            }
            @keyframes at-popIn {
                0%   { transform: scale(0.8); opacity: 0; }
                100% { transform: scale(1);   opacity: 1; }
            }
            #at-editor .at-animate-pop {
                animation: at-popIn 0.3s cubic-bezier(0.175,0.885,0.32,1.275) forwards;
            }
        `;
        document.head.appendChild(style);
    }

    // ── Panel HTML (VIEW 1: Editor, VIEW 2: Draw) ────────────────
    panel.innerHTML = `
    <!-- CLOSE BUTTON (floating) -->
    <div style="position:absolute;top:12px;right:16px;z-index:100;">
      <button id="at-close"
        style="background:#fff;border:1px solid #d1d5db;color:#374151;border-radius:6px;
               padding:6px 14px;font-size:13px;font-weight:700;cursor:pointer;
               box-shadow:0 1px 4px rgba(0,0,0,.12);">✕ Close</button>
    </div>

    <!-- ===== VIEW 1: EDITOR MODE ===== -->
    <div id="at-editor-view" style="display:flex;width:100%;height:100%;">

      <!-- Left Panel: Brush Controls & Gallery -->
      <div style="width:320px;background:white;border-right:1px solid #e5e7eb;
                  box-shadow:1px 0 4px rgba(0,0,0,.05);display:flex;flex-direction:column;
                  height:100%;z-index:10;flex-shrink:0;">
        <div style="padding:24px 24px 16px;">

          <!-- Brush Selector -->
          <div style="margin-bottom:20px;">
            <label style="display:block;font-size:10px;font-weight:600;color:#9ca3af;
                           text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">
              Active Brush
            </label>
            <div style="display:flex;gap:6px;align-items:center;">
              <select id="at-brush-select"
                style="flex:1;border:none;border-bottom:1px solid #9ca3af;padding:4px 0;
                       outline:none;color:#374151;background:transparent;font-size:13px;">
                <option value="">— Select brush —</option>
              </select>
              <button id="at-brush-new"
                style="background:#fff;border:1px solid #4ade80;color:#16a34a;border-radius:4px;
                       padding:4px 8px;font-size:12px;cursor:pointer;font-weight:700;">+</button>
              <button id="at-brush-delete"
                style="background:#fff;border:1px solid #fca5a5;color:#b91c1c;border-radius:4px;
                       padding:4px 6px;font-size:12px;cursor:pointer;">🗑</button>
            </div>
          </div>

          <!-- Brush Name (shown when brush selected) -->
          <div id="at-brush-name-row" style="margin-bottom:20px;display:none;">
            <label style="display:block;font-size:10px;font-weight:600;color:#9ca3af;
                           text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">
              Brush Name
            </label>
            <input id="at-brush-name" type="text"
              style="width:100%;border:none;border-bottom:1px solid #9ca3af;padding:4px 0;
                     outline:none;color:#374151;background:transparent;font-size:14px;">
          </div>

          <!-- Upload Individual Pieces -->
          <button id="at-upload-many"
            style="width:100%;padding:8px 0;border:2px solid #3b82f6;color:#3b82f6;font-weight:700;
                   border-radius:6px;background:white;cursor:pointer;font-size:12px;
                   letter-spacing:.05em;text-transform:uppercase;margin-bottom:10px;">
            ⬆ Upload Images
          </button>
          <input type="file" id="at-pieces-file-input" multiple accept="image/*" style="display:none;">
        </div>

        <!-- Gallery -->
        <div style="flex:1;overflow-y:auto;padding:0 24px 24px;">
          <div id="at-gallery"
               style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;"></div>
          <div id="at-empty-gallery-msg"
               style="text-align:center;font-size:13px;color:#9ca3af;margin-top:40px;">
            No images yet.<br>Upload pieces or a full brush.
          </div>
        </div>
      </div>

      <!-- Right Panel: Grid + Actions -->
      <div style="flex:1;overflow-y:auto;padding:40px;display:flex;flex-direction:column;
                  align-items:center;justify-content:center;position:relative;">
        <div style="background:white;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);
                    padding:32px;width:100%;max-width:520px;">

          <!-- Header & Guide toggle -->
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h2 style="font-size:18px;font-weight:700;color:#374151;margin:0;">Tile Editor</h2>
            <button id="at-guide-toggle"
              style="display:flex;align-items:center;gap:6px;font-size:12px;color:#6b7280;
                     background:none;border:none;cursor:pointer;">
              👁 <span id="at-guides-label">Guides OFF</span>
            </button>
          </div>

          <!-- Toolbar -->
          <div style="display:flex;background:#f3f4f6;padding:4px;border-radius:8px;
                      margin-bottom:24px;width:max-content;box-shadow:inset 0 1px 3px rgba(0,0,0,.1);">
            <button id="at-tool-drag"
              style="display:flex;align-items:center;gap:6px;padding:6px 16px;border-radius:6px;
                     background:white;box-shadow:0 1px 3px rgba(0,0,0,.1);font-size:12px;
                     font-weight:700;color:#2563eb;border:none;cursor:pointer;">
              ✥ Drag &amp; Drop
            </button>
            <button id="at-tool-erase"
              style="display:flex;align-items:center;gap:6px;padding:6px 16px;border-radius:6px;
                     background:none;border:none;font-size:12px;font-weight:700;
                     color:#6b7280;cursor:pointer;">
              ⌫ Eraser Brush
            </button>
          </div>

          <!-- 4×4 Tile Grid -->
          <div id="at-grid-container"
               style="display:flex;flex-direction:column;gap:10px;width:max-content;margin:0 auto;"
               class="at-mode-drag">
            <!-- Top Row: 3×3 + 1×3 -->
            <div style="display:flex;gap:10px;">
              <div style="display:grid;grid-template-columns:repeat(3,1fr);" class="at-tile-block">
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="0"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="1"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="2"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="3"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="4"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="5"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="6"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="7"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="8"></div>
              </div>
              <div style="display:grid;grid-template-columns:1fr;" class="at-tile-block">
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="9"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="10"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="11"></div>
              </div>
            </div>
            <!-- Bottom Row: 3×1 + 1×1 -->
            <div style="display:flex;gap:10px;">
              <div style="display:grid;grid-template-columns:repeat(3,1fr);" class="at-tile-block">
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="12"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="13"></div>
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="14"></div>
              </div>
              <div style="display:grid;grid-template-columns:1fr;" class="at-tile-block">
                <div class="at-drop-target" style="width:60px;height:60px;" data-slot="15"></div>
              </div>
            </div>
          </div>

          <!-- Map settings + action buttons -->
          <div style="margin-top:32px;display:flex;flex-direction:column;gap:12px;">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11px;color:#6b7280;">
              <span>Cols</span>
              <input id="at-cols" type="number" min="1" max="512"
                style="width:48px;background:#f9fafb;border:1px solid #d1d5db;color:#374151;
                       border-radius:4px;padding:4px;font-size:11px;outline:none;text-align:right;">
              <span>Rows</span>
              <input id="at-rows" type="number" min="1" max="512"
                style="width:48px;background:#f9fafb;border:1px solid #d1d5db;color:#374151;
                       border-radius:4px;padding:4px;font-size:11px;outline:none;text-align:right;">
              <span>TW</span>
              <input id="at-tw" type="number" min="4" max="512"
                style="width:48px;background:#f9fafb;border:1px solid #d1d5db;color:#374151;
                       border-radius:4px;padding:4px;font-size:11px;outline:none;text-align:right;">
              <span>TH</span>
              <input id="at-th" type="number" min="4" max="512"
                style="width:48px;background:#f9fafb;border:1px solid #d1d5db;color:#374151;
                       border-radius:4px;padding:4px;font-size:11px;outline:none;text-align:right;">
              <select id="at-filter"
                style="background:#f9fafb;border:1px solid #d1d5db;color:#374151;
                       border-radius:4px;padding:4px 6px;font-size:11px;outline:none;">
                <option value="smooth">Smooth</option>
                <option value="pixelated">Pixelated</option>
              </select>
            </div>
            <button id="at-go-to-draw-btn"
              style="width:100%;padding:12px 0;background:#10b981;color:white;font-weight:700;
                     border-radius:6px;border:none;cursor:pointer;font-size:13px;
                     letter-spacing:.05em;text-transform:uppercase;box-shadow:0 4px 6px rgba(0,0,0,.1);">
              🗺 Done / Draw Map
            </button>
            <button id="at-upload-sheet"
              style="width:100%;padding:8px 0;border:2px solid #3b82f6;color:#3b82f6;font-weight:700;
                     border-radius:6px;background:white;cursor:pointer;font-size:12px;
                     letter-spacing:.05em;text-transform:uppercase;">
              ⬆ Advanced Auto-Complete (4×4 Brush)
            </button>
            <input type="file" id="at-brush-file-input" accept="image/*" style="display:none;">
          </div>
        </div>

        <div style="position:absolute;bottom:24px;font-size:12px;color:#9ca3af;">
          ℹ️ Use the Eraser Brush to manually trim pixels inside a tile box!
        </div>
      </div>
    </div>

    <!-- ===== VIEW 2: DRAWING MODE ===== -->
    <div id="at-draw-view"
         style="display:none;flex-direction:column;width:100%;height:100%;background:#1e293b;">
      <div style="background:white;border-bottom:1px solid #e5e7eb;padding:16px;
                  display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:16px;">
          <button id="at-back-to-editor-btn"
            style="padding:8px 16px;background:#f3f4f6;color:#374151;font-weight:600;
                   border-radius:6px;border:none;cursor:pointer;font-size:13px;">
            ← Edit Brush
          </button>
          <span style="font-size:18px;font-weight:700;color:#1f2937;">🖊 Map Drawer</span>
        </div>
        <div style="display:flex;align-items:center;gap:16px;font-size:12px;color:#6b7280;font-weight:500;">
          <span>🔵 Left Click: Draw</span>
          <span>🔴 Right Click: Erase</span>
          <button id="at-clear-map-btn"
            style="margin-left:16px;padding:4px 12px;border:1px solid #fca5a5;color:#ef4444;
                   background:white;border-radius:4px;cursor:pointer;font-size:12px;">Clear Map</button>
        </div>
      </div>
      <div style="flex:1;overflow:auto;padding:32px;display:flex;justify-content:center;align-items:center;">
        <div style="position:relative;background:white;box-shadow:0 25px 50px rgba(0,0,0,.25);
                    border-radius:4px;overflow:hidden;">
          <canvas id="at-draw-canvas" oncontextmenu="return false;"></canvas>
        </div>
      </div>
    </div>
    `;

    document.body.appendChild(panel);
    _wireNewEditor(panel, obj);
}

// ── New editor wiring (HTML-reference implementation) ────────
function _wireNewEditor(panel, obj) {
    const d = obj.autoTileData;
    const $  = sel => panel.querySelector(sel);
    const $$ = sel => Array.from(panel.querySelectorAll(sel));

    // Populate map settings from obj
    $('#at-cols').value   = d.cols;
    $('#at-rows').value   = d.rows;
    $('#at-tw').value     = d.tileW;
    $('#at-th').value     = d.tileH;
    $('#at-filter').value = d.filterMode || 'smooth';

    // ── Brush management ─────────────────────────────────────────
    const brushSel = $('#at-brush-select');
    let activeBrushId = state.tilesetBrushes[0]?.id || null;

    function _getBrush() {
        return state.tilesetBrushes.find(b => b.id === activeBrushId) || null;
    }

    function _populateBrushes() {
        brushSel.innerHTML = '<option value="">— Select brush —</option>';
        for (const b of state.tilesetBrushes) {
            const o = document.createElement('option');
            o.value = b.id; o.textContent = b.name;
            if (b.id === activeBrushId) o.selected = true;
            brushSel.appendChild(o);
        }
        _updateBrushNameRow();
    }

    function _updateBrushNameRow() {
        const brush = _getBrush();
        $('#at-brush-name-row').style.display = brush ? 'block' : 'none';
        if (brush) $('#at-brush-name').value = brush.name;
    }

    brushSel.addEventListener('change', () => {
        activeBrushId = brushSel.value || null;
        _updateBrushNameRow();
        _loadBrushIntoGrid();
    });

    $('#at-brush-name').addEventListener('change', e => {
        const b = _getBrush(); if (!b) return;
        b.name = e.target.value || b.name;
        _populateBrushes();
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
        _loadBrushIntoGrid();
    });

    $('#at-brush-delete').addEventListener('click', () => {
        const brush = _getBrush(); if (!brush) return;
        if (!confirm(`Delete brush "${brush.name}"?`)) return;
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
        _loadBrushIntoGrid();
    });

    _populateBrushes();

    // ── Gallery ──────────────────────────────────────────────────
    const gallery  = $('#at-gallery');
    const emptyMsg = $('#at-empty-gallery-msg');
    let draggedImageSrc = null;

    function addImageToGallery(imgSrc) {
        emptyMsg.style.display = 'none';
        const wrap = document.createElement('div');
        wrap.style.cssText = `width:100%;aspect-ratio:1;background:#dce3ef;border:1px solid #d1d5db;
            border-radius:4px;overflow:hidden;cursor:grab;`;
        wrap.draggable = true;
        const img = document.createElement('img');
        img.src = imgSrc;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;';
        wrap.appendChild(img);
        gallery.appendChild(wrap);
        wrap.addEventListener('dragstart', e => {
            draggedImageSrc = imgSrc;
            e.dataTransfer.setData('text/plain', imgSrc);
            e.dataTransfer.effectAllowed = 'copy';
            setTimeout(() => wrap.style.opacity = '0.5', 0);
        });
        wrap.addEventListener('dragend', () => { wrap.style.opacity = ''; draggedImageSrc = null; });
    }

    $('#at-upload-many').addEventListener('click', () => $('#at-pieces-file-input').click());
    $('#at-pieces-file-input').addEventListener('change', e => {
        Array.from(e.target.files).forEach(file => {
            if (!file.type.startsWith('image/')) return;
            const r = new FileReader();
            r.onload = ev => addImageToGallery(ev.target.result);
            r.readAsDataURL(file);
        });
        e.target.value = '';
    });

    // ── Slot fill / clear ────────────────────────────────────────
    function fillSlot(target, imgSrc) {
        target.innerHTML = '';
        const clearBtn = document.createElement('div');
        clearBtn.className = 'at-clear-btn';
        clearBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
        clearBtn.addEventListener('click', e2 => {
            e2.stopPropagation();
            if (currentEditorMode === 'drag') clearSlot(target);
        });
        target.appendChild(clearBtn);

        const img = new Image();
        img.onload = () => {
            const cv = document.createElement('canvas');
            cv.width  = img.width; cv.height = img.height;
            cv.style.cssText = 'width:100%;height:100%;pointer-events:none;border-radius:2px;';
            cv.getContext('2d').drawImage(img, 0, 0);
            target.insertBefore(cv, clearBtn);
            const dataUrl = cv.toDataURL('image/png');
            target.dataset.imgSrc = dataUrl;
            target.classList.add('has-image');
            const slotId = parseInt(target.dataset.slot);
            const brush = _getBrush();
            if (brush) brush.tiles[slotId] = dataUrl;
        };
        img.src = imgSrc;
        target.style.backgroundImage = 'none';
    }

    function clearSlot(target) {
        const slotId = parseInt(target.dataset.slot);
        const brush = _getBrush();
        if (brush) brush.tiles[slotId] = null;
        target.innerHTML = '';
        target.dataset.imgSrc = '';
        target.classList.remove('has-image');
    }

    function _loadBrushIntoGrid() {
        const brush = _getBrush();
        $$('.at-drop-target').forEach(target => {
            const slotId = parseInt(target.dataset.slot);
            if (brush && brush.tiles[slotId]) {
                fillSlot(target, brush.tiles[slotId]);
            } else {
                target.innerHTML = '';
                target.dataset.imgSrc = '';
                target.classList.remove('has-image');
            }
        });
    }

    _loadBrushIntoGrid();

    // ── Eraser tool ──────────────────────────────────────────────
    let isSlotErasing     = false;
    let activeEraseCanvas = null;
    let activeEraseCtx    = null;
    let lastErasePos      = { x: 0, y: 0 };
    let currentEditorMode = 'drag';

    function _getEventPos(e) {
        if (e.touches && e.touches.length > 0)
            return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
        return { clientX: e.clientX, clientY: e.clientY };
    }

    function _canvasLocalPos(cv, e) {
        const rect = cv.getBoundingClientRect();
        const pos  = _getEventPos(e);
        return {
            x: (pos.clientX - rect.left) * (cv.width  / rect.width),
            y: (pos.clientY - rect.top)  * (cv.height / rect.height),
        };
    }

    function _slotEraseStart(e, target) {
        if (currentEditorMode !== 'erase') return;
        const cv = target.querySelector('canvas');
        if (!cv) return;
        isSlotErasing     = true;
        activeEraseCanvas = cv;
        activeEraseCtx    = cv.getContext('2d');
        activeEraseCtx.globalCompositeOperation = 'destination-out';
        activeEraseCtx.lineWidth = cv.width / 5;
        activeEraseCtx.lineCap   = 'round';
        activeEraseCtx.lineJoin  = 'round';
        lastErasePos = _canvasLocalPos(cv, e);
        activeEraseCtx.beginPath();
        activeEraseCtx.arc(lastErasePos.x, lastErasePos.y, activeEraseCtx.lineWidth / 2, 0, Math.PI * 2);
        activeEraseCtx.fill();
    }

    function _slotEraseMove(e) {
        if (!isSlotErasing || !activeEraseCanvas) return;
        e.preventDefault();
        const pos = _canvasLocalPos(activeEraseCanvas, e);
        activeEraseCtx.beginPath();
        activeEraseCtx.moveTo(lastErasePos.x, lastErasePos.y);
        activeEraseCtx.lineTo(pos.x, pos.y);
        activeEraseCtx.stroke();
        lastErasePos = pos;
    }

    function _slotEraseEnd() {
        if (!isSlotErasing || !activeEraseCanvas) return;
        isSlotErasing = false;
        const target = activeEraseCanvas.closest('.at-drop-target');
        if (target) {
            const dataUrl = activeEraseCanvas.toDataURL('image/png');
            target.dataset.imgSrc = dataUrl;
            const brush = _getBrush();
            if (brush) brush.tiles[parseInt(target.dataset.slot)] = dataUrl;
        }
        activeEraseCanvas = null;
        activeEraseCtx    = null;
    }

    window.addEventListener('mousemove',  _slotEraseMove);
    window.addEventListener('touchmove',  _slotEraseMove, { passive: false });
    window.addEventListener('mouseup',    _slotEraseEnd);
    window.addEventListener('touchend',   _slotEraseEnd);

    // Wire drop targets
    const gridContainer = $('#at-grid-container');
    $$('.at-drop-target').forEach(target => {
        target.addEventListener('dragover', e => {
            if (currentEditorMode !== 'drag') return;
            e.preventDefault();
            target.classList.add('drag-over');
            e.dataTransfer.dropEffect = 'copy';
        });
        target.addEventListener('dragleave', () => target.classList.remove('drag-over'));
        target.addEventListener('drop', e => {
            if (currentEditorMode !== 'drag') return;
            e.preventDefault();
            target.classList.remove('drag-over');
            const src = e.dataTransfer.getData('text/plain') || draggedImageSrc;
            if (src) fillSlot(target, src);
        });
        target.addEventListener('mousedown', e => {
            if (e.target.closest('.at-clear-btn')) return;
            _slotEraseStart(e, target);
        });
        target.addEventListener('touchstart', e => {
            if (e.target.closest('.at-clear-btn')) return;
            _slotEraseStart(e, target);
        });
    });

    // ── Tool toggle ──────────────────────────────────────────────
    function setEditorMode(mode) {
        currentEditorMode = mode;
        const dragBtn  = $('#at-tool-drag');
        const eraseBtn = $('#at-tool-erase');
        if (mode === 'drag') {
            gridContainer.classList.remove('at-mode-erase');
            gridContainer.classList.add('at-mode-drag');
            dragBtn.style.background  = 'white';
            dragBtn.style.color       = '#2563eb';
            dragBtn.style.boxShadow   = '0 1px 3px rgba(0,0,0,.1)';
            eraseBtn.style.background = 'none';
            eraseBtn.style.color      = '#6b7280';
            eraseBtn.style.boxShadow  = 'none';
        } else {
            gridContainer.classList.remove('at-mode-drag');
            gridContainer.classList.add('at-mode-erase');
            eraseBtn.style.background = 'white';
            eraseBtn.style.color      = '#dc2626';
            eraseBtn.style.boxShadow  = '0 1px 3px rgba(0,0,0,.1)';
            dragBtn.style.background  = 'none';
            dragBtn.style.color       = '#6b7280';
            dragBtn.style.boxShadow   = 'none';
        }
    }
    $('#at-tool-drag').addEventListener('click',  () => setEditorMode('drag'));
    $('#at-tool-erase').addEventListener('click', () => setEditorMode('erase'));

    // ── Guide toggle ─────────────────────────────────────────────
    let guidesOff = false;
    $('#at-guide-toggle').addEventListener('click', () => {
        guidesOff = !guidesOff;
        gridContainer.classList.toggle('guides-off', guidesOff);
        $('#at-guides-label').textContent = guidesOff ? 'Guides ON' : 'Guides OFF';
    });

    // ── Advanced Auto-Complete (4×4 sheet) ───────────────────────
    const sliceToSlotMapping = [0, 1, 2, 9, 3, 4, 5, 10, 6, 7, 8, 11, 12, 13, 14, 15];
    $('#at-upload-sheet').addEventListener('click', () => $('#at-brush-file-input').click());
    $('#at-brush-file-input').addEventListener('change', e => {
        const file = e.target.files[0]; if (!file) return;
        const fr = new FileReader();
        fr.onload = ev => {
            const img = new Image();
            img.onload = () => {
                if (!_getBrush()) {
                    const id   = 'brush_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
                    const name = 'Brush ' + (state.tilesetBrushes.length + 1);
                    state.tilesetBrushes.push({
                        id, name, type: '16-tile',
                        tileW: Math.floor(img.width/4), tileH: Math.floor(img.height/4),
                        tiles: new Array(SLOTS).fill(null),
                    });
                    activeBrushId = id;
                    _populateBrushes();
                }
                const brush  = _getBrush();
                const sliceW = Math.floor(img.width  / 4);
                const sliceH = Math.floor(img.height / 4);
                const offCv  = document.createElement('canvas');
                offCv.width  = sliceW; offCv.height = sliceH;
                const offCtx = offCv.getContext('2d');
                const slices = [];
                for (let y = 0; y < 4; y++)
                    for (let x = 0; x < 4; x++) {
                        offCtx.clearRect(0, 0, sliceW, sliceH);
                        offCtx.drawImage(img, x*sliceW, y*sliceH, sliceW, sliceH, 0, 0, sliceW, sliceH);
                        slices.push(offCv.toDataURL('image/png'));
                    }
                slices.forEach((url, idx) => {
                    setTimeout(() => {
                        addImageToGallery(url);
                        const targetSlotId = sliceToSlotMapping[idx];
                        const targetEl = panel.querySelector(`.at-drop-target[data-slot="${targetSlotId}"]`);
                        if (targetEl) {
                            fillSlot(targetEl, url);
                            targetEl.classList.remove('at-animate-pop');
                            void targetEl.offsetWidth;
                            targetEl.classList.add('at-animate-pop');
                        }
                        if (brush) brush.tiles[targetSlotId] = url;
                    }, idx * 40);
                });
            };
            img.src = ev.target.result;
        };
        fr.readAsDataURL(file);
        e.target.value = '';
    });

    // ── Map settings helper ──────────────────────────────────────
    function _applyMapSettings() {
        const nc = Math.max(1, parseInt($('#at-cols').value)  || d.cols);
        const nr = Math.max(1, parseInt($('#at-rows').value)  || d.rows);
        const tw = Math.max(4, parseInt($('#at-tw').value)    || d.tileW);
        const th = Math.max(4, parseInt($('#at-th').value)    || d.tileH);
        const fm = $('#at-filter').value || d.filterMode;
        const newCells = new Int16Array(nc * nr).fill(-1);
        for (let r = 0; r < Math.min(nr, d.rows); r++)
            for (let c = 0; c < Math.min(nc, d.cols); c++)
                newCells[r*nc+c] = d.cells[r*d.cols+c];
        d.cols = nc; d.rows = nr; d.tileW = tw; d.tileH = th;
        d.cells = newCells; d.filterMode = fm;
    }

    // ── MAP DRAWING VIEW ─────────────────────────────────────────
    // bitmaskToSlot: maps 4-neighbor bitmask → which of the 16 slots to render
    const bitmaskToSlot = {
        0: 15, 1: 11, 2: 12, 3: 6,  4: 9,  5: 10, 6: 0,  7: 3,
        8: 14, 9: 8,  10: 13, 11: 7, 12: 2, 13: 5, 14: 1, 15: 4
    };

    const canvas = $('#at-draw-canvas');
    const ctx    = canvas.getContext('2d');
    let brushImages      = new Array(SLOTS).fill(null);
    let isDrawingMap     = false;
    let currentDrawAction = 1;
    let hoverX = -1, hoverY = -1;

    function _initDrawCanvas() {
        _applyMapSettings();
        canvas.width  = d.cols * d.tileW;
        canvas.height = d.rows * d.tileH;
        const sharp = d.filterMode === 'pixelated';
        canvas.style.imageRendering = sharp ? 'pixelated' : 'auto';
        ctx.imageSmoothingEnabled   = !sharp;
    }

    function _loadBrushImages() {
        brushImages = new Array(SLOTS).fill(null);
        $$('.at-drop-target').forEach(target => {
            const slotId = parseInt(target.dataset.slot);
            const src = target.dataset.imgSrc;
            if (src) { const im = new Image(); im.src = src; brushImages[slotId] = im; }
        });
        const brush = _getBrush();
        if (brush) {
            for (let i = 0; i < SLOTS; i++) {
                if (!brushImages[i] && brush.tiles[i]) {
                    const im = new Image(); im.src = brush.tiles[i]; brushImages[i] = im;
                }
            }
        }
    }

    function _calcBitmask(x, y) {
        let m = 0;
        if (y > 0            && d.cells[(y-1)*d.cols+x  ] >= 0) m |= 1;
        if (x < d.cols-1     && d.cells[ y   *d.cols+x+1] >= 0) m |= 2;
        if (y < d.rows-1     && d.cells[(y+1)*d.cols+x  ] >= 0) m |= 4;
        if (x > 0            && d.cells[ y   *d.cols+x-1] >= 0) m |= 8;
        return m;
    }

    function renderMapCanvas() {
        const TW = d.tileW, TH = d.tileH;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
        for (let x = 0; x <= d.cols; x++) {
            ctx.beginPath(); ctx.moveTo(x*TW, 0); ctx.lineTo(x*TW, canvas.height); ctx.stroke();
        }
        for (let y = 0; y <= d.rows; y++) {
            ctx.beginPath(); ctx.moveTo(0, y*TH); ctx.lineTo(canvas.width, y*TH); ctx.stroke();
        }
        for (let y = 0; y < d.rows; y++) {
            for (let x = 0; x < d.cols; x++) {
                if (d.cells[y*d.cols+x] >= 0) {
                    const slot = bitmaskToSlot[_calcBitmask(x, y)];
                    const im   = brushImages[slot];
                    if (im && im.complete && im.naturalWidth > 0) {
                        ctx.drawImage(im, x*TW, y*TH, TW, TH);
                    } else {
                        ctx.fillStyle = '#f472b6';
                        ctx.fillRect(x*TW, y*TH, TW, TH);
                        ctx.fillStyle = 'white'; ctx.font = '9px sans-serif';
                        ctx.fillText(`${_calcBitmask(x,y)}`, x*TW+4, y*TH+18);
                    }
                }
            }
        }
        if (hoverX >= 0 && hoverX < d.cols && hoverY >= 0 && hoverY < d.rows) {
            const erasing = currentDrawAction === 0;
            const color   = erasing ? '#ef4444' : '#3b82f6';
            ctx.fillStyle = erasing ? 'rgba(239,68,68,0.2)' : 'rgba(59,130,246,0.2)';
            ctx.fillRect(hoverX*TW, hoverY*TH, TW, TH);
            ctx.strokeStyle = color; ctx.lineWidth = 2;
            ctx.strokeRect(hoverX*TW, hoverY*TH, TW, TH);
            ctx.beginPath();
            ctx.moveTo(hoverX*TW+TW/2, hoverY*TH+TH/2-5);
            ctx.lineTo(hoverX*TW+TW/2, hoverY*TH+TH/2+5);
            ctx.moveTo(hoverX*TW+TW/2-5, hoverY*TH+TH/2);
            ctx.lineTo(hoverX*TW+TW/2+5, hoverY*TH+TH/2);
            ctx.stroke();
        }
    }

    function _updateHover(e) {
        const rect = canvas.getBoundingClientRect();
        hoverX = Math.floor(((e.clientX-rect.left)*(canvas.width /rect.width )) / d.tileW);
        hoverY = Math.floor(((e.clientY-rect.top) *(canvas.height/rect.height)) / d.tileH);
    }

    function _drawAction() {
        const i = hoverY*d.cols+hoverX;
        if (hoverX < 0 || hoverX >= d.cols || hoverY < 0 || hoverY >= d.rows) return;
        const brushId = activeBrushId;
        let bIdx = brushId ? d.brushList.indexOf(brushId) : -1;
        if (bIdx < 0 && brushId) { d.brushList.push(brushId); bIdx = d.brushList.length - 1; }
        const newVal = currentDrawAction === 0 ? -1 : (bIdx >= 0 ? bIdx : 0);
        if (d.cells[i] !== newVal) d.cells[i] = newVal;
        renderMapCanvas();
    }

    canvas.addEventListener('mousedown', e => {
        isDrawingMap     = true;
        currentDrawAction = e.button === 2 ? 0 : 1;
        _updateHover(e); _drawAction();
    });
    canvas.addEventListener('mouseleave', () => { hoverX = -1; hoverY = -1; renderMapCanvas(); });

    const _mapMouseMove = e => {
        if (e.target === canvas || canvas.contains(e.target)) {
            _updateHover(e);
            if (isDrawingMap) _drawAction(); else renderMapCanvas();
        } else if (hoverX !== -1) {
            hoverX = -1; hoverY = -1; renderMapCanvas();
        }
    };
    window.addEventListener('mousemove', _mapMouseMove);
    window.addEventListener('mouseup',   () => { isDrawingMap = false; });

    // ── Navigation ───────────────────────────────────────────────
    const editorView = $('#at-editor-view');
    const drawView   = $('#at-draw-view');

    $('#at-go-to-draw-btn').addEventListener('click', () => {
        _initDrawCanvas();
        _loadBrushImages();
        editorView.style.display = 'none';
        drawView.style.display   = 'flex';
        renderMapCanvas();
    });

    $('#at-back-to-editor-btn').addEventListener('click', () => {
        drawView.style.display   = 'none';
        editorView.style.display = 'flex';
        window.removeEventListener('mousemove', _mapMouseMove);
    });

    $('#at-clear-map-btn').addEventListener('click', () => {
        d.cells = new Int16Array(d.cols * d.rows).fill(-1);
        renderMapCanvas();
    });

    // ── Close ────────────────────────────────────────────────────
    $('#at-close').addEventListener('click', () => {
        _applyMapSettings();
        rebuildAutoTileSprites(obj);
        _buildHelper(obj);
        import('./engine.ui.js').then(m => { m.syncPixiToInspector(); m.refreshHierarchy(); });
        panel.remove();
        window.removeEventListener('keydown', _onKey);
        window.removeEventListener('mousemove', _slotEraseMove);
        window.removeEventListener('mouseup',   _slotEraseEnd);
        window.removeEventListener('touchmove', _slotEraseMove);
        window.removeEventListener('touchend',  _slotEraseEnd);
        window.removeEventListener('mousemove', _mapMouseMove);
        window.removeEventListener('mouseup',   () => { isDrawingMap = false; });
    });

    const _onKey = e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); }
    };
    window.addEventListener('keydown', _onKey);


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
