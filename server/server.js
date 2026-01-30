import express from 'express';
import cors from 'cors';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import crypto from 'crypto';
import { MongoClient } from 'mongodb';
import path from 'path';

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
app.use(express.static('../public'));

// ===== JaaS 配置 =====
const APP_ID = 'vpaas-magic-cookie-7aa44c342e744b7386a1563d686a04bf';
const APP_ID_EXTRA = '29e98e'
const PRIVATE_KEY = fs.readFileSync('./fellowship.pk', 'utf8').trim();

// ===== WebSocket Server =====
const wss = new WebSocketServer({ port: 3001 });

await redisSub.subscribe(globalChannel());

redisSub.on('message', (channel, message) => {
  if (channel !== globalChannel()) return;

  const { roomId, payload } = JSON.parse(message);
  broadcast(roomId, payload);
});

// 心跳（30 秒）
const HEARTBEAT_INTERVAL = 30000;

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
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

wss.on('connection', async (ws, req) => {
  console.log('[WS] connected');
  // ===== 心跳初始化 =====
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // ===== 解析 room =====
  const url = new URL(req.url, `http://${req.headers.host}`);
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
  const enabled = !!req.body.enabled;

  await allowedUsersCol.updateOne(
    { username },
    {
      $set: {
        enabled,
        updatedAt: new Date()
      }
    }
  );

  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', requireAdmin, async (req, res) => {
  const username = normalizeUsername(req.params.username);
  await allowedUsersCol.deleteOne({ username });
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

const HTTP_PORT = process.env.HTTP_PORT || 8081;
app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running on port ${HTTP_PORT}`);
});