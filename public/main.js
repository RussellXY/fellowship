window.addEventListener('DOMContentLoaded', async () => {

  let hasJoinedMeeting = false;
  let pendingShowLive = null;

  const APP_ID = "vpaas-magic-cookie-7aa44c342e744b7386a1563d686a04bf"
  const ROOM_NAME = "Fellowship";
  const USER_NAME = await getUserName();;

  let allowLocalControl = false;

  const meeting = document.getElementById("meeting");
  const live = document.getElementById("live");
  const video = document.getElementById("player");
  const toggleBtn = document.getElementById("toggle-live");
  const refreshBtn = document.getElementById('refreshBtn');

  const controls = document.getElementById('controls');

  video.controls = true;

  // ===== 1. 获取 token =====
  const tokenRes = await fetch(`/api/get-token?room=${ROOM_NAME}&name=${USER_NAME}`);
  const token = await tokenRes.text();

  // ===== 2. 初始化 Jitsi =====
  const api = new JitsiMeetExternalAPI("8x8.vc", {
    roomName: `${APP_ID}/${ROOM_NAME}`,
    parentNode: meeting,
    jwt: token,
    configOverwrite: { prejoinPageEnabled: false },
    lang: "zh",
    configOverwrite: {
      prejoinPageEnabled: false,
      disableDeepLinking: true,
      startWithAudioMuted: true,
      startWithVideoMuted: true
    }
  });

  // ===== 3. WebSocket =====
  let wsRetry = 0;
  let ws = null;
  let wsConnecting = false;
  let wsRetryTimer = null;
  let retryDelay = 1000;

  function connectWS() {
    if (ws && (ws.readyState === WebSocket.OPEN || wsConnecting)) {
      return;
    }

    retryDelay = Math.min(1000 * 2 ** wsRetry, 10000);
    wsConnecting = true;

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${location.host}/ws/?room=${encodeURIComponent(ROOM_NAME)}&name=${encodeURIComponent(USER_NAME)}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS] connected');
      wsConnecting = false;
      wsRetry = 0;
    };

    ws.onmessage = e => {
      handleWSMessage(JSON.parse(e.data));
    };

    ws.onclose = () => {
      wsConnecting = false;
      console.warn('[WS] disconnected, retry in', retryDelay);
      wsRetry++;
      clearTimeout(wsRetryTimer);
      wsRetryTimer = setTimeout(connectWS, retryDelay);
    };

    ws.onerror = e => {
      console.warn(`[WS] error:${e}`);
    };
  }

  function refreshLiveStream() {
    console.log('[LIVE] refreshing stream');

    if (hls) {
      hls.stopLoad();
      hls.destroy();
      hls = null;
    }

    if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(liveUrl);
      hls.attachMedia(video);
    } else {
      video.src = liveUrl;
      video.load();
    }
  }

  connectWS();

  let lastRefreshAt = 0;

  function handleWSMessage(data) {
    // ===== 播放 =====
    if (data.type === 'play') {
      suppressLocalEvent = true;
      video.currentTime = data.currentTime;

      video.play().catch(() => { });

      setTimeout(() => {
        suppressLocalEvent = false;
      }, 0);
    }

    // ===== 暂停 =====
    if (data.type === 'pause') {
      suppressLocalEvent = true;
      video.currentTime = data.currentTime;
      video.pause();

      setTimeout(() => {
        suppressLocalEvent = false;
      }, 0);
    }

    // ===== 显示 / 隐藏 live =====
    if (data.type === 'toggle-live') {
      pendingShowLive = data.show;

      if (hasJoinedMeeting) {
        toggleLive(data.show);
      }
    }

    // ===== 刷新直播 =====
    if (data.type === 'refresh-live') {
      if (data.at && data.at <= lastRefreshAt) return;

      lastRefreshAt = data.at;
      refreshLiveStream();
    }

    // ===== 全量同步（late join / reconnect）=====
    if (data.type === 'sync') {
      suppressLocalEvent = true;

      // 时间 & 播放状态
      video.currentTime = data.state.currentTime;

      if (data.state.playing) {
        video.play().catch(() => { });
      } else {
        video.pause();
      }

      // live 显示状态
      pendingShowLive = data.state.showLive;
      if (hasJoinedMeeting && typeof data.state.showLive === 'boolean') {
        toggleLive(data.state.showLive);
      }

      // HLS 刷新
      if (
        data.state.refreshAt &&
        data.state.refreshAt > lastRefreshAt
      ) {
        lastRefreshAt = data.state.refreshAt;
        refreshLiveStream();
      }

      setTimeout(() => {
        suppressLocalEvent = false;
      }, 0);
    }
  }

  // ===== 4. HLS 播放 =====
  const liveUrl = '/live/hls/stream.m3u8';
  let hls;

  if (Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(liveUrl);
    hls.attachMedia(video);
  } else {
    video.src = liveUrl;
  }

  // ===== 5. 主持人识别 =====
  api.addEventListener('participantRoleChanged', e => {
    console.log('Participant role changed: ', e);
    if (e.role === 'moderator') {
      allowLocalControl = true;

      // 显示主持人控制区
      controls.classList.remove('hidden');

      // ===== UI 解锁 =====
      toggleBtn.style.display = "flex";

      // ===== 播放 =====
      playBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          wsSend({ type: 'play', currentTime: video.currentTime });
        }
      };

      // ===== 暂停 =====
      pauseBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          wsSend({ type: 'pause', currentTime: video.currentTime });
        }
      };

      // ===== 快退 10 秒 =====
      rewindBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          const t = Math.max(video.currentTime - 10, 0);
          wsSend({ type: 'pause', currentTime: t });
        }
      };

      // ===== 快进 10 秒 =====
      forwardBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          const t = video.currentTime + 10;
          wsSend({ type: 'pause', currentTime: t });
        }
      };

      // ===== 刷新直播（HLS） =====
      refreshBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          wsSend({ type: 'refresh-live' });
        }
      };
    }
  });

  api.addEventListener('videoConferenceJoined', () => {
    console.log('[JITSI] conference joined');
    hasJoinedMeeting = true;

    // 🔥 如果服务器当前是 showLive=true，补一次显示
    if (pendingShowLive === true) {
      toggleLive(true);
    }
  });

  // ===== 5. 处理用户leave meet时回到主页面 =====
  let pageReloading = false;
  api.addEventListener('readyToClose', () => {
    if (pageReloading) return;
    pageReloading = true;
    window.location.reload();
  });

  // ===== 6. toggle 按钮 =====
  toggleBtn.addEventListener("click", () => {
    // translate-y-full = live hidden (single source of truth)
    const isHidden = live.classList.contains('translate-y-full');
    wsSend({
      type: 'toggle-live',
      show: isHidden
    });
  });

  function validateUsername(username) {
    if (!username) {
      return '用户名不能为空';
    }

    if (!/^[A-Za-z]+$/.test(username)) {
      return '用户名只能包含英文字母（A-Z / a-z）';
    }

    return null; // 合法
  }

  async function getUserName() {
    while (true) {
      let name = localStorage.getItem('fellowship_username');

      if (!name) {
        name = prompt('请输入你的用户名（仅限英文字母）');
      }

      if (!name) {
        alert('用户名不能为空');
        continue;
      }

      name = name.trim();

      // ① 前端格式校验
      const err = validateUsername(name);
      if (err) {
        alert(err);
        localStorage.removeItem('fellowship_username');
        continue;
      }

      // ② 请求后端验证（不真正进会，只验证）
      const ok = await verifyUsernameWithServer(name);
      if (!ok) {
        localStorage.removeItem('fellowship_username');
        continue;
      }

      // ③ 一切通过，保存
      localStorage.setItem('fellowship_username', name);
      return name;
    }
  }

  async function verifyUsernameWithServer(username) {
    try {
      showLoading('正在验证用户名…');

      const res = await fetch(
        `/api/get-token?room=test&name=${encodeURIComponent(username)}`
      );

      hideLoading();

      if (res.ok) {
        return true;
      }

      const data = await res.json().catch(() => ({}));

      if (data.error === 'USERNAME_NOT_ALLOWED') {
        alert('❌ 用户名未注册，请联系管理员');
        return false;
      }

      if (data.error === 'USERNAME_EMPTY') {
        alert('❌ 用户名不能为空');
        return false;
      }

      alert('服务器错误，请稍后再试');
      return false;
    } catch (e) {
      hideLoading();
      alert('无法连接服务器，请检查网络');
      return false;
    }
  }

  function wsSend(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[WS] send skipped, ws not open');
      return;
    }
    ws.send(JSON.stringify(payload));
  }

  function toggleLive(show) {
    if (show) {
      showLiveTailwind();
    } else {
      hideLiveTailwind();
    }
  }

  function showLoading(text = '正在处理，请稍候…') {
    const el = document.getElementById('global-loading');
    if (!el) return;

    const msg = el.querySelector('div > div');
    if (msg) msg.textContent = `⏳ ${text}`;

    el.style.display = 'flex';
  }

  function hideLoading() {
    const el = document.getElementById('global-loading');
    if (!el) return;

    el.style.display = 'none';
  }

  // ===== 7. 普通参会者禁止操作 =====
  let suppressLocalEvent = false;

  video.addEventListener('play', () => {
    if (suppressLocalEvent) return;

    if (!allowLocalControl) {
      wsSend({ type: 'sync-request' });
      return;
    }

    // 主持人 + 用户手势
    wsSend({
      type: 'play',
      currentTime: video.currentTime
    });
  });

  video.addEventListener('pause', () => {
    if (!allowLocalControl || suppressLocalEvent) return
    
    wsSend({
          type: 'pause',
          currentTime: video.currentTime
        });
  });

  video.addEventListener('seeking', () => {
    if (!allowLocalControl || suppressLocalEvent) return;

    wsSend({
      type: 'pause',
      currentTime: video.currentTime
    });
  });

  function showLiveTailwind() {
    // 竖屏：Y 轴 modal
    live.classList.remove('translate-y-full');

    // 横屏 / 桌面：X 轴 slide
    live.classList.remove('md:translate-x-full');

    toggleBtn.textContent = '❌';
  }

  function hideLiveTailwind() {
    // 竖屏
    live.classList.add('translate-y-full');

    // 横屏 / 桌面
    live.classList.add('md:translate-x-full');

    toggleBtn.textContent = '🎬';
  }
});