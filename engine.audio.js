/* ============================================================
   Zengine — engine.audio.js
   Audio asset import, playback, and inspector panel.
   Supported: .mp3, .wav, .ogg, .m4a, .flac
   Audio assets stored in state.audioAssets (shared, like images)
   ============================================================ */

import { state } from './engine.state.js';

// ── Import audio file(s) ──────────────────────────────────────
export async function importAudioFile(file) {
    const SUPPORTED = ['audio/mpeg','audio/wav','audio/ogg','audio/mp4','audio/flac','audio/x-flac','audio/aac'];
    if (!SUPPORTED.some(t => file.type.startsWith(t.split('/')[0]) && file.name.match(/\.(mp3|wav|ogg|m4a|flac|aac)$/i))) {
        _toast(`Unsupported format: ${file.name}`, 'error');
        return null;
    }

    // Deduplicate by name
    if (state.audioAssets.find(a => a.name === file.name)) {
        _toast(`"${file.name}" already imported`, 'warn');
        return null;
    }

    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const dataURL = e.target.result;

            // Get duration via AudioContext
            let duration = 0;
            try {
                const ctx    = new (window.AudioContext || window.webkitAudioContext)();
                const buf    = await ctx.decodeAudioData(e.target.result.split(',')[1]
                    ? _dataURLToArrayBuffer(dataURL) : new ArrayBuffer(0));
                duration     = buf?.duration || 0;
                ctx.close();
            } catch (_) {}

            const asset = {
                id:       'audio_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                name:     file.name,
                dataURL:  dataURL,
                type:     file.type || 'audio/mpeg',
                size:     file.size,
                duration: duration,
                volume:   1.0,
                loop:     false,
                _audio:   null,   // HTMLAudioElement — created on demand
            };

            state.audioAssets.push(asset);
            refreshAudioPanel();
            resolve(asset);
        };
        reader.readAsDataURL(file);
    });
}

// ── Refresh the audio grid in the panel ──────────────────────
export function refreshAudioPanel() {
    const grid = document.getElementById('audio-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!state.audioAssets.length) {
        grid.innerHTML = '<div style="color:#555; font-style:italic; padding:12px; font-size:11px;">No audio assets — import .mp3 .wav .ogg .m4a .flac</div>';
        return;
    }

    for (const asset of state.audioAssets) {
        const item = document.createElement('div');
        item.style.cssText = `
            display:flex; align-items:center; gap:8px;
            padding:6px 10px; border-bottom:1px solid #222;
            cursor:pointer; transition: background 0.1s;
        `;

        const ext = asset.name.split('.').pop().toUpperCase();
        const dur = asset.duration > 0 ? _fmtDuration(asset.duration) : '—';

        item.innerHTML = `
            <div style="width:32px; height:32px; background:#1a2a3a; border:1px solid #2a4a6a;
                        border-radius:4px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:#3A72A5;stroke-width:2;">
                    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                </svg>
            </div>
            <div style="flex:1; min-width:0;">
                <div style="color:#ccc; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${asset.name}</div>
                <div style="color:#666; font-size:10px;">${ext} · ${dur} · ${_fmtSize(asset.size)}</div>
            </div>
            <div style="display:flex; gap:4px; flex-shrink:0;">
                <button class="audio-play-btn" data-id="${asset.id}"
                        style="background:#1e3050; border:1px solid #3A72A5; color:#9bc; border-radius:3px;
                               padding:2px 8px; cursor:pointer; font-size:11px;">▶</button>
                <button class="audio-del-btn" data-id="${asset.id}"
                        style="background:#3a1e1e; border:1px solid #6a2a2a; color:#f88; border-radius:3px;
                               padding:2px 6px; cursor:pointer; font-size:11px;">✕</button>
            </div>
        `;

        item.querySelector('.audio-play-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            _togglePlay(asset, e.target);
        });
        item.querySelector('.audio-del-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            _stopAudio(asset);
            const idx = state.audioAssets.indexOf(asset);
            if (idx !== -1) state.audioAssets.splice(idx, 1);
            refreshAudioPanel();
        });

        item.addEventListener('click', () => _showAudioInspector(asset));
        item.addEventListener('mouseenter', () => item.style.background = '#2a2a2a');
        item.addEventListener('mouseleave', () => item.style.background = '');

        grid.appendChild(item);
    }
}

// ── Toggle play/pause ─────────────────────────────────────────
let _currentlyPlaying = null;

function _togglePlay(asset, btn) {
    if (_currentlyPlaying && _currentlyPlaying !== asset) {
        _stopAudio(_currentlyPlaying);
        document.querySelectorAll('.audio-play-btn').forEach(b => b.textContent = '▶');
    }
    if (!asset._audio) {
        asset._audio = new Audio(asset.dataURL);
        asset._audio.volume = asset.volume ?? 1;
        asset._audio.loop   = asset.loop   ?? false;
        asset._audio.onended = () => { btn.textContent = '▶'; _currentlyPlaying = null; };
    }
    if (asset._audio.paused) {
        asset._audio.play();
        btn.textContent = '⏸';
        _currentlyPlaying = asset;
    } else {
        asset._audio.pause();
        btn.textContent = '▶';
        _currentlyPlaying = null;
    }
}

function _stopAudio(asset) {
    if (asset._audio) { asset._audio.pause(); asset._audio.currentTime = 0; }
}

// ── Audio inspector popup ─────────────────────────────────────
function _showAudioInspector(asset) {
    document.getElementById('audio-inspector-popup')?.remove();

    const popup = document.createElement('div');
    popup.id = 'audio-inspector-popup';
    popup.style.cssText = `
        position:fixed; right:320px; bottom:240px;
        width:260px; background:#242424; border:1px solid #444;
        border-radius:4px; box-shadow:0 4px 20px rgba(0,0,0,0.7);
        z-index:5000; font-size:11px; color:#e0e0e0; overflow:hidden;
    `;

    const dur = asset.duration > 0 ? _fmtDuration(asset.duration) : '—';
    const ext = asset.name.split('.').pop().toUpperCase();

    popup.innerHTML = `
        <div style="background:#1a1a1a; padding:8px 12px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333;">
            <span style="font-weight:bold; color:#9bc;">🎵 Audio Inspector</span>
            <button id="audio-insp-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;">✕</button>
        </div>
        <div style="padding:12px; display:flex; flex-direction:column; gap:10px;">
            <div style="color:#888; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${asset.name}">${asset.name}</div>

            <div style="display:flex; gap:8px; font-size:10px; color:#666;">
                <span>Format: <strong style="color:#aaa;">${ext}</strong></span>
                <span>Duration: <strong style="color:#aaa;">${dur}</strong></span>
                <span>Size: <strong style="color:#aaa;">${_fmtSize(asset.size)}</strong></span>
            </div>

            <div>
                <label style="color:#888; font-size:10px; display:block; margin-bottom:4px;">Volume</label>
                <div style="display:flex; align-items:center; gap:8px;">
                    <input type="range" id="audio-insp-vol" min="0" max="1" step="0.01" value="${asset.volume}"
                           style="flex:1; accent-color:#3A72A5;">
                    <span id="audio-insp-vol-val" style="color:#fff; min-width:28px;">${Math.round(asset.volume * 100)}%</span>
                </div>
            </div>

            <div style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" id="audio-insp-loop" ${asset.loop ? 'checked' : ''}
                       style="accent-color:#3A72A5;">
                <label for="audio-insp-loop" style="color:#ccc; cursor:pointer;">Loop</label>
            </div>

            <div style="display:flex; gap:6px;">
                <button id="audio-insp-play" style="flex:1; background:#1e3050; border:1px solid #3A72A5;
                        color:#9bc; border-radius:3px; padding:5px; cursor:pointer; font-size:11px;">▶ Play</button>
                <button id="audio-insp-stop" style="background:#2a2a2a; border:1px solid #444;
                        color:#888; border-radius:3px; padding:5px 10px; cursor:pointer; font-size:11px;">■ Stop</button>
            </div>
        </div>
    `;

    popup.querySelector('#audio-insp-close').addEventListener('click', () => popup.remove());

    const volSlider = popup.querySelector('#audio-insp-vol');
    const volVal    = popup.querySelector('#audio-insp-vol-val');
    volSlider.addEventListener('input', () => {
        asset.volume = parseFloat(volSlider.value);
        volVal.textContent = Math.round(asset.volume * 100) + '%';
        if (asset._audio) asset._audio.volume = asset.volume;
    });

    popup.querySelector('#audio-insp-loop').addEventListener('change', (e) => {
        asset.loop = e.target.checked;
        if (asset._audio) asset._audio.loop = asset.loop;
    });

    popup.querySelector('#audio-insp-play').addEventListener('click', () => {
        const btn = document.querySelector(`.audio-play-btn[data-id="${asset.id}"]`);
        _togglePlay(asset, btn || popup.querySelector('#audio-insp-play'));
    });
    popup.querySelector('#audio-insp-stop').addEventListener('click', () => {
        _stopAudio(asset);
        document.querySelectorAll('.audio-play-btn').forEach(b => b.textContent = '▶');
    });

    document.body.appendChild(popup);
    setTimeout(() => {
        document.addEventListener('click', function h(e) {
            if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', h); }
        });
    }, 0);
}

// ── Helpers ───────────────────────────────────────────────────
function _fmtDuration(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
}
function _fmtSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}
function _dataURLToArrayBuffer(dataURL) {
    const b64  = dataURL.split(',')[1];
    const bin  = atob(b64);
    const buf  = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return buf;
}
function _toast(msg, type = 'info') {
    const t = document.createElement('div');
    const bg = type === 'error' ? '#3a1e1e' : type === 'warn' ? '#3a3a1e' : '#1e3a1e';
    const cl = type === 'error' ? '#f88'    : type === 'warn' ? '#fa8'    : '#8f8';
    t.style.cssText = `position:fixed;bottom:30px;left:50%;transform:translateX(-50%);
        background:${bg};border:1px solid;color:${cl};border-radius:4px;padding:6px 16px;font-size:11px;z-index:9999;`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
}
