const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ============================================================
// ClipShare — WiFi Clipboard Sharing
// ============================================================

const PORT = process.env.PORT || 9977;
const PIN = process.env.CLIPSHARE_PIN || '1stbrain';  // Change this!
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB max
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const DATA_FILE = path.join(__dirname, 'clipshare-data.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Persistent clipboard history — loads from disk, saves on every change
let clipboardHistory = [];
const MAX_HISTORY = 200;
const activeSessions = new Map(); // token → { created, lastSeen }

// --- Persistence ---
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      clipboardHistory = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      console.log(`[ClipShare] Loaded ${clipboardHistory.length} clips from disk`);
    }
  } catch (e) {
    console.error('[ClipShare] Failed to load data:', e.message);
    clipboardHistory = [];
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(clipboardHistory, null, 2));
  } catch (e) {
    console.error('[ClipShare] Failed to save data:', e.message);
  }
}

loadData();

// Generate session token
function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validateToken(token) {
  const session = activeSessions.get(token);
  if (!session) return false;
  session.lastSeen = Date.now();
  return true;
}

// Clean old sessions (>24h)
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600_000;
  for (const [token, s] of activeSessions) {
    if (s.lastSeen < cutoff) activeSessions.delete(token);
  }
}, 3600_000);

// Clean old uploads (>24h)
setInterval(() => {
  try {
    const cutoff = Date.now() - 24 * 3600_000;
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const fp = path.join(UPLOADS_DIR, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch {}
}, 3600_000);

// Express
const app = express();
app.use(express.json({ limit: '10mb' }));

// Multer for file uploads
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// Auth middleware
function auth(req, res, next) {
  const token = req.headers['x-token'] || req.query.token;
  if (!validateToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// --- Routes ---

// Login with PIN
app.post('/api/login', (req, res) => {
  const { pin } = req.body;
  if (pin !== PIN) return res.status(403).json({ error: 'Invalid PIN' });
  const token = createToken();
  activeSessions.set(token, { created: Date.now(), lastSeen: Date.now() });
  res.json({ token });
});

// Get clipboard history
app.get('/api/clipboard', auth, (_req, res) => {
  res.json(clipboardHistory);
});

// Post text to clipboard
app.post('/api/clipboard', auth, (req, res) => {
  const { type, content, label } = req.body;
  const entry = {
    id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    type: type || 'text',  // text, url, image, file
    content,
    label: label || content?.slice?.(0, 60) || 'Clipboard item',
    from: req.headers['x-device'] || 'unknown',
    timestamp: new Date().toISOString(),
  };
  clipboardHistory.unshift(entry);
  if (clipboardHistory.length > MAX_HISTORY) clipboardHistory.pop();
  saveData();
  broadcast({ event: 'new_clip', data: entry });
  res.status(201).json(entry);
});

// Update clip label
app.patch('/api/clipboard/:id', auth, (req, res) => {
  const clip = clipboardHistory.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: 'Not found' });
  if (req.body.label !== undefined) clip.label = req.body.label;
  if (req.body.tags !== undefined) clip.tags = req.body.tags; // optional array
  saveData();
  broadcast({ event: 'clip_updated', data: clip });
  res.json(clip);
});

// Upload file (legacy single-file endpoint)
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(req.file.originalname);
  const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(req.file.originalname);
  const entry = {
    id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    type: isImage ? 'image' : isVideo ? 'video' : 'file',
    content: `/uploads/${req.file.filename}`,
    originalName: req.file.originalname,
    size: req.file.size,
    label: req.file.originalname,
    from: req.headers['x-device'] || 'unknown',
    timestamp: new Date().toISOString(),
  };
  clipboardHistory.unshift(entry);
  if (clipboardHistory.length > MAX_HISTORY) clipboardHistory.pop();
  saveData();
  broadcast({ event: 'new_clip', data: entry });
  res.status(201).json(entry);
});

// Composite entry — text + files in ONE clip
app.post('/api/composite', auth, upload.array('files', 10), (req, res) => {
  const text = req.body.text || '';
  const label = req.body.label || '';
  const attachments = (req.files || []).map(f => {
    const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f.originalname);
    const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(f.originalname);
    return {
      path: `/uploads/${f.filename}`,
      originalName: f.originalname,
      size: f.size,
      type: isImage ? 'image' : isVideo ? 'video' : 'file',
    };
  });

  if (!text && attachments.length === 0) {
    return res.status(400).json({ error: 'Nothing to send' });
  }

  const entry = {
    id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    type: 'composite',
    content: text,
    attachments,
    label: label || text?.slice?.(0, 60) || attachments[0]?.originalName || 'Clip',
    from: req.headers['x-device'] || 'unknown',
    timestamp: new Date().toISOString(),
  };

  // If only text, no attachments → make it text/url type instead
  if (attachments.length === 0) {
    entry.type = 'text';
    try { if (new URL(text).protocol.startsWith('http')) entry.type = 'url'; } catch {}
    delete entry.attachments;
  }
  // If only file(s), no text → use first file as content
  if (!text && attachments.length === 1) {
    entry.type = attachments[0].type;
    entry.content = attachments[0].path;
    entry.originalName = attachments[0].originalName;
    entry.size = attachments[0].size;
    delete entry.attachments;
  }

  clipboardHistory.unshift(entry);
  if (clipboardHistory.length > MAX_HISTORY) clipboardHistory.pop();
  saveData();
  broadcast({ event: 'new_clip', data: entry });
  res.status(201).json(entry);
});

// Serve uploaded files (auth via query param)
app.use('/uploads', (req, res, next) => {
  const token = req.query.token;
  if (!validateToken(token)) return res.status(401).send('Unauthorized');
  next();
}, express.static(UPLOADS_DIR));

// Delete a clip
app.delete('/api/clipboard/:id', auth, (req, res) => {
  const idx = clipboardHistory.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = clipboardHistory.splice(idx, 1);
  // Clean up file if it was an upload
  if (removed.content?.startsWith('/uploads/')) {
    const fp = path.join(__dirname, removed.content);
    try { fs.unlinkSync(fp); } catch {}
  }
  // Clean up composite attachments
  if (removed.attachments) {
    for (const att of removed.attachments) {
      try { fs.unlinkSync(path.join(__dirname, att.path)); } catch {}
    }
  }
  saveData();
  broadcast({ event: 'clip_deleted', data: { id: req.params.id } });
  res.json({ ok: true });
});

// Clear all
app.delete('/api/clipboard', auth, (_req, res) => {
  clipboardHistory.length = 0;
  saveData();
  broadcast({ event: 'cleared' });
  res.json({ ok: true });
});

// Serve the HTML app
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Server + WebSocket ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  // Extract token from URL query
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  if (!validateToken(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  // Get local IP
  const nets = require('os').networkInterfaces();
  let localIp = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address;
        break;
      }
    }
  }
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║         ClipShare — Ready                ║`);
  console.log(`  ╠══════════════════════════════════════════╣`);
  console.log(`  ║  Local:   http://localhost:${PORT}        ║`);
  console.log(`  ║  Network: http://${localIp}:${PORT}   ║`);
  console.log(`  ║  PIN:     ${PIN.padEnd(30)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
