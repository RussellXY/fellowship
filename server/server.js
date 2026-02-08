import express from 'express';
import cors from 'cors';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import crypto from 'crypto';
import { MongoClient } from 'mongodb';
import path from 'path';

import multer from 'multer';
import { spawn } from 'child_process';

let currentFfmpeg = null;
let currentStreamSession = null;
let isStreamStoppingManually = false;

let lastStreamAdminActiveAt = null;

function loadLocalEnv(filename = 'key.env') {
  const filePath = path.resolve(process.cwd(), filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`[FATAL] Missing ${filename} file`);
  }

  const content = fs.readFileSync(filePath, 'utf8');

  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();

    env[key] = value;
  }

  return env;
}

const localEnv = loadLocalEnv('key.env');
const ADMIN_TOKEN = localEnv.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  throw new Error('[FATAL] ADMIN_TOKEN not found in key.env');
}

// ===== File Upload =====
const UPLOAD_ROOT = '/data/uploads';
const CACHE_PATH = 'cached'
const TMP_PATH = '/data/uploads/tmp';
const CACHE_DIR = path.join(UPLOAD_ROOT, CACHE_PATH);
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 7 天
const TRANSCODED_VIDEO_TABLE = 'transcoded_videos';
const STREAM_LOG_TABLE = 'stream_logs'

fs.mkdirSync(CACHE_DIR, { recursive: true });

function cleanupSession(sessionDir) {
  if (!sessionDir) return;

  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log('[CLEANUP] removed session:', sessionDir);
  } catch (e) {
    console.warn('[CLEANUP] failed:', e.message);
  }
}

function emptyDir(dir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch (e) {
      console.warn('[CLEANUP] failed to remove:', fullPath, e.message);
    }
  }
}

async function getOrCreateCachedFile(fingerprint,
  uploadedPath,
  originalName) {
  if (!fingerprint) {
    throw new Error('MISSING_FINGERPRINT');
  }

  if (!uploadedPath) {
    throw new Error('MISSING_UPLOADED_PATH');
  }

  const cachedPath = path.join(CACHE_DIR, fingerprint + '.mp4');

  // ===== 1. 已存在缓存 =====
  const record = await mongoDb
    .collection(TRANSCODED_VIDEO_TABLE)
    .findOne({ fingerprint });

  if (record && fs.existsSync(record.path)) {
    return record.path;
  }

  // ===== 2. 不存在 → 创建缓存 =====
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // 这里假设：tempPath 已经是
  // - 客户端转码后的文件
  // - 或服务器转码完成的文件
  fs.renameSync(uploadedPath, cachedPath);

  // ===== 3. 现在，缓存“正式成立” =====
  await mongoDb.collection(TRANSCODED_VIDEO_TABLE).updateOne(
    { fingerprint },
    {
      $set: {
        fingerprint,
        path: cachedPath,
        originalName,
        createdAt: new Date()
      }
    },
    { upsert: true }
  );

  return cachedPath;
}

// ===== MongoDB =====
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017';
const MONGO_DB = process.env.MONGO_DB || 'fellowship';

const mongoClient = new MongoClient(MONGO_URI);
await mongoClient.connect();

const mongoDb = mongoClient.db(MONGO_DB);
const allowedUsersCol = mongoDb.collection('allowed_users');

const usersCol = mongoDb.collection('users');
await usersCol.createIndex({ userId: 1 }, { unique: true });
await usersCol.createIndex({ username: 1 });

// username 唯一索引（只 trim，不 lowercase）
await allowedUsersCol.createIndex({ username: 1 }, { unique: true });

const ROOM_TTL_SECONDS = 60 * 60 * 2; // 1 小时

// ===== Redis =====
const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: 6379
});

function roomUsersKey(roomId) {
  return `fellowship:room:${roomId}:users`;
}

async function getRoomUsers(roomId) {
  const data = await redis.get(roomUsersKey(roomId));
  return data ? JSON.parse(data) : {};
}

async function setRoomUsers(roomId, users) {
  await redis.set(
    roomUsersKey(roomId),
    JSON.stringify(users),
    'EX',
    ROOM_TTL_SECONDS
  );
}

// ===== Redis Pub/Sub =====
const redisSub = redis.duplicate();

function globalChannel() {
  return 'fellowship:room:broadcast';
}

function roomKey(roomId) {
  return `fellowship:room:${roomId}`;
}

async function getRoomState(roomId) {
  const data = await redis.get(roomKey(roomId));
  if (data) {
    await redis.expire(roomKey(roomId), ROOM_TTL_SECONDS);
    return JSON.parse(data)
  }

  const initState = {
    playing: false,
    currentTime: 0,
    showLive: false,
    anchorAt: Date.now(),
    refreshAt: 0,
    hostCount: 0
  };

  await redis.set(roomKey(roomId), JSON.stringify(initState));
  await redis.expire(roomKey(roomId), ROOM_TTL_SECONDS);
  return initState;
}

async function setRoomState(roomId, state) {
  await redis.set(
    roomKey(roomId),
    JSON.stringify(state),
    'EX',
    ROOM_TTL_SECONDS
  );
}

function normalizeUsername(username) {
  if (typeof username !== 'string') return '';
  return username.trim();
}

function printLogWithObject(object) {
  console.log(JSON.stringify(object, null, 2));
}

async function assertUsernameAllowed(username) {
  const normalized = normalizeUsername(username);

  if (!normalized) {
    throw new Error('USERNAME_EMPTY');
  }

  const record = await allowedUsersCol.findOne({
    username: normalized,
    enabled: true
  });

  if (!record) {
    throw new Error('USERNAME_NOT_ALLOWED');
  }

  return record;
}

function generateHashKey(value) {
  const normalized = value.trim().toLowerCase();
  return crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, 32); // 32 chars 足够，JaaS 很安全
}

function globalUserID(username) {
  const globalUserKey = `fellowship:user:global:${username.trim().toLowerCase()}`;
  return generateHashKey(globalUserKey);
}

async function getOrCreateGlobalUser(username) {
  await assertUsernameAllowed(username);

  const userId = globalUserID(username);

  let user = await usersCol.findOne({ userId });

  if (user) {
    return user;
  }

  user = {
    userId,
    username: normalizeUsername(username),
    systemRole: 'user',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  await usersCol.insertOne(user);
  return user;
}

function getLiveCurrentTime(room) {
  if (!room.playing) {
    return room.currentTime;
  }

  const now = Date.now();
  const elapsed = (now - room.anchorAt) / 1000; // ms → 秒
  return room.currentTime + elapsed;
}

const app = express();
app.use(cors());
// ===== COOP / COEP 只对 /stream 生效 =====
app.use('/stream', (req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
app.use(express.static('../public'));

// ===== JaaS 配置 =====
const APP_ID = 'vpaas-magic-cookie-7aa44c342e744b7386a1563d686a04bf';
const APP_ID_EXTRA = '29e98e'
const PRIVATE_KEY = fs.readFileSync('./fellowship.pk', 'utf8').trim();

// ===== WebSocket Server =====
const STREAM_ADMIN_IDLE_LIMIT_MS = 30 * 60 * 1000; // 30 分钟
const adminClients = new Set();
const wss = new WebSocketServer({ port: 3001 });

await redisSub.subscribe(globalChannel());

redisSub.on('message', (channel, message) => {
  if (channel !== globalChannel()) return;

  const { roomId, payload } = JSON.parse(message);
  broadcast(roomId, payload);
});

// 心跳（30 秒）
const HEARTBEAT_INTERVAL = 60000;

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      console.log(`[INFO] terminal websocket connection ws: ${ws}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c.room === room) {
      c.send(msg);
    }
  });
}

async function publishAndBroadcast(roomId, payload) {
  // 发布给所有 Node
  await redis.publish(
    globalChannel(),
    JSON.stringify({ roomId, payload })
  );

  // 同时给当前 Node 的客户端
  broadcast(roomId, payload);
}

async function broadcastRoomUsers(roomId) {
  const users = await getRoomUsers(roomId);

  await publishAndBroadcast(roomId, {
    type: 'room-users',
    users: Object.values(users)
  });
}

function broadcastToAdmins(payload) {
  const msg = JSON.stringify(payload);

  for (const ws of adminClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ===== stream admin ws =====
  if (url.pathname === '/ws/stream') {
    console.log('[WS] stream page connected');
    adminClients.add(ws);

    // ✅ 参与心跳
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    lastStreamAdminActiveAt = Date.now();

    ws.on('close', () => {
      adminClients.delete(ws);

      // 如果这是最后一个 admin 断开
      if (adminClients.size === 0) {
        lastStreamAdminActiveAt = Date.now();
      }
    });

    ws.on('message', async raw => {
      lastStreamAdminActiveAt = Date.now();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }

      if (data.type === 'keepalive') {
        // 什么都不用做，只要让 nginx 看到“有数据”
        return;
      }
    });

    return;
  }

  console.log('[WS] connected');
  // ===== 心跳初始化 =====
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // ===== 解析 room =====
  const roomId = url.searchParams.get('room');
  const username = url.searchParams.get('name');

  if (!roomId || !username) {
    console.log(`[WS] closed by server because of invalid roomId:${roomId} or username:${username}`);
    ws.close();
    return;
  }

  const user = await getOrCreateGlobalUser(username);
  ws.userId = user.userId;
  ws.username = user.username;

  ws.role = (user.systemRole === 'host' || user.systemRole === 'admin')
    ? 'host'
    : 'viewer';

  if (ws.role === 'host') {
    const state = await getRoomState(roomId);
    state.hostCount += 1;
    await setRoomState(roomId, state);
  }

  ws.room = roomId;

  // 记录房间里的用户列表
  const users = await getRoomUsers(roomId);
  users[user.userId] = {
    userId: user.userId,
    username,
    role: ws.role
  };
  await setRoomUsers(roomId, users);

  // ===== 初始化房间 =====
  const state = await getRoomState(roomId);

  ws.send(JSON.stringify({
    type: 'sync',
    state
  }));

  // ===== 接收消息 =====
  ws.on('message', async raw => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const state = await getRoomState(roomId);

    if (data.type === 'sync-request') {
      console.log('[Info] client sync reqeust');
      state.currentTime = getLiveCurrentTime(state);
      ws.send(JSON.stringify({
        type: 'sync',
        state
      }));
    }

    if (data.type === 'keepalive') {
      console.log('receive keepalive message');
      // 什么都不用做，只要让 nginx 看到“有数据”
      return;
    }

    // 非主持人禁止控制
    if (ws.role !== 'host') return;

    if (data.type === 'play') {
      console.log('[INFO] PLAY')
      state.playing = true;
      state.currentTime = data.currentTime;
      state.anchorAt = Date.now();
      await publishAndBroadcast(roomId, { type: 'play', currentTime: state.currentTime });
      await setRoomState(roomId, state);
    }

    if (data.type === 'pause') {
      console.log('[INFO] PAUSE')
      state.playing = false;
      state.currentTime = data.currentTime;
      state.anchorAt = Date.now();
      await publishAndBroadcast(roomId, { type: 'pause', currentTime: state.currentTime });
      await setRoomState(roomId, state);
    }

    if (data.type === 'toggle-live') {
      state.showLive = data.show;
      await publishAndBroadcast(roomId, { type: 'toggle-live', show: state.showLive });
      await setRoomState(roomId, state);
    }

    if (data.type === 'refresh-live') {
      state.refreshAt = Date.now();
      await publishAndBroadcast(roomId, {
        type: 'refresh-live',
        at: state.refreshAt
      });
      await setRoomState(roomId, state);
    }
  });

  // 广播房间里的用户列表信息
  await broadcastRoomUsers(roomId);

  // ===== 断开连接 =====
  ws.on('close', async () => {
    console.log('[WS] closed by server');
    const state = await getRoomState(roomId);
    if (!state) return;

    // 广播房间里的用户列表信息
    const users = await getRoomUsers(roomId);
    delete users[ws.userId];
    if (Object.keys(users).length === 0) {
      await redis.del(roomUsersKey(roomId));
    } else {
      await setRoomUsers(roomId, users);
    }

    await broadcastRoomUsers(roomId);

    if (ws.role === 'host') {
      state.hostCount--;
      if (state.hostCount <= 0) {
        state.showLive = false;
        state.playing = false;

        // 当所有主持人都离开时，自动关闭live界面，如果不需要的话可以注释这一段内容
        await publishAndBroadcast(roomId, {
          type: 'toggle-live',
          show: false
        });

        await setRoomState(roomId, state);
      }
    }

    const stillUsed = [...wss.clients].some(c => c.room === roomId);
    if (!stillUsed) {
      await redis.del(roomKey(roomId));
    }
  });
});

// 进程退出时清理心跳
process.on('SIGTERM', () => clearInterval(heartbeat));
process.on('SIGINT', () => clearInterval(heartbeat));

// ===== FFMPEG 接口 =====

function startFfmpeg(mode, dir, playlistPath, isClientTranscoded) {
  const RTMP_URL = process.env.RTMP_URL;
  if (!RTMP_URL) {
    throw new Error('RTMP_URL not set');
  }

  const STREAM_KEY = 'BO#Dn2bTkCkSDhPgjchO0Dgm#hjd5U'

  const rtmpUrl = `${RTMP_URL}/${STREAM_KEY}`;

  let args;

  if (mode === 'playlist') {
    args = [
      '-nostats',
      '-loglevel', 'info',
      '-stream_loop', ' -1',
      '-re',
      '-f', 'concat',
      '-safe', '0',
      '-i', playlistPath,
      '-c', 'copy',
      '-map', ' 0:v',
      '-map', ' 0:a?',
      '-flush_packets', '0',
      '-avioflags', 'direct',
      '-flvflags', 'no_duration_filesize',
      '-rtmp_live', 'live',
      '-f', 'flv',
      rtmpUrl
    ];
  } else {
    const files = fs.readdirSync(dir).filter(f => f !== 'playlist.txt');
    args = [
      '-nostats',
      '-loglevel', 'info',
      '-stream_loop', '-1',
      '-re',
      '-i', path.join(dir, files[0]),
      '-c', 'copy',
      '-map', ' 0:v',
      '-map', ' 0:a?',
      '-flush_packets', '0',
      '-avioflags', 'direct',
      '-flvflags', 'no_duration_filesize',
      '-rtmp_live', 'live',
      '-f', 'flv',
      rtmpUrl
    ];
  }

  console.log(`[FFMPEG] execute command: ffmpeg ${args.join(' ')}`);
  currentFfmpeg = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  currentStreamSession = dir;

  let finished = false;

  function cleanup() {
    if (finished) return;
    finished = true;

    currentFfmpeg = null;
    currentStreamSession = null;
  }

  currentFfmpeg.stderr.on('data', d => {
    console.log('[ffmpeg]', d.toString());
  });

  currentFfmpeg.stdout.on('data', d => {
    console.log('[ffmpeg:out]', d.toString());
  });

  currentFfmpeg.on('error', async err => {
    if (isStreamStoppingManually) {
      console.log('[FFMPEG] stopped manually (error ignored)');
      return;
    }

    console.error('[FFMPEG ERROR]', err);

    cleanup();

    await mongoDb.collection(STREAM_LOG_TABLE).insertOne({
      action: 'ERROR',
      at: new Date(),
      result: err.message
    });

    broadcastToAdmins({
      type: 'stream-status',
      status: 'error',
      message: '推流失败'
    });
  });

  currentFfmpeg.on('exit', async (code, signal) => {
    const manual = isStreamStoppingManually;
    console.log('[FFMPEG EXIT]', code, signal);

    cleanup();
    cleanupSession(currentStreamSession);

    currentFfmpeg = null;
    currentStreamSession = null;
    isStreamStoppingManually = false;

    await mongoDb.collection(STREAM_LOG_TABLE).insertOne({
      action: 'EXIT',
      at: new Date(),
      result: code === 0 ? 'OK' : 'ERROR',
      code,
      signal
    });

    if (manual) {
      broadcastToAdmins({
        type: 'stream-status',
        status: 'stopped',
      });
    }
    else {
      broadcastToAdmins({
        type: 'stream-status',
        status: code === 0 ? 'stopped' : 'error',
        message:
          code === 0
            ? '推流结束'
            : '推流出错'
      });
    }
  });
}

// ===== JWT 接口 =====
app.get('/api/get-token', async (req, res) => {
  const { room, name } = req.query;

  if (!room || !name) {
    return res.status(400).send('Missing room or name');
  }

  // 获取全局用户
  let user;
  try {
    user = await getOrCreateGlobalUser(name);
  } catch (err) {
    if (err.message === 'USERNAME_NOT_ALLOWED') {
      return res.status(403).json({ error: 'USERNAME_NOT_ALLOWED' });
    }
    if (err.message === 'USERNAME_EMPTY') {
      return res.status(400).json({ error: 'USERNAME_EMPTY' });
    }
    console.error(err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }

  // 是否给 JaaS moderator，只取决于 systemRole
  const moderator = user.systemRole === 'host' || user.systemRole === 'admin';

  const payload = {
    context: {
      user: {
        id: user.userId,
        name: user.username,
        moderator,
      }
    },
    aud: 'jitsi',
    sub: APP_ID,
    iss: 'chat',
    room: '*',
    exp: Math.floor(Date.now() / 1000) + 3600
  };

  const header = {
    kid: `${APP_ID}/${APP_ID_EXTRA}`,
    alg: 'RS256',
    typ: 'JWT'
  };

  const token = jwt.sign(payload, PRIVATE_KEY, {
    algorithm: 'RS256',
    header
  });

  res.send(token);
});

const upload = multer({
  dest: TMP_PATH
});

const cacheUpload = multer({
  dest: TMP_PATH
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
}

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const list = await allowedUsersCol.find({}).toArray();
  res.json(list);
});

app.post('/api/admin/users', requireAdmin, express.json(), async (req, res) => {
  const username = normalizeUsername(req.body.username);

  if (!username) {
    return res.status(400).json({ error: 'USERNAME_EMPTY' });
  }

  try {
    await allowedUsersCol.insertOne({
      username,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ error: 'USERNAME_EXISTS' });
    }
    throw e;
  }

  res.json({ ok: true });
});

app.put('/api/admin/users/:username', requireAdmin, express.json(), async (req, res) => {
  const username = normalizeUsername(req.params.username);
  const enabled = req.body.enabled;

  if (!username) {
    return res.status(400).json({ error: 'USERNAME_EMPTY' });
  }

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'INVALID_ENABLED_VALUE' });
  }

  const result = await allowedUsersCol.updateOne(
    { username },
    {
      $set: {
        enabled,
        updatedAt: new Date()
      }
    }
  );

  if (result.matchedCount === 0) {
    return res.status(404).json({ error: 'USERNAME_NOT_FOUND' });
  }

  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', requireAdmin, async (req, res) => {
  const username = normalizeUsername(req.params.username);

  if (!username) {
    return res.status(400).json({ error: 'USERNAME_EMPTY' });
  }

  const result = await allowedUsersCol.deleteOne({ username });

  if (result.deletedCount === 0) {
    return res.status(404).json({ error: 'USERNAME_NOT_FOUND' });
  }

  res.json({ ok: true });
});

app.post('/api/admin/set-role', express.json(), requireAdmin, async (req, res) => {
  const { username, role } = req.body;

  if (!username || !role) {
    return res.status(400).json({ error: 'MISSING_PARAMS' });
  }

  if (!['user', 'host', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'INVALID_ROLE' });
  }

  // 先确保 username 在白名单
  await assertUsernameAllowed(username);

  const normalized = normalizeUsername(username);
  const userId = globalUserID(normalized);

  const result = await usersCol.updateOne(
    { userId },
    {
      $set: {
        username: normalized,
        systemRole: role,
        updatedAt: new Date()
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    },
    { upsert: true }   // 👈 关键
  );

  res.json({
    ok: true,
    userId,
    role
  });
});

app.get('/api/internal/admin-token', (req, res) => {
  res.json({
    token: ADMIN_TOKEN
  });
});

// 推流相关
app.post(
  '/api/stream/start',
  requireAdmin,
  upload.array('files'),
  async (req, res) => {
    try {
      // ===== 已有推流在进行中 =====
      if (currentFfmpeg) {
        return res.status(409).send('后台正在推流中，请先结束推流后再重试');
      }

      const mode = req.body.mode || 'playlist';

      const files = req.files || [];
      const sessionFiles = [];

      // fingerprints 只对应 uploaded files
      const fingerprints = req.body.fingerprints
        ? (Array.isArray(req.body.fingerprints)
          ? req.body.fingerprints
          : [req.body.fingerprints])
        : [];

      const indexs = req.body.indexs ? (Array.isArray(req.body.indexs) ? req.body.indexs : [req.body.indexs]) : [];

      // existing：前端命中缓存、不再上传的文件
      const existing = req.body.existing
        ? (Array.isArray(req.body.existing)
          ? req.body.existing.map(e => JSON.parse(e))
          : [JSON.parse(req.body.existing)])
        : [];

      const isClientTranscoded = req.body.clientTranscoded === '1';

      const hasUploadedFiles = files.length > 0;
      const hasExistingFiles = existing.length > 0;

      // ===== 合法性校验 =====
      if (!hasUploadedFiles && !hasExistingFiles) {
        return res.status(400).send('NO_FILES');
      }

      if (hasUploadedFiles && (fingerprints.length !== files.length || indexs.length != files.length)) {
        return res.status(400).send('FINGERPRINT_OR_INDEXS_MISMATCH');
      }

      // ===== 创建 session 目录 =====
      const sessionDir = `/data/uploads/session-${Date.now()}`;
      fs.mkdirSync(sessionDir, { recursive: true });

      const orderedFiles = [];

      // =====================================================
      // 1️⃣ 先处理 existing（已缓存文件，不需要 fingerprint）
      // =====================================================
      for (const { filePath, index } of existing) {

        console.log(`filePath: ${filePath}, index: ${index}`);
        if (!fs.existsSync(filePath)) {
          return res.status(400).send('EXISTING_FILE_NOT_FOUND');
        }

        const sessionPath = path.join(sessionDir, path.basename(filePath));

        try {
          fs.linkSync(filePath, sessionPath);
        } catch {
          fs.copyFileSync(filePath, sessionPath);
        }

        orderedFiles.push({
          index: index,
          path: sessionPath
        });
      }

      // =====================================================
      // 2️⃣ 再处理 uploaded files（前端已转码）
      // =====================================================
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const fingerprint = fingerprints[i];
        const index = indexs[i];

        console.log(`[INFO] path:${f}, name: ${f.originalname}, index: ${index}`);
        if (!fingerprint) {
          return res.status(400).send('MISSING_FINGERPRINT');
        }

        if (!f.path) {
          return res.status(400).send('UPLOAD_PATH_MISSING');
        }

        const cachedPath = await getOrCreateCachedFile(fingerprint, f.path, f.originalname);

        const sessionPath = path.join(
          sessionDir,
          path.basename(cachedPath)
        );

        try {
          fs.linkSync(cachedPath, sessionPath);
        } catch {
          fs.copyFileSync(cachedPath, sessionPath);
        }

        orderedFiles.push({
          index: index,
          path: sessionPath
        });
      }

      orderedFiles
        .sort((a, b) => a.index - b.index)
        .forEach(item => sessionFiles.push(item.path));

      // =====================================================
      // 3️⃣ playlist 模式：生成 playlist.txt
      // =====================================================
      let playlistPath = null;

      if (mode === 'playlist') {
        playlistPath = path.join(sessionDir, 'playlist.txt');

        const content = sessionFiles
          .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
          .join('\n');

        fs.writeFileSync(playlistPath, content);
      }

      // =====================================================
      // 4️⃣ 启动 ffmpeg 推流
      // =====================================================
      startFfmpeg(mode, sessionDir, playlistPath, isClientTranscoded);

      // =====================================================
      // 5️⃣ 操作日志（Mongo）
      // =====================================================
      await mongoDb.collection(STREAM_LOG_TABLE).insertOne({
        action: 'START',
        by: 'admin',
        mode,
        uploadedFiles: files.map(f => f.originalname),
        existingFiles: existing,
        at: new Date(),
        result: 'OK'
      });

      res.send('STREAM_STARTED');
    } catch (err) {
      console.error('[STREAM_START_ERROR]', err);

      await mongoDb.collection(STREAM_LOG_TABLE).insertOne({
        action: 'START',
        by: 'admin',
        at: new Date(),
        result: 'ERROR',
        error: err.message
      });

      res.status(500).send('STREAM_START_FAILED');
    }
  }
);

app.post('/api/stream/stop', requireAdmin, async (req, res) => {
  if (!currentFfmpeg) {
    return res.send('当前没有推流');
  }

  if (currentStreamSession) {
    cleanupSession(currentStreamSession);
  }

  currentFfmpeg.kill('SIGTERM');
  isStreamStoppingManually = true;

  await mongoDb.collection(STREAM_LOG_TABLE).insertOne({
    action: 'STOP',
    by: 'admin',
    at: new Date(),
    result: 'OK'
  });

  res.send('stopped');
});

app.post('/api/stream/message', requireAdmin, express.json(), async (req, res) => {
  broadcastToAdmins({
    type: 'stream-status',
    status: 'info',
    message: req.body.message
  });

  res.send('消息已发送');
});

app.put(
  '/api/stream/cache',
  requireAdmin,
  cacheUpload.single('file'),
  async (req, res) => {
    try {
      const file = req.file;
      const fingerprint = req.body.fingerprint;

      // return res.status(400).send('Failed');

      if (!file || !fingerprint) {
        return res.status(400).send('MISSING_FILE_OR_FINGERPRINT');
      }

      const existed = await mongoDb
        .collection(TRANSCODED_VIDEO_TABLE)
        .findOne({ fingerprint });

      if (existed && fs.existsSync(existed.path)) {
        return res.json({
          ok: true,
          existed: true,
          path: existed.path
        });
      }

      // 复用你已有的缓存逻辑
      const cachedPath = await getOrCreateCachedFile(
        fingerprint,
        file.path,
        file.originalname
      );

      await mongoDb.collection(STREAM_LOG_TABLE).insertOne({
        action: 'CACHE_UPLOAD',
        fingerprint,
        file: file.originalname,
        path: cachedPath,
        at: new Date()
      });

      res.json({
        ok: true,
        path: cachedPath
      });
    } catch (err) {
      console.error('[CACHE_UPLOAD_ERROR]', err);
      res.status(500).send('CACHE_UPLOAD_FAILED');
    }
  }
);

app.post(
  '/api/stream/cache/delete',
  requireAdmin,
  express.json(),
  async (req, res) => {
    try {
      const { fingerprint } = req.body;

      if (!fingerprint || typeof fingerprint !== 'string') {
        return res.status(400).json({
          error: 'MISSING_OR_INVALID_FINGERPRINT'
        });
      }

      // 1️⃣ 查找 Mongo 记录
      const record = await mongoDb
        .collection(TRANSCODED_VIDEO_TABLE)
        .findOne({ fingerprint });

      if (!record) {
        return res.status(404).json({
          error: 'CACHE_RECORD_NOT_FOUND'
        });
      }

      const filePath = record.path;

      // 2️⃣ 删除文件（如果存在）
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.error('[CACHE_DELETE] Failed to delete file:', filePath, e);
          return res.status(500).json({
            error: 'FAILED_TO_DELETE_FILE'
          });
        }
      }

      // 3️⃣ 删除 Mongo 记录
      await mongoDb
        .collection('transcoded_videos')
        .deleteOne({ fingerprint });

      // 4️⃣ 记录操作日志（可选但推荐）
      await mongoDb.collection(STREAM_LOG_TABLE).insertOne({
        action: 'CACHE_DELETE',
        fingerprint,
        filePath,
        at: new Date(),
        result: 'OK'
      });

      res.json({
        ok: true,
        fingerprint
      });
    } catch (err) {
      console.error('[CACHE_DELETE_ERROR]', err);

      await mongoDb.collection(STREAM_LOG_TABLE).insertOne({
        action: 'CACHE_DELETE',
        at: new Date(),
        result: 'ERROR',
        error: err.message
      });

      res.status(500).json({
        error: 'INTERNAL_ERROR'
      });
    }
  }
);

app.post(
  '/api/admin/cleanup-transcode',
  requireAdmin,
  async (req, res) => {
    try {
      console.warn('[ADMIN] cleanup-transcode triggered');

      // =====  如果正在推流 则返回失败 =====
      if (currentFfmpeg) {
        return res.status(400).json({ error: 'Cannot cleanup while streaming' });
      }

      // ===== 2️⃣ 清空磁盘 =====
      emptyDir(CACHE_DIR);                // cached/*
      // emptyDir(TMP_DIR):
      
      // session-* 目录
      if (fs.existsSync(UPLOAD_ROOT)) {
        const dirs = fs.readdirSync(UPLOAD_ROOT);
        for (const name of dirs) {
          if (name.startsWith('session-')) {
            const fullPath = path.join(UPLOAD_ROOT, name);
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        }
      }

      // ===== 3️⃣ 清空 Mongo =====
      const result = await mongoDb
        .collection('transcoded_videos')
        .deleteMany({});

      // ===== 4️⃣ 记录日志 =====
      await mongoDb.collection('stream_logs').insertOne({
        action: 'CLEANUP_TRANSCODE',
        by: 'admin',
        removedCachedFiles: true,
        // removedTmpFiles: true,
        removedSessions: true,
        removedMongoCount: result.deletedCount,
        at: new Date()
      });

      res.json({
        ok: true,
        deletedMongoRecords: result.deletedCount
      });
    } catch (err) {
      console.error('[CLEANUP_TRANSCODE_ERROR]', err);

      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post('/api/stream/check', requireAdmin, express.json(), async (req, res) => {
  const { fingerprint } = req.body;
  if (!fingerprint) {
    return res.status(400).json({ error: 'MISSING_FINGERPRINT' });
  }

  const record = await mongoDb
    .collection(TRANSCODED_VIDEO_TABLE)
    .findOne({ fingerprint });

  if (!record) {
    return res.json({ exists: false });
  }

  res.json({
    exists: true,
    path: record.path
  });
});

setInterval(() => {
  const now = Date.now();

  fs.readdir(CACHE_DIR, (err, files) => {
    if (err) return;

    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);

      try {
        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;

        if (age > CACHE_TTL_MS) {
          fs.unlinkSync(filePath);
          console.log('[CACHE] removed:', file);
        }
      } catch { }
    }
  });
}, 6 * 60 * 60 * 1000); // 每 6 小时跑一次

const HTTP_PORT = process.env.HTTP_PORT || 8081;
app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP server running on port ${HTTP_PORT}`);
});

setInterval(async () => {
  // 没在推流，不关心
  if (!currentFfmpeg) return;

  // 还存在 admin 连接，不关心
  if (adminClients.size > 0) return;

  // 从来没有 admin 连接过（例如重启后）
  if (!lastStreamAdminActiveAt) return;

  const idleMs = Date.now() - lastStreamAdminActiveAt;

  if (idleMs < STREAM_ADMIN_IDLE_LIMIT_MS) return;

  console.warn('[WATCHDOG] No stream admin for 30 minutes, stopping stream');

  // 👇 标记为“系统自动停止”
  isStreamStoppingManually = true;

  currentFfmpeg.kill('SIGTERM');

  await mongoDb.collection(STREAM_LOG_TABLE).insertOne({
    action: 'AUTO_STOP',
    reason: 'NO_STREAM_ADMIN_30_MIN',
    by: 'Server',
    at: new Date()
  });

}, 60 * 1000); // 每 1 分钟检查一次
