window.addEventListener('DOMContentLoaded', async () => {

  let hasJoinedMeeting = false;
  let pendingShowLive = null;

  const APP_ID = "vpaas-magic-cookie-20556988122d40bb94a9dfa6fd4437c7"
  const ROOM_NAME = "Fellowship";
  const USER_NAME = getUserName();;

  let allowLocalControl = false;

  const meeting = document.getElementById("meeting");
  const live = document.getElementById("live");
  const video = document.getElementById("player");
  const toggleBtn = document.getElementById("toggle-live");
  const refreshBtn = document.getElementById('refreshBtn');

  // ===== 1. 获取 token =====
  const tokenRes = await fetch(`/api/get-token?room=${ROOM_NAME}&name=${USER_NAME}`);
  const token = await tokenRes.text();

  // ===== 2. 初始化 Jitsi =====
  const api = new JitsiMeetExternalAPI("8x8.vc", {
    roomName: `${APP_ID}/${ROOM_NAME}`,
    parentNode: meeting,
    jwt: token,
    configOverwrite: { prejoinPageEnabled: false },
    lang: "cn"
  });

  // ===== 3. WebSocket =====
  let ws;
  let wsRetry = 0;

  function connectWS() {
    const delay = Math.min(1000 * 2 ** wsRetry, 10000);

    ws = new WebSocket(
      `ws://${window.location.hostname}:3001?room=${encodeURIComponent(ROOM_NAME)}`
    );

    ws.onopen = () => {
      console.log('[WS] connected');
      wsRetry = 0;
      ws.send(JSON.stringify({ type: 'sync-request' }));
    };

    ws.onmessage = e => {
      const data = JSON.parse(e.data);
      handleWSMessage(data);
    };

    ws.onclose = () => {
      console.warn('[WS] disconnected, retry in', delay);
      wsRetry++;
      setTimeout(connectWS, delay);
    };

    ws.onerror = () => {
      ws.close(); // 统一走 onclose
    };
  }

  connectWS();

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

  let lastRefreshAt = 0;

  function handleWSMessage(data) {
    if (data.type === 'play') {
      video.currentTime = data.currentTime;
      video.play();
    }

    if (data.type === 'pause') {
      video.currentTime = data.currentTime;
      video.pause();
    }

    if (data.type === 'toggle-live') {
      pendingShowLive = data.show;
      // 只有进入会议，才立即应用
      if (hasJoinedMeeting) {
        toggleLive(data.show);
      }
    }

    if (data.type === 'refresh-live') {
      if (data.at && data.at <= lastRefreshAt) return;
      lastRefreshAt = data.at;
      refreshLiveStream();
    }

    if (data.type === 'sync') {
      video.currentTime = data.state.currentTime;
      data.state.playing ? video.play() : video.pause();
      pendingShowLive = data.state.showLive;

      if (hasJoinedMeeting && typeof data.state.showLive === 'boolean') {
        toggleLive(data.state.showLive);
      }

      if (
        data.state.refreshAt &&
        data.state.refreshAt > lastRefreshAt
      ) {
        lastRefreshAt = data.state.refreshAt;
        refreshLiveStream();
      }
    }
  }

  ws.onmessage = e => {
    const data = JSON.parse(e.data);
    handleWSMessage(data);
  };

  // ===== 4. HLS 播放 =====
  const liveUrl = "http://ec2-13-124-131-156.ap-northeast-2.compute.amazonaws.com:8080/hls/stream.m3u8";
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
    if (e.role === 'moderator') {
      IS_HOST = true;
      allowLocalControl = true;

      // ===== UI 解锁 =====
      toggleBtn.style.display = "flex";
      refreshBtn.style.display = "inline-block";

      playBtn.style.display = "inline-block";
      pauseBtn.style.display = "inline-block";
      rewindBtn.style.display = "inline-block";
      forwardBtn.style.display = "inline-block";
      fullscreenBtn.style.display = "inline-block";

      video.controls = true;

      // ===== 告诉 WebSocket：我是主持人 =====
      ws.send(JSON.stringify({ type: 'upgrade-role' }));

      // ===== 播放 =====
      playBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'play',
            currentTime: video.currentTime
          }));
        }
      };

      // ===== 暂停 =====
      pauseBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'pause',
            currentTime: video.currentTime
          }));
        }
      };

      // ===== 快退 10 秒 =====
      rewindBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          const t = Math.max(video.currentTime - 10, 0);
          ws.send(JSON.stringify({
            type: 'pause',
            currentTime: t
          }));
        }
      };

      // ===== 快进 10 秒 =====
      forwardBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          const t = video.currentTime + 10;
          ws.send(JSON.stringify({
            type: 'pause',
            currentTime: t
          }));
        }
      };

      // ===== 直播全屏 =====
      fullscreenBtn.onclick = () => {
        if (video.requestFullscreen) {
          video.requestFullscreen();
        }
      };

      // ===== 刷新直播（HLS） =====
      refreshBtn.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'refresh-live' }));
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
  api.addEventListener('readyToClose', () => {
    // 回到 Jitsi 官方 Prejoin 页面
    console.log('[JITSI] conference left');
    window.location.reload();
  });

  // ===== 6. toggle 按钮 =====
  toggleBtn.addEventListener("click", () => {
    const show = !live.classList.contains("show");
    ws.send(JSON.stringify({ type: "toggle-live", show }));
  });

  function getUserName() {
    let name = localStorage.getItem("fellowship_username");

    if (!name) {
      name = prompt("请输入你的名字") || "Guest";
      localStorage.setItem("fellowship_username", name);
    }

    return name;
  }

  function toggleLive(show) {
    const liveWidth = 70;

    if (show) {
      meeting.style.width = `${100 - liveWidth}%`;
      live.classList.add("show");
      toggleBtn.textContent = "❌";
    } else {
      meeting.style.width = "100%";
      live.classList.remove("show");
      toggleBtn.textContent = "🎬";
    }
  }

  // ===== 7. 普通参会者禁止操作 =====
  ['play', 'pause', 'seeking'].forEach(evt => {
    video.addEventListener(evt, () => {
      if (!allowLocalControl) {
        ws.send(JSON.stringify({ type: 'sync-request' }));
      }
    });
  });
});