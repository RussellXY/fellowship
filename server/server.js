import express from 'express';
import cors from 'cors';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';

const ROOM_TTL_SECONDS = 60 * 60 * 2; // 1 小时

// ===== Redis =====
const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: 6379
});

// ===== Redis Pub/Sub =====
const redisSub = redis.duplicate();

function globalChannel() {
  return 'fellowship:room:broadcast';
}

function roomKey(roomId) {
  return `fellowship:room:${roomId}`;
}

function roomChannel(roomId) {
  return `fellowship:room:channel:${roomId}`;
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

function isHostAllowed(req, room) {
  // 示例策略（你可以随时替换）
  // 1. 本地环境：允许
  if (process.env.NODE_ENV !== 'production') return true;

  // 2. 生产环境：必须带一个 server-only key
  return req.headers['x-fellowship-host-key'] === process.env.HOST_KEY;
}

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

wss.on('connection', async (ws, req) => {
  console.log('[WS] connected');
  // ===== 心跳初始化 =====
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // ===== 解析 room =====
  const params = new URLSearchParams(req.url.replace('/?', ''));
  const roomId = params.get('room');

  if (!roomId) {
    ws.close();
    return;
  }

  ws.room = roomId;
  ws.role = 'viewer';

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

    // 主持人升级
    if (data.type === 'upgrade-role') {
      if (ws.role !== 'host') {
        ws.role = 'host';
        const state = await getRoomState(roomId);
        state.hostCount += 1;
        await setRoomState(roomId, state);
      }
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

  // ===== 断开连接 =====
  ws.on('close', async () => {
    console.log('[WS] closed by server');
    const state = await getRoomState(roomId);
    if (!state) return;

    if (ws.role === 'host') {
      state.hostCount--;
      if (state.hostCount <= 0) {
        state.showLive = false;
        state.playing = false;

        await publishAndBroadcast(roomId, {
          type: 'toggle-live',
          show: false
        });
        await setRoomState(roomId, state);
      }

      const stillUsed = [...wss.clients].some(c => c.room === roomId);
      if (!stillUsed) {
        await redis.del(roomKey(roomId));
      }
    }
  });
});

// 进程退出时清理心跳
process.on('SIGTERM', () => clearInterval(heartbeat));
process.on('SIGINT', () => clearInterval(heartbeat));

// ===== JWT 接口 =====
app.get('/api/get-token', (req, res) => {
  const { room, name } = req.query;

  const moderator = isHostAllowed(req, room);
  const payload = {
    context: {
      user: {
        id: name,
        name,
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

const HTTP_PORT = process.env.HTTP_PORT || 8081;
app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running on port ${HTTP_PORT}`);
});