const transcodeStatus = document.getElementById('transcodeStatus');
const transcodeText = document.getElementById('transcodeText');
const transcodeBar = document.getElementById('transcodeBar');

console.log('[DEBUG]', {
    crossOriginIsolated: window.crossOriginIsolated,
    sab: typeof SharedArrayBuffer,
    location: location.href
});

let ADMIN_TOKEN = null;

let ws = null;

let isTranscoding = false;

function initStreamWS() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${location.host}/ws/stream`;

    ws = new WebSocket(wsUrl);

    let wsKeepAliveTimer = null;

    ws.onopen = () => {
        wsKeepAliveTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'keepalive' }));
            }
        }, 10000);
        console.log('[WS] stream connected');
    };

    ws.onclose = () => {
        clearInterval(wsKeepAliveTimer);
        console.warn('[WS] stream disconnected');
    };

    ws.onerror = (e) => {
        clearInterval(wsKeepAliveTimer);
        console.warn('[WS] stream error', e);
    };

    ws.onmessage = (e) => {
        let data;
        try {
            data = JSON.parse(e.data);
        } catch {
            console.warn('[WARN] failed to parse websocket message');
            return;
        }

        console.log('receive info message');
        if (data.type === 'stream-status') {
            if (data.status === 'error') {
                setStatus('❌ 推流出错，请联系管理员', 'error');
            }

            if (data.status === 'stopped') {
                setStatus('⏹ 推流已结束', 'info');
            }

            if (data.status === 'running') {
                setStatus('✅ 推流中', 'ok');
            }

            if (data.status === 'info') {
                setStatus(`${data.message}`, 'info');
            }
        }
    };
}

async function loadAdminToken() {
    if (ADMIN_TOKEN) return ADMIN_TOKEN;

    const res = await fetch('/api/internal/admin-token');
    if (!res.ok) {
        throw new Error('无法获取 admin token');
    }

    const data = await res.json();
    ADMIN_TOKEN = data.token;
    return ADMIN_TOKEN;
}
// ===== 状态 =====
const playlist = [];
const fileFingerprints = new Set();

// ===== DOM =====
const playlistEl = document.getElementById('playlist');
const emptyTip = document.getElementById('emptyTip');
const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode');
const loopSelector = document.getElementById('loopSelector');
const loopTarget = document.getElementById('loopTarget');
const fileInput = document.getElementById('fileInput');

// ===== 工具 =====
function fileKey(file) {
    return `${file.name}|${file.size}|${file.lastModified}`;
}

function formatSize(bytes) {
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function setStatus(text, cls = '') {
    statusEl.textContent = text;
    statusEl.className = 'status ' + cls;
}

// ===== 渲染 =====
function renderPlaylist() {
    playlistEl.innerHTML = '';
    loopTarget.innerHTML = '';

    if (playlist.length === 0) {
        emptyTip.style.display = 'block';
        loopSelector.classList.add('hidden');
        return;
    }

    emptyTip.style.display = 'none';

    playlist.forEach((item, index) => {
        const file = item.originalFile;

        const li = document.createElement('li');
        li.innerHTML = `
      <span>
        ${index + 1}. ${file.name}
        <span class="small">(${formatSize(file.size)})</span>
      </span>
      <button onclick="removeItem(${index})">移除</button>
    `;
        playlistEl.appendChild(li);

        const opt = document.createElement('option');
        opt.value = index;
        opt.textContent = file.name;
        loopTarget.appendChild(opt);
    });

    if (modeEl.value === 'loop') {
        loopSelector.classList.remove('hidden');
    }
}

// ===== 行为 =====
function removeItem(index) {
    const item = playlist[index];
    const file = item.originalFile;

    fileFingerprints.delete(fileKey(file));
    playlist.splice(index, 1);
    renderPlaylist();
}

async function fingerprintFile(file) {
    const buf = await file.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hashBuf)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function checkTranscodedExists(fingerprint) {
    const token = await loadAdminToken();

    const res = await fetch('/api/stream/check', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-admin-token': token
        },
        body: JSON.stringify({ fingerprint })
    });

    if (!res.ok) return null;
    return await res.json(); // { exists: true, path }
}

function canClientTranscode() {
    // Safari / iOS 一律禁用
    const ua = navigator.userAgent;
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

    if (isSafari) return false;

    // Brave / 非隔离环境下 SharedArrayBuffer 不存在
    let hasSAB = false;
    try {
        hasSAB = typeof SharedArrayBuffer !== 'undefined';
    } catch {
        hasSAB = false;
    }

    return (
        !isMobileDevice() &&
        hasSAB &&
        'Worker' in window
    );
}

function isMobileDevice() {
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

async function safeTranscode(file, index, total) {
    try {
        return await transcodeVideo(file, index, total);
    } catch (err) {
        if (err.message === 'CLIENT_TRANSCODE_CANCELLED') {
            throw err; // 直接中断整个流程
        }

        console.warn('客户端转码失败，回退服务器转码:', err);
        return null;
    }
}

// ===== API =====
async function start() {
    if (playlist.length === 0) {
        setStatus('❌ 播放列表为空', 'error');
        return;
    }

    const mode = modeEl.value;
    const form = new FormData();

    setStatus('⏳ 准备推流…');

    const token = await loadAdminToken();

    // ===== 决定是否客户端转码 =====
    const useClientTranscode = canClientTranscode();

    if (useClientTranscode) {
        setStatus('🖥️ 桌面环境，使用客户端转码…');
    } else {
        setStatus('📱 移动端或不支持转码，使用服务器转码…');
    }

    // ===== 用“中间结构”收集，最后统一 append =====
    const uploadItems = [];
    const existingItems = [];

    if (mode === 'loop') {
        const index = Number(loopTarget.value);
        const item = playlist[index];
        const file = item.originalFile;
        const fp = item.fingerprint;

        const check = await checkTranscodedExists(fp);

        if (check?.exists) {
            // ✅ 已有后端缓存
            existingItems.push({ filePath: check.path, index });
        } else {
            if (!useClientTranscode) {
                setStatus('❌ 当前环境不支持客户端转码', 'error');
                return;
            }

            // ✅ 客户端转码（Step 2 核心）
            console.log('[INFO] 开始转码...');
            updateTranscodeProgress(0, `准备转码第 1 / 1 个视频`);
            const safeFile = await transcodeToRTMPSafe(file, 0, 1);
            uploadItems.push({ file: safeFile, fingerprint: fp, index });
        }

        form.append('loopIndex', index);
    }
    else {
        const total = playlist.length;

        for (let i = 0; i < playlist.length; i++) {
            const item = playlist[i];
            const file = item.originalFile;
            const fp = item.fingerprint;

            const check = await checkTranscodedExists(fp);

            if (check?.exists) {
                // ✅ 已有缓存
                existingItems.push({ filePath: check.path, index: i });
                continue;
            }

            if (!useClientTranscode) {
                setStatus('❌ 当前环境不支持客户端转码', 'error');
                return;
            }

            updateTranscodeProgress(
                0,
                `准备转码第 ${i + 1} / ${total} 个视频：${file.name}`
            );
            console.log('[INFO] 开始转码...');
            const safeFile = await transcodeToRTMPSafe(file, i, total);
            uploadItems.push({ file: safeFile, fingerprint: fp, index: i });
        }
    }

    for (const item of existingItems) {
        form.append('existing', JSON.stringify(item));
    }

    for (const item of uploadItems) {
        form.append('files', item.file, item.file.name);
        form.append('fingerprints', item.fingerprint);
    }

    if (uploadItems.length > 0) {
        form.append('clientTranscoded', '1');
    }


    form.append('mode', mode);

    setStatus('📡 正在启动推流…');

    const res = await fetch('/api/stream/start', {
        method: 'POST',
        headers: {
            'x-admin-token': token
        },
        body: form
    });

    const text = await res.text();

    res.ok
        ? setStatus('✅ 推流中', 'ok')
        : setStatus('❌ ' + text, 'error');
}

async function stop() {
    const token = await loadAdminToken();
    const res = await fetch('/api/stream/stop', {
        method: 'POST', headers: {
            'x-admin-token': token
        },
    });
    const text = await res.text();
    setStatus(text);
}

const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const TARGET_FPS = 30;
const VIDEO_BITRATE = 2_000_000; // 2 Mbps
const MAX_CLIENT_DURATION = 2 * 60 * 60; // 2 hours

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const DEV_BASE = 'https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/esm';
const PROD_BASE = '/stream/ffmpeg';

function getFFmpegBaseURL() {
    return __DEV__ ? DEV_BASE : PROD_BASE;
}

let ffmpeg;

let ffmpegPreloading = false;

async function preloadFFmpeg() {
    if (ffmpeg || ffmpegPreloading) return;

    if (!canClientTranscode()) {
        console.log('[ffmpeg] client transcode not supported, skip preload');
        return;
    }

    ffmpegPreloading = true;
    setStatus('⏳ 初始化转码引擎…');

    try {
        await getFFmpeg();
        setStatus('✅ 转码引擎就绪');
    } catch (e) {
        console.warn('[ffmpeg] preload failed', e);
        setStatus('⚠️ 当前浏览器不支持客户端转码');
    }
}

export async function getFFmpeg() {
    if (ffmpeg) return ffmpeg;

    ffmpeg = new FFmpeg();
    const baseURL = getFFmpegBaseURL();

    await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpeg.on('progress', ({ progress, time }) => {
        if (!isTranscoding) return;

        const percent = Math.min(99, Math.round(progress * 100));
        updateTranscodeProgress(percent);
    });

    return ffmpeg;
}

async function transcodeToRTMPSafe(file, index, total) {
    if (file.duration && file.duration > MAX_CLIENT_DURATION) {
        throw new Error('视频文件太大，请重新上传不超过2G的文件。');
    }

    isTranscoding = true;

    console.log('[INFO] loading ffmpeg');
    const ffmpeg = await getFFmpeg();
    console.log('[INFO] load ffmpeg success');

    const inputName = `input-${Date.now()}.mp4`;
    const outputName = `output-${Date.now()}.mp4`;

    updateTranscodeProgress(0, `准备转码第 ${index + 1}/${total} 个视频`);

    await ffmpeg.writeFile(inputName, await fetchFile(file));

    try {
        console.log('[INFO] start transcoding...');
        await ffmpeg.exec([
            '-i', inputName,

            // ===== 视频 =====
            '-vf', `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,fps=${TARGET_FPS}`,
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'veryfast',
            '-crf', '24',

            // 关键帧（RTMP 稳定）
            '-g', String(TARGET_FPS * 2),
            '-keyint_min', String(TARGET_FPS),
            '-sc_threshold', '0',

            // ===== 音频（必须有）=====
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '2',
            '-b:a', '128k',

            '-movflags', '+faststart',
            outputName
        ]);
    } catch (e) {
        if (e.name === 'AbortError') {
            console.warn('[transcode] cancelled by user');
            throw new Error('CLIENT_TRANSCODE_CANCELLED');
        }

        console.error('[transcode] ffmpeg failed', e);
        throw new Error('CLIENT_TRANSCODE_FAILED');
    } finally {
        isTranscoding = false;
    }

    const data = await ffmpeg.readFile(outputName);

    // ✅ 清理虚拟文件系统
    try {
        await ffmpeg.unlink(inputName);
        await ffmpeg.unlink(outputName);
    }
    catch (e) {
        console.warn(`[WARN] unlink file failed, error: ${e}`);
    }

    console.log('[INFO] finish transcode');
    updateTranscodeProgress(100, '✅ 转码完成');
    return new File(
        [data.buffer],
        file.name.replace(/\.\w+$/, '.mp4'),
        { type: 'video/mp4' }
    );
}

async function cancelTranscode() {
    if (!ffmpeg || !isTranscoding) return;

    console.warn('[ffmpeg] terminate worker');

    await ffmpeg.terminate();
    ffmpeg = null; // ⚠️ 非常重要：下次重新 new

    isTranscoding = false;

    transcodeText.textContent = '转码已取消';
    transcodeBar.style.width = '0%';
    setStatus('⛔ 已取消转码', 'info');
}

function updateTranscodeProgress(percent, text) {
    transcodeStatus.style.display = 'block';
    transcodeBar.style.width = `${percent}%`;

    if (text) {
        transcodeText.textContent = text;
    } else {
        transcodeText.textContent = `转码中… ${percent}%`;
    }
}

function bindUI() {
    fileInput.addEventListener('change', async e => {
        preloadFFmpeg();
        const files = Array.from(e.target.files);
        if (!files.length) return;

        let added = false;

        for (const file of files) {
            // ⚠️ 这里仍然可以用 fileKey 做“快速去重”
            const key = fileKey(file);
            if (fileFingerprints.has(key)) {
                continue;
            }

            // ✅ 关键：只在这里算一次 fingerprint（基于原始文件）
            const fingerprint = await fingerprintFile(file);

            playlist.push({
                originalFile: file,
                fingerprint
            });

            fileFingerprints.add(key);
            added = true;
        }

        e.target.value = '';

        if (added) {
            renderPlaylist();
        }
    });

    modeEl.addEventListener('change', () => {
        if (modeEl.value === 'loop' && playlist.length > 0) {
            loopSelector.classList.remove('hidden');
        } else {
            loopSelector.classList.add('hidden');
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initStreamWS();
    bindUI();
});

// 显式暴露给 HTML inline handler
window.start = start;
window.stop = stop;
window.cancelTranscode = cancelTranscode;
window.removeItem = removeItem;