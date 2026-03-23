/**
 * SMS Mirror — Serveur principal
 * Reçoit les messages/notifications/appels depuis l'app Android
 * et les diffuse en temps réel sur le tableau de bord web.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || 'changez-moi-en-production-' + Math.random().toString(36);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'token-android-' + Math.random().toString(36).slice(2, 10);

console.log('═══════════════════════════════════════════════');
console.log('  SMS Mirror — Démarrage du serveur');
console.log('═══════════════════════════════════════════════');
console.log(`  Port         : ${PORT}`);
console.log(`  Device Token : ${DEVICE_TOKEN}`);
console.log(`  Dashboard    : http://localhost:${PORT}`);
console.log('  Mot de passe : voir variable DASHBOARD_PASSWORD');
console.log('═══════════════════════════════════════════════\n');

// ─── Base de données SQLite ───────────────────────────────────────────────────
const db = new Database('sms_mirror.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL,
    device_name TEXT,
    type        TEXT NOT NULL CHECK(type IN ('sms', 'notification', 'call')),
    sender      TEXT,
    sender_name TEXT,
    content     TEXT,
    app_name    TEXT,
    app_package TEXT,
    call_type   TEXT,
    call_duration INTEGER,
    timestamp   INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    is_read     INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
  CREATE INDEX IF NOT EXISTS idx_messages_device ON messages(device_id);

  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    platform    TEXT,
    last_seen   INTEGER,
    token       TEXT
  );
`);

// ─── Application Express ──────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Middleware Auth JWT (pour dashboard) ──────────────────────────────────────
function requireDashboardAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), SECRET_KEY);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

// ─── Middleware Auth Device (pour l'app Android) ──────────────────────────────
function requireDeviceAuth(req, res, next) {
  const token = req.headers['x-device-token'];
  if (!token || token !== DEVICE_TOKEN) {
    return res.status(403).json({ error: 'Token appareil invalide' });
  }
  next();
}

// ─── Routes API ───────────────────────────────────────────────────────────────

// POST /api/login — Connexion au dashboard
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  const token = jwt.sign({ role: 'dashboard' }, SECRET_KEY, { expiresIn: '30d' });
  res.json({ token });
});

// POST /api/device/register — Enregistrer un appareil Android
app.post('/api/device/register', requireDeviceAuth, (req, res) => {
  const { device_id, name, platform } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requis' });

  db.prepare(`
    INSERT INTO devices (id, name, platform, last_seen, token)
    VALUES (@id, @name, @platform, @last_seen, @token)
    ON CONFLICT(id) DO UPDATE SET name=@name, platform=@platform, last_seen=@last_seen
  `).run({ id: device_id, name: name || 'Android', platform: platform || 'android',
           last_seen: Date.now(), token: DEVICE_TOKEN });

  io.emit('device_connected', { device_id, name, platform });
  console.log(`[Appareil] ${name || device_id} connecté (${platform})`);
  res.json({ ok: true, message: 'Appareil enregistré' });
});

// POST /api/messages — Envoyer des messages depuis l'app
app.post('/api/messages', requireDeviceAuth, (req, res) => {
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const inserted = [];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, device_id, device_name, type, sender, sender_name, content,
       app_name, app_package, call_type, call_duration, timestamp, received_at)
    VALUES
      (@id, @device_id, @device_name, @type, @sender, @sender_name, @content,
       @app_name, @app_package, @call_type, @call_duration, @timestamp, @received_at)
  `);

  // Mettre à jour le last_seen de l'appareil
  const updateDevice = db.prepare(`
    UPDATE devices SET last_seen=@ts WHERE id=@id
  `);

  const insertMany = db.transaction((msgs) => {
    for (const msg of msgs) {
      const row = {
        id:            msg.id || uuidv4(),
        device_id:     msg.device_id || 'unknown',
        device_name:   msg.device_name || null,
        type:          msg.type || 'sms',
        sender:        msg.sender || null,
        sender_name:   msg.sender_name || null,
        content:       msg.content || null,
        app_name:      msg.app_name || null,
        app_package:   msg.app_package || null,
        call_type:     msg.call_type || null,
        call_duration: msg.call_duration || null,
        timestamp:     msg.timestamp || Date.now(),
        received_at:   Date.now(),
      };
      const result = insert.run(row);
      if (result.changes > 0) {
        inserted.push(row);
        console.log(`[${row.type.toUpperCase()}] ${row.sender_name || row.sender} → "${(row.content || '').slice(0, 50)}"`);
      }
      updateDevice.run({ ts: Date.now(), id: row.device_id });
    }
  });

  insertMany(messages);

  // Émettre en temps réel vers le dashboard
  if (inserted.length > 0) {
    io.emit('new_messages', inserted);
  }

  res.json({ ok: true, inserted: inserted.length });
});

// GET /api/messages — Récupérer les messages (dashboard)
app.get('/api/messages', requireDashboardAuth, (req, res) => {
  const { type, device_id, search, limit = 200, offset = 0 } = req.query;

  let query = 'SELECT * FROM messages WHERE 1=1';
  const params = {};

  if (type)      { query += ' AND type=@type';           params.type = type; }
  if (device_id) { query += ' AND device_id=@device_id'; params.device_id = device_id; }
  if (search)    {
    query += ' AND (content LIKE @s OR sender LIKE @s OR sender_name LIKE @s OR app_name LIKE @s)';
    params.s = `%${search}%`;
  }

  query += ' ORDER BY timestamp DESC LIMIT @limit OFFSET @offset';
  params.limit = parseInt(limit);
  params.offset = parseInt(offset);

  const messages = db.prepare(query).all(params);
  const total = db.prepare(
    query.replace('SELECT *', 'SELECT COUNT(*) as cnt').replace('ORDER BY timestamp DESC LIMIT @limit OFFSET @offset', '')
  ).get(params)?.cnt || 0;

  res.json({ messages, total });
});

// GET /api/stats — Statistiques pour le dashboard
app.get('/api/stats', requireDashboardAuth, (req, res) => {
  const stats = {
    total:         db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
    sms:           db.prepare("SELECT COUNT(*) as c FROM messages WHERE type='sms'").get().c,
    notifications: db.prepare("SELECT COUNT(*) as c FROM messages WHERE type='notification'").get().c,
    calls:         db.prepare("SELECT COUNT(*) as c FROM messages WHERE type='call'").get().c,
    unread:        db.prepare('SELECT COUNT(*) as c FROM messages WHERE is_read=0').get().c,
    devices:       db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all(),
  };
  res.json(stats);
});

// POST /api/messages/read — Marquer comme lus
app.post('/api/messages/read', requireDashboardAuth, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) {
    db.prepare('UPDATE messages SET is_read=1').run();
  } else {
    const mark = db.prepare('UPDATE messages SET is_read=1 WHERE id=?');
    ids.forEach(id => mark.run(id));
  }
  io.emit('messages_read', { ids });
  res.json({ ok: true });
});

// GET /api/config — Infos de configuration pour l'app Android
app.get('/api/config', requireDeviceAuth, (req, res) => {
  res.json({
    version: '1.0.0',
    server_time: Date.now(),
    sync_interval: 30000, // toutes les 30 secondes
  });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[WebSocket] Dashboard connecté (${socket.id})`);

  socket.on('disconnect', () => {
    console.log(`[WebSocket] Dashboard déconnecté (${socket.id})`);
  });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur démarré sur le port ${PORT}`);
  console.log(`📱 Token Android : ${DEVICE_TOKEN}`);
  console.log(`🔒 Mot de passe dashboard : ${DASHBOARD_PASSWORD}\n`);
});
