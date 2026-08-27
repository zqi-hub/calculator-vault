/* chat.js — 点对点端到端加密聊天（WebRTC DataChannel + ECDH + AES-GCM），阅后即焚
   配对方式（二选一，安全模型一致）：
   ① 助记词邀请码（默认）：5 个英文单词。单词经 PBKDF2 派生出信令加密密钥与中转主题，
      SDP/ECDH 公钥用 AES-GCM 加密后经由公共中转（ntfy.sh）投递——中转方无法读取或伪造；
      聊天密钥仍由 ECDH 独立协商，与邀请码无关。
   ② 手动连接码（备用）：完整 SDP+公钥经任意渠道人工复制粘贴，不依赖任何网络服务。 */
const Chat = (() => {
  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const NTFY_BASE = 'https://ntfy.sh';
  const WORD_COUNT = 5;

  let pc = null;          // RTCPeerConnection
  let dc = null;          // RTCDataChannel
  let aesKey = null;      // 聊天用 AES-GCM 密钥（ECDH 协商）
  let signal = null;      // { chanKey, topic, done } 助记词配对会话状态
  let sockets = [];       // 信令 WebSocket 列表
  let manualClose = false;     // 用户主动关闭（区分意外中断，避免误报）
  let connLostNotified = false; // 本次连接是否已提示过中断（防止 failed/closed/onclose 重复提示）
  const burnTimers = new Map();

  const $ = (id) => document.getElementById(id);
  const setupEl = $('chat-setup');
  const roomEl = $('chat-room');
  const statusEl = $('chat-status');
  const msgsEl = $('chat-messages');
  const wordsEl = $('invite-words');
  const peerStateEl = $('chat-peer-state');

  /* ---------- 顶部连接状态指示灯 ----------
     st-connecting 蓝色呼吸（连接中） / st-ok 绿色常亮（已连接）
     st-warn 橙色呼吸（不稳定/恢复中） / st-err 红色常亮（断开） */
  function setPeerState(cls, text) {
    if (!peerStateEl) return;
    peerStateEl.className = 'peer-state ' + cls;
    peerStateEl.innerHTML = '<i class="lamp"></i>' + text;
  }

  /* ---------- 编码工具 ---------- */
  const te = new TextEncoder();
  const td = new TextDecoder();
  const b64encode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const b64decode = (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;
  const packCode = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  const unpackCode = (str) => JSON.parse(decodeURIComponent(escape(atob(str.trim()))));

  /* ---------- ECDH / 聊天消息加解密（两种配对方式共用） ---------- */
  async function genECDH() {
    return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  }
  async function exportPub(key) {
    return b64encode(await crypto.subtle.exportKey('raw', key.publicKey));
  }
  async function deriveAES(myPriv, peerPubB64) {
    const peerPub = await crypto.subtle.importKey(
      'raw', b64decode(peerPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPub }, myPriv,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptWith(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text));
    return b64encode(iv) + '.' + b64encode(ct);
  }
  async function decryptWith(key, payload) {
    const [ivB64, ctB64] = payload.split('.');
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(b64decode(ivB64)) }, key, b64decode(ctB64));
    return td.decode(pt);
  }

  /* ---------- 二进制加解密（图片/视频分片用，端到端 AES-GCM） ---------- */
  // 与 encryptWith 不同：这里直接加密原始字节，返回 "iv+密文" 合并后的 base64
  async function encryptBytes(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const merged = new Uint8Array(iv.length + ct.length);
    merged.set(iv, 0);
    merged.set(ct, iv.length);
    return b64encode(merged.buffer);
  }
  async function decryptBytes(key, b64) {
    const merged = new Uint8Array(b64decode(b64));
    const iv = merged.subarray(0, 12);
    const ct = merged.subarray(12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
  }

  /* ---------- 助记词 → 信令通道参数 ---------- */
  function randomWords(n) {
    const rnd = crypto.getRandomValues(new Uint32Array(n));
    return Array.from(rnd, v => WORDS[v % WORDS.length]);
  }
  function normalizeWords(str) {
    return str.trim().toLowerCase().replace(/\s+/g, ' ');
  }
  async function channelParams(phrase) {
    const keyMat = await crypto.subtle.importKey('raw', te.encode(phrase), 'PBKDF2', false, ['deriveKey']);
    const chanKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: te.encode('calcvault/sig/v1'), iterations: 60000, hash: 'SHA-256' },
      keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const topicHash = await crypto.subtle.digest('SHA-256', te.encode('calcvault/topic/v1:' + phrase));
    const topic = 'cv-' + Array.from(new Uint8Array(topicHash))
      .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
    return { chanKey, topic };
  }
  async function seal(obj) {   // 用信令密钥加密后投递
    return encryptWith(signal.chanKey, JSON.stringify(obj));
  }
  async function unseal(cipher) {  // 解密失败（单词不符/无关消息）返回 null
    try { return JSON.parse(await decryptWith(signal.chanKey, cipher)); }
    catch (e) { return null; }
  }

  /* ---------- 公共中转传输（仅承载密文） ---------- */
  async function sigPublish(text) {
    await fetch(`${NTFY_BASE}/${signal.topic}`, { method: 'POST', body: text });
  }
  function sigSubscribe(onMsg) {
    const ws = new WebSocket(`wss://ntfy.sh/${signal.topic}/ws`);
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.event === 'message') onMsg(d.message);
      } catch (err) { /* 忽略非 JSON 帧 */ }
    };
    sockets.push(ws);
  }
  async function sigPoll(onMsg) {  // 拉取缓存消息，防止订阅前漏收
    try {
      const r = await fetch(`${NTFY_BASE}/${signal.topic}/json?poll=1&since=all`);
      const txt = await r.text();
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.event === 'message') onMsg(d.message);
        } catch (err) { /* skip */ }
      }
    } catch (err) { /* 网络异常时仅靠 WebSocket */ }
  }
  function closeSigSockets() {
    sockets.forEach(ws => { try { ws.close(); } catch (e) {} });
    sockets = [];
  }

  /* ---------- 等待 ICE 收集完成 ---------- */
  function waitIceComplete() {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve();
      });
    });
  }

  function newPeer() {
    manualClose = true;    // 让旧连接的 close 回调静默，不误报中断
    teardownPeerOnly();
    manualClose = false;
    connLostNotified = false;
    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'connected') {
        setStatus('已连接', true);
        setPeerState('st-ok', '已连接 · 端到端加密');
        if (connLostNotified) addSystemNote('网络波动后连接已恢复');
        connLostNotified = false;
      } else if (st === 'disconnected') {
        // 网络抖动可能是暂时的，先提示不稳定；传输层未断，不终止任务
        setStatus('连接不稳定，正在尝试恢复…', false);
        setPeerState('st-warn', '连接不稳定，恢复中…');
      } else if (st === 'failed') {
        if (!manualClose) handleUnexpectedDisconnect('连接意外中断：对方可能已离线或网络异常');
      } else if (st === 'closed') {
        if (!manualClose) handleUnexpectedDisconnect('连接已关闭');
      }
    };
  }

  function bindChannel(channel) {
    dc = channel;
    dc.onopen = () => {
      setupEl.classList.add('hidden');
      roomEl.classList.remove('hidden');
      setPeerState('st-ok', '已建立加密通道');
      addSystemNote('加密通道已建立，可以开始聊天');
      closeSigSockets();   // 握手完成后不再需要信令通道
      signal = null;
    };
    dc.onclose = () => {
      // 用户主动关闭（teardown）时静默；意外断开时提示并清理传输
      if (!manualClose) handleUnexpectedDisconnect('连接已中断，双方无法再收发消息');
    };
    dc.onmessage = async (e) => {
      const data = e.data;
      // 文件分片帧：F|<id>|<seq>|<base64密文>
      if (typeof data === 'string' && data[0] === 'F' && data[1] === '|') {
        const p1 = data.indexOf('|');
        const p2 = data.indexOf('|', p1 + 1);
        const p3 = data.indexOf('|', p2 + 1);
        const fid = data.slice(p1 + 1, p2);
        const seq = parseInt(data.slice(p2 + 1, p3), 10);
        const b64 = data.slice(p3 + 1);
        try { const bytes = await decryptBytes(aesKey, b64); ingestChunk(fid, seq, bytes); }
        catch (err) { /* 解密失败的分片直接丢弃 */ }
        return;
      }
      try {
        const plain = await decryptWith(aesKey, data);
        handleMessage(JSON.parse(plain));
      } catch (err) { /* 无法解密的消息直接丢弃 */ }
    };
  }

  /* ================= 方式一：助记词邀请码 ================= */

  /* 发起方：生成 5 个单词并发布加密的 offer */
  $('btn-create-invite').onclick = async () => {
    if (!crypto.subtle) { setStatus('当前环境不支持 WebCrypto（需 https 或 localhost）', false); return; }
    try {
      setStatus('正在生成邀请码…', false);
      const words = randomWords(WORD_COUNT);
      signal = { ...(await channelParams(normalizeWords(words.join(' ')))), done: false };
      newPeer();
      const kp = await genECDH();
      pc._keypair = kp;
      bindChannel(pc.createDataChannel('chat'));
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceComplete();
      await sigPublish(await seal({ role: 'offer', sdp: pc.localDescription.sdp, pub: await exportPub(kp) }));

      wordsEl.textContent = words.join('  ');
      wordsEl.classList.remove('hidden');
      setStatus('邀请码已生成，等待对方加入…', true);

      const onMsg = async (cipher) => {
        if (!signal || signal.done) return;
        const data = await unseal(cipher);
        if (!data || data.role !== 'answer') return;
        signal.done = true;
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        aesKey = await deriveAES(kp.privateKey, data.pub);
        setStatus('对方已加入，正在建立连接…', true);
      };
      sigSubscribe(onMsg);
      sigPoll(onMsg);
    } catch (e) { setStatus('生成失败：' + e.message, false); }
  };

  /* 加入方：输入单词，拉取 offer 并回传加密的 answer */
  $('btn-join').onclick = async () => {
    if (!crypto.subtle) { setStatus('当前环境不支持 WebCrypto（需 https 或 localhost）', false); return; }
    const phrase = normalizeWords($('in-words').value);
    const words = phrase.split(' ').filter(Boolean);
    if (words.length < 4) { setStatus('请输入完整的邀请单词（空格分隔）', false); return; }
    const bad = words.find(w => !WORDS.includes(w));
    if (bad) { setStatus(`无法识别的单词「${bad}」，请核对后重试`, false); return; }

    try {
      setStatus('正在查找邀请…', false);
      signal = { ...(await channelParams(phrase)), done: false };
      let handled = false;
      const onMsg = async (cipher) => {
        if (!signal || handled) return;
        const data = await unseal(cipher);
        if (!data || data.role !== 'offer') return;
        handled = true;
        try {
          newPeer();
          const kp = await genECDH();
          pc.ondatachannel = (e) => bindChannel(e.channel);
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          await pc.setLocalDescription(await pc.createAnswer());
          await waitIceComplete();
          await sigPublish(await seal({ role: 'answer', sdp: pc.localDescription.sdp, pub: await exportPub(kp) }));
          aesKey = await deriveAES(kp.privateKey, data.pub);
          setStatus('已应答，正在建立连接…', true);
        } catch (e) { setStatus('应答失败：' + e.message, false); }
      };
      sigSubscribe(onMsg);
      await sigPoll(onMsg);
      setTimeout(() => {
        if (!handled && signal) setStatus('暂未收到邀请，请确认单词无误、对方仍在等待页面', false);
      }, 15000);
    } catch (e) { setStatus('加入失败：' + e.message, false); }
  };

  /* ================= 方式二：手动连接码（备用） ================= */

  $('btn-create-invite-manual').onclick = async () => {
    if (!crypto.subtle) { setStatus('当前环境不支持 WebCrypto（需 https 或 localhost）', false); return; }
    try {
      newPeer();
      const kp = await genECDH();
      pc._keypair = kp;
      bindChannel(pc.createDataChannel('chat'));
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceComplete();
      $('ta-invite').value = packCode({ sdp: pc.localDescription.sdp, type: 'offer', pub: await exportPub(kp) });
      setStatus('连接码已生成，等待对方回应…', false);
    } catch (e) { setStatus('生成失败：' + e.message, false); }
  };

  $('btn-accept-answer').onclick = async () => {
    try {
      const data = unpackCode($('ta-answer-in').value);
      if (data.type !== 'answer') throw new Error('这不是回应码');
      if (!pc || !pc._keypair) throw new Error('请先生成连接码');
      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      aesKey = await deriveAES(pc._keypair.privateKey, data.pub);
      setStatus('正在建立连接…', true);
    } catch (e) { setStatus('失败：' + e.message, false); }
  };

  $('btn-join-manual').onclick = async () => {
    if (!crypto.subtle) { setStatus('当前环境不支持 WebCrypto（需 https 或 localhost）', false); return; }
    try {
      const data = unpackCode($('ta-invite-in').value);
      if (data.type !== 'offer') throw new Error('这不是连接码');
      newPeer();
      const kp = await genECDH();
      pc.ondatachannel = (e) => bindChannel(e.channel);
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIceComplete();
      $('ta-answer').value = packCode({ sdp: pc.localDescription.sdp, type: 'answer', pub: await exportPub(kp) });
      aesKey = await deriveAES(kp.privateKey, data.pub);
      setStatus('回应码已生成，发回给对方即可连接', true);
    } catch (e) { setStatus('失败：' + e.message, false); }
  };

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.classList.toggle('ok', !!ok);
  }

  /* ---------- 消息收发 ---------- */
  function sendRaw(obj) {
    if (!dc || dc.readyState !== 'open' || !aesKey) return false;
    encryptWith(aesKey, JSON.stringify(obj)).then(ct => dc.send(ct));
    return true;
  }

  function send() {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    const ttl = parseInt($('sel-ttl').value, 10);
    const id = 'm' + Date.now() + Math.random().toString(36).slice(2, 7);
    if (!sendRaw({ kind: 'msg', id, text, ttl })) { addSystemNote('通道未就绪，发送失败'); return; }
    addMessage({ id, text, ttl, mine: true });
    input.value = '';
  }
  $('btn-send').onclick = send;
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  function handleMessage(obj) {
    if (obj.kind === 'msg') addMessage({ id: obj.id, text: obj.text, ttl: obj.ttl, mine: false });
    else if (obj.kind === 'burn') removeMessage(obj.id);
    else if (obj.kind === 'recall') {
      // 收到对方撤回通知：本地立即删除该消息（若还存在），并附系统提示
      const existed = !!msgsEl.querySelector(`[data-mid="${obj.id}"]`);
      removeMessage(obj.id);
      // 对方撤回的若恰是传输中的媒体，终止接收，避免孤儿分片
      const xi = xferIn.get(obj.id);
      if (xi) { xi.done = true; xi.chunks = null; xferIn.delete(obj.id); }
      if (existed) addSystemNote('一条消息已被撤回');
    }
    /* ----- 媒体文件协议 ----- */
    else if (obj.kind === 'file-start') onFileStart(obj);
    else if (obj.kind === 'file-ack') onFileAck(obj);
    else if (obj.kind === 'file-resume') onFileResume(obj);
    else if (obj.kind === 'file-complete') onFileComplete(obj);
    else if (obj.kind === 'file-resend') onFileResend(obj);
    else if (obj.kind === 'file-cancel') onFileCancel(obj);
  }

  function addMessage({ id, text, ttl, mine, media }) {
    const div = document.createElement('div');
    div.className = 'msg ' + (mine ? 'me' : 'peer');
    div.dataset.mid = id;

    let onTap = null;
    if (media) {
      div.classList.add('media-msg');
      div.dataset.mkind = media.type;          // image | video，供菜单判断
      const wrap = document.createElement('div');
      wrap.className = 'media-wrap';
      wrap.appendChild(mediaThumb(media));
      const meta = document.createElement('div');
      meta.className = 'media-meta';
      meta.textContent = (media.type === 'video' ? '🎬 ' : '🖼 ') + (media.name || '');
      if (media.size) meta.textContent += ' · ' + fmtSize2(media.size);
      wrap.appendChild(meta);
      // 进度条：pending（接收中占位）或 transferring（发送中）时显示
      const bar = document.createElement('div');
      bar.className = 'xfer-bar';
      const fill = document.createElement('div');
      fill.className = 'xfer-fill';
      fill.style.width = media.progress ? (media.progress * 100).toFixed(0) + '%' : '0%';
      bar.appendChild(fill);
      const showBar = media.pending || media.transferring;
      if (!showBar) bar.classList.add('hidden');
      wrap.appendChild(bar);
      div.appendChild(wrap);
      mediaCache.set(id, media);   // 供预览/保存
      // 媒体一律绑定预览：未就绪时 previewChatMedia 会提示
      onTap = () => previewChatMedia(id);
    } else {
      const span = document.createElement('span');
      span.textContent = text;
      div.appendChild(span);
    }

    if (ttl > 0) {
      div.classList.add('burn');
      const badge = document.createElement('span');
      badge.className = 'ttl-badge';
      div.appendChild(badge);
      let remain = ttl;
      badge.textContent = `🔥 ${remain}s 后焚毁`;
      const timer = setInterval(() => {
        remain--;
        if (remain <= 0) {
          clearInterval(timer);
          burnTimers.delete(id);
          // 若焚毁的是媒体且正在全屏预览，立即关闭（阅后即焚的隐私要求，收发双方一致）
          if (media) { try { if (window.Vault && Vault.closeFsPreview) Vault.closeFsPreview(); } catch (e) {} }
          removeMessage(id);
          if (mine) sendRaw({ kind: 'burn', id }); // 通知对方同步销毁
          else addSystemNote('一条消息已焚毁');
        } else {
          badge.textContent = `🔥 ${remain}s 后焚毁`;
        }
      }, 1000);
      burnTimers.set(id, timer);
    }
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    // 绑定点击/右键：媒体单击预览，文字/媒体长按或右键弹操作菜单
    bindBubbleTap(div, id, mine, onTap);
  }

  /* ---------- 消息气泡操作菜单（撤回） ---------- */
  const msgActionMenu = $('msg-action-menu');
  const msgActionBackdrop = $('msg-action-backdrop');
  const msgActionRecall = $('msg-action-recall');
  const msgActionCancel = $('msg-action-cancel');
  const msgActionSave = $('msg-action-save');
  const msgActionDownload = $('msg-action-download');
  let actionTargetId = null;

  function openMessageMenu(mid) {
    actionTargetId = mid;
    const bubble = msgsEl.querySelector(`[data-mid="${mid}"]`);
    if (!bubble) return;
    const isMedia = !!bubble.classList.contains('media-msg');
    const isMine = !!bubble.classList.contains('me');
    const canRecall = isMine;   // 只能撤回自己发送的消息，对方的消息由对方撤回
    const canSave = isMedia;    // 媒体可保存/下载（无论收发）
    if (!canRecall && !canSave) return;   // 无可用操作不弹菜单
    msgActionSave.hidden = !canSave;
    msgActionDownload.hidden = !canSave;
    msgActionRecall.hidden = !canRecall;
    msgActionMenu.classList.remove('hidden');
  }
  function closeMessageMenu() {
    msgActionMenu.classList.add('hidden');
    actionTargetId = null;
  }

  function bindBubbleTap(el, id, mine, onTap) {
    // 桌面：右键 / 移动：长按 / 单击（媒体单击预览，文字单击弹菜单）
    let pressTimer = null;
    let longPressed = false;
    let downX = 0, downY = 0;

    el.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      downX = t.clientX; downY = t.clientY;
      longPressed = false;
      pressTimer = setTimeout(() => {
        longPressed = true;
        openMessageMenu(id);
      }, 420);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.changedTouches[0];
      if (Math.hypot(t.clientX - downX, t.clientY - downY) > 8 && pressTimer) {
        clearTimeout(pressTimer); pressTimer = null;
      }
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    });
    el.addEventListener('click', (e) => {
      // 系统提示消息不弹菜单
      if (el.classList.contains('system-note')) return;
      if (longPressed) return;
      if (onTap) onTap();           // 媒体：单击预览
      else openMessageMenu(id);     // 文字：单击弹菜单
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMessageMenu(id);
    });
  }

  msgActionRecall.onclick = () => {
    const mid = actionTargetId;
    closeMessageMenu();
    if (!mid) return;
    // 安全校验：只能撤回自己发送的消息，对方的消息只能由对方撤回
    const bubble = msgsEl.querySelector(`[data-mid="${mid}"]`);
    if (!bubble || !bubble.classList.contains('me')) {
      addSystemNote('只能撤回自己发送的消息');
      return;
    }
    // 撤回的是传输中的媒体时，同时终止本地发送任务
    const xt = xferOut.get(mid);
    if (xt) { xt.done = true; xferOut.delete(mid); }
    // 通过加密通道通知对方同步删除
    if (dc && dc.readyState === 'open' && aesKey) {
      sendRaw({ kind: 'recall', id: mid });
    }
    const existed = !!msgsEl.querySelector(`[data-mid="${mid}"]`);
    removeMessage(mid);
    if (existed) addSystemNote('你撤回了一条消息');
  };
  msgActionCancel.onclick = closeMessageMenu;
  msgActionBackdrop.onclick = closeMessageMenu;

  // 保存到隐藏空间相册（IndexedDB），持久留存在本机
  msgActionSave.onclick = async () => {
    const mid = actionTargetId;
    closeMessageMenu();
    if (!mid) return;
    const m = mediaCache.get(mid);
    if (!m || !m.blob) { addSystemNote('媒体尚未就绪，无法保存'); return; }
    try {
      await DB.add('files', { type: m.type, name: m.name, mime: m.mime, size: m.size, blob: m.blob, date: Date.now() });
      addSystemNote('已保存到相册');
    } catch (e) { addSystemNote('保存失败：' + e.message); }
  };
  // 下载到设备（浏览器下载）
  msgActionDownload.onclick = () => {
    const mid = actionTargetId;
    closeMessageMenu();
    if (!mid) return;
    const m = mediaCache.get(mid);
    if (!m || !m.url) { addSystemNote('媒体尚未就绪，无法下载'); return; }
    const a = document.createElement('a');
    a.href = m.url;
    a.download = m.name || ('media_' + mid);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  // 锁定时也关菜单（保险）
  // (lock() 已关闭所有 .modal，这里菜单是 .msg-action-menu 不是 .modal，所以加一个保险)
  // 在 Chat.teardown() 中加入菜单清理：

  function removeMessage(id) {
    const el = msgsEl.querySelector(`[data-mid="${id}"]`);
    if (el) el.remove();
    if (burnTimers.has(id)) { clearInterval(burnTimers.get(id)); burnTimers.delete(id); }
    // 统一清理媒体缓存与传输状态（撤回 / 焚毁共用，防止孤儿分片与内存泄漏）
    const m = mediaCache.get(id);
    if (m) { if (m.url) URL.revokeObjectURL(m.url); mediaCache.delete(id); }
    const xt = xferOut.get(id);
    if (xt) { xt.done = true; if (xt.url) URL.revokeObjectURL(xt.url); xferOut.delete(id); }
    const xi = xferIn.get(id);
    if (xi) { xi.done = true; xi.chunks = null; xferIn.delete(id); }
  }

  function addSystemNote(text) {
    const div = document.createElement('div');
    div.className = 'msg system-note';
    div.textContent = text;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  /* ---------- 连接意外中断处理（双端各自感知并提示） ---------- */
  function handleUnexpectedDisconnect(note) {
    if (connLostNotified) return;
    connLostNotified = true;
    setStatus('连接已断开', false);
    setPeerState('st-err', '连接已断开');
    addSystemNote(note);
    // 终止所有进行中的媒体传输并标记中断，避免气泡永远停在进度条
    xferOut.forEach(t => { t.done = true; markXferInterrupted(t, '⚠ 发送中断'); });
    xferIn.forEach(t => { t.done = true; t.chunks = null; markXferInterrupted(t, '⚠ 接收中断'); });
  }
  function markXferInterrupted(t, label) {
    if (!t.bubble) return;
    const meta = t.bubble.querySelector('.media-meta');
    if (meta) meta.textContent = label;
    const bar = t.bubble.querySelector('.xfer-bar');
    if (bar) bar.classList.add('hidden');
  }

  /* ================= 媒体（图片/视频）端到端加密传输 =================
     协议（控制消息走 sendRaw 加密 JSON；分片密文用 F| 前缀直发，避免双重 JSON 编码）：
       file-start    {kind,id,name,mime,kind2:'image'|'video',size,total,chunkSize}
       F|id|seq|b64   单片密文（encryptBytes，AES-GCM）
       file-ack      {kind,id,seq}            接收方累计已收片数（用于续传基准）
       file-resume   {kind,id,fromSeq}        接收方已有 fromSeq 片，请从此处续传（断点续传）
       file-resend   {kind,id,seqs:[...]}     请求重传缺失片
       file-complete {kind,id}                发送方已发完全部分片
       file-cancel   {kind,id}               任一方取消
     DataChannel 为有序可靠通道，正常无丢片；bufferedAmount 超高水位时发送方自动背压。 */
  const CHUNK_RAW = 10240;              // 每片原始字节（base64 后 ~13.7KB，低于 SCTP 16KB 上限）
  const HIGH_WATER = 1 << 20;           // 1MB：发送缓冲超此暂停
  const LOW_WATER = 256 * 1024;         // 256KB：缓冲降至此恢复
  const ACK_EVERY = 8;                  // 每收 8 片回一次 ack
  const VIDEO_CAP = 100 * 1024 * 1024;  // 视频大小上限 100MB
  const IMG_MAX_DIM = 1920;             // 图片最长边上限
  const IMG_QUALITY = 0.82;
  const VIDEO_EXT_OK = ['mp4', 'mov', 'm4v', 'webm'];
  const IMG_EXT_OK = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

  const xferOut = new Map();            // 发送侧：id -> 传输状态
  const xferIn = new Map();             // 接收侧：id -> 传输状态
  const mediaCache = new Map();         // id -> {blob,url,type,name,mime,size}（完成后供预览/保存）

  function fmtSize2(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* ---------- 缩略图元素 ---------- */
  function mediaThumb(media) {
    if (media.pending) {
      const d = document.createElement('div');
      d.className = 'media-thumb pending';
      d.textContent = media.type === 'video' ? '🎬 接收中…' : '🖼 接收中…';
      return d;
    }
    if (media.type === 'image') {
      const i = document.createElement('img');
      i.className = 'media-thumb';
      i.src = media.url;
      i.alt = '';
      i.loading = 'lazy';
      return i;
    }
    const v = document.createElement('video');
    v.className = 'media-thumb';
    v.src = media.url;
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    return v;
  }

  /* ---------- 图片压缩（Canvas 重绘，保留清晰度） ---------- */
  async function compressImage(file) {
    if (!file.type.startsWith('image/')) return null;
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    const scale = Math.min(1, IMG_MAX_DIM / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    // PNG 带透明通道且尺寸不大时保留 PNG，否则统一 JPEG（兼顾体积与兼容）
    const isPng = file.type === 'image/png';
    const keepPng = isPng && (w * h) < 2000000;
    const mime = keepPng ? 'image/png' : 'image/jpeg';
    const blob = await new Promise(res => canvas.toBlob(res, mime, IMG_QUALITY));
    return { blob, mime };
  }

  /* ---------- 采集入口（相册 / 拍照 / 录视频） ---------- */
  const albumInput = $('chat-file-album');
  const camPhotoInput = $('chat-file-cam-photo');
  const camVideoInput = $('chat-file-cam-video');

  $('btn-attach').onclick = () => {
    if (!dc || dc.readyState !== 'open') { addSystemNote('请先建立加密通道'); return; }
    openAttachSheet();
  };
  // 绑定采集动作（三个隐藏 input 的 change）
  async function onPick(e) {
    const files = e.target.files;
    if (!files || !files.length) return;
    for (const f of files) await sendMedia(f);
    e.target.value = '';
  }
  if (albumInput) albumInput.addEventListener('change', onPick);
  if (camPhotoInput) camPhotoInput.addEventListener('change', onPick);
  if (camVideoInput) camVideoInput.addEventListener('change', onPick);

  // 采集方式选择 ActionSheet
  const attachSheet = $('chat-attach-sheet');
  function openAttachSheet() { if (attachSheet) attachSheet.classList.remove('hidden'); }
  function closeAttachSheet() { if (attachSheet) attachSheet.classList.add('hidden'); }
  const attachPick = (which) => {
    closeAttachSheet();
    let input;
    if (which === 'album') input = albumInput;
    else if (which === 'photo') input = camPhotoInput;
    else input = camVideoInput;
    if (!input) return;
    input.value = '';
    input.click();
  };
  if ($('attach-album')) $('attach-album').onclick = () => attachPick('album');
  if ($('attach-photo')) $('attach-photo').onclick = () => attachPick('photo');
  if ($('attach-video')) $('attach-video').onclick = () => attachPick('video');
  if ($('attach-cancel')) $('attach-cancel').onclick = closeAttachSheet;
  if ($('chat-attach-backdrop')) $('chat-attach-backdrop').onclick = closeAttachSheet;

  /* ---------- 发送侧 ---------- */
  async function sendMedia(file) {
    if (!dc || dc.readyState !== 'open' || !aesKey) { addSystemNote('通道未就绪，无法发送'); return; }
    const isImg = file.type.startsWith('image/');
    const isVid = file.type.startsWith('video/');
    if (!isImg && !isVid) { addSystemNote('仅支持图片或视频'); return; }

    // 扩展名白名单校验（兼容部分机型 type 为空的情况）
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (isImg && file.type && !IMG_EXT_OK.includes(ext) && !/image\/(jpeg|png|webp|heic|heif)/.test(file.type)) {
      addSystemNote('图片仅支持 JPG / PNG / WebP'); return;
    }
    if (isVid && !VIDEO_EXT_OK.includes(ext) && !/video\/(mp4|quicktime|webm|x-m4v)/.test(file.type)) {
      addSystemNote('视频仅支持 MP4 / MOV'); return;
    }

    let blob = file, mime = file.type, name = file.name || ('媒体_' + Date.now());
    if (isVid) {
      if (file.size > VIDEO_CAP) {
        addSystemNote(`视频 ${fmtSize2(file.size)} 超过 100MB 上限，请压缩后再发送`);
        return;
      }
    } else {
      try {
        const c = await compressImage(file);
        if (c) { blob = c.blob; mime = c.mime; name = name.replace(/\.(png|jpe?g|webp|heic|heif)$/i, '') + (mime === 'image/png' ? '.png' : '.jpg'); }
      } catch (e) { /* 压缩失败用原图 */ }
    }
    const kind2 = isImg ? 'image' : 'video';
    const id = 'f' + Date.now() + Math.random().toString(36).slice(2, 7);
    const total = Math.max(1, Math.ceil(blob.size / CHUNK_RAW));
    const url = URL.createObjectURL(blob);
    const ttl = parseInt($('sel-ttl').value, 10) || 0;   // 媒体同样支持阅后即焚

    // 本地立即展示气泡（含进度条；若 ttl>0 同步启动焚毁倒计时）
    addMessage({ id, mine: true, ttl, media: { url, type: kind2, name, size: blob.size, mime, pending: false, transferring: true, progress: 0, blob } });
    const bubble = msgsEl.querySelector(`[data-mid="${id}"]`);
    const bar = bubble && bubble.querySelector('.xfer-bar');

    xferOut.set(id, { blob, name, mime, kind2, size: blob.size, total, chunkSize: CHUNK_RAW, seq: 0, acked: 0, paused: false, done: false, bubble, bar, url });
    if (dc) dc.bufferedAmountLowThreshold = LOW_WATER;
    // ts 为发送时间戳：接收方据此扣减传输耗时，保证双方焚毁时刻一致
    sendRaw({ kind: 'file-start', id, name, mime, kind2, size: blob.size, total, chunkSize: CHUNK_RAW, ttl, ts: Date.now() });
    pumpChunks(id);
  }

  function waitForDrain() {
    return new Promise(resolve => {
      if (!dc || dc.bufferedAmount <= LOW_WATER) return resolve();
      const h = () => {
        if (dc && dc.bufferedAmount <= LOW_WATER) {
          dc.removeEventListener('bufferedamountlow', h);
          resolve();
        }
      };
      dc.addEventListener('bufferedamountlow', h);
    });
  }

  function pumpChunks(id) {
    const t = xferOut.get(id);
    if (!t || t.done) return;
    (async () => {
      while (t.seq < t.total && !t.done) {
        // 背压：缓冲超 HIGH_WATER 暂停，等降回 LOW_WATER 续传
        if (dc && dc.bufferedAmount > HIGH_WATER) {
          t.paused = true;
          await waitForDrain();
          t.paused = false;
          if (!dc || dc.readyState !== 'open' || t.done) break;
        }
        if (!dc || dc.readyState !== 'open') { t.paused = true; break; }
        const start = t.seq * t.chunkSize;
        const slice = t.blob.slice(start, start + t.chunkSize);
        const buf = new Uint8Array(await slice.arrayBuffer());
        const b64 = await encryptBytes(aesKey, buf);
        dc.send('F|' + id + '|' + t.seq + '|' + b64);
        t.seq++;
        if (t.seq % 4 === 0 || t.seq === t.total) updateXferProgress(t, t.seq / t.total, '发送');
      }
      if (!t.done && t.seq >= t.total) {
        sendRaw({ kind: 'file-complete', id });
        t.done = true;
        updateXferProgress(t, 1, '已发送', true);
      }
    })().catch(e => { addSystemNote('发送出错：' + e.message); });
  }

  function updateXferProgress(t, ratio, label, done) {
    if (!t.bubble) return;
    const fill = t.bubble.querySelector('.xfer-fill');
    const meta = t.bubble.querySelector('.media-meta');
    if (fill) fill.style.width = (ratio * 100).toFixed(0) + '%';
    if (meta) {
      const base = (t.kind2 === 'video' ? '🎬 ' : '🖼 ') + (t.name || '');
      meta.textContent = base + (done ? '' : ` · ${label} ${(ratio * 100).toFixed(0)}%`);
    }
    if (done && t.bar) t.bar.classList.add('hidden');
  }

  // 协议处理：接收 ack（仅记录续传基准）
  function onFileAck(o) {
    const t = xferOut.get(o.id);
    if (t) t.acked = o.seq;
  }
  // 接收方请求续传：从 fromSeq 继续
  function onFileResume(o) {
    const t = xferOut.get(o.id);
    if (!t || t.done) return;
    if (o.fromSeq > t.seq) return;   // 不可能超前
    t.seq = o.fromSeq;                // 跳过已收片，续传
    pumpChunks(o.id);
  }
  // 接收方请求重传缺失片
  function onFileResend(o) {
    const t = xferOut.get(o.id);
    if (!t || t.done || !o.seqs) return;
    (async () => {
      for (const s of o.seqs) {
        if (!dc || dc.readyState !== 'open') break;
        const start = s * t.chunkSize;
        const buf = new Uint8Array(await t.blob.slice(start, start + t.chunkSize).arrayBuffer());
        const b64 = await encryptBytes(aesKey, buf);
        dc.send('F|' + o.id + '|' + s + '|' + b64);
      }
    })();
  }
  // 对方取消
  function onFileCancel(o) {
    cancelXfer(o.id, '对方取消了传输');
  }

  /* ---------- 接收侧 ---------- */
  function onFileStart(o) {
    // 断点续传：若同一 id 已有部分片，请求从已收数续传，不重建气泡
    const exist = xferIn.get(o.id);
    if (exist && exist.received > 0 && exist.received < o.total) {
      sendRaw({ kind: 'file-resume', id: o.id, fromSeq: exist.received });
      return;
    }
    if (exist && exist.received >= o.total) { sendRaw({ kind: 'file-resume', id: o.id, fromSeq: o.total }); return; }
    const id = o.id;
    // 阅后即焚：以发送方 ts 为基准扣减传输耗时，保证双方焚毁时刻一致；已过期则不落屏
    let ttl = 0;
    if (o.ttl > 0) {
      const elapsed = Math.max(0, Math.round((Date.now() - (o.ts || Date.now())) / 1000));
      ttl = o.ttl - elapsed;
      if (ttl <= 0) {
        addSystemNote('一条媒体消息已过期焚毁');
        sendRaw({ kind: 'file-cancel', id });
        return;
      }
    }
    addMessage({ id, mine: false, ttl, media: { pending: true, type: o.kind2, name: o.name, size: o.size, progress: 0 } });
    const bubble = msgsEl.querySelector(`[data-mid="${id}"]`);
    const bar = bubble && bubble.querySelector('.xfer-bar');
    xferIn.set(id, {
      meta: o, chunks: new Array(o.total), received: 0, total: o.total,
      bubble, bar, done: false
    });
  }

  function ingestChunk(id, seq, bytes) {
    const t = xferIn.get(id);
    if (!t || t.done) return;
    if (!t.chunks[seq]) { t.chunks[seq] = bytes; t.received++; }
    if (t.received % ACK_EVERY === 0 || t.received === t.total) {
      sendRaw({ kind: 'file-ack', id, seq: t.received });
    }
    updateIngressProgress(t, t.received / t.total);
    if (t.received === t.total) finalizeIn(id);
  }

  function updateIngressProgress(t, ratio) {
    if (!t.bubble) return;
    const fill = t.bubble.querySelector('.xfer-fill');
    const meta = t.bubble.querySelector('.media-meta');
    if (fill) fill.style.width = (ratio * 100).toFixed(0) + '%';
    if (meta) meta.textContent = (t.meta.kind2 === 'video' ? '🎬 ' : '🖼 ') + (t.meta.name || '') + ` · 接收 ${(ratio * 100).toFixed(0)}%`;
  }

  function onFileComplete(o) {
    const t = xferIn.get(o.id);
    if (!t) return;
    if (t.received === t.total) { finalizeIn(o.id); }
    else {
      // 有缺失：请求重传
      const missing = [];
      for (let i = 0; i < t.total; i++) if (!t.chunks[i]) missing.push(i);
      if (missing.length) sendRaw({ kind: 'file-resend', id: o.id, seqs: missing });
      else finalizeIn(o.id);
    }
  }

  function finalizeIn(id) {
    const t = xferIn.get(id);
    if (!t || t.done) return;
    t.done = true;
    try {
      const blob = new Blob(t.chunks, { type: t.meta.mime || (t.meta.kind2 === 'video' ? 'video/mp4' : 'image/jpeg') });
      const url = URL.createObjectURL(blob);
      // 升级气泡为可预览媒体
      setBubbleMedia(t.bubble, { url, blob, type: t.meta.kind2, name: t.meta.name, size: t.meta.size, mime: t.meta.mime });
      mediaCache.set(id, { url, blob, type: t.meta.kind2, name: t.meta.name, size: t.meta.size, mime: t.meta.mime || (t.meta.kind2 === 'video' ? 'video/mp4' : 'image/jpeg') });
      if (t.bar) t.bar.classList.add('hidden');
      // 清理分片缓冲释放内存
      t.chunks = null;
    } catch (e) { addSystemNote('媒体组装失败'); }
  }

  // 把接收气泡从"接收中"升级为真实媒体
  function setBubbleMedia(bubble, media) {
    if (!bubble) return;
    const wrap = bubble.querySelector('.media-wrap');
    if (!wrap) return;
    const oldThumb = wrap.querySelector('.media-thumb');
    if (oldThumb) oldThumb.remove();
    wrap.insertBefore(mediaThumb(media), wrap.firstChild);
    const meta = wrap.querySelector('.media-meta');
    if (meta) meta.textContent = (media.type === 'video' ? '🎬 ' : '🖼 ') + (media.name || '') + (media.size ? ' · ' + fmtSize2(media.size) : '');
    // 让单击可预览：重新绑定 onTap
    bubble.classList.add('media-msg');
    bubble.dataset.mkind = media.type;
  }

  /* ---------- 预览：复用 Vault 全屏预览 ---------- */
  function previewChatMedia(id) {
    const m = mediaCache.get(id);
    if (!m || !m.blob) { addSystemNote('媒体尚未就绪'); return; }
    if (window.Vault && Vault.previewMedia) Vault.previewMedia({ blob: m.blob, name: m.name, type: m.type });
  }

  /* ---------- 取消传输 ---------- */
  function cancelXfer(id, note) {
    const o = xferOut.get(id); if (o) o.done = true;
    const i = xferIn.get(id); if (i) { i.done = true; i.chunks = null; }
    if (dc && dc.readyState === 'open' && aesKey) sendRaw({ kind: 'file-cancel', id });
    const bubble = msgsEl.querySelector(`[data-mid="${id}"]`);
    if (bubble) {
      const meta = bubble.querySelector('.media-meta');
      if (meta) meta.textContent = '⚠ 已取消';
      const bar = bubble.querySelector('.xfer-bar'); if (bar) bar.classList.add('hidden');
    }
    addSystemNote(note);
  }

  /* ---------- 断开与清理 ---------- */
  function teardownPeerOnly() {
    if (dc) { try { dc.close(); } catch (e) {} dc = null; }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  }

  function teardown() {
    manualClose = true;   // 用户主动关闭：连接回调静默，不误报"意外中断"
    teardownPeerOnly();
    closeSigSockets();
    signal = null;
    aesKey = null;
    connLostNotified = false;
    burnTimers.forEach(t => clearInterval(t));
    burnTimers.clear();
    // 清理媒体传输与缓存
    xferOut.forEach(t => { t.done = true; if (t.url) URL.revokeObjectURL(t.url); });
    xferOut.clear();
    xferIn.forEach(t => { t.done = true; t.chunks = null; });
    xferIn.clear();
    mediaCache.forEach(m => { /* url 可能仍被气泡引用，保留到 innerHTML 清空 */ });
    mediaCache.clear();
    if (attachSheet) attachSheet.classList.add('hidden');
    msgsEl.innerHTML = '';
    roomEl.classList.add('hidden');
    setupEl.classList.remove('hidden');
    wordsEl.classList.add('hidden');
    wordsEl.textContent = '';
    if (msgActionMenu) msgActionMenu.classList.add('hidden');
    actionTargetId = null;
    ['in-words', 'ta-invite', 'ta-answer', 'ta-answer-in', 'ta-invite-in'].forEach(id => { $(id).value = ''; });
    setStatus('未连接', false);
    setPeerState('st-ok', '已建立加密通道');   // 复位默认文案（房间已隐藏）
  }

  $('btn-chat-close').onclick = teardown;

  return { teardown };
})();
