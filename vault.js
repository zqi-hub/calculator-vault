/* vault.js — 隐藏空间：文件管理 + 笔记 + 设置 */
const Vault = (() => {
  const screenCalc = document.getElementById('screen-calc');
  const screenVault = document.getElementById('screen-vault');
  const fileInput = document.getElementById('file-input');
  const TYPE_TABS = ['album', 'audio', 'doc'];
  const TYPE_LABEL = { album: '相册', audio: '音频', doc: '文档' };
  const ACCEPT = {
    album: 'image/*,video/*',
    audio: 'audio/*',
    doc: '.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.md,.csv,application/pdf,text/*'
  };
  let currentFileType = 'album';
  let editingNoteId = null;

  function unlock() {
    screenCalc.classList.add('hidden');
    screenVault.classList.remove('hidden');
    refreshFiles(currentFileType);
    refreshNotes();
  }

  function lock() {
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
    pane.innerHTML = `
      <div class="pane-toolbar">
        <button class="btn primary" data-import="${type}">＋ 导入${TYPE_LABEL[type]}</button>
        <span class="muted">文件仅保存在本机浏览器存储中，不上传</span>
      </div>
      <div class="file-grid ${type === 'doc' || type === 'audio' ? 'doc-mode' : ''}" id="grid-${type}"></div>`;
  });
  document.querySelectorAll('[data-import]').forEach(btn => {
    btn.addEventListener('click', () => {
      fileInput.accept = ACCEPT[btn.dataset.import];
      fileInput.dataset.type = btn.dataset.import;
      fileInput.value = '';
      fileInput.click();
    });
  });

  fileInput.addEventListener('change', async () => {
    const paneType = fileInput.dataset.type;
    for (const f of fileInput.files) {
      // 相册导入时按真实媒体类型存储（image / video），其余面板直接用面板类型
      const storeType = paneType === 'album'
        ? (f.type.startsWith('video/') ? 'video' : 'image')
        : paneType;
      await DB.add('files', { type: storeType, name: f.name, mime: f.type, size: f.size, blob: f, date: Date.now() });
    }
    refreshFiles(paneType);
  });

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  async function refreshFiles(type) {
    const grid = document.getElementById('grid-' + type);
    // 相册面板同时显示图片和视频（含旧版本遗留的 image/video 记录）
    const match = type === 'album'
      ? (f) => f.type === 'image' || f.type === 'video'
      : (f) => f.type === type;
    const all = (await DB.getAll('files')).filter(match).sort((a, b) => b.date - a.date);
    if (all.length === 0) {
      grid.innerHTML = `<div class="empty-tip">暂无${TYPE_LABEL[type]}，点击上方按钮导入</div>`;
      return;
    }
    grid.innerHTML = '';
    for (const item of all) {
      if (type === 'doc' || type === 'audio') {
        const row = document.createElement('div');
        row.className = 'doc-row';
        row.innerHTML = `
          <span class="dicon">${type === 'audio' ? '🎵' : '📄'}</span>
          <span class="dname" title="${item.name}">${item.name}</span>
          <span class="dsize">${fmtSize(item.size)}</span>
          <button class="btn small" data-act="open">打开</button>
          <button class="btn small" data-act="save">导出</button>
          <button class="btn small danger" data-act="del">删除</button>`;
        row.querySelector('[data-act="open"]').onclick = () => preview(item);
        row.querySelector('[data-act="save"]').onclick = () => exportFile(item);
        row.querySelector('[data-act="del"]').onclick = async () => {
          if (confirm(`删除「${item.name}」？`)) { await DB.del('files', item.id); refreshFiles(type); }
        };
        grid.appendChild(row);
      } else {
        const card = document.createElement('div');
        card.className = 'file-card';
        const url = URL.createObjectURL(item.blob);
        const thumb = item.type === 'image'
          ? `<img class="file-thumb" src="${url}" alt="">`
          : `<div class="file-thumb icon-mode">🎬</div>`;
        card.innerHTML = `${thumb}<div class="fname">${item.name}</div><button class="file-del" title="删除">✕</button>`;
        card.querySelector('.file-thumb').addEventListener('click', () => preview(item));
        card.querySelector('.file-del').onclick = async () => {
          if (confirm(`删除「${item.name}」？`)) { await DB.del('files', item.id); refreshFiles(type); }
        };
        grid.appendChild(card);
      }
    }
  }

  /* ---------- 预览 / 导出 ---------- */
  const previewModal = document.getElementById('preview-modal');
  const previewBody = document.getElementById('preview-body');
  const previewName = document.getElementById('preview-name');
  let previewUrl = null;

  function preview(item) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(item.blob);
    previewName.textContent = item.name;
    if (item.type === 'image') previewBody.innerHTML = `<img src="${previewUrl}">`;
    else if (item.type === 'video') previewBody.innerHTML = `<video src="${previewUrl}" controls autoplay></video>`;
    else if (item.type === 'audio') previewBody.innerHTML = `<audio src="${previewUrl}" controls autoplay></audio>`;
    else previewBody.innerHTML = `<p class="muted">文档不支持在线预览，请导出后查看。</p>`;
    previewModal.classList.remove('hidden');
  }

  document.getElementById('btn-preview-close').onclick = () => {
    previewModal.classList.add('hidden');
    previewBody.innerHTML = '';
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  };

  function exportFile(item) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(item.blob);
    a.download = item.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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

  /* ---------- 启动 ---------- */
  DB.open().then(() => PwdStore.ensureInit());

  return { unlock, lock };
})();
