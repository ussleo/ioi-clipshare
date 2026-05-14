const express    = require('express');
const http       = require('http');
const { WebSocketServer } = require('ws');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const Database   = require('better-sqlite3');

// ============================================================
// ClipShare — WiFi Clipboard Sharing  (SQLite edition)
// ============================================================

const PORT        = process.env.PORT || 9977;
const PIN         = process.env.CLIPSHARE_PIN || '1stbrain';
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_FILE     = path.join(__dirname, 'clipshare.db');
const JSON_FILE   = path.join(__dirname, 'clipshare-data.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---- Database setup ----
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');  // safe concurrent reads
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clips (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL DEFAULT 'text',
    content      TEXT,
    label        TEXT,
    from_device  TEXT,
    timestamp    TEXT NOT NULL,
    original_name TEXT,
    size         INTEGER,
    attachments  TEXT,
    tags         TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created    INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
`);

// ---- Prepared statements ----
const stmts = {
  insertClip: db.prepare(`
    INSERT OR REPLACE INTO clips
      (id, type, content, label, from_device, timestamp, original_name, size, attachments, tags)
    VALUES
      (@id, @type, @content, @label, @from_device, @timestamp, @original_name, @size, @attachments, @tags)
  `),
  updateClip: db.prepare(`
    UPDATE clips SET type=@type, content=@content, label=@label,
      original_name=@original_name, size=@size, attachments=@attachments, tags=@tags
    WHERE id=@id
  `),
  deleteClip:    db.prepare('DELETE FROM clips WHERE id = ?'),
  deleteAllClips: db.prepare('DELETE FROM clips'),
  getClip:       db.prepare('SELECT * FROM clips WHERE id = ?'),
  getAllClips:   db.prepare('SELECT * FROM clips ORDER BY timestamp DESC'),
  countClips:   db.prepare('SELECT COUNT(*) AS n FROM clips'),

  upsertSession: db.prepare(`
    INSERT INTO sessions (token, created, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET last_seen = excluded.last_seen
  `),
  touchSession:  db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?'),
  getSession:    db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteOldSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ?'),
};

// ---- Serialize / deserialize clips ----
function rowToClip(row) {
  if (!row) return null;
  return {
    id:           row.id,
    type:         row.type,
    content:      row.content,
    label:        row.label,
    from:         row.from_device,
    timestamp:    row.timestamp,
    originalName: row.original_name,
    size:         row.size,
    attachments:  row.attachments ? JSON.parse(row.attachments) : undefined,
    tags:         row.tags        ? JSON.parse(row.tags)        : undefined,
  };
}

function clipToRow(clip) {
  return {
    id:            clip.id,
    type:          clip.type,
    content:       clip.content   ?? null,
    label:         clip.label     ?? null,
    from_device:   clip.from      ?? 'unknown',
    timestamp:     clip.timestamp,
    original_name: clip.originalName ?? null,
    size:          clip.size      ?? null,
    attachments:   clip.attachments ? JSON.stringify(clip.attachments) : null,
    tags:          clip.tags        ? JSON.stringify(clip.tags)        : null,
  };
}

const MAX_HISTORY = 200;

function saveClip(clip) {
  stmts.insertClip.run(clipToRow(clip));
  // Trim to MAX_HISTORY
  const { n } = stmts.countClips.get();
  if (n > MAX_HISTORY) {
    db.prepare(`
      DELETE FROM clips WHERE id IN (
        SELECT id FROM clips ORDER BY timestamp ASC LIMIT ?
      )
    `).run(n - MAX_HISTORY);
  }
}

function getAllClips() {
  return stmts.getAllClips.all().map(rowToClip);
}

// ---- Migrate from JSON if DB is empty ----
if (fs.existsSync(JSON_FILE)) {
  const { n } = stmts.countClips.get();
  if (n === 0) {
    try {
      const legacy = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
      const insert = db.transaction(items => {
        for (const c of items) {
          stmts.insertClip.run(clipToRow({ ...c, from: c.from || 'unknown' }));
        }
      });
      insert(legacy);
      console.log(`[ClipShare] Migrated ${legacy.length} clips from JSON → SQLite`);
      fs.renameSync(JSON_FILE, JSON_FILE + '.migrated');
    } catch (e) {
      console.error('[ClipShare] Migration failed:', e.message);
    }
  }
}

console.log(`[ClipShare] DB loaded — ${stmts.countClips.get().n} clips`);

// ---- Sessions ----
function createToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  stmts.upsertSession.run(token, now, now);
  return token;
}

function validateToken(token) {
  if (!token) return false;
  const session = stmts.getSession.get(token);
  if (!session) return false;
  stmts.touchSession.run(Date.now(), token);
  return true;
}

// Cleanup jobs
setInterval(() => {
  stmts.deleteOldSessions.run(Date.now() - 24 * 3600_000);
}, 3600_000);

setInterval(() => {
  try {
    const cutoff = Date.now() - 24 * 3600_000;
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const fp = path.join(UPLOADS_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch {}
}, 3600_000);

// ---- Express ----
const app = express();
app.use(express.json({ limit: '10mb' }));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

function auth(req, res, next) {
  const token = req.headers['x-token'] || req.query.token;
  if (!validateToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ---- Routes ----

app.post('/api/login', (req, res) => {
  const { pin } = req.body;
  if (pin !== PIN) return res.status(403).json({ error: 'Invalid PIN' });
  res.json({ token: createToken() });
});

app.get('/api/clipboard', auth, (_req, res) => {
  res.json(getAllClips());
});

app.post('/api/clipboard', auth, (req, res) => {
  const { type, content, label } = req.body;
  const clip = {
    id:        Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    type:      type || 'text',
    content,
    label:     label || content?.slice?.(0, 60) || 'Clipboard item',
    from:      req.headers['x-device'] || 'unknown',
    timestamp: new Date().toISOString(),
  };
  saveClip(clip);
  broadcast({ event: 'new_clip', data: clip });
  res.status(201).json(clip);
});

app.patch('/api/clipboard/:id', auth, (req, res) => {
  const row  = stmts.getClip.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const clip = rowToClip(row);
  if (req.body.label !== undefined) clip.label = req.body.label;
  if (req.body.tags  !== undefined) clip.tags  = req.body.tags;
  stmts.updateClip.run(clipToRow(clip));
  broadcast({ event: 'clip_updated', data: clip });
  res.json(clip);
});

// Full edit: text + attachments
app.put('/api/clipboard/:id', auth, upload.array('files', 10), (req, res) => {
  const row = stmts.getClip.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const clip = rowToClip(row);

  if (req.body.label   !== undefined) clip.label   = req.body.label.trim() || clip.label;
  if (req.body.content !== undefined) clip.content = req.body.content;

  // Remove attachments
  const toRemove = req.body.removeFiles
    ? (Array.isArray(req.body.removeFiles) ? req.body.removeFiles : [req.body.removeFiles])
    : [];

  if (toRemove.length > 0) {
    if (clip.attachments) {
      clip.attachments = clip.attachments.filter(att => {
        if (toRemove.includes(att.path)) {
          try { fs.unlinkSync(path.join(__dirname, att.path)); } catch {}
          return false;
        }
        return true;
      });
    }
    if (toRemove.includes(clip.content)) {
      try { fs.unlinkSync(path.join(__dirname, clip.content)); } catch {}
      clip.content = '';
    }
  }

  // Add new files
  if (req.files?.length > 0) {
    const newAtts = req.files.map(f => {
      const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(f.originalname);
      const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(f.originalname);
      return {
        path: `/uploads/${f.filename}`,
        originalName: f.originalname,
        size: f.size,
        type: isImage ? 'image' : isVideo ? 'video' : 'file',
      };
    });
    if (!clip.attachments) clip.attachments = [];
    clip.attachments.push(...newAtts);
  }

  // Recalculate type
  const hasText = clip.content?.trim();
  const hasAtts = clip.attachments?.length > 0;

  if (hasAtts) {
    clip.type = 'composite';
  } else if (hasText && !clip.content.startsWith('/uploads/')) {
    clip.type = 'text';
    try { if (new URL(clip.content.trim()).protocol.startsWith('http')) clip.type = 'url'; } catch {}
  }

  if (clip.attachments?.length === 0) clip.attachments = undefined;

  stmts.updateClip.run(clipToRow(clip));
  broadcast({ event: 'clip_updated', data: clip });
  res.json(clip);
});

// Upload file (single)
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(req.file.originalname);
  const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(req.file.originalname);
  const clip = {
    id:           Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    type:         isImage ? 'image' : isVideo ? 'video' : 'file',
    content:      `/uploads/${req.file.filename}`,
    originalName: req.file.originalname,
    size:         req.file.size,
    label:        req.file.originalname,
    from:         req.headers['x-device'] || 'unknown',
    timestamp:    new Date().toISOString(),
  };
  saveClip(clip);
  broadcast({ event: 'new_clip', data: clip });
  res.status(201).json(clip);
});

// Composite: text + files
app.post('/api/composite', auth, upload.array('files', 10), (req, res) => {
  const text  = req.body.text  || '';
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

  const clip = {
    id:          Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    type:        'composite',
    content:     text,
    attachments,
    label:       label || text?.slice?.(0, 60) || attachments[0]?.originalName || 'Clip',
    from:        req.headers['x-device'] || 'unknown',
    timestamp:   new Date().toISOString(),
  };

  if (attachments.length === 0) {
    clip.type = 'text';
    delete clip.attachments;
    try { if (new URL(text).protocol.startsWith('http')) clip.type = 'url'; } catch {}
  } else if (!text && attachments.length === 1) {
    clip.type         = attachments[0].type;
    clip.content      = attachments[0].path;
    clip.originalName = attachments[0].originalName;
    clip.size         = attachments[0].size;
    delete clip.attachments;
  }

  saveClip(clip);
  broadcast({ event: 'new_clip', data: clip });
  res.status(201).json(clip);
});

// Serve uploads (auth via query param)
app.use('/uploads', (req, res, next) => {
  if (!validateToken(req.query.token)) return res.status(401).send('Unauthorized');
  next();
}, express.static(UPLOADS_DIR));

// Delete one clip
app.delete('/api/clipboard/:id', auth, (req, res) => {
  const row = stmts.getClip.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const clip = rowToClip(row);

  if (clip.content?.startsWith('/uploads/')) {
    try { fs.unlinkSync(path.join(__dirname, clip.content)); } catch {}
  }
  if (clip.attachments) {
    for (const att of clip.attachments) {
      try { fs.unlinkSync(path.join(__dirname, att.path)); } catch {}
    }
  }
  stmts.deleteClip.run(req.params.id);
  broadcast({ event: 'clip_deleted', data: { id: req.params.id } });
  res.json({ ok: true });
});

// Clear all
app.delete('/api/clipboard', auth, (_req, res) => {
  stmts.deleteAllClips.run();
  broadcast({ event: 'cleared' });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- WebSocket ----
const server   = http.createServer(app);
const wss      = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  if (!validateToken(token)) { ws.close(4001, 'Unauthorized'); return; }
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

// ---- Start ----
server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let localIp = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; }
    }
  }
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║         ClipShare — Ready (SQLite)       ║`);
  console.log(`  ╠══════════════════════════════════════════╣`);
  console.log(`  ║  Local:   http://localhost:${PORT}        ║`);
  console.log(`  ║  Network: http://${localIp}:${PORT}   ║`);
  console.log(`  ║  PIN:     ${PIN.padEnd(30)}║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
