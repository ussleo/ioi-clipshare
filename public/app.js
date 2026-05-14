const API = location.origin;
let TOKEN = localStorage.getItem('clipshare_token') || '';
let ws = null;
let clips = [];
let wsRetryDelay = 1000;
let pollInterval = null;
let activeDate = null;
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

const DEVICE = navigator.userAgent.includes('Windows') ? 'Windows' :
               navigator.userAgent.includes('Mac') ? 'Mac' :
               navigator.userAgent.includes('Linux') ? 'Linux' : 'Device';

// ---- Auth ----
async function login() {
  const pin = document.getElementById('pinInput').value;
  if (!pin) return;
  try {
    const res = await fetch(`${API}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      document.getElementById('loginError').textContent = 'PIN inválido / Acceso denegado';
      return;
    }
    const { token } = await res.json();
    TOKEN = token;
    localStorage.setItem('clipshare_token', token);
    showApp();
  } catch (e) {
    document.getElementById('loginError').textContent = 'Error de conexión';
  }
}

document.getElementById('pinInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') login();
});

// ---- App ----
function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('deviceLabel').textContent = DEVICE;
  loadClips();
  connectWS();
}

async function loadClips(retries = 2) {
  try {
    const res = await fetch(`${API}/api/clipboard`, { headers: { 'x-token': TOKEN } });
    if (res.status === 401) return logout();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    clips = await res.json();
    render();
    renderCalendar();
  } catch (e) {
    console.warn('[ClipShare] loadClips failed:', e.message);
    if (retries > 0) setTimeout(() => loadClips(retries - 1), 2000);
    else toast('Conexión perdida — presiona 🔄 para reintentar');
  }
}

function connectWS() {
  if (ws) { try { ws.close(); } catch {} }
  try {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}?token=${TOKEN}`);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    wsRetryDelay = 1000;
    document.getElementById('wsDot').className = 'dot';
    document.getElementById('wsLabel').textContent = 'Live';
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    loadClips();
  };
  ws.onclose = () => {
    document.getElementById('wsDot').className = 'dot off';
    document.getElementById('wsLabel').textContent = 'Offline — reintentando...';
    scheduleReconnect();
    if (!pollInterval) {
      pollInterval = setInterval(() => { if (TOKEN) loadClips(0); }, 10000);
    }
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.event === 'new_clip') {
        if (!clips.find(c => c.id === msg.data.id)) {
          clips.unshift(msg.data);
          prependClipEl(msg.data);
          renderCalendar();
          toast('Nuevo dato recibido');
        }
      } else if (msg.event === 'clip_updated') {
        const idx = clips.findIndex(c => c.id === msg.data.id);
        if (idx >= 0) {
          clips[idx] = msg.data;
          patchClipEl(msg.data);
          renderCalendar();
        }
      } else if (msg.event === 'clip_deleted') {
        clips = clips.filter(c => c.id !== msg.data.id);
        removeClipEl(msg.data.id);
        renderCalendar();
      } else if (msg.event === 'cleared') {
        clips = [];
        render();
        renderCalendar();
      }
    } catch {}
  };
}

function scheduleReconnect() {
  setTimeout(connectWS, wsRetryDelay);
  wsRetryDelay = Math.min(wsRetryDelay * 1.5, 30000);
}

// ---- Staging area (new send) ----
let stagedFiles = [];

function stageFiles(input) {
  for (const f of input.files) stagedFiles.push(f);
  input.value = '';
  renderStaged();
}

function removeStagedFile(idx) {
  stagedFiles.splice(idx, 1);
  renderStaged();
}

function renderStaged() {
  const container = document.getElementById('stagedFiles');
  const countEl = document.getElementById('stagedCount');
  countEl.textContent = stagedFiles.length > 0 ? ` (${stagedFiles.length})` : '';
  if (stagedFiles.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = stagedFiles.map((f, i) => {
    const isImg = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f.name) || f.type.startsWith('image/');
    const thumb = isImg
      ? `<img src="${URL.createObjectURL(f)}" alt="${esc(f.name)}">`
      : `<div class="sf-icon">📄</div>`;
    return `<div class="staged-file">
      ${thumb}
      <div class="sf-name">${esc(f.name)}</div>
      <button class="sf-remove" onclick="removeStagedFile(${i})">&times;</button>
    </div>`;
  }).join('');
}

// ---- Send ----
async function sendComposite() {
  const input = document.getElementById('clipInput');
  const labelInput = document.getElementById('clipLabel');
  const text = input.value.trim();
  if (!text && stagedFiles.length === 0) return;

  const form = new FormData();
  if (text) form.append('text', text);
  if (labelInput.value.trim()) form.append('label', labelInput.value.trim());
  for (const f of stagedFiles) form.append('files', f);

  await fetch(`${API}/api/composite?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'x-token': TOKEN, 'x-device': DEVICE },
    body: form,
  });

  input.value = '';
  labelInput.value = '';
  stagedFiles = [];
  renderStaged();
  input.focus();
}

// ---- Edit per-item ----
const editStaged = {};    // id → File[]
const editRemoved = {};   // id → Set<path>

function openEdit(id) {
  const clip = clips.find(c => c.id === id);
  if (!clip) return;

  // Close any other open edit panels
  document.querySelectorAll('.clip-edit-panel[style*="block"]').forEach(el => {
    if (el.id !== `edit-${id}`) { el.style.display = 'none'; }
  });

  const panel = document.getElementById(`edit-${id}`);
  if (!panel) return;

  const isOpen = panel.style.display === 'block';
  if (isOpen) { cancelEdit(id); return; }

  editStaged[id] = [];
  editRemoved[id] = new Set();

  panel.querySelector('.edit-label').value = clip.label || '';
  // Only fill textarea for text-type clips; leave empty for pure file clips
  const textContent = ['text','url','composite'].includes(clip.type) ? (clip.content || '') : '';
  panel.querySelector('.edit-textarea').value = textContent;
  panel.querySelector('.edit-new-count').textContent = '';

  renderEditAtts(id, clip);
  panel.style.display = 'block';
}

function renderEditAtts(id, clip) {
  const panel = document.getElementById(`edit-${id}`);
  if (!panel) return;
  const container = panel.querySelector('.edit-current-files');
  const removed = editRemoved[id] || new Set();

  const allAtts = [];
  if (clip.type === 'composite' && clip.attachments) {
    clip.attachments.forEach(a => allAtts.push(a));
  } else if (['image','video','file'].includes(clip.type) && clip.content?.startsWith('/uploads/')) {
    allAtts.push({ path: clip.content, originalName: clip.originalName || clip.content.split('/').pop(), type: clip.type, size: clip.size });
  }

  if (allAtts.length === 0) { container.innerHTML = ''; return; }

  container.innerHTML = '<div class="edit-atts-label">Archivos actuales:</div>' +
    allAtts.map(att => {
      const isRemoved = removed.has(att.path);
      return `<div class="edit-att-item ${isRemoved ? 'removed' : ''}">
        <span class="edit-att-name">${esc(att.originalName)}</span>
        <span class="edit-att-size">${formatSize(att.size)}</span>
        <button class="clip-btn ${isRemoved ? '' : 'del'}" onclick="toggleRemoveAtt('${id}','${att.path}')">
          ${isRemoved ? '↩️ Restaurar' : '🗑️'}
        </button>
      </div>`;
    }).join('');
}

function toggleRemoveAtt(id, attPath) {
  if (!editRemoved[id]) editRemoved[id] = new Set();
  if (editRemoved[id].has(attPath)) editRemoved[id].delete(attPath);
  else editRemoved[id].add(attPath);
  const clip = clips.find(c => c.id === id);
  if (clip) renderEditAtts(id, clip);
}

function stageEditFile(id, input) {
  if (!editStaged[id]) editStaged[id] = [];
  for (const f of input.files) editStaged[id].push(f);
  input.value = '';
  const panel = document.getElementById(`edit-${id}`);
  if (panel) {
    const countEl = panel.querySelector('.edit-new-count');
    countEl.textContent = editStaged[id].length > 0 ? ` (${editStaged[id].length} nuevos)` : '';
  }
}

async function saveEdit(id) {
  const panel = document.getElementById(`edit-${id}`);
  if (!panel) return;

  const text    = panel.querySelector('.edit-textarea').value;
  const label   = panel.querySelector('.edit-label').value.trim();
  const removed = [...(editRemoved[id] || [])];
  const newFiles = editStaged[id] || [];

  const form = new FormData();
  form.append('content', text);
  form.append('label', label);
  for (const p of removed) form.append('removeFiles', p);
  for (const f of newFiles) form.append('files', f);

  const res = await fetch(`${API}/api/clipboard/${id}`, {
    method: 'PUT',
    headers: { 'x-token': TOKEN, 'x-device': DEVICE },
    body: form,
  });

  if (res.ok) {
    const updated = await res.json();
    const idx = clips.findIndex(c => c.id === id);
    if (idx >= 0) clips[idx] = updated;
    delete editStaged[id];
    delete editRemoved[id];
    patchClipEl(updated);
    renderCalendar();
    toast('Guardado ✓');
  } else {
    toast('Error al guardar');
  }
}

function cancelEdit(id) {
  delete editStaged[id];
  delete editRemoved[id];
  const panel = document.getElementById(`edit-${id}`);
  if (panel) panel.style.display = 'none';
}

// ---- Wipe confirm ----
function showWipeConfirm() {
  document.getElementById('wipeModal').classList.add('visible');
}
function closeWipeConfirm() {
  document.getElementById('wipeModal').classList.remove('visible');
}
async function confirmWipe() {
  closeWipeConfirm();
  await fetch(`${API}/api/clipboard`, {
    method: 'DELETE',
    headers: { 'x-token': TOKEN },
  });
}

// Close modal on overlay click
document.getElementById('wipeModal').addEventListener('click', e => {
  if (e.target === document.getElementById('wipeModal')) closeWipeConfirm();
});

// ---- Calendar ----
function renderCalendar() {
  const cal = document.getElementById('calendar');
  if (!cal) return;

  const datesWithClips = {};
  clips.forEach(c => {
    const d = c.timestamp.slice(0, 10);
    datesWithClips[d] = (datesWithClips[d] || 0) + 1;
  });

  const monthName = new Date(calYear, calMonth, 1)
    .toLocaleString('es', { month: 'long', year: 'numeric' });
  const firstDay  = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const todayStr  = new Date().toISOString().slice(0, 10);

  let html = `
    <div class="cal-header">
      <button class="cal-nav-btn" onclick="calPrev()">‹</button>
      <span class="cal-month-name">${monthName}</span>
      <button class="cal-nav-btn" onclick="calNext()">›</button>
    </div>
    <div class="cal-grid">
      ${['Do','Lu','Ma','Mi','Ju','Vi','Sa'].map(d => `<div class="cal-day-hdr">${d}</div>`).join('')}
      ${Array(firstDay).fill('<div></div>').join('')}
      ${Array.from({ length: daysInMonth }, (_, i) => {
        const d = i + 1;
        const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const count   = datesWithClips[dateStr] || 0;
        const classes = [
          'cal-day',
          count    ? 'has-clips' : '',
          activeDate === dateStr ? 'active' : '',
          dateStr === todayStr   ? 'today'  : '',
        ].filter(Boolean).join(' ');
        return `<div class="${classes}" onclick="setDateFilter('${dateStr}')">${d}${count ? '<span class="cal-dot"></span>' : ''}</div>`;
      }).join('')}
    </div>`;

  if (activeDate) {
    html += `<button class="cal-clear-btn" onclick="setDateFilter(null)">✕ Mostrar todo</button>`;
  }

  cal.innerHTML = html;
  renderCalTitles();
}

function renderCalTitles() {
  const titlesEl = document.getElementById('calTitles');
  if (!titlesEl) return;

  const date = activeDate || new Date().toISOString().slice(0, 10);
  const dayClips = clips.filter(c => c.timestamp.slice(0, 10) === date);

  const dateLabel = new Date(date + 'T12:00:00')
    .toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });

  if (dayClips.length === 0) {
    titlesEl.innerHTML = `
      <div class="cal-titles-header">${dateLabel}</div>
      <div class="cal-no-items">Sin items</div>`;
    return;
  }

  titlesEl.innerHTML = `
    <div class="cal-titles-header">
      ${dateLabel} <span class="cal-count">${dayClips.length}</span>
    </div>
    <div class="cal-title-list">
      ${dayClips.map(c => `
        <div class="cal-title-item" onclick="scrollToClip('${c.id}')">
          <span class="cal-title-dot ${c.type}"></span>
          <span class="cal-title-text">${esc(c.label || c.content?.slice(0, 50) || 'Clip')}</span>
        </div>`).join('')}
    </div>`;
}

function calPrev() {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
}

function calNext() {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

function setDateFilter(date) {
  activeDate = (date === null || activeDate === date) ? null : date;
  renderCalendar();
  render();
}

function scrollToClip(id) {
  // Si hay filtro activo y el clip no es de esa fecha, quitar filtro primero
  if (activeDate) {
    const clip = clips.find(c => c.id === id);
    if (clip && clip.timestamp.slice(0, 10) !== activeDate) {
      activeDate = null;
      renderCalendar();
      render();
    }
  }
  setTimeout(() => {
    const el = document.querySelector(`.clip[data-id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 80);
}

// ---- Render (smart DOM updates — no re-render completo en eventos WS) ----

function clipInnerHTML(c) {
  const time = new Date(c.timestamp).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const date = new Date(c.timestamp).toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: '2-digit' });

  let contentHtml = '';
  let attachHtml  = '';

  if (c.type === 'composite') {
    if (c.content) {
      const lines = c.content.split('\n').map(line => {
        try {
          const url = new URL(line.trim());
          if (url.protocol.startsWith('http'))
            return `<a href="${esc(line.trim())}" target="_blank" rel="noopener">${esc(line.trim())}</a>`;
        } catch {}
        return esc(line);
      });
      contentHtml = `<div>${lines.join('<br>')}</div>`;
    }
    if (c.attachments?.length > 0) {
      attachHtml = `<div class="clip-attachments">${c.attachments.map(att => renderAtt(att)).join('')}</div>`;
    }
  } else if (c.type === 'url') {
    contentHtml = `<a href="${esc(c.content)}" target="_blank" rel="noopener">${esc(c.content)}</a>`;
  } else if (c.type === 'image') {
    contentHtml = `<img src="${API}${c.content}?token=${TOKEN}" alt="${esc(c.originalName || 'image')}" loading="lazy">`;
  } else if (c.type === 'video') {
    contentHtml = `<video controls src="${API}${c.content}?token=${TOKEN}"></video>`;
  } else if (c.type === 'file') {
    contentHtml = renderAtt({ path: c.content, originalName: c.originalName, size: c.size, type: 'file' });
  } else {
    contentHtml = `<pre>${esc(c.content)}</pre>`;
  }

  const hasLabel = c.label && c.label !== c.content?.slice?.(0, 60);
  const labelHtml = hasLabel
    ? `<span class="clip-label-text" id="label-${c.id}" onclick="editLabel('${c.id}')" title="Editar título">${esc(c.label)}</span>`
    : `<span class="clip-label-text empty" id="label-${c.id}" onclick="editLabel('${c.id}')" title="Agregar título">+ agregar título</span>`;

  const isFile      = ['image','video','file'].includes(c.type) && c.content?.startsWith('/uploads/');
  const hasAtts     = c.type === 'composite' && c.attachments?.length > 0;

  // Edit panel (starts hidden)
  const editPanel = `
    <div class="clip-edit-panel" id="edit-${c.id}" style="display:none">
      <input class="edit-label label-input" placeholder="Título">
      <textarea class="edit-textarea" placeholder="Texto, URLs..."></textarea>
      <div class="edit-current-files"></div>
      <div class="edit-add-row">
        <button class="btn" onclick="document.getElementById('ef-${c.id}').click()">
          📎 Agregar archivos<span class="edit-new-count"></span>
        </button>
        <input type="file" class="file-input" id="ef-${c.id}" onchange="stageEditFile('${c.id}',this)" multiple>
      </div>
      <div class="edit-actions">
        <button class="btn primary" onclick="saveEdit('${c.id}')">💾 Guardar</button>
        <button class="btn" onclick="cancelEdit('${c.id}')">Cancelar</button>
      </div>
    </div>`;

  return `
    <div class="clip-header">
      <span class="clip-type ${c.type}">${c.type === 'composite' ? 'BUNDLE' : c.type.toUpperCase()}</span>
      <span>${esc(c.from)}</span>
      <span>•</span>
      <span>${date} ${time}</span>
    </div>
    <div class="clip-label">${labelHtml}</div>
    <div class="clip-content">${contentHtml}</div>
    ${attachHtml}
    <div class="clip-actions">
      <button class="clip-btn" onclick="copyClip('${c.id}')" title="Copiar">📋</button>
      <button class="clip-btn" onclick="openEdit('${c.id}')" title="Editar">✏️ Editar</button>
      ${isFile || hasAtts ? `<button class="clip-btn" onclick="downloadClip('${c.id}')" title="Descargar">⬇️</button>` : ''}
      <button class="clip-btn del" onclick="deleteClip('${c.id}')" title="Eliminar">🗑️</button>
    </div>
    ${editPanel}`;
}

function renderAtt(att) {
  if (att.type === 'image') {
    return `<a href="${API}${att.path}?token=${TOKEN}" target="_blank">
      <img src="${API}${att.path}?token=${TOKEN}" alt="${esc(att.originalName)}" loading="lazy"></a>`;
  }
  if (att.type === 'video') {
    return `<video controls src="${API}${att.path}?token=${TOKEN}"></video>`;
  }
  const isText = /\.(txt|md|json|csv|log|yaml|yml|xml|html|css|js|ts)$/i.test(att.originalName || '');
  const url = `${API}${att.path}?token=${TOKEN}`;
  return `<div class="att-file">
    📎 <a href="${url}" download="${esc(att.originalName)}">${esc(att.originalName)}</a>
    <span class="att-size">${formatSize(att.size)}</span>
    ${isText ? `<button class="clip-btn" onclick="previewText(event,'${url}')">👁️</button>` : ''}
  </div>`;
}

async function previewText(event, url) {
  const btn = event.currentTarget;
  const previewId = `prev-${btoa(url).replace(/[^a-z0-9]/gi,'').slice(0,16)}`;
  const existing = document.getElementById(previewId);
  if (existing) { existing.remove(); return; }
  try {
    const res = await fetch(url);
    const text = await res.text();
    const div = document.createElement('div');
    div.id = previewId;
    div.className = 'text-preview';
    div.innerHTML = `<button class="preview-close" onclick="this.parentElement.remove()">✕ cerrar</button><pre>${esc(text)}</pre>`;
    btn.closest('.att-file, .clip-content').after(div);
  } catch { toast('No se pudo cargar el archivo'); }
}

function render() {
  const container = document.getElementById('clips');
  const empty     = document.getElementById('emptyState');

  const filtered = activeDate
    ? clips.filter(c => c.timestamp.slice(0, 10) === activeDate)
    : clips;

  if (filtered.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  container.innerHTML = filtered.map(c =>
    `<div class="glass-element clip" data-id="${c.id}">${clipInnerHTML(c)}</div>`
  ).join('');
}

// Smart DOM patching — no tocan el resto del feed
function prependClipEl(clip) {
  if (activeDate && clip.timestamp.slice(0, 10) !== activeDate) return;
  const container = document.getElementById('clips');
  document.getElementById('emptyState').style.display = 'none';
  const div = document.createElement('div');
  div.className = 'glass-element clip';
  div.dataset.id = clip.id;
  div.innerHTML = clipInnerHTML(clip);
  container.prepend(div);
}

function patchClipEl(clip) {
  const el = document.querySelector(`.clip[data-id="${clip.id}"]`);
  if (el) {
    el.innerHTML = clipInnerHTML(clip);
  } else if (!activeDate || clip.timestamp.slice(0, 10) === activeDate) {
    render();
  }
}

function removeClipEl(id) {
  document.querySelector(`.clip[data-id="${id}"]`)?.remove();
  if (!document.querySelector('.clip')) {
    document.getElementById('emptyState').style.display = 'block';
  }
}

// ---- Acciones ----
function editLabel(id) {
  const clip = clips.find(c => c.id === id);
  if (!clip) return;
  const el = document.getElementById(`label-${id}`);
  if (!el) return;
  el.outerHTML = `<input class="clip-label-input" id="label-edit-${id}" value="${esc(clip.label || '')}"
    onblur="saveLabel('${id}')"
    onkeydown="if(event.key==='Enter'){event.preventDefault();saveLabel('${id}');}
               if(event.key==='Escape'){patchClipEl(clips.find(c=>c.id==='${id}'));}" autofocus>`;
  const inp = document.getElementById(`label-edit-${id}`);
  if (inp) { inp.focus(); inp.select(); }
}

async function saveLabel(id) {
  const inp = document.getElementById(`label-edit-${id}`);
  if (!inp) return;
  const newLabel = inp.value.trim();
  const clip = clips.find(c => c.id === id);
  if (!clip) return;
  clip.label = newLabel;
  patchClipEl(clip);
  await fetch(`${API}/api/clipboard/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-token': TOKEN },
    body: JSON.stringify({ label: newLabel }),
  });
}

async function copyClip(id) {
  const clip = clips.find(c => c.id === id);
  if (!clip) return;
  if (['image','video','file'].includes(clip.type)) {
    await navigator.clipboard.writeText(`${API}${clip.content}?token=${TOKEN}`);
    toast('Link copiado!');
  } else {
    await navigator.clipboard.writeText(clip.content || '');
    toast('Copiado!');
  }
}

async function downloadClip(id) {
  const clip = clips.find(c => c.id === id);
  if (!clip) return;
  const target = clip.content?.startsWith('/uploads/') ? clip
    : clip.attachments?.[0] ? { content: clip.attachments[0].path, originalName: clip.attachments[0].originalName }
    : null;
  if (!target) return;
  const a = document.createElement('a');
  a.href = `${API}${target.content}?token=${TOKEN}`;
  a.download = target.originalName || 'download';
  a.click();
}

async function deleteClip(id) {
  await fetch(`${API}/api/clipboard/${id}`, {
    method: 'DELETE',
    headers: { 'x-token': TOKEN },
  });
}

function logout() {
  TOKEN = '';
  localStorage.removeItem('clipshare_token');
  document.getElementById('app').classList.remove('visible');
  document.getElementById('loginScreen').style.display = 'flex';
}

// ---- Paste global ----
document.addEventListener('paste', async (e) => {
  if (!TOKEN) return;
  if (e.clipboardData.files.length > 0) {
    // No interceptar si el foco está dentro de un panel de edición de item
    if (document.activeElement?.closest('.clip-edit-panel')) return;
    e.preventDefault();
    for (const file of e.clipboardData.files) stagedFiles.push(file);
    renderStaged();
    toast('Archivo adjuntado — Ctrl+Enter para enviar');
    document.getElementById('clipInput').focus();
  }
});

document.getElementById('clipInput').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendComposite(); }
});

// ---- Helpers ----
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ---- Init ----
(async () => {
  if (TOKEN) {
    try {
      const res = await fetch(`${API}/api/clipboard`, { headers: { 'x-token': TOKEN } });
      if (res.ok) return showApp();
      if (res.status === 401) { TOKEN = ''; localStorage.removeItem('clipshare_token'); }
    } catch {
      return showApp();
    }
  }
  document.getElementById('loginScreen').style.display = 'flex';
})();
