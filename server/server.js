/**
 * SMS Mirror – Serveur principal
 * Reçoit les messages/notifications/appels depuis l'app Android
 * et les diffuse en temps réel sur le tableau de bord web.
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const Database   = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

// ── Configuration ────────────────────────────────────────────────────────────
const PORT               = process.env.PORT               || 3000;
const SECRET_KEY         = process.env.SECRET_KEY         || 'changez-moi-' + Math.random().toString(36);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';
const DEVICE_TOKEN       = process.env.DEVICE_TOKEN       || 'token-android-' + Math.random().toString(36).slice(2, 10);

console.log('─────────────────────────────────────────────');
console.log('  SMS Mirror – Démarrage du serveur');
console.log('─────────────────────────────────────────────');
console.log(`  Port         : ${PORT}`);
console.log(`  Device Token : ${DEVICE_TOKEN}`);
console.log('─────────────────────────────────────────────\n');

// ── Base de données SQLite ───────────────────────────────────────────────────
const _dbPath = process.env.DB_PATH || 'sms_mirror.db';
const _dbDir = require('path').dirname(_dbPath);
if (_dbDir !== '.') require('fs').mkdirSync(_dbDir, { recursive: true });
const db = new Database(_dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    device_id     TEXT NOT NULL,
    device_name   TEXT,
    type          TEXT NOT NULL CHECK(type IN ('sms','notification','call')),
    sender        TEXT,
    sender_name   TEXT,
    content       TEXT,
    app_name      TEXT,
    app_package   TEXT,
    call_type     TEXT,
    call_duration INTEGER,
    timestamp     INTEGER NOT NULL,
    received_at   INTEGER NOT NULL,
    is_read       INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_type      ON messages(type);
  CREATE INDEX IF NOT EXISTS idx_messages_device    ON messages(device_id);

  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    platform    TEXT,
    last_seen   INTEGER,
    token       TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT DEFAULT 'user',
    is_active     INTEGER DEFAULT 1,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS device_permissions (
    user_id   INTEGER NOT NULL,
    device_id TEXT    NOT NULL,
    PRIMARY KEY (user_id, device_id)
  );
`);

// ── Migrations ───────────────────────────────────────────────────────────────
try { db.exec("ALTER TABLE messages ADD COLUMN status       TEXT DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE devices  ADD COLUMN number       INTEGER");            } catch(e) {}
try { db.exec("ALTER TABLE devices  ADD COLUMN display_name TEXT");               } catch(e) {}

// Attribuer un numéro aux appareils qui n'en ont pas encore
const devicesWithoutNum = db.prepare("SELECT id FROM devices WHERE number IS NULL ORDER BY last_seen ASC").all();
devicesWithoutNum.forEach(d => {
  const maxNum = db.prepare("SELECT COALESCE(MAX(number),0) as m FROM devices").get().m;
  db.prepare("UPDATE devices SET number=? WHERE id=?").run(maxNum + 1, d.id);
});

// ── Migration: add is_active if missing ──────────────────────────────────────
try { db.exec("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1"); } catch(e) {}

// ── Nouvelles tables: expéditeurs épinglés ───────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS pinned_senders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender     TEXT NOT NULL UNIQUE,
    pinned_at  INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS user_sender_permissions (
    user_id    INTEGER NOT NULL,
    sender     TEXT NOT NULL,
    PRIMARY KEY (user_id, sender)
  );
`);

// Créer l'utilisateur admin par défaut si inexistant
const adminExists = db.prepare("SELECT id FROM users WHERE role='admin'").get();
if (!adminExists) {
  const hash = bcrypt.hashSync(DASHBOARD_PASSWORD, 10);
  db.prepare("INSERT OR IGNORE INTO users (username,password_hash,role) VALUES ('admin',?,'admin')").run(hash);
  console.log('[Auth] Compte admin créé avec le mot de passe DASHBOARD_PASSWORD');
}
// Seed default pinned senders
['Wave Business', '+454', 'MobileMoney', 'MoovMoney'].forEach(function(s) {
  db.prepare('INSERT OR IGNORE INTO pinned_senders (sender) VALUES (?)').run(s);
});


// ── Express + Socket.io ──────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','PATCH','DELETE','PUT'] }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile('index.html', { root: path.join(__dirname, 'public') }));

// ── Middlewares Auth ─────────────────────────────────────────────────────────
function requireDashboardAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(auth.slice(7), SECRET_KEY);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Accès admin requis' });
  next();
}

function requireDeviceAuth(req, res, next) {
  const token = req.headers['x-device-token'];
  if (!token || token !== DEVICE_TOKEN)
    return res.status(403).json({ error: 'Token appareil invalide' });
  next();
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Retourne null pour admin (= tous les appareils), ou tableau d'IDs pour user
function getUserDevices(user) {
  if (user.role === 'admin') return null;
  return db.prepare("SELECT device_id FROM device_permissions WHERE user_id=?")
           .all(user.id).map(p => p.device_id);
}

// Ajoute un filtre device_id IN (...) à une requête named-params
function addDeviceFilter(query, params, allowed) {
  if (allowed === null) return { query, params };
  if (allowed.length === 0) return { query: query + ' AND 1=0', params };
  const dp = {};
  const ph = allowed.map((d, i) => { dp[`_dv${i}`] = d; return `@_dv${i}`; });
  return { query: query + ` AND device_id IN (${ph.join(',')})`, params: { ...params, ...dp } };
}

// ── Routes : Authentification ────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!password) return res.status(401).json({ error: 'Mot de passe requis' });

  const loginUsername = (username || 'admin').trim();
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(loginUsername);

  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Identifiants incorrects' });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET_KEY, { expiresIn: '30d' }
  );
  res.json({ token, role: user.role, username: user.username });
});

// ── Routes : Appareils Android ───────────────────────────────────────────────
app.post('/api/device/register', requireDeviceAuth, (req, res) => {
  const { device_id, name, platform } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requis' });

  const existing = db.prepare("SELECT id FROM devices WHERE id=?").get(device_id);
  if (!existing) {
    const maxNum = db.prepare("SELECT COALESCE(MAX(number),0) as m FROM devices").get().m;
    const num    = maxNum + 1;
    db.prepare(`
      INSERT INTO devices (id,name,display_name,platform,last_seen,token,number)
      VALUES (@id,@name,@dn,@platform,@ts,@tok,@num)
    `).run({
      id: device_id,
      name: name || 'Android',
      dn: name || ('Appareil ' + num),
      platform: platform || 'android',
      ts: Date.now(),
      tok: DEVICE_TOKEN,
      num
    });
  } else {
    db.prepare("UPDATE devices SET name=@name,platform=@platform,last_seen=@ts WHERE id=@id")
      .run({ id: device_id, name: name||'Android', platform: platform||'android', ts: Date.now() });
  }

  io.emit('device_connected', { device_id, name, platform });
  console.log(`[Appareil] ${name||device_id} connecté (${platform||'?'})`);
  res.json({ ok: true });
});

app.post('/api/messages', requireDeviceAuth, (req, res) => {
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const inserted = [];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id,device_id,device_name,type,sender,sender_name,content,
       app_name,app_package,call_type,call_duration,timestamp,received_at)
    VALUES
      (@id,@device_id,@device_name,@type,@sender,@sender_name,@content,
       @app_name,@app_package,@call_type,@call_duration,@timestamp,@received_at)
  `);
  const updateDev = db.prepare("UPDATE devices SET last_seen=@ts WHERE id=@id");

  db.transaction((msgs) => {
    for (const msg of msgs) {
      const row = {
        id:            msg.id            || uuidv4(),
        device_id:     msg.device_id     || 'unknown',
        device_name:   msg.device_name   || null,
        type:          msg.type          || 'sms',
        sender:        msg.sender        || null,
        sender_name:   msg.sender_name   || null,
        content:       msg.content       || null,
        app_name:      msg.app_name      || null,
        app_package:   msg.app_package   || null,
        call_type:     msg.call_type     || null,
        call_duration: msg.call_duration || null,
        timestamp:     msg.timestamp     || Date.now(),
        received_at:   Date.now(),
      };
      if (insert.run(row).changes > 0) {
        inserted.push(row);
        console.log(`[${row.type.toUpperCase()}] ${row.sender_name||row.sender} → "${(row.content||'').slice(0,60)}"`);
      }
      updateDev.run({ ts: Date.now(), id: row.device_id });
    }
  })(messages);

  if (inserted.length > 0) io.emit('new_messages', inserted);
  res.json({ ok: true, inserted: inserted.length });
});

// ── Routes : Messages (dashboard) ───────────────────────────────────────────
app.get('/api/messages', requireDashboardAuth, (req, res) => {
  try {
    const user = req.user;
    const { type, device, search, sender, limit=100, offset=0 } = req.query;
    let whereClauses = [];
    let params = [];
    if (type)   { whereClauses.push("type = ?"); params.push(type); }
    if (device) { whereClauses.push("device_id = ?"); params.push(device); }
    if (search) { whereClauses.push("(content LIKE ? OR sender LIKE ? OR app_name LIKE ? OR sender_name LIKE ?)"); params.push('%'+search+'%','%'+search+'%','%'+search+'%','%'+search+'%'); }
    if (sender) {
      whereClauses.push("COALESCE(sender_name, sender, app_name, '') = ?");
      params.push(sender);
    }
    if (user.role !== 'admin') {
      const allowedSenders = db.prepare('SELECT usp.sender FROM user_sender_permissions usp INNER JOIN pinned_senders ps ON ps.sender = usp.sender WHERE usp.user_id = ?').all(user.id).map(r => r.sender);
      if (allowedSenders.length === 0) return res.json([]);
      const placeholders = allowedSenders.map(() => '?').join(',');
      whereClauses.push("COALESCE(sender_name, sender, app_name, '') IN (" + placeholders + ")");
      params.push(...allowedSenders);
    }
    const where = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
    const rows = db.prepare('SELECT * FROM messages ' + where + ' ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(...params, parseInt(limit), parseInt(offset));
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/senders', requireDashboardAuth, (req, res) => {
  const allowed = getUserDevices(req.user);
  let query  = `SELECT COALESCE(sender_name,sender,app_name,'Inconnu') as display_name,
    sender, sender_name, app_name, type,
    COUNT(*) as count,
    SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) as unread,
    MAX(timestamp) as last_ts
    FROM messages WHERE 1=1`;
  let params = {};
  ({ query, params } = addDeviceFilter(query, params, allowed));
  query += ` GROUP BY COALESCE(sender_name,sender,app_name,'Inconnu') ORDER BY last_ts DESC`;
  let rows = db.prepare(query).all(params);
  if (req.user.role !== 'admin') {
    const allowedSenders = new Set(
      db.prepare('SELECT sender FROM user_sender_permissions WHERE user_id = ?')
        .all(req.user.id).map(r => r.sender)
    );
    rows = rows.filter(r => allowedSenders.has(r.display_name));
  }
  res.json(rows);
});

app.patch('/api/messages/:id/status', requireDashboardAuth, (req, res) => {
  const { status } = req.body;
  if (!['approuve','pas_de_commande',null].includes(status))
    return res.status(400).json({ error: 'Statut invalide' });
  const result = db.prepare('UPDATE messages SET status=? WHERE id=?').run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Message non trouvé' });
  io.emit('message_status_updated', { id: req.params.id, status });
  res.json({ ok: true, id: req.params.id, status });
});

app.get('/api/stats', requireDashboardAuth, (req, res) => {
  const allowed = getUserDevices(req.user);
  let base   = 'FROM messages WHERE 1=1';
  let params = {};
  ({ query: base, params } = addDeviceFilter(base, params, allowed));

  const stats = {
    total:         db.prepare(`SELECT COUNT(*) as c ${base}`).get(params).c,
    sms:           db.prepare(`SELECT COUNT(*) as c ${base} AND type='sms'`).get(params).c,
    notifications: db.prepare(`SELECT COUNT(*) as c ${base} AND type='notification'`).get(params).c,
    calls:         db.prepare(`SELECT COUNT(*) as c ${base} AND type='call'`).get(params).c,
    unread:        db.prepare(`SELECT COUNT(*) as c ${base} AND is_read=0`).get(params).c,
    devices: req.user.role === 'admin'
      ? db.prepare('SELECT * FROM devices ORDER BY number ASC').all()
      : [],
  };
  res.json(stats);
});

app.post('/api/messages/read', requireDashboardAuth, (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) {
    db.prepare('UPDATE messages SET is_read=1').run();
  } else {
    const s = db.prepare('UPDATE messages SET is_read=1 WHERE id=?');
    ids.forEach(id => s.run(id));
  }
  io.emit('messages_read', { ids });
  res.json({ ok: true });
});

app.get('/api/config', requireDeviceAuth, (req, res) => {
  res.json({ version: '1.0.0', server_time: Date.now(), sync_interval: 30000 });
});

// ── Routes : Admin – Utilisateurs ───────────────────────────────────────────
app.get('/api/admin/users', requireDashboardAuth, requireAdmin, (req, res) => {
  const users    = db.prepare("SELECT id,username,role,is_active,created_at FROM users ORDER BY created_at ASC").all();
  const permsStmt= db.prepare("SELECT device_id FROM device_permissions WHERE user_id=?");
  res.json(users.map(u => ({ ...u, device_ids: permsStmt.all(u.id).map(p => p.device_id) })));
});

app.post('/api/admin/users', requireDashboardAuth, requireAdmin, (req, res) => {
  const { username, password, role='user' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username et password requis' });
  if (!['user','admin'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  try {
    const r = db.prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?,?)")
                .run(username.trim(), bcrypt.hashSync(password, 10), role);
    res.json({ ok: true, id: r.lastInsertRowid, username: username.trim(), role });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: "Nom d'utilisateur déjà pris" });
    throw e;
  }
});

app.delete('/api/admin/users/:id', requireDashboardAuth, requireAdmin, (req, res) => {
  const uid = parseInt(req.params.id);
  if (uid === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
  db.prepare("DELETE FROM device_permissions WHERE user_id=?").run(uid);
  db.prepare("DELETE FROM users WHERE id=?").run(uid);
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/password', requireDashboardAuth, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Mot de passe requis' });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?")
    .run(bcrypt.hashSync(password, 10), parseInt(req.params.id));
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/permissions', requireDashboardAuth, requireAdmin, (req, res) => {
  const uid = parseInt(req.params.id);
  const { device_ids } = req.body;
  if (!Array.isArray(device_ids)) return res.status(400).json({ error: 'device_ids doit être un tableau' });
  db.prepare("DELETE FROM device_permissions WHERE user_id=?").run(uid);
  const ins = db.prepare("INSERT OR IGNORE INTO device_permissions (user_id,device_id) VALUES (?,?)");
  db.transaction(ids => ids.forEach(did => ins.run(uid, did)))(device_ids);
  res.json({ ok: true });
});

// ── PATCH /api/admin/users/:id/access — Activer / bloquer un compte ──────────
app.patch('/api/admin/users/:id/access', requireDashboardAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const user = db.prepare('SELECT id, username, is_active FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const newState = user.is_active === 0 ? 1 : 0;
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newState, id);
  res.json({ id: user.id, username: user.username, is_active: newState });
});

// ── Routes : Admin – Expéditeurs épinglés ────────────────────────────────────

// Lister tous les expéditeurs uniques + statut épinglé
app.get('/api/admin/senders', requireDashboardAuth, requireAdmin, (req, res) => {
  try {
    const pinned = new Set(
      db.prepare('SELECT sender FROM pinned_senders').all().map(r => r.sender)
    );
    let msgSenders = [];
    try {
      msgSenders = db.prepare(
        'SELECT DISTINCT s FROM (SELECT COALESCE(app_name, address, phone_number, \'\') AS s FROM messages) WHERE s != \'\''
      ).all().map(r => r.s);
    } catch(e) {}
    const all = [...new Set([...pinned, ...msgSenders])];
    res.json(all.map(s => ({ sender: s, pinned: pinned.has(s) })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Épingler un expéditeur
app.post('/api/admin/senders/pin', requireDashboardAuth, requireAdmin, (req, res) => {
  const { sender } = req.body;
  if (!sender) return res.status(400).json({ error: 'sender requis' });
  try {
    db.prepare('INSERT OR IGNORE INTO pinned_senders (sender) VALUES (?)').run(sender);
    res.json({ ok: true, sender });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Désépingler un expéditeur
app.delete('/api/admin/senders/pin/:sender', requireDashboardAuth, requireAdmin, (req, res) => {
  const sender = decodeURIComponent(req.params.sender);
  db.prepare('DELETE FROM pinned_senders WHERE sender = ?').run(sender);
  // Remove all user permissions for this sender
  db.prepare('DELETE FROM user_sender_permissions WHERE sender = ?').run(sender);
  res.json({ ok: true });
});

// Lister les expéditeurs autorisés pour un utilisateur
app.get('/api/admin/users/:id/senders', requireDashboardAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const senders = db.prepare('SELECT sender FROM user_sender_permissions WHERE user_id = ?').all(id).map(r => r.sender);
  res.json(senders);
});

// Autoriser un expéditeur pour un utilisateur
app.post('/api/admin/users/:id/senders', requireDashboardAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { sender } = req.body;
  if (!sender) return res.status(400).json({ error: 'sender requis' });
  db.prepare('INSERT OR IGNORE INTO user_sender_permissions (user_id, sender) VALUES (?, ?)').run(id, sender);
  res.json({ ok: true });
});

// Retirer l'autorisation d'un expéditeur pour un utilisateur
app.delete('/api/admin/users/:id/senders/:sender', requireDashboardAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const sender = decodeURIComponent(req.params.sender);
  db.prepare('DELETE FROM user_sender_permissions WHERE user_id = ? AND sender = ?').run(id, sender);
  res.json({ ok: true });
});

// ── Routes : Admin – Appareils ───────────────────────────────────────────────
app.get('/api/admin/devices', requireDashboardAuth, requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM devices ORDER BY number ASC, last_seen DESC").all());
});

app.put('/api/admin/devices/:id', requireDashboardAuth, requireAdmin, (req, res) => {
  const { display_name, number } = req.body;
  const updates = [];
  const params  = { id: req.params.id };
  if (display_name !== undefined) { updates.push('display_name=@display_name'); params.display_name = display_name; }
  if (number       !== undefined) { updates.push('number=@number');             params.number       = number;       }
  if (updates.length)
    db.prepare(`UPDATE devices SET ${updates.join(',')} WHERE id=@id`).run(params);
  res.json({ ok: true });
});

// ── WebSocket ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[WebSocket] Dashboard connecté (${socket.id})`);
  socket.on('disconnect', () => console.log(`[WebSocket] Dashboard déconnecté (${socket.id})`));
});

// ── Démarrage ────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✓ Serveur démarré sur le port ${PORT}`);
  console.log(`📱 Token Android  : ${DEVICE_TOKEN}`);
  console.log(`🔐 Mot de passe   : ${DASHBOARD_PASSWORD}\n`);
});
