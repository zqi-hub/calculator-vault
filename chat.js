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
  const burnTimers = new Map();

  const $ = (id) => document.getElementById(id);
  const setupEl = $('chat-setup');
  const roomEl = $('chat-room');
  const statusEl = $('chat-status');
  const msgsEl = $('chat-messages');
  const wordsEl = $('invite-words');

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
    teardownPeerOnly();
    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        setStatus('连接已断开', false);
      }
    };
  }

  function bindChannel(channel) {
    dc = channel;
    dc.onopen = () => {
      setupEl.classList.add('hidden');
      roomEl.classList.remove('hidden');
      addSystemNote('加密通道已建立，可以开始聊天');
      closeSigSockets();   // 握手完成后不再需要信令通道
      signal = null;
    };
    dc.onclose = () => addSystemNote('通道已关闭');
    dc.onmessage = async (e) => {
      try {
        const plain = await decryptWith(aesKey, e.data);
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
  }

  function addMessage({ id, text, ttl, mine }) {
    const div = document.createElement('div');
    div.className = 'msg ' + (mine ? 'me' : 'peer');
    div.dataset.mid = id;
    const span = document.createElement('span');
    span.textContent = text;
    div.appendChild(span);

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
  }

  function removeMessage(id) {
    const el = msgsEl.querySelector(`[data-mid="${id}"]`);
    if (el) el.remove();
    if (burnTimers.has(id)) { clearInterval(burnTimers.get(id)); burnTimers.delete(id); }
  }

  function addSystemNote(text) {
    const div = document.createElement('div');
    div.className = 'msg system-note';
    div.textContent = text;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  /* ---------- 断开与清理 ---------- */
  function teardownPeerOnly() {
    if (dc) { try { dc.close(); } catch (e) {} dc = null; }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  }

  function teardown() {
    teardownPeerOnly();
    closeSigSockets();
    signal = null;
    aesKey = null;
    burnTimers.forEach(t => clearInterval(t));
    burnTimers.clear();
    msgsEl.innerHTML = '';
    roomEl.classList.add('hidden');
    setupEl.classList.remove('hidden');
    wordsEl.classList.add('hidden');
    wordsEl.textContent = '';
    ['in-words', 'ta-invite', 'ta-answer', 'ta-answer-in', 'ta-invite-in'].forEach(id => { $(id).value = ''; });
    setStatus('未连接', false);
  }

  $('btn-chat-close').onclick = teardown;

  return { teardown };
})();
