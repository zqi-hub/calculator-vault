/* vault.js — 隐藏空间：相册（图片+视频）/ 音频 / 笔记 / 加密聊天 / 设置 */
const Vault = (() => {
  const screenCalc = document.getElementById('screen-calc');
  const screenVault = document.getElementById('screen-vault');
  const fileInput = document.getElementById('file-input');
  // 相册专用 input（解决部分 Android 选择器只显示图片的问题）
  const albumImgInput = document.getElementById('album-img-input');
  const albumVidInput = document.getElementById('album-vid-input');
  const albumFileInput = document.getElementById('album-file-input');
  // 操作菜单
  const albumImportMenu = document.getElementById('album-import-menu');
  const fileActionMenu = document.getElementById('file-action-menu');

  // 文件类型面板：相册（图片/视频）+ 音频
  const TYPE_TABS = ['album', 'audio'];
  const TYPE_LABEL = { album: '相册', audio: '音频' };
  const ACCEPT = { audio: 'audio/*' };
  // 卡片缩略图用：图片→缩略图，其他类型→图标
  function cardThumb(item, url) {
    if (item.type === 'image') return `<img class="file-thumb" src="${url}" alt="">`;
    if (item.type === 'video') return `<div class="file-thumb icon-mode">🎬</div>`;
    if (item.type === 'audio') return `<div class="file-thumb icon-mode">🎵</div>`;
    return `<div class="file-thumb icon-mode">📁</div>`;
  }
  let currentFileType = 'album';
  let editingNoteId = null;
  let activeFileItem = null;   // 当前文件操作菜单对应的数据项

  /* ---------- 相册多选模式（长按进入，批量保存/删除） ---------- */
  const selBar = document.getElementById('select-bar');
  const selCount = document.getElementById('select-count');
  const selGrid = document.getElementById('grid-album');
  let selMode = false;               // 是否处于多选模式
  const selIds = new Set();          // 已选中的文件 id
  let albumItems = [];               // 当前相册渲染的数据项（供批量操作取数据）

  function updateSelectUI() {
    if (!selBar) return;
    selBar.classList.toggle('hidden', !selMode);
    if (selGrid) selGrid.classList.toggle('selecting', selMode);
    if (selCount) selCount.textContent = `已选 ${selIds.size} 项`;
    if (selMode) {
      const allSel = albumItems.length > 0 && selIds.size === albumItems.length;
      document.getElementById('select-all').textContent = allSel ? '全不选' : '全选';
      // 标记卡片选中态（refreshFiles 重绘后调用同样生效）
      selGrid.querySelectorAll('.file-card').forEach(card => {
        const on = selIds.has(Number(card.dataset.fid));
        card.classList.toggle('selected', on);
        const chk = card.querySelector('.sel-check');
        if (chk) chk.textContent = on ? '✓' : '';
      });
    }
  }

  function enterSelectMode(firstId) {
    selMode = true;
    selIds.clear();
    if (firstId !== undefined && firstId !== null) selIds.add(firstId);
    updateSelectUI();
  }

  function exitSelectMode() {
    selMode = false;
    selIds.clear();
    updateSelectUI();
  }

  function toggleSelect(id) {
    if (selIds.has(id)) selIds.delete(id); else selIds.add(id);
    if (selIds.size === 0) { exitSelectMode(); return; }
    updateSelectUI();
  }

  // 相册卡片长按进入多选（touch 长按 / 桌面右键）
  function bindCardSelect(card, id) {
    let timer = null, long = false, downX = 0, downY = 0;
    card.addEventListener('touchstart', (e) => {
      if (selMode) return;   // 多选模式下长按无意义
      const t = e.changedTouches[0];
      downX = t.clientX; downY = t.clientY;
      long = false;
      timer = setTimeout(() => { long = true; enterSelectMode(id); }, 500);
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      const t = e.changedTouches[0];
      if (Math.hypot(t.clientX - downX, t.clientY - downY) > 10 && timer) { clearTimeout(timer); timer = null; }
    }, { passive: true });
    card.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selMode) enterSelectMode(id);
    });
    // 长按后紧接着触发的 click 不应再预览
    card.addEventListener('click', (e) => {
      if (long) { long = false; e.stopPropagation(); }
    }, true);
  }

  // 批量保存：优先系统分享面板一次带出多个文件；不支持时退化为逐个保存（仍走 AndroidBridge）
  async function saveBatch(items) {
    if (!items.length) return;
    // 1) Android 原生桥：把多文件以数组传给原生层（原生层逐个写 MediaStore）
    const Bridge = window.AndroidBridge;
    if (Bridge && typeof Bridge.saveFiles === 'function') {
      try {
        const arr = [];
        for (const it of items) arr.push({ name: it.name || 'file', mime: it.mime || it.blob.type || 'application/octet-stream', b64: await blobToBase64(it.blob) });
        const r = Bridge.saveFiles(JSON.stringify(arr));
        if (r && typeof r === 'string' && r.startsWith('OK')) return;
      } catch (e) { /* 桥失败继续 */ }
    }
    // 2) Web 分享面板
    try {
      const files = items.map(it => new File([it.blob], it.name || 'file', { type: it.mime || it.blob.type || 'application/octet-stream' }));
      if (navigator.share && navigator.canShare && navigator.canShare({ files })) {
        try {
          await navigator.share({ files, title: `私密空间导出（${files.length} 项）` });
          return;
        } catch (e) { if (e.name === 'AbortError') return; }
      }
    } catch (e) { /* 继续 */ }
    // 3) 逐个走 saveToDevice
    for (const it of items) await saveToDevice(it);
  }

  if (selBar) {
    document.getElementById('select-all').onclick = () => {
      if (selIds.size === albumItems.length) selIds.clear();
      else { selIds.clear(); albumItems.forEach(it => selIds.add(it.id)); }
      if (selIds.size === 0) { exitSelectMode(); return; }
      updateSelectUI();
    };
    document.getElementById('select-save').onclick = async () => {
      const items = albumItems.filter(it => selIds.has(it.id));
      if (!items.length) return;
      exitSelectMode();
      await saveBatch(items);
    };
    document.getElementById('select-del').onclick = async () => {
      const items = albumItems.filter(it => selIds.has(it.id));
      if (!items.length) return;
      if (!confirm(`删除选中的 ${items.length} 项？此操作不可恢复！`)) return;
      for (const it of items) await DB.del('files', it.id);
      exitSelectMode();
      refreshFiles('album');
    };
    document.getElementById('select-exit').onclick = exitSelectMode;
  }

  function unlock() {
    screenCalc.classList.add('hidden');
    screenVault.classList.remove('hidden');
    refreshFiles(currentFileType);
    refreshNotes();
  }

  function lock() {
    fsClose();  // 主动关闭全屏预览以避免泄露（fsClose 在下方定义，但因函数声明提升可调用）
    if (window.Chat) Chat.teardown();
    screenVault.classList.add('hidden');
    screenCalc.classList.remove('hidden');
    // 关闭所有弹窗
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  }

  /* ---------- 标签切换 ---------- */
  document.querySelectorAll('.vault-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.vault-tabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      document.getElementById('pane-' + name).classList.add('active');
      if (TYPE_TABS.includes(name)) { currentFileType = name; refreshFiles(name); }
      if (name === 'note') refreshNotes();
    });
  });

  document.getElementById('btn-lock').addEventListener('click', lock);
  // 切到后台自动锁定，防止他人看到
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !screenVault.classList.contains('hidden')) lock();
  });

  /* ---------- 文件面板骨架 ---------- */
  TYPE_TABS.forEach(type => {
    const pane = document.getElementById('pane-' + type);
    const isAlbum = type === 'album';
    pane.innerHTML = `
      <div class="pane-toolbar">
        <button class="btn primary" data-import="${type}">＋ 导入${isAlbum ? '媒体' : TYPE_LABEL[type]}</button>
        <span class="muted">文件仅保存在本机浏览器存储中，不上传</span>
      </div>
      ${isAlbum ? `
      <div id="select-bar" class="select-bar hidden">
        <span id="select-count" class="select-count">已选 0 项</span>
        <div class="select-actions">
          <button id="select-all" class="btn small" type="button">全选</button>
          <button id="select-save" class="btn small primary" type="button">批量保存</button>
          <button id="select-del" class="btn small danger" type="button">批量删除</button>
          <button id="select-exit" class="btn small" type="button">退出</button>
        </div>
      </div>` : ''}
      <div class="file-grid ${type === 'doc' || type === 'audio' ? 'doc-mode' : ''}" id="grid-${type}"></div>`;
  });
  document.querySelectorAll('[data-import]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.import;
      if (type === 'album') {
        // 相册：弹出选择菜单（图片 / 视频 / 文件管理器）
        albumImportMenu.classList.remove('hidden');
      } else {
        fileInput.accept = ACCEPT[type];
        fileInput.dataset.type = type;
        fileInput.value = '';
        fileInput.click();
      }
    });
  });

  /* ---------- 相册导入菜单 ---------- */
  function openAlbumImport(inputEl) {
    inputEl.value = '';
    inputEl.click();
    albumImportMenu.classList.add('hidden');
  }
  document.getElementById('album-import-img').onclick = () => openAlbumImport(albumImgInput);
  document.getElementById('album-import-vid').onclick = () => openAlbumImport(albumVidInput);
  document.getElementById('album-import-file').onclick = () => openAlbumImport(albumFileInput);
  document.getElementById('album-import-cancel').onclick = () => albumImportMenu.classList.add('hidden');
  document.getElementById('album-import-backdrop').onclick = () => albumImportMenu.classList.add('hidden');

  async function handleFileSelect(inputEl, paneType) {
    for (const f of inputEl.files) {
      // 相册面板按真实媒体类型归类；其余面板用面板类型
      let storeType = paneType;
      if (paneType === 'album') {
        if (f.type.startsWith('video/')) storeType = 'video';
        else if (f.type.startsWith('image/')) storeType = 'image';
        else if (f.type.startsWith('audio/')) storeType = 'audio';
        else storeType = 'file';   // 兜底：从文件管理器选到的非媒体文件，存为通用类型
      }
      await DB.add('files', { type: storeType, name: f.name, mime: f.type || '', size: f.size, blob: f, date: Date.now() });
    }
    refreshFiles(paneType);
  }

  fileInput.addEventListener('change', () => handleFileSelect(fileInput, fileInput.dataset.type));
  albumImgInput.addEventListener('change', () => handleFileSelect(albumImgInput, 'album'));
  albumVidInput.addEventListener('change', () => handleFileSelect(albumVidInput, 'album'));
  albumFileInput.addEventListener('change', () => handleFileSelect(albumFileInput, 'album'));

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  async function refreshFiles(type) {
    const grid = document.getElementById('grid-' + type);
    // 相册面板展示图片、视频以及文件管理器选到的非媒体通用文件；音频面板只展示音频
    const match = type === 'album'
      ? (f) => f.type === 'image' || f.type === 'video' || f.type === 'file'
      : (f) => f.type === type;
    const all = (await DB.getAll('files')).filter(match).sort((a, b) => b.date - a.date);
    if (type === 'album') albumItems = all;   // 供多选模式取数据
    if (all.length === 0) {
      grid.innerHTML = `<div class="empty-tip">暂无${TYPE_LABEL[type]}，点击上方按钮导入</div>`;
      if (type === 'album' && selMode) exitSelectMode();   // 空了自动退出多选
      return;
    }
    grid.innerHTML = '';
    for (const item of all) {
      if (type === 'audio') {
        // 音频面板：行式布局（文件名 + 三个按钮 + 长按操作菜单）
        const row = document.createElement('div');
        row.className = 'doc-row';
        row.innerHTML = `
          <div class="doc-row-main">
            <span class="dicon">🎵</span>
            <span class="dname" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            <span class="dsize">${fmtSize(item.size)}</span>
          </div>
          <div class="doc-row-actions">
            <button class="btn small" data-act="open" title="打开/预览">打开</button>
            <button class="btn small" data-act="save" title="保存到设备">导出</button>
            <button class="btn small danger" data-act="del" title="删除">删除</button>
          </div>`;
        row.querySelector('[data-act="open"]').onclick = () => preview(item);
        row.querySelector('[data-act="save"]').onclick = () => saveToDevice(item);
        row.querySelector('[data-act="del"]').onclick = async () => {
          if (confirm(`删除「${item.name}」？`)) { await DB.del('files', item.id); refreshFiles(type); }
        };
        // 移动端长按/点击整行也弹出操作菜单（防止按钮被截时无法操作）
        bindFileRowMenu(row, item, type);
        grid.appendChild(row);
      } else {
        // 相册面板：卡片布局（缩略图 + 名称 + 保存/删除按钮 + 长按多选）
        const card = document.createElement('div');
        card.className = 'file-card';
        card.dataset.fid = item.id;
        const url = URL.createObjectURL(item.blob);
        card.innerHTML = `${cardThumb(item, url)}
          <span class="sel-check" aria-hidden="true"></span>
          <div class="fname">${escapeHtml(item.name)}</div>
          <button class="file-card-btn file-save" title="保存到设备">⬇</button>
          <button class="file-card-btn file-del" title="删除">✕</button>`;
        // 多选模式下点击 = 勾选/取消；正常模式 = 预览
        card.querySelector('.file-thumb').addEventListener('click', () => {
          if (selMode) { toggleSelect(item.id); return; }
          // 通用 file 类型没有预览，跳过
          if (item.type === 'file') return;
          preview(item);
        });
        card.querySelector('.file-save').onclick = (e) => {
          e.stopPropagation();
          if (selMode) { toggleSelect(item.id); return; }
          saveToDevice(item);
        };
        card.querySelector('.file-del').onclick = async (e) => {
          e.stopPropagation();
          if (selMode) { toggleSelect(item.id); return; }
          if (confirm(`删除「${item.name}」？`)) { await DB.del('files', item.id); refreshFiles(type); }
        };
        bindCardSelect(card, item.id);   // 长按进入多选
        grid.appendChild(card);
      }
    }
    if (type === 'album' && selMode) updateSelectUI();   // 重绘后恢复选中标记
  }

  /* ---------- 普通预览（音频走弹窗；相册图像/视频走全屏预览） ---------- */
  const previewModal = document.getElementById('preview-modal');
  const previewBody = document.getElementById('preview-body');
  const previewName = document.getElementById('preview-name');
  let previewUrl = null;
  let previewItem = null;

  // 把 Blob 转成 data: URI（base64）。Android WebView 对 blob: URL 的音频/视频支持不稳定，
  // 用 data: URI 几乎所有机型都能直接播放；小文件首选，大文件仍可走原始 src。
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
  }
  function revokePreviewUrl() {
    if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (e) {} previewUrl = null; }
  }

  async function previewAudio(item) {
    if (item.type !== 'audio') return;   // 仅音频走弹窗
    if (previewUrl) { revokePreviewUrl(); previewItem = null; }
    previewItem = item;
    previewName.textContent = item.name || '音频';
    // Android WebView 对 blob: 音频支持差，且部分机型不会自动播放；
    // 优先尝试 data: URI（保证能播），失败再退回 blob: URL；两种都给显式播放按钮。
    previewBody.innerHTML = `
      <div class="audio-player-wrap">
        <div class="audio-name">${escapeHtml(item.name || '')}</div>
        <audio id="preview-audio" controls playsinline preload="metadata"></audio>
        <div class="audio-actions">
          <button class="btn primary" id="btn-audio-play">▶ 播放</button>
          <button class="btn" id="btn-audio-export">⬇ 保存到设备</button>
        </div>
        <p class="muted audio-tip" id="audio-tip">正在准备音频…</p>
      </div>`;
    const audio = document.getElementById('preview-audio');
    const tip = document.getElementById('audio-tip');
    const playBtn = document.getElementById('btn-audio-play');
    const exportBtn = document.getElementById('btn-audio-export');
    const blob = item.blob;
    const mime = item.mime || blob.type || 'audio/mpeg';

    if (blob.size === 0) {
      tip.textContent = '⚠ 文件为空（0 字节），无法播放。';
      playBtn.disabled = true;
    } else {
      // 优先 data: URI（小文件最佳兼容性）
      try {
        const dataUrl = await blobToDataURL(blob);
        audio.src = dataUrl;
        tip.textContent = `准备就绪（${fmtSize(blob.size)} · ${mime}）。点击下方「播放」或在控制条上点 ▶。`;
      } catch (e) {
        // data URL 生成失败，退回 blob URL
        previewUrl = URL.createObjectURL(blob);
        audio.src = previewUrl;
        tip.textContent = `准备就绪（${fmtSize(blob.size)} · ${mime}）。点击下方「播放」或在控制条上点 ▶。`;
      }
    }

    function describeError() {
      const err = audio.error;
      if (!err) return '音频播放失败';
      switch (err.code) {
        case 1: return '音频加载被中止';
        case 2: return '网络错误（离线或断网）';
        case 3: return '音频解码失败（编码格式不受支持）';
        case 4: return '音频源不可用（格式不支持或文件已损坏）';
        default: return '音频播放失败（未知错误）';
      }
    }

    playBtn.onclick = async () => {
      try {
        tip.textContent = '正在播放…';
        await audio.play();
        tip.textContent = `▶ 正在播放（${fmtSize(blob.size)} · ${mime}）`;
      } catch (err) {
        // 退回 blob URL 再试一次（针对某些只能播 blob 的 WebView）
        if (!previewUrl && audio.src.startsWith('data:')) {
          try {
            previewUrl = URL.createObjectURL(blob);
            audio.src = previewUrl;
            await audio.play();
            tip.textContent = `▶ 正在播放（${fmtSize(blob.size)} · ${mime}）`;
            return;
          } catch (e2) { /* fall through */ }
        }
        tip.textContent = `⚠ ${describeError()}（${(err && err.message) || '未知原因'}）。请点「保存到设备」用系统播放器打开。`;
      }
    };
    audio.onerror = () => {
      tip.textContent = `⚠ ${describeError()}。请点「保存到设备」用系统播放器打开。`;
    };
    exportBtn.onclick = () => saveToDevice(item);

    previewModal.classList.remove('hidden');
  }

  document.getElementById('btn-preview-close').onclick = () => {
    previewModal.classList.add('hidden');
    previewBody.innerHTML = '';
    revokePreviewUrl();
    previewItem = null;
  };

  /* ---------- 相册全屏预览（支持双指缩放 / 单指拖动 / 双击放大） ---------- */
  const fsPreview = document.getElementById('fs-preview');
  const fsStage = document.getElementById('fs-stage');
  const fsCloseBtn = document.getElementById('fs-close');
  let fsMedia = null;       // 当前展示的 <img> 或 <video>
  let fsUrl = null;         // 当前 ObjectURL
  let fsIsVideo = false;
  let fsCurrentItem = null; // 当前全屏预览的数据项，用于保存
  let fsScale = 1;          // 当前缩放（1 ~ 5）
  let fsOffsetX = 0;        // 平移
  let fsOffsetY = 0;
  // 手势状态
  const fsPointers = new Map(); // touch.identifier → {x, y}
  let fsInitPinchDist = 0;
  let fsInitScale = 1;
  let fsInitCenter = { x: 0, y: 0 };
  let fsInitOffsetX = 0;
  let fsInitOffsetY = 0;
  let fsLastSingle = null;
  let fsIsDragging = false;
  let fsLastTap = 0;
  let fsDidPan = false;     // 用于区分单击关闭 / 拖动
  let fsDownX = 0, fsDownY = 0;

  const FS_MIN = 1;
  const FS_MAX = 5;

  function clampScale(s) { return Math.max(FS_MIN, Math.min(FS_MAX, s)); }

  function applyFsTransform() {
    if (!fsMedia) return;
    // 平移量按当前 scale 限制边界，避免图像被拖飞
    if (fsScale <= 1.0001) { fsOffsetX = 0; fsOffsetY = 0; }
    fsMedia.style.transform = `translate(${fsOffsetX}px, ${fsOffsetY}px) scale(${fsScale})`;
  }

  // 手势进行中必须禁用 CSS 过渡：否则每一帧缩放都在做 0.15s 缓动，出现明显拖尾卡顿；
  // 手势结束后恢复过渡，让双击放大/滚轮收尾保持平滑
  function fsSetAnim(on) {
    if (!fsMedia) return;
    fsMedia.style.transition = on ? '' : 'none';
  }

  function fsOpen(item) {
    if (fsUrl) URL.revokeObjectURL(fsUrl);
    fsCurrentItem = item;
    fsUrl = URL.createObjectURL(item.blob);
    fsIsVideo = item.type === 'video';
    fsStage.innerHTML = '';
    fsMedia = document.createElement(fsIsVideo ? 'video' : 'img');
    fsMedia.src = fsUrl;
    fsMedia.className = 'fs-media';
    if (fsIsVideo) {
      fsMedia.controls = true;
      fsMedia.autoplay = true;
      fsMedia.playsInline = true;
    }
    fsStage.appendChild(fsMedia);
    fsStage.classList.toggle('video-mode', fsIsVideo);

    fsScale = 1; fsOffsetX = 0; fsOffsetY = 0;
    fsPointers.clear();
    fsLastSingle = null; fsIsDragging = false; fsLastTap = 0;
    applyFsTransform();

    fsPreview.classList.remove('hidden');
    fsPreview.classList.remove('no-hint');
    // 3s 后自动隐藏手势提示
    setTimeout(() => fsPreview.classList.add('no-hint'), 3000);
  }

  function fsClose() {
    if (fsIsVideo && fsMedia) try { fsMedia.pause(); } catch (e) {}
    fsPreview.classList.add('hidden');
    fsStage.innerHTML = '';
    if (fsUrl) { URL.revokeObjectURL(fsUrl); fsUrl = null; }
    fsMedia = null; fsIsVideo = false;
    fsCurrentItem = null;
    fsScale = 1; fsOffsetX = 0; fsOffsetY = 0;
    fsPointers.clear();
  }

  function fsPinchDist() {
    const pts = [...fsPointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  }
  function fsPinchCenter() {
    const pts = [...fsPointers.values()];
    if (pts.length < 2) return null;
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  function fsRecenter() {
    fsInitPinchDist = fsPinchDist();
    fsInitScale = fsScale;
    const c = fsPinchCenter();
    if (c) fsInitCenter = c;
    fsInitOffsetX = fsOffsetX;
    fsInitOffsetY = fsOffsetY;
  }

  fsStage.addEventListener('touchstart', (e) => {
    // 对图像自定义手势；对视频保留原生控制，避免吃掉视频自身的点按控制条
    if (fsIsVideo) return;
    e.preventDefault();
    fsSetAnim(false);   // 手势期间逐帧跟手，禁用缓动过渡
    for (const t of e.changedTouches) {
      fsPointers.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    if (fsPointers.size === 1) {
      const id = [...fsPointers.keys()][0];
      const p = fsPointers.get(id);
      fsLastSingle = p;
      fsDownX = p.x; fsDownY = p.y;
      fsDidPan = false;
      fsIsDragging = fsScale > 1;
    } else if (fsPointers.size === 2) {
      fsRecenter();
    }
  }, { passive: false });

  fsStage.addEventListener('touchmove', (e) => {
    if (fsIsVideo) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (fsPointers.has(t.identifier)) {
        fsPointers.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
    }
    if (fsPointers.size === 2) {
      const newDist = fsPinchDist();
      if (fsInitPinchDist > 0) {
        const ratio = newDist / fsInitPinchDist;
        fsScale = clampScale(fsInitScale * ratio);
        applyFsTransform();
      }
    } else if (fsPointers.size === 1) {
      const id = [...fsPointers.keys()][0];
      const p = fsPointers.get(id);
      if (fsIsDragging && fsLastSingle) {
        fsOffsetX += p.x - fsLastSingle.x;
        fsOffsetY += p.y - fsLastSingle.y;
        applyFsTransform();
        if (Math.hypot(p.x - fsDownX, p.y - fsDownY) > 8) fsDidPan = true;
      }
      fsLastSingle = p;
    }
  }, { passive: false });

  fsStage.addEventListener('touchend', (e) => {
    if (fsIsVideo) return;
    for (const t of e.changedTouches) {
      fsPointers.delete(t.identifier);
    }
    if (fsPointers.size === 0) {
      fsSetAnim(true);   // 手势结束，恢复过渡（双击缩放平滑）
      // 单次触摸结束：检测双击；否则仅在没有发生拖动且 scale=1 时视为"点背景关"
      if (!fsDidPan && fsScale <= 1.001) {
        const now = Date.now();
        if (now - fsLastTap < 280) {
          // 双击：切换 1× 与 2.5×
          if (fsScale > 1.001) { fsScale = 1; fsOffsetX = 0; fsOffsetY = 0; }
          else { fsScale = 2.5; }
          fsLastTap = 0;
          applyFsTransform();
        } else {
          fsLastTap = now;
        }
      }
      fsIsDragging = false;
      fsLastSingle = null;
      fsDidPan = false;
    } else if (fsPointers.size === 1) {
      // 二指变单指，重置 single point
      const id = [...fsPointers.keys()][0];
      fsLastSingle = fsPointers.get(id);
      fsIsDragging = fsScale > 1;
    } else if (fsPointers.size >= 2) {
      fsRecenter();
    }
  });

  // 单击空白（图片预览且未缩放）关闭
  fsStage.addEventListener('click', (e) => {
    if (e.target !== fsStage) return;
    if (fsScale <= 1.001 && !fsIsVideo) fsClose();
  });

  // 桌面端：滚轮缩放
  let fsWheelTimer = null;
  fsStage.addEventListener('wheel', (e) => {
    if (fsIsVideo) return;
    e.preventDefault();
    fsSetAnim(false);   // 连续滚轮期间禁用过渡，避免每帧缓动卡顿
    const factor = Math.exp(-e.deltaY * 0.0015);
    fsScale = clampScale(fsScale * factor);
    if (fsScale <= 1.001) { fsOffsetX = 0; fsOffsetY = 0; }
    applyFsTransform();
    clearTimeout(fsWheelTimer);
    fsWheelTimer = setTimeout(() => fsSetAnim(true), 120);
  }, { passive: false });

  fsCloseBtn.addEventListener('click', fsClose);
  document.getElementById('fs-save').addEventListener('click', () => {
    if (fsCurrentItem) saveToDevice(fsCurrentItem);
  });

  // 让预览（相册图片/视频）走全屏；音频保持原弹窗
  function preview(item) {
    if (item.type === 'image' || item.type === 'video') {
      fsOpen(item);
    } else if (item.type === 'audio') {
      previewAudio(item);
    }
  }

  // 对外暴露：聊天媒体全屏预览复用同一套手势 UI
  function previewMedia(media) {
    fsOpen({ blob: media.blob, name: media.name, type: media.type });
  }

  // 保存到设备：分三层兜底
  //  1. Android 壳注入的 AndroidBridge.saveFile(base64,name,mime) → 写 MediaStore / Downloads（最可靠，落到相册或下载目录）
  //  2. Web 分享面板（navigator.share({files})）
  //  3. <a download> 触发浏览器下载
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error || new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
  }

  async function saveToDevice(item) {
    const mime = item.mime || item.blob.type || 'application/octet-stream';
    const name = item.name || 'download';

    // 1) Android 原生桥（最高优先级，最可靠）
    const Bridge = window.AndroidBridge;
    if (Bridge && typeof Bridge.saveFile === 'function') {
      try {
        const b64 = await blobToBase64(item.blob);
        const result = Bridge.saveFile(b64, name, mime);
        if (result && typeof result === 'string' && result.startsWith('OK')) return;
        // 返回 "ERR:..." 时继续走兜底
      } catch (e) { /* 桥失败继续兜底 */ }
    }

    // 2) Web 分享面板（部分 WebView 仍可用）
    try {
      const file = new File([item.blob], name, { type: mime });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
          return;
        } catch (e) {
          if (e.name === 'AbortError') return;   // 用户取消
          // 其他错误 → 继续 fallback
        }
      }
    } catch (e) { /* 继续 fallback */ }

    // 3) <a download> 触发浏览器下载（落到默认下载目录）
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(item.blob);
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return;
    } catch (e) {
      alert('保存失败：' + (e.message || '请检查浏览器权限或存储空间'));
    }
  }

  function exportFile(item) { saveToDevice(item); }

  /* ---------- 文件（音频/文档）操作菜单 ---------- */
  function openFileActionMenu(item, type) {
    activeFileItem = item;
    fileActionMenu.classList.remove('hidden');
  }
  function closeFileActionMenu() {
    fileActionMenu.classList.add('hidden');
    activeFileItem = null;
  }
  document.getElementById('file-action-open').onclick = () => {
    if (activeFileItem) preview(activeFileItem);
    closeFileActionMenu();
  };
  document.getElementById('file-action-save').onclick = () => {
    if (activeFileItem) saveToDevice(activeFileItem);
    closeFileActionMenu();
  };
  document.getElementById('file-action-del').onclick = async () => {
    if (!activeFileItem) { closeFileActionMenu(); return; }
    if (confirm(`删除「${activeFileItem.name}」？`)) { await DB.del('files', activeFileItem.id); refreshFiles(currentFileType); }
    closeFileActionMenu();
  };
  document.getElementById('file-action-cancel').onclick = closeFileActionMenu;
  document.getElementById('file-action-backdrop').onclick = closeFileActionMenu;

  function bindFileRowMenu(row, item, type) {
    let timer = null, long = false, downX = 0, downY = 0;
    row.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      downX = t.clientX; downY = t.clientY;
      long = false;
      timer = setTimeout(() => { long = true; openFileActionMenu(item); }, 500);
    }, { passive: true });
    row.addEventListener('touchmove', (e) => {
      const t = e.changedTouches[0];
      if (Math.hypot(t.clientX - downX, t.clientY - downY) > 10 && timer) { clearTimeout(timer); timer = null; }
    }, { passive: true });
    row.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); openFileActionMenu(item); });
  }

  /* ---------- 笔记 ---------- */
  const noteModal = document.getElementById('note-modal');
  const noteTitle = document.getElementById('note-title');
  const noteContent = document.getElementById('note-content');

  async function refreshNotes() {
    const list = document.getElementById('note-list');
    const notes = (await DB.getAll('notes')).sort((a, b) => b.date - a.date);
    if (notes.length === 0) { list.innerHTML = '<div class="empty-tip">暂无笔记</div>'; return; }
    list.innerHTML = '';
    for (const n of notes) {
      const div = document.createElement('div');
      div.className = 'note-item';
      div.innerHTML = `
        <div class="ntitle">${escapeHtml(n.title) || '（无标题）'}</div>
        <div class="npreview">${escapeHtml(n.content.slice(0, 60))}</div>
        <div class="ndate">${new Date(n.date).toLocaleString('zh-CN')}</div>`;
      div.onclick = () => openNoteEditor(n);
      list.appendChild(div);
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function openNoteEditor(note) {
    editingNoteId = note ? note.id : null;
    document.getElementById('note-modal-title').textContent = note ? '编辑笔记' : '新建笔记';
    noteTitle.value = note ? note.title : '';
    noteContent.value = note ? note.content : '';
    noteModal.classList.remove('hidden');
  }

  document.getElementById('btn-new-note').onclick = () => openNoteEditor(null);
  document.getElementById('btn-note-cancel').onclick = () => noteModal.classList.add('hidden');
  document.getElementById('btn-note-save').onclick = async () => {
    const rec = { title: noteTitle.value.trim(), content: noteContent.value, date: Date.now() };
    if (!rec.title && !rec.content.trim()) { noteModal.classList.add('hidden'); return; }
    if (editingNoteId !== null) rec.id = editingNoteId;
    await DB.put('notes', rec);
    noteModal.classList.add('hidden');
    refreshNotes();
  };
  // 长按笔记删除（移动端友好）；桌面端用右键
  document.getElementById('note-list').addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const items = document.querySelectorAll('#note-list .note-item');
    const idx = Array.from(items).indexOf(e.target.closest('.note-item'));
    if (idx < 0) return;
    const notes = (await DB.getAll('notes')).sort((a, b) => b.date - a.date);
    if (confirm('删除该笔记？')) { await DB.del('notes', notes[idx].id); refreshNotes(); }
  });

  /* ---------- 设置 ---------- */
  document.getElementById('btn-change-pwd').onclick = async () => {
    const msg = document.getElementById('pwd-msg');
    const oldPwd = document.getElementById('old-pwd').value;
    const p1 = document.getElementById('new-pwd').value;
    const p2 = document.getElementById('new-pwd2').value;
    msg.className = 'form-msg';
    if (!(await PwdStore.verify(oldPwd))) { msg.textContent = '当前密码不正确'; msg.classList.add('err'); return; }
    if (!/^\d{4,12}$/.test(p1)) { msg.textContent = '新密码须为 4-12 位数字'; msg.classList.add('err'); return; }
    if (p1 !== p2) { msg.textContent = '两次输入的新密码不一致'; msg.classList.add('err'); return; }
    await PwdStore.set(p1);
    msg.textContent = '密码已修改，下次输入新密码进入';
    msg.classList.add('ok');
    document.getElementById('old-pwd').value = '';
    document.getElementById('new-pwd').value = '';
    document.getElementById('new-pwd2').value = '';
  };

  document.getElementById('btn-wipe').onclick = async () => {
    if (!confirm('确定清空全部文件和笔记？此操作不可恢复！')) return;
    if (!confirm('再次确认：真的要删除隐藏空间里的所有数据吗？')) return;
    await DB.clear('files');
    await DB.clear('notes');
    refreshFiles(currentFileType);
    refreshNotes();
    alert('已清空。');
  };

  /* ---------- 数据备份：导出 / 导入（防清缓存丢数据） ---------- */
  const backupInput = document.getElementById('backup-import-input');
  const backupMsg = document.getElementById('backup-msg');

  function setBackupMsg(text, cls) {
    backupMsg.className = 'form-msg' + (cls ? ' ' + cls : '');
    backupMsg.textContent = text;
  }

  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error || new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
  }

  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'application/octet-stream' });
  }

  document.getElementById('btn-backup-export').onclick = async () => {
    setBackupMsg('正在打包，文件较多时请稍候…');
    try {
      const files = await DB.getAll('files');
      const notes = await DB.getAll('notes');
      if (!files.length && !notes.length) { setBackupMsg('当前没有可导出的数据', 'err'); return; }
      const outFiles = [];
      for (const f of files) {
        outFiles.push({
          type: f.type, name: f.name, mime: f.mime || '', size: f.size, date: f.date,
          b64: await blobToB64(f.blob)
        });
      }
      const data = {
        app: 'calculator-vault', version: 1, exportedAt: Date.now(),
        pwdHash: localStorage.getItem('vault-pwd-hash') || '',
        files: outFiles,
        notes: notes.map(n => ({ title: n.title || '', content: n.content || '', date: n.date }))
      };
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const d = new Date();
      const pad = (x) => String(x).padStart(2, '0');
      const name = `vault-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      setBackupMsg(`已导出 ${outFiles.length} 个文件、${notes.length} 条笔记（${fmtSize(blob.size)}）。备份未加密，请妥善保管。`, 'ok');
    } catch (e) {
      setBackupMsg('导出失败：' + (e.message || e), 'err');
    }
  };

  document.getElementById('btn-backup-import').onclick = () => {
    backupInput.value = '';
    backupInput.click();
  };

  backupInput.addEventListener('change', async () => {
    const f = backupInput.files && backupInput.files[0];
    if (!f) return;
    setBackupMsg('正在读取备份…');
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'calculator-vault' || !Array.isArray(data.files) || !Array.isArray(data.notes)) {
        throw new Error('不是本应用的备份文件');
      }
      const nf = data.files.length, nn = data.notes.length;
      const pwdNote = data.pwdHash ? '，并恢复备份时的进入密码' : '';
      if (!confirm(`备份包含 ${nf} 个文件、${nn} 条笔记（导出于 ${new Date(data.exportedAt || Date.now()).toLocaleString('zh-CN')}）。\n确定导入吗？导入内容将合并进现有数据${pwdNote}。`)) {
        setBackupMsg('已取消导入');
        return;
      }
      setBackupMsg('正在导入，请勿离开此页面…');
      for (const r of data.files) {
        await DB.add('files', {
          type: r.type || 'file', name: r.name || 'file', mime: r.mime || '',
          size: r.size || 0, date: r.date || Date.now(),
          blob: b64ToBlob(r.b64, r.mime || 'application/octet-stream')
        });
      }
      for (const n of data.notes) {
        await DB.put('notes', { title: n.title || '', content: n.content || '', date: n.date || Date.now() });
      }
      if (data.pwdHash) localStorage.setItem('vault-pwd-hash', data.pwdHash);
      refreshFiles(currentFileType);
      refreshNotes();
      setBackupMsg(`导入完成：${nf} 个文件、${nn} 条笔记。`, 'ok');
    } catch (e) {
      setBackupMsg('导入失败：' + (e.message || '文件格式错误'), 'err');
    }
  });

  /* ---------- 启动 ---------- */
  DB.open().then(() => PwdStore.ensureInit());

  /* ---------- 视觉视口（键盘）适配：让聊天输入框始终位于键盘之上 ---------- */
  // 部分 Android WebView 在键盘弹出时 dvh 不收缩，这里用 visualViewport 兜底
  if (window.visualViewport) {
    const updateVV = () => {
      const vh = window.visualViewport.height;
      const top = window.visualViewport.offsetTop;
      // 设置 CSS 变量，聊天面板和聊天输入框可用
      document.documentElement.style.setProperty('--visual-height', vh + 'px');
      document.documentElement.style.setProperty('--visual-top', top + 'px');
    };
    window.visualViewport.addEventListener('resize', updateVV);
    window.visualViewport.addEventListener('scroll', updateVV);
    updateVV();
  } else {
    document.documentElement.style.setProperty('--visual-height', '100dvh');
  }

  return { unlock, lock, previewMedia, closeFsPreview: fsClose };
})();
