import express from 'express';
import cors from 'cors';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import crypto from 'crypto';

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
  const userId = globalUserID(username);
  const raw = await redis.get(userId);

  if (raw) {
    return JSON.parse(raw);
  }

  const user = {
    userId: userId,
    username,
    systemRole: 'user' // 默认不是主持人
  };

  await redis.set(userId, JSON.stringify(user));
  return user;
}

const app = express();
app.use(cors());
app.use(express.static('../public'));

// ===== JaaS 配置 =====
const APP_ID = 'vpaas-magic-cookie-20556988122d40bb94a9dfa6fd4437c7';
const PRIVATE_KEY = fs.readFileSync('./fellowship.pk', 'utf8').trim();

// ===== WebSocket 全局状态 =====
let liveState = {
  playing: false,
  currentTime: 0,
  showLive: false,
  refreshAt: 0 // 时间戳，用来区分是否需要刷新
};

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

    // 非主持人禁止控制
    if (ws.role !== 'host') return;

    const state = await getRoomState(roomId);

    if (data.type === 'play') {
      state.playing = true;
      state.currentTime = data.currentTime;
      await publishAndBroadcast(roomId, { type: 'play', currentTime: state.currentTime });
      await setRoomState(roomId, state);
    }

    if (data.type === 'pause') {
      state.playing = false;
      state.currentTime = data.currentTime;
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
  const user = await getOrCreateGlobalUser(name);

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
    kid: `${APP_ID}/f6bce1`,
    alg: 'RS256',
    typ: 'JWT'
  };

  const token = jwt.sign(payload, PRIVATE_KEY, {
    algorithm: 'RS256',
    header
  });

  res.send(token);
});

app.post('/api/admin/set-role', express.json(), async (req, res) => {
  const { username, role } = req.body;

  if (!username || !role) {
    return res.status(400).send('Missing username');
  }

  if (!['user', 'host', 'admin'].includes(role)) {
    return res.status(400).send('Invalid role, must be one of "user", "host", "admin"');
  }

  const user = await getOrCreateGlobalUser(username);
  user.systemRole = role;

  await redis.set(user.userId, JSON.stringify(user));

  res.send({ ok: true, user });
});

const HTTP_PORT = process.env.HTTP_PORT || 8081;
app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running on port ${HTTP_PORT}`);
});