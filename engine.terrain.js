/* ============================================================
   Zengine — engine.terrain.js
   Terrain Brush system: auto-tiling terrain objects.

   Two terrain modes:
     1. Tilemap (free-paint) — existing engine.tilemap.js
     2. Terrain Brush        — THIS FILE
        • Upload N tile images (16-tile or 47-tile bitmask set)
        • Name the brush + pick tileset type
        • Place a Terrain object; paint cells
        • Engine auto-selects the correct tile based on
          8-neighbor bitmask (47-tile Wang blob set)
          or 4-neighbor bitmask (16-tile corner set)

   Data model on each terrain object:
     obj.isTerrain    = true
     obj.terrainData  = {
       brushName:  string,
       tileW: 32, tileH: 32,
       cols: 20, rows: 15,
       tilesetType: '16' | '47',
       tiles:  Int32Array,   // flat cols*rows — 0=empty, 1=filled
       images: string[],     // dataURLs indexed by tile index
     }
   ============================================================ */

import { state } from './engine.state.js';

// ── 16-tile bitmask → tile-index lookup (corner bitmask) ─────
// Bits: N=1, E=2, S=4, W=8  (4-directional neighbors)
const BITMASK_16 = {
    0:0,   1:1,   2:2,   3:3,   4:4,   5:5,   6:6,   7:7,
    8:8,   9:9,  10:10, 11:11, 12:12, 13:13, 14:14, 15:15,
};

// 47-tile blob bitmask (all 8 neighbors, reduces to 47 visual variants)
// Mapping from full 8-bit mask → one of 47 tile indices
// Based on RPG Maker / Godot blob tileset standard
const _blob47 = (() => {
    const map = {};
    // Full lookup table: 256 entries → 0..46
    const t=[0,4,1,5,16,28,17,29,4,12,5,13,20,48,21,53,1,17,3,19,17,29,19,31,5,13,7,15,21,53,23,55,
             16,28,17,29,18,30,19,31,28,44,29,45,30,46,31,47,17,29,19,31,19,31,19,31,29,45,31,47,31,47,31,47,
             4,12,5,13,20,48,21,53,12,36,13,37,48,40,53,41,5,13,7,15,21,53,23,55,13,37,15,39,53,41,55,43,
             20,48,21,53,22,50,23,55,48,40,53,41,50,42,55,43,21,53,23,55,23,55,23,55,53,41,55,43,55,43,55,43,
             1,5,3,7,17,29,19,31,5,13,7,15,21,53,23,55,3,7,3,7,19,31,19,31,7,15,7,15,23,55,23,55,
             17,29,19,31,19,31,19,31,29,45,31,47,31,47,31,47,19,31,19,31,19,31,19,31,31,47,31,47,31,47,31,47,
             5,13,7,15,21,53,23,55,13,37,15,39,53,41,55,43,7,15,7,15,23,55,23,55,15,39,15,39,55,43,55,43,
             21,53,23,55,23,55,23,55,53,41,55,43,55,43,55,43,23,55,23,55,23,55,23,55,55,43,55,43,55,43,55,43];
    for(let i=0;i<256;i++) map[i]=t[i]%47;
    return map;
})();

// ── Create a Terrain object ───────────────────────────────────
export function createTerrain(x = 0, y = 0) {
    const label = _uniqueTerrainName('Terrain');

    const container = new PIXI.Container();
    container.x = x; container.y = y;
    container.isTerrain  = true;
    container.isLight    = false;
    container.isImage    = false;
    container.isTilemap  = false;
    container.label      = label;
    container.unityZ     = 0;
    container.animations = [];
    container.activeAnimIndex = 0;

    container.terrainData = {
        brushName:   'Untitled Brush',
        tileW:       32,
        tileH:       32,
        cols:        20,
        rows:        15,
        tilesetType: '16',
        tiles:       new Int32Array(20 * 15).fill(0), // 0=empty, 1=filled
        images:      new Array(47).fill(null),         // tile dataURLs
    };

    _buildTerrainHelper(container);
    _attachTranslateGizmoTerrain(container);
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

// ── Editor wireframe helper ───────────────────────────────────
export function _buildTerrainHelper(container) {
    if (container._terrainHelper) {
        container.removeChild(container._terrainHelper);
        try { container._terrainHelper.destroy(); } catch(_) {}
    }
    const d = container.terrainData;
    const g = new PIXI.Graphics();
    const W = d.cols * d.tileW;
    const H = d.rows * d.tileH;
    g.beginFill(0x1a3520, 0.5); g.drawRect(0, 0, W, H); g.endFill();
    g.lineStyle(1, 0x4ade80, 0.2);
    for (let c = 0; c <= d.cols; c++) { g.moveTo(c * d.tileW, 0); g.lineTo(c * d.tileW, H); }
    for (let r = 0; r <= d.rows; r++) { g.moveTo(0, r * d.tileH); g.lineTo(W, r * d.tileH); }
    g.lineStyle(2, 0x4ade80, 0.6);
    g.drawRect(0, 0, W, H);
    container._terrainHelper = g;
    container.addChildAt(g, 0);
}

// ── Rebuild rendered terrain sprites ─────────────────────────
export function rebuildTerrainSprites(container) {
    if (!container.isTerrain) return;
    // Remove old sprites
    if (container._terrainSprites) {
        container._terrainSprites.forEach(s => { try { s.destroy(); } catch(_) {} });
    }
    container._terrainSprites = [];

    const d   = container.terrainData;
    const tW  = d.tileW;
    const tH  = d.tileH;
    const cnt = d.tilesetType === '47' ? 47 : 16;

    for (let r = 0; r < d.rows; r++) {
        for (let c = 0; c < d.cols; c++) {
            const idx = r * d.cols + c;
            if (!d.tiles[idx]) continue; // empty

            const tileIdx = _computeTileIndex(d, c, r);
            const imgURL  = d.images[tileIdx < cnt ? tileIdx : 0];
            if (!imgURL) continue;

            try {
                const tex = PIXI.Texture.from(imgURL);
                const sp  = new PIXI.Sprite(tex);
                sp.x      = c * tW;
                sp.y      = r * tH;
                sp.width  = tW;
                sp.height = tH;
                container.addChild(sp);
                container._terrainSprites.push(sp);
            } catch (_) {}
        }
    }
}

// ── Compute which tile variant to use for (col, row) ─────────
function _computeTileIndex(d, c, r) {
    if (d.tilesetType === '47') {
        // 8-neighbor blob bitmask
        const n  = _filled(d, c,   r-1) ? 1   : 0;
        const ne = _filled(d, c+1, r-1) ? 2   : 0;
        const e  = _filled(d, c+1, r)   ? 4   : 0;
        const se = _filled(d, c+1, r+1) ? 8   : 0;
        const s  = _filled(d, c,   r+1) ? 16  : 0;
        const sw = _filled(d, c-1, r+1) ? 32  : 0;
        const w  = _filled(d, c-1, r)   ? 64  : 0;
        const nw = _filled(d, c-1, r-1) ? 128 : 0;
        // Corners only count if cardinal neighbors both filled
        const mask =
            (n  ? 1   : 0) |
            ((n && e && ne) ? 2 : 0) |
            (e  ? 4   : 0) |
            ((e && s && se) ? 8 : 0) |
            (s  ? 16  : 0) |
            ((s && w && sw) ? 32 : 0) |
            (w  ? 64  : 0) |
            ((w && n && nw) ? 128 : 0);
        return (_blob47[mask] ?? 0);
    } else {
        // 4-neighbor bitmask (16 tiles)
        const n = _filled(d, c,   r-1) ? 1 : 0;
        const e = _filled(d, c+1, r)   ? 2 : 0;
        const s = _filled(d, c,   r+1) ? 4 : 0;
        const w = _filled(d, c-1, r)   ? 8 : 0;
        return BITMASK_16[n|e|s|w] ?? 0;
    }
}

function _filled(d, c, r) {
    if (c < 0 || c >= d.cols || r < 0 || r >= d.rows) return false;
    return d.tiles[r * d.cols + c] === 1;
}

// ── Inspector HTML ────────────────────────────────────────────
export function buildTerrainInspectorHTML(obj) {
    const d = obj.terrainData;
    return `
    <div class="component-block" style="border-left:3px solid #4ade80;">
      <div class="component-header" style="background:#0e2018;">
        <svg viewBox="0 0 24 24" class="comp-icon" style="color:#4ade80;"><path d="M3 20h18M3 20l4-8 4 4 4-6 4 10" stroke="currentColor" stroke-width="2" fill="none"/></svg>
        <span style="font-weight:700;color:#4ade80;">Terrain Brush</span>
      </div>
      <div class="component-body" style="display:flex;flex-direction:column;gap:5px;">
        <div class="prop-row"><span class="prop-label">Brush</span>
          <span style="color:#9bc;font-size:10px;font-style:italic;">${d.brushName || '— none —'}</span></div>
        <div class="prop-row"><span class="prop-label">Size</span>
          <span style="color:#9bc;">${d.cols} × ${d.rows} cells</span></div>
        <div class="prop-row"><span class="prop-label">Cell size</span>
          <span style="color:#9bc;">${d.tileW} × ${d.tileH} px</span></div>
        <div class="prop-row"><span class="prop-label">Type</span>
          <span style="color:#9bc;">${d.tilesetType}-tile auto-tiler</span></div>
        <button id="btn-open-terrain-brush" style="width:100%;background:#1a2a1a;border:1px solid #4ade80;
                color:#4ade80;border-radius:4px;padding:6px;cursor:pointer;font-size:11px;margin-top:2px;
                display:flex;align-items:center;justify-content:center;gap:6px;">
          <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;">
            <path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
          </svg>
          Open Terrain Editor
        </button>
        <button id="btn-open-brush-setup" style="width:100%;background:#0d1f0d;border:1px solid #2a5a2a;
                color:#6cac6c;border-radius:4px;padding:5px;cursor:pointer;font-size:10px;
                display:flex;align-items:center;justify-content:center;gap:5px;">
          <svg viewBox="0 0 24 24" style="width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2;">
            <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/>
          </svg>
          Configure Brush Tiles
        </button>
      </div>
    </div>`;
}

// ── Open terrain brush setup (upload tiles + name + type) ─────
export function openBrushSetup(obj) {
    document.getElementById('tb-setup')?.remove();

    const d   = obj.terrainData;
    const cnt = d.tilesetType === '47' ? 47 : 16;

    const panel = document.createElement('div');
    panel.id = 'tb-setup';
    panel.style.cssText = `
        position:fixed;inset:0;z-index:16000;background:rgba(0,0,0,0.94);
        display:flex;align-items:center;justify-content:center;
        font-family:'Inter','Segoe UI',sans-serif;font-size:11px;color:#d8d8e8;`;

    panel.innerHTML = `
    <div style="background:#1e1e28;border:1px solid #3a3a48;border-radius:10px;
                width:780px;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;
                box-shadow:0 24px 80px rgba(0,0,0,0.8);">

      <!-- Header -->
      <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;
                  border-bottom:1px solid #2e2e3a;background:#191920;border-radius:10px 10px 0 0;flex-shrink:0;">
        <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:none;stroke:#4ade80;stroke-width:2;">
          <path d="M3 20h18M3 20l4-8 4 4 4-6 4 10"/>
        </svg>
        <span style="font-weight:700;font-size:14px;color:#fff;">Terrain Brush Setup</span>
        <div style="flex:1;"></div>
        <button id="tb-close" style="background:none;border:none;color:#666;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;">✕</button>
      </div>

      <div style="display:flex;flex:1;overflow:hidden;">

        <!-- LEFT: settings + tile grid -->
        <div style="width:320px;flex-shrink:0;border-right:1px solid #2e2e3a;
                    display:flex;flex-direction:column;overflow:hidden;">

          <!-- Settings -->
          <div style="padding:14px 16px;border-bottom:1px solid #2e2e3a;flex-shrink:0;">
            <div style="font-size:9px;font-weight:700;color:#505060;letter-spacing:.8px;margin-bottom:10px;">BRUSH SETTINGS</div>

            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#7a7a90;font-size:10px;">Brush Name</span>
              <input type="text" id="tb-name" value="${d.brushName}"
                style="width:160px;background:#16161e;border:1px solid #3a3a48;color:#d8d8e8;
                       border-radius:4px;padding:4px 8px;font-size:11px;outline:none;">
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <span style="color:#7a7a90;font-size:10px;">Tileset Type</span>
              <select id="tb-type" style="width:120px;background:#16161e;border:1px solid #3a3a48;
                      color:#d8d8e8;border-radius:4px;padding:4px 6px;font-size:11px;outline:none;">
                <option value="16" ${d.tilesetType==='16'?'selected':''}>16 Tiles</option>
                <option value="47" ${d.tilesetType==='47'?'selected':''}>47 Tiles</option>
              </select>
            </div>

            <div style="display:flex;gap:6px;">
              <div style="flex:1;">
                <div style="color:#7a7a90;font-size:10px;margin-bottom:4px;">Tile W (px)</div>
                <input type="number" id="tb-tw" value="${d.tileW}" min="4" max="256"
                  style="width:100%;background:#16161e;border:1px solid #3a3a48;color:#d8d8e8;
                         border-radius:4px;padding:4px 6px;font-size:11px;outline:none;text-align:center;">
              </div>
              <div style="flex:1;">
                <div style="color:#7a7a90;font-size:10px;margin-bottom:4px;">Tile H (px)</div>
                <input type="number" id="tb-th" value="${d.tileH}" min="4" max="256"
                  style="width:100%;background:#16161e;border:1px solid #3a3a48;color:#d8d8e8;
                         border-radius:4px;padding:4px 6px;font-size:11px;outline:none;text-align:center;">
              </div>
            </div>

            <button id="tb-upload-all" style="width:100%;margin-top:10px;background:#1a3050;
                    border:1px solid #3A72A5;color:#7aabcc;border-radius:4px;padding:7px;
                    cursor:pointer;font-size:11px;font-weight:600;display:flex;align-items:center;
                    justify-content:center;gap:7px;">
              <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;">
                <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
                <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
              </svg>
              Upload Images
            </button>
          </div>

          <!-- Tile grid -->
          <div style="flex:1;overflow-y:auto;padding:10px 14px;">
            <div style="font-size:9px;font-weight:700;color:#505060;letter-spacing:.8px;margin-bottom:8px;">
              TILE SLOTS &nbsp;<span id="tb-slot-count" style="color:#4ade80;font-weight:400;"></span>
            </div>
            <div id="tb-tile-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;"></div>
          </div>
        </div>

        <!-- RIGHT: Auto-tiler preview -->
        <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0e0e18;">
          <div style="padding:10px 16px;border-bottom:1px solid #1e1e2e;flex-shrink:0;
                      display:flex;align-items:center;justify-content:space-between;">
            <span style="font-weight:700;color:#d8d8e8;font-size:12px;">Brush Auto Tiler</span>
            <button id="tb-toggle-guides" style="background:none;border:1px solid #3a3a48;
                    color:#7a7a90;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:10px;
                    display:flex;align-items:center;gap:5px;">
              <svg viewBox="0 0 24 24" style="width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2;">
                <path d="M1 1l22 22M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
                <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
              </svg>
              <span id="tb-guides-label">Tile guides OFF</span>
            </button>
          </div>

          <!-- Preview canvas area -->
          <div style="flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px;">
            <canvas id="tb-preview-canvas" style="display:block;image-rendering:pixelated;border:1px solid #2e2e3a;border-radius:4px;"></canvas>
            <div style="display:flex;gap:8px;flex-shrink:0;">
              <button id="tb-dl-preview" style="flex:1;background:#0d1520;border:1px solid #2a3a4a;
                      color:#7aabcc;border-radius:4px;padding:7px;cursor:pointer;font-size:10px;
                      display:flex;align-items:center;justify-content:center;gap:6px;font-weight:600;">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download Preview
              </button>
              <button id="tb-upload-brush-img" style="flex:1;background:#0d1520;border:1px solid #3a4a2a;
                      color:#7acc7a;border-radius:4px;padding:7px;cursor:pointer;font-size:10px;
                      display:flex;align-items:center;justify-content:center;gap:6px;font-weight:600;">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;">
                  <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
                  <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
                </svg>
                Upload Brush Image
              </button>
            </div>
          </div>

          <!-- Save -->
          <div style="padding:12px 16px;border-top:1px solid #1e1e2e;flex-shrink:0;">
            <button id="tb-save" style="width:100%;background:#1a3020;border:1px solid #4ade80;
                    color:#4ade80;border-radius:5px;padding:9px;cursor:pointer;font-size:12px;
                    font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;">
                <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              Save Brush & Close
            </button>
          </div>
        </div>
      </div>
    </div>

    <style>
      #tb-setup input:focus, #tb-setup select:focus { border-color:#3A72A5 !important; }
      .tb-slot { aspect-ratio:1;background:#12121c;border:1px dashed #2e2e3a;border-radius:4px;
                  cursor:pointer;overflow:hidden;position:relative;display:flex;align-items:center;
                  justify-content:center;transition:border-color .15s; }
      .tb-slot:hover { border-color:#3A72A5; }
      .tb-slot.filled { border-style:solid;border-color:#2a4a2a; }
      .tb-slot img { width:100%;height:100%;object-fit:cover;image-rendering:pixelated; }
      .tb-slot .tb-idx { position:absolute;bottom:1px;right:2px;font-size:8px;color:#505060;
                          font-family:monospace;pointer-events:none; }
      .tb-slot .tb-del { position:absolute;top:1px;right:1px;background:rgba(248,113,113,0.85);
                          color:#fff;border:none;border-radius:2px;font-size:8px;cursor:pointer;
                          padding:0 3px;line-height:14px;display:none; }
      .tb-slot.filled .tb-del { display:block; }
      .tb-slot.filled .tb-empty-hint { display:none; }
      .tb-empty-hint { font-size:9px;color:#303040;text-align:center; }
    </style>`;

    document.body.appendChild(panel);
    _wireBrushSetup(panel, obj);
}

function _wireBrushSetup(panel, obj) {
    const d = obj.terrainData;
    let showGuides = false;

    // Close
    panel.querySelector('#tb-close').addEventListener('click', () => panel.remove());

    // Name
    panel.querySelector('#tb-name').addEventListener('input', e => { d.brushName = e.target.value; });

    // Type selector
    const typeEl = panel.querySelector('#tb-type');
    typeEl.addEventListener('change', () => {
        d.tilesetType = typeEl.value;
        _rebuildSlotGrid();
        _drawPreview();
    });

    // Tile size
    panel.querySelector('#tb-tw').addEventListener('change', e => { d.tileW = Math.max(4, parseInt(e.target.value)||32); _drawPreview(); });
    panel.querySelector('#tb-th').addEventListener('change', e => { d.tileH = Math.max(4, parseInt(e.target.value)||32); _drawPreview(); });

    // Tile guides toggle
    panel.querySelector('#tb-toggle-guides').addEventListener('click', () => {
        showGuides = !showGuides;
        panel.querySelector('#tb-guides-label').textContent = showGuides ? 'Tile guides ON' : 'Tile guides OFF';
        _drawPreview();
    });

    // Upload all images
    panel.querySelector('#tb-upload-all').addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
        inp.addEventListener('change', async () => {
            const files = Array.from(inp.files);
            const cnt   = d.tilesetType === '47' ? 47 : 16;
            for (let i = 0; i < Math.min(files.length, cnt); i++) {
                d.images[i] = await _readFileAsDataURL(files[i]);
            }
            _rebuildSlotGrid();
            _drawPreview();
        });
        inp.click();
    });

    // Upload single brush image (spritesheet)
    panel.querySelector('#tb-upload-brush-img').addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.addEventListener('change', async () => {
            if (!inp.files[0]) return;
            const url = await _readFileAsDataURL(inp.files[0]);
            // Slice into individual tile slots from a spritesheet
            const cnt = d.tilesetType === '47' ? 47 : 16;
            const cols = d.tilesetType === '47' ? 8 : 4;
            const sliced = await _sliceSpritesheet(url, d.tileW, d.tileH, cols, cnt);
            sliced.forEach((s, i) => { d.images[i] = s; });
            _rebuildSlotGrid();
            _drawPreview();
        });
        inp.click();
    });

    // Download preview
    panel.querySelector('#tb-dl-preview').addEventListener('click', () => {
        const cv = panel.querySelector('#tb-preview-canvas');
        const a  = document.createElement('a');
        a.download = (d.brushName || 'terrain-brush') + '-preview.png';
        a.href = cv.toDataURL();
        a.click();
    });

    // Save & close
    panel.querySelector('#tb-save').addEventListener('click', () => {
        rebuildTerrainSprites(obj);
        _buildTerrainHelper(obj);
        import('./engine.ui.js').then(m => { m.syncPixiToInspector(); m.refreshHierarchy(); });
        panel.remove();
    });

    // Build slot grid and preview initially
    _rebuildSlotGrid();
    _drawPreview();

    // ── Slot grid ────────────────────────────────────────────
    function _rebuildSlotGrid() {
        const grid = panel.querySelector('#tb-tile-grid');
        grid.innerHTML = '';
        const cnt = d.tilesetType === '47' ? 47 : 16;
        const filled = d.images.slice(0, cnt).filter(Boolean).length;
        panel.querySelector('#tb-slot-count').textContent = `${filled}/${cnt} uploaded`;

        for (let i = 0; i < cnt; i++) {
            const slot = document.createElement('div');
            slot.className = 'tb-slot' + (d.images[i] ? ' filled' : '');

            const hint = document.createElement('div');
            hint.className = 'tb-empty-hint';
            hint.innerHTML = `<div style="font-size:16px;opacity:.3;">+</div><div>${i}</div>`;

            const del = document.createElement('button');
            del.className = 'tb-del'; del.textContent = '×';
            del.addEventListener('click', e => {
                e.stopPropagation();
                d.images[i] = null;
                _rebuildSlotGrid(); _drawPreview();
            });

            const idx = document.createElement('div');
            idx.className = 'tb-idx'; idx.textContent = i;

            if (d.images[i]) {
                const img = document.createElement('img');
                img.src = d.images[i];
                slot.appendChild(img);
            }
            slot.appendChild(hint); slot.appendChild(del); slot.appendChild(idx);

            // Click to upload single tile
            slot.addEventListener('click', () => {
                const inp = document.createElement('input');
                inp.type = 'file'; inp.accept = 'image/*';
                inp.addEventListener('change', async () => {
                    if (!inp.files[0]) return;
                    d.images[i] = await _readFileAsDataURL(inp.files[0]);
                    _rebuildSlotGrid(); _drawPreview();
                });
                inp.click();
            });

            grid.appendChild(slot);
        }
    }

    // ── Auto-tiler preview (draws a sample terrain map) ──────
    function _drawPreview() {
        const cv   = panel.querySelector('#tb-preview-canvas');
        const ctx  = cv.getContext('2d');
        const tW   = Math.max(4, d.tileW);
        const tH   = Math.max(4, d.tileH);
        const cnt  = d.tilesetType === '47' ? 47 : 16;

        // Determine columns: pack tiles in a preview that shows
        // a sample of the auto-tiler in action (fixed 8×4 demo map)
        const DEMO_COLS = 8, DEMO_ROWS = 5;
        // Sample filled map that shows most tile transitions
        const DEMO = [
            0,0,0,0,0,0,0,0,
            0,1,1,1,1,1,0,0,
            0,1,1,1,1,1,1,0,
            0,1,1,0,1,1,0,0,
            0,0,0,0,0,0,0,0,
        ];
        const demoData = {
            tileW: tW, tileH: tH,
            cols: DEMO_COLS, rows: DEMO_ROWS,
            tilesetType: d.tilesetType,
            tiles: new Int32Array(DEMO),
            images: d.images,
        };

        // Also show tile atlas on the right side
        const atlasRows = Math.ceil(cnt / 4);
        const atlasCols = Math.min(cnt, 4);
        const totalW    = (DEMO_COLS + 1 + atlasCols) * tW;
        const totalH    = Math.max(DEMO_ROWS, atlasRows) * tH;

        cv.width  = totalW;
        cv.height = totalH;
        ctx.clearRect(0, 0, totalW, totalH);
        ctx.fillStyle = '#0e0e18';
        ctx.fillRect(0, 0, totalW, totalH);

        // Draw demo terrain
        for (let r = 0; r < DEMO_ROWS; r++) {
            for (let c = 0; c < DEMO_COLS; c++) {
                if (!DEMO[r * DEMO_COLS + c]) continue;
                const tIdx = _computeTileIndex(demoData, c, r);
                const imgURL = d.images[tIdx < cnt ? tIdx : 0];
                if (imgURL) {
                    const img = new Image();
                    img.src = imgURL;
                    ctx.drawImage(img, c * tW, r * tH, tW, tH);
                } else {
                    // placeholder
                    ctx.fillStyle = `hsl(${tIdx * 12},40%,30%)`;
                    ctx.fillRect(c * tW + 1, r * tH + 1, tW - 2, tH - 2);
                    ctx.fillStyle = '#fff4';
                    ctx.font = `${Math.max(8, tW/4)}px monospace`;
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.fillText(tIdx, c * tW + tW/2, r * tH + tH/2);
                }
            }
        }

        // Guide lines over demo
        if (showGuides) {
            ctx.strokeStyle = 'rgba(100,180,255,0.35)';
            ctx.lineWidth = 0.5;
            for (let c = 0; c <= DEMO_COLS; c++) { ctx.beginPath(); ctx.moveTo(c*tW,0); ctx.lineTo(c*tW,DEMO_ROWS*tH); ctx.stroke(); }
            for (let r = 0; r <= DEMO_ROWS; r++) { ctx.beginPath(); ctx.moveTo(0,r*tH); ctx.lineTo(DEMO_COLS*tW,r*tH); ctx.stroke(); }
        }

        // Divider
        ctx.strokeStyle = '#3a3a48'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo((DEMO_COLS + 0.5)*tW, 0); ctx.lineTo((DEMO_COLS + 0.5)*tW, totalH); ctx.stroke();

        // Tile atlas
        const offX = (DEMO_COLS + 1) * tW;
        for (let i = 0; i < cnt; i++) {
            const ac = i % atlasCols;
            const ar = Math.floor(i / atlasCols);
            const ax = offX + ac * tW;
            const ay = ar * tH;
            ctx.fillStyle = '#1a1a28';
            ctx.fillRect(ax, ay, tW, tH);
            if (d.images[i]) {
                const img = new Image();
                img.src = d.images[i];
                ctx.drawImage(img, ax, ay, tW, tH);
            }
            if (showGuides) {
                ctx.strokeStyle = 'rgba(100,180,255,0.25)'; ctx.lineWidth = 0.5;
                ctx.strokeRect(ax+.5, ay+.5, tW-1, tH-1);
                ctx.fillStyle = 'rgba(255,255,255,0.35)';
                ctx.font = `${Math.max(7, tW/5)}px monospace`;
                ctx.textAlign = 'left'; ctx.textBaseline = 'top';
                ctx.fillText(i, ax+2, ay+1);
            }
        }
    }
}

// ── Open terrain paint editor ─────────────────────────────────
export function openTerrainEditor(obj) {
    document.getElementById('te-editor')?.remove();

    const d = obj.terrainData;

    const panel = document.createElement('div');
    panel.id = 'te-editor';
    panel.style.cssText = `
        position:fixed;inset:0;z-index:15000;background:rgba(0,0,0,0.92);
        display:flex;font-family:'Inter','Segoe UI',sans-serif;font-size:11px;color:#d8d8e8;`;

    panel.innerHTML = `
    <div style="display:flex;width:100%;height:100%;">

      <!-- Left sidebar -->
      <div style="width:220px;flex-shrink:0;background:#1a1a24;border-right:1px solid #2e2e3a;
                  display:flex;flex-direction:column;overflow:hidden;">

        <!-- Header -->
        <div style="padding:12px 14px;border-bottom:1px solid #2e2e3a;
                    display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:none;stroke:#4ade80;stroke-width:2;">
            <path d="M3 20h18M3 20l4-8 4 4 4-6 4 10"/>
          </svg>
          <span style="font-weight:700;color:#fff;">Terrain Editor</span>
          <div style="flex:1;"></div>
          <button id="te-close" style="background:none;border:none;color:#666;cursor:pointer;font-size:16px;padding:2px 5px;">✕</button>
        </div>

        <!-- Grid settings -->
        <div style="padding:10px 14px;border-bottom:1px solid #2e2e3a;flex-shrink:0;">
          <div style="font-size:9px;font-weight:700;color:#505060;letter-spacing:.8px;margin-bottom:8px;">MAP SIZE</div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <span style="color:#7a7a90;font-size:10px;">Columns</span>
            <input type="number" id="te-cols" value="${d.cols}" min="1" max="512"
              style="width:65px;background:#16161e;border:1px solid #3a3a48;color:#d8d8e8;
                     border-radius:3px;padding:3px 5px;font-size:10px;outline:none;text-align:right;">
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <span style="color:#7a7a90;font-size:10px;">Rows</span>
            <input type="number" id="te-rows" value="${d.rows}" min="1" max="512"
              style="width:65px;background:#16161e;border:1px solid #3a3a48;color:#d8d8e8;
                     border-radius:3px;padding:3px 5px;font-size:10px;outline:none;text-align:right;">
          </div>
          <button id="te-apply-size" style="width:100%;background:#1e3050;border:1px solid #3A72A5;
                  color:#7aabcc;border-radius:4px;padding:5px;cursor:pointer;font-size:10px;">Apply Size</button>
        </div>

        <!-- Tools -->
        <div style="padding:10px 14px;border-bottom:1px solid #2e2e3a;flex-shrink:0;">
          <div style="font-size:9px;font-weight:700;color:#505060;letter-spacing:.8px;margin-bottom:8px;">TOOLS</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="te-tool-btn te-tool-active" data-tool="paint" title="Paint filled (B)">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
            </button>
            <button class="te-tool-btn" data-tool="erase" title="Erase (E)">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M20 20H7L3 16l10-10 7 7-1.5 1.5"/></svg>
            </button>
            <button class="te-tool-btn" data-tool="fill" title="Fill (F)">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M16 6l2 2-8 8-4-4 8-8z"/><circle cx="20" cy="20" r="2"/></svg>
            </button>
          </div>
        </div>

        <!-- Brush info -->
        <div style="padding:10px 14px;border-bottom:1px solid #2e2e3a;flex-shrink:0;">
          <div style="font-size:9px;font-weight:700;color:#505060;letter-spacing:.8px;margin-bottom:6px;">BRUSH</div>
          <div style="color:#4ade80;font-size:11px;font-weight:600;">${d.brushName || '—'}</div>
          <div style="color:#505060;font-size:10px;margin-top:2px;">${d.tilesetType}-tile auto-tiler</div>
          <button id="te-open-setup" style="width:100%;margin-top:8px;background:#0d1f0d;border:1px solid #2a5a2a;
                  color:#6cac6c;border-radius:4px;padding:5px;cursor:pointer;font-size:10px;">
            Configure Brush Tiles ↗
          </button>
        </div>

        <!-- Info -->
        <div style="padding:10px 14px;flex:1;">
          <div style="color:#303040;font-size:9px;line-height:1.7;">
            B = Paint &nbsp; E = Erase &nbsp; F = Fill<br>
            Ctrl+Z = Undo<br>
            Drag to paint multiple cells
          </div>
          <div id="te-cursor-info" style="color:#7a7a90;font-size:10px;margin-top:8px;"></div>
        </div>
      </div>

      <!-- Canvas -->
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0e0e18;">
        <div style="padding:8px 14px;border-bottom:1px solid #1e1e2e;font-size:10px;color:#505060;flex-shrink:0;">
          <span style="color:#4ade80;">Auto-tiling terrain</span>
          — cells auto-select tile variant based on neighbors
        </div>
        <div id="te-canvas-wrap" style="flex:1;overflow:auto;padding:20px;">
          <div style="position:relative;display:inline-block;">
            <canvas id="te-map-canvas" style="display:block;image-rendering:pixelated;cursor:crosshair;"></canvas>
            <canvas id="te-map-overlay" style="position:absolute;inset:0;pointer-events:none;"></canvas>
          </div>
        </div>
      </div>
    </div>

    <style>
      .te-tool-btn { background:#16161e;border:1px solid #2e2e3a;color:#606070;border-radius:4px;
                     padding:7px;cursor:pointer;display:flex;align-items:center;justify-content:center; }
      .te-tool-btn:hover { border-color:#4ade80;color:#4ade80; }
      .te-tool-active { border-color:#4ade80 !important;background:#1a3020 !important;color:#4ade80 !important; }
    </style>`;

    document.body.appendChild(panel);
    _wireTerrainEditor(panel, obj);
}

function _wireTerrainEditor(panel, obj) {
    const d = obj.terrainData;
    let tool = 'paint';
    let isPainting = false;
    const undoStack = [];

    const mapCanvas  = panel.querySelector('#te-map-canvas');
    const mapOverlay = panel.querySelector('#te-map-overlay');
    const mctx  = mapCanvas.getContext('2d');
    const moctx = mapOverlay.getContext('2d');

    // Close
    panel.querySelector('#te-close').addEventListener('click', () => {
        rebuildTerrainSprites(obj);
        _buildTerrainHelper(obj);
        import('./engine.ui.js').then(m => { m.syncPixiToInspector(); m.refreshHierarchy(); });
        panel.remove();
    });

    // Configure brush
    panel.querySelector('#te-open-setup').addEventListener('click', () => {
        openBrushSetup(obj);
    });

    // Resize canvas to map
    function _resizeCanvas() {
        const W = d.cols * d.tileW;
        const H = d.rows * d.tileH;
        mapCanvas.width  = W; mapCanvas.height  = H;
        mapOverlay.width = W; mapOverlay.height = H;
        _drawMap();
    }

    // Apply size
    panel.querySelector('#te-apply-size').addEventListener('click', () => {
        const nc = Math.max(1, parseInt(panel.querySelector('#te-cols').value) || d.cols);
        const nr = Math.max(1, parseInt(panel.querySelector('#te-rows').value) || d.rows);
        // Preserve existing tiles
        const newTiles = new Int32Array(nc * nr).fill(0);
        for (let r = 0; r < Math.min(nr, d.rows); r++)
            for (let c = 0; c < Math.min(nc, d.cols); c++)
                newTiles[r * nc + c] = d.tiles[r * d.cols + c];
        d.cols = nc; d.rows = nr; d.tiles = newTiles;
        _resizeCanvas();
    });

    // Tools
    panel.querySelectorAll('.te-tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            panel.querySelectorAll('.te-tool-btn').forEach(b => b.classList.remove('te-tool-active'));
            btn.classList.add('te-tool-active');
            tool = btn.dataset.tool;
        });
    });

    // Keyboard shortcuts
    const _onKey = e => {
        if (e.target.tagName === 'INPUT') return;
        if (e.key === 'b' || e.key === 'B') { tool='paint'; _setActiveTool('paint'); }
        if (e.key === 'e' || e.key === 'E') { tool='erase'; _setActiveTool('erase'); }
        if (e.key === 'f' || e.key === 'F') { tool='fill';  _setActiveTool('fill'); }
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { _undo(); }
    };
    document.addEventListener('keydown', _onKey);
    panel.querySelector('#te-close').addEventListener('click', () => document.removeEventListener('keydown', _onKey), { once: true });

    function _setActiveTool(t) {
        panel.querySelectorAll('.te-tool-btn').forEach(b =>
            b.classList.toggle('te-tool-active', b.dataset.tool === t));
        tool = t;
    }

    // Drawing
    function _cellAt(e) {
        const rect = mapCanvas.getBoundingClientRect();
        const sx = mapCanvas.width  / rect.width;
        const sy = mapCanvas.height / rect.height;
        return {
            c: Math.floor((e.clientX - rect.left) * sx / d.tileW),
            r: Math.floor((e.clientY - rect.top)  * sy / d.tileH),
        };
    }

    function _paintCell(c, r) {
        if (c < 0 || c >= d.cols || r < 0 || r >= d.rows) return;
        const val = tool === 'erase' ? 0 : 1;
        if (d.tiles[r * d.cols + c] === val) return;
        d.tiles[r * d.cols + c] = val;
        // Redraw this cell + neighbors (they may change variant)
        for (let dr = -1; dr <= 1; dr++)
            for (let dc = -1; dc <= 1; dc++)
                _drawCell(c + dc, r + dr);
    }

    function _flood(c, r, fillVal) {
        const src = d.tiles[r * d.cols + c];
        if (src === fillVal) return;
        const stack = [{c, r}];
        const visited = new Set();
        while (stack.length) {
            const {c, r} = stack.pop();
            if (c < 0 || c >= d.cols || r < 0 || r >= d.rows) continue;
            const k = r * d.cols + c;
            if (visited.has(k)) continue;
            if (d.tiles[k] !== src) continue;
            visited.add(k);
            d.tiles[k] = fillVal;
            stack.push({c:c+1,r},{c:c-1,r},{c,r:r+1},{c,r:r-1});
        }
        _drawMap();
    }

    mapCanvas.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        isPainting = true;
        mapCanvas.setPointerCapture(e.pointerId);
        undoStack.push(d.tiles.slice());
        if (undoStack.length > 50) undoStack.shift();
        const {c, r} = _cellAt(e);
        if (tool === 'fill') { _flood(c, r, 1); return; }
        _paintCell(c, r);
    });
    mapCanvas.addEventListener('pointermove', e => {
        if (!isPainting) {
            const {c, r} = _cellAt(e);
            panel.querySelector('#te-cursor-info').textContent = `Cell (${c}, ${r})`;
            _drawOverlay(c, r);
            return;
        }
        const {c, r} = _cellAt(e);
        _paintCell(c, r);
    });
    mapCanvas.addEventListener('pointerup', () => { isPainting = false; });
    mapCanvas.addEventListener('pointerleave', () => {
        moctx.clearRect(0,0,mapOverlay.width,mapOverlay.height);
    });

    function _undo() {
        if (!undoStack.length) return;
        d.tiles = undoStack.pop();
        _drawMap();
    }

    // Render
    function _drawMap() {
        const cnt = d.tilesetType === '47' ? 47 : 16;
        mctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
        mctx.fillStyle = '#0e0e18';
        mctx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

        // Draw empty grid
        mctx.strokeStyle = 'rgba(74,222,128,0.1)';
        mctx.lineWidth = 0.5;
        for (let c = 0; c <= d.cols; c++) { mctx.beginPath(); mctx.moveTo(c*d.tileW,0); mctx.lineTo(c*d.tileW,mapCanvas.height); mctx.stroke(); }
        for (let r = 0; r <= d.rows; r++) { mctx.beginPath(); mctx.moveTo(0,r*d.tileH); mctx.lineTo(mapCanvas.width,r*d.tileH); mctx.stroke(); }

        for (let r = 0; r < d.rows; r++)
            for (let c = 0; c < d.cols; c++)
                _drawCell(c, r);
    }

    function _drawCell(c, r) {
        if (c < 0 || c >= d.cols || r < 0 || r >= d.rows) return;
        const cnt = d.tilesetType === '47' ? 47 : 16;
        mctx.clearRect(c * d.tileW, r * d.tileH, d.tileW, d.tileH);
        if (!d.tiles[r * d.cols + c]) {
            mctx.fillStyle = '#0e0e18';
            mctx.fillRect(c * d.tileW, r * d.tileH, d.tileW, d.tileH);
            mctx.strokeStyle = 'rgba(74,222,128,0.08)';
            mctx.lineWidth = 0.5;
            mctx.strokeRect(c * d.tileW + .5, r * d.tileH + .5, d.tileW-1, d.tileH-1);
            return;
        }
        const tIdx  = _computeTileIndex(d, c, r);
        const imgURL = d.images[tIdx < cnt ? tIdx : 0];
        if (imgURL) {
            const img = new Image();
            img.src = imgURL;
            mctx.drawImage(img, c * d.tileW, r * d.tileH, d.tileW, d.tileH);
        } else {
            mctx.fillStyle = `hsl(120,35%,${20 + tIdx}%)`;
            mctx.fillRect(c * d.tileW + 1, r * d.tileH + 1, d.tileW - 2, d.tileH - 2);
            mctx.fillStyle = 'rgba(255,255,255,0.4)';
            mctx.font = `${Math.max(8, d.tileW/4)}px monospace`;
            mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
            mctx.fillText(tIdx, c * d.tileW + d.tileW/2, r * d.tileH + d.tileH/2);
        }
    }

    function _drawOverlay(hc, hr) {
        moctx.clearRect(0, 0, mapOverlay.width, mapOverlay.height);
        if (hc < 0 || hc >= d.cols || hr < 0 || hr >= d.rows) return;
        moctx.fillStyle   = tool === 'erase'
            ? 'rgba(248,113,113,0.35)'
            : tool === 'fill'
            ? 'rgba(100,200,255,0.25)'
            : 'rgba(74,222,128,0.3)';
        moctx.fillRect(hc * d.tileW, hr * d.tileH, d.tileW, d.tileH);
        moctx.strokeStyle = tool === 'erase' ? '#f87171' : tool === 'fill' ? '#64c8ff' : '#4ade80';
        moctx.lineWidth   = 1.5;
        moctx.strokeRect(hc * d.tileW + .5, hr * d.tileH + .5, d.tileW - 1, d.tileH - 1);
    }

    _resizeCanvas();
}

// ── Snapshot / restore ────────────────────────────────────────
export function snapshotTerrain(obj) {
    return {
        isTerrain: true,
        label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
        terrainData: {
            ...obj.terrainData,
            tiles:  Array.from(obj.terrainData.tiles),
            images: obj.terrainData.images.slice(),
        },
    };
}

export async function restoreTerrain(s) {
    const obj = createTerrain(s.x, s.y);
    obj.label   = s.label;
    obj.unityZ  = s.unityZ || 0;
    obj.terrainData = {
        ...s.terrainData,
        tiles:  new Int32Array(s.terrainData.tiles),
        images: s.terrainData.images.slice(),
    };
    _buildTerrainHelper(obj);
    rebuildTerrainSprites(obj);
    return obj;
}

// ── Utilities ─────────────────────────────────────────────────
function _uniqueTerrainName(base) {
    const existing = new Set(state.gameObjects.map(o => o.label));
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
}

function _readFileAsDataURL(file) {
    return new Promise(res => {
        const r = new FileReader();
        r.onload = e => res(e.target.result);
        r.readAsDataURL(file);
    });
}

async function _sliceSpritesheet(url, tW, tH, sheetCols, count) {
    return new Promise(res => {
        const img = new Image();
        img.onload = () => {
            const result = [];
            for (let i = 0; i < count; i++) {
                const sc = i % sheetCols;
                const sr = Math.floor(i / sheetCols);
                const cv = document.createElement('canvas');
                cv.width = tW; cv.height = tH;
                cv.getContext('2d').drawImage(img, sc*tW, sr*tH, tW, tH, 0, 0, tW, tH);
                result.push(cv.toDataURL());
            }
            res(result);
        };
        img.src = url;
    });
}

function _attachTranslateGizmoTerrain(container) {
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
    [g1,g2,g3].forEach(h => h.on('pointerdown', e => e.stopPropagation()));
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
