/**
 * SMS Mirror – Serveur principal (version Firestore + liste blanche)
 * - Ne conserve QUE les expéditeurs autorisés (Wave Business, +454, MobileMoney, MoovMoney)
 *   + les notifications Wave (perso) « Transfert reçu » retaguées Wave Business.
 * - Persistance durable via Firebase Firestore (survit aux redéploiements Railway).
 *   SQLite reste la base de travail locale (rapide), rechargée depuis Firestore au démarrage.
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
const HYDRATE_LIMIT      = parseInt(process.env.HYDRATE_LIMIT || '40000', 10); // messages récents chargés en SQLite au boot

console.log('─────────────────────────────────────────────');
console.log('  SMS Mirror – Démarrage du serveur');
console.log('─────────────────────────────────────────────');
console.log(`  Port         : ${PORT}`);
console.log(`  Device Token : ${DEVICE_TOKEN}`);
console.log('─────────────────────────────────────────────\n');

// ── Firebase Firestore (persistance durable) ─────────────────────────────────
let fsdb = null;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    const admin = require('firebase-admin');
    const creds = JSON.parse(raw);
    if (creds.private_key && creds.private_key.includes('\\n')) {
      creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    fsdb = admin.firestore();
    console.log('[Firestore] ✓ Connecté au projet', creds.project_id || '(?)');
  } else {
    console.warn('[Firestore] ⚠ FIREBASE_SERVICE_ACCOUNT absent — démarrage SANS persistance cloud (données perdues au redéploiement !)');
  }
} catch (e) {
  console.error('[Firestore] ✗ Initialisation échouée:', e.message);
  console.warn('[Firestore] Démarrage SANS persistance cloud.');
  fsdb = null;
}

// ── Liste blanche des expéditeurs ────────────────────────────────────────────
function normKey(s) {
  if (!s) return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '').trim();
}
const ALLOWED_SENDERS = new Set(['wavebusiness', '+454', '454', 'mobilemoney', 'moovmoney']);

/**
 * Décide si un message est conservé et s'il doit être retagué.
 * @returns {{keep:boolean, override:(string|null)}}
 */
function classify(msg) {
  const eff = msg.sender_name || msg.sender || msg.app_name || '';
  const k   = normKey(eff);
  const ck  = normKey(msg.content || '');
  // Wave (perso) « Transfert reçu » → bascule sous Wave Business
  if (k === 'wave' && ck.includes('transfertrecu')) return { keep: true, override: 'Wave Business' };
  if (ALLOWED_SENDERS.has(k)) return { keep: true, override: null };
  return { keep: false, override: null };
}

// ── Base de données SQLite (cache de travail) ────────────────────────────────
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
    is_read       INTEGER DEFAULT 0,
    status        TEXT DEFAULT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_type      ON messages(type);
  CREATE INDEX IF NOT EXISTS idx_messages_device    ON messages(device_id);

  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    platform    TEXT,
    last_seen   INTEGER,
    token       TEXT,
    number       INTEGER,
    display_name TEXT
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

// Migrations défensives (si vieille base déjà présente)
try { db.exec("ALTER TABLE messages ADD COLUMN status       TEXT DEFAULT NULL"); } catch(e) {}
try { db.exec("ALTER TABLE devices  ADD COLUMN number       INTEGER");            } catch(e) {}
try { db.exec("ALTER TABLE devices  ADD COLUMN display_name TEXT");               } catch(e) {}
try { db.exec("ALTER TABLE users    ADD COLUMN is_active    INTEGER DEFAULT 1");  } catch(e) {}

// ── Helpers Firestore (miroir durable) ───────────────────────────────────────
function sid(s) { return (String(s).replace(/\//g, '_SLASH_').slice(0, 1400)) || '_EMPTY_'; }

async function fsSet(coll, id, data) {
  if (!fsdb) return;
  try { await fsdb.collection(coll).doc(sid(id)).set(data); }
  catch (e) { console.error(`[Firestore] set ${coll}/${id} échec:`, e.message); }
}
async function fsDelete(coll, id) {
  if (!fsdb) return;
  try { await fsdb.collection(coll).doc(sid(id)).delete(); }
  catch (e) { console.error(`[Firestore] delete ${coll}/${id} échec:`, e.message); }
}
async function fsBatchSet(coll, rows, idFn) {
  if (!fsdb || !rows.length) return;
  for (let i = 0; i < rows.length; i += 450) {
    const slice = rows.slice(i, i + 450);
    const batch = fsdb.batch();
    for (const r of slice) batch.set(fsdb.collection(coll).doc(sid(idFn(r))), r);
    try { await batch.commit(); }
    catch (e) { console.error(`[Firestore] batch ${coll} échec:`, e.message); }
  }
}

// ── Hydratation depuis Firestore au démarrage ────────────────────────────────
function msgRow(v) {
  return {
    id: v.id, device_id: v.device_id || 'unknown', device_name: v.device_name ?? null,
    type: v.type || 'notification', sender: v.sender ?? null, sender_name: v.sender_name ?? null,
    content: v.content ?? null, app_name: v.app_name ?? null, app_package: v.app_package ?? null,
    call_type: v.call_type ?? null, call_duration: v.call_duration ?? null,
    timestamp: v.timestamp || Date.now(), received_at: v.received_at || Date.now(),
    is_read: v.is_read ? 1 : 0, status: v.status ?? null,
  };
}

async function hydrate() {
  if (!fsdb) return;
  console.log('[Firestore] Hydratation de la base locale…');

  const insDev = db.prepare(`INSERT OR REPLACE INTO devices (id,name,display_name,platform,last_seen,token,number)
                             VALUES (@id,@name,@display_name,@platform,@last_seen,@token,@number)`);
  const dsnap = await fsdb.collection('devices').get();
  db.transaction(() => dsnap.forEach(d => { const v = d.data();
    insDev.run({ id: v.id || d.id, name: v.name ?? null, display_name: v.display_name ?? null,
      platform: v.platform ?? null, last_seen: v.last_seen ?? null, token: v.token ?? null, number: v.number ?? null });
  }))();

  const insUser = db.prepare(`INSERT OR REPLACE INTO users (id,username,password_hash,role,is_active,created_at)
                              VALUES (@id,@username,@password_hash,@role,@is_active,@created_at)`);
  const usnap = await fsdb.collection('users').get();
  db.transaction(() => usnap.forEach(d => { const v = d.data();
    insUser.run({ id: v.id, username: v.username, password_hash: v.password_hash,
      role: v.role || 'user', is_active: v.is_active ?? 1, created_at: v.created_at ?? Math.floor(Date.now()/1000) });
  }))();

  const insDP = db.prepare(`INSERT OR IGNORE INTO device_permissions (user_id,device_id) VALUES (@user_id,@device_id)`);
  const dpsnap = await fsdb.collection('device_permissions').get();
  db.transaction(() => dpsnap.forEach(d => { const v = d.data(); insDP.run({ user_id: v.user_id, device_id: v.device_id }); }))();

  const insPin = db.prepare(`INSERT OR IGNORE INTO pinned_senders (sender) VALUES (@sender)`);
  const psnap = await fsdb.collection('pinned_senders').get();
  db.transaction(() => psnap.forEach(d => { const v = d.data(); insPin.run({ sender: v.sender }); }))();

  const insUSP = db.prepare(`INSERT OR IGNORE INTO user_sender_permissions (user_id,sender) VALUES (@user_id,@sender)`);
  const uspsnap = await fsdb.collection('user_sender_permissions').get();
  db.transaction(() => uspsnap.forEach(d => { const v = d.data(); insUSP.run({ user_id: v.user_id, sender: v.sender }); }))();

  // Messages : on ne charge que les plus récents (working set)
  const insMsg = db.prepare(`INSERT OR REPLACE INTO messages
    (id,device_id,device_name,type,sender,sender_name,content,app_name,app_package,call_type,call_duration,timestamp,received_at,is_read,status)
    VALUES (@id,@device_id,@device_name,@type,@sender,@sender_name,@content,@app_name,@app_package,@call_type,@call_duration,@timestamp,@received_at,@is_read,@status)`);
  const msnap = await fsdb.collection('messages').orderBy('timestamp', 'desc').limit(HYDRATE_LIMIT).get();
  db.transaction(() => msnap.forEach(d => insMsg.run(msgRow(d.data()))))();

  console.log(`[Firestore] ✓ Hydraté : ${dsnap.size} appareils, ${usnap.size} utilisateurs, ${msnap.size} messages récents (limite ${HYDRATE_LIMIT}).`);
}

// ── Express + Socket.io ──────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','PATCH','DELETE','PUT'] }
});

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile('index.html', { root: path.join(__dirname, 'public') }));

// ── Middlewares Auth ─────────────────────────────────────────────────────────
function requireDashboardAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'Non authentifié' });
  try { req.user = jwt.verify(auth.slice(7), SECRET_KEY); next(); }
  catch { return res.status(401).json({ error: 'Token invalide' }); }
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès admin requis' });
  next();
}
function requireDeviceAuth(req, res, next) {
  const token = req.headers['x-device-token'];
  if (!token || token !== DEVICE_TOKEN) return res.status(403).json({ error: 'Token appareil invalide' });
  next();
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getUserDevices(user) {
  if (user.role === 'admin') return null;
  return db.prepare("SELECT device_id FROM device_permissions WHERE user_id=?").all(user.id).map(p => p.device_id);
}
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
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET_KEY, { expiresIn: '30d' });
  res.json({ token, role: user.role, username: user.username });
});

// ── Routes : Appareils Android ───────────────────────────────────────────────
app.post('/api/device/register', requireDeviceAuth, async (req, res) => {
  const { device_id, name, platform } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id requis' });
  const existing = db.prepare("SELECT id FROM devices WHERE id=?").get(device_id);
  if (!existing) {
    const maxNum = db.prepare("SELECT COALESCE(MAX(number),0) as m FROM devices").get().m;
    const num    = maxNum + 1;
    db.prepare(`INSERT INTO devices (id,name,display_name,platform,last_seen,token,number)
                VALUES (@id,@name,@dn,@platform,@ts,@tok,@num)`)
      .run({ id: device_id, name: name || 'Android', dn: name || ('Appareil ' + num),
             platform: platform || 'android', ts: Date.now(), tok: DEVICE_TOKEN, num });
  } else {
    db.prepare("UPDATE devices SET name=@name,platform=@platform,last_seen=@ts WHERE id=@id")
      .run({ id: device_id, name: name||'Android', platform: platform||'android', ts: Date.now() });
  }
  const dev = db.prepare("SELECT * FROM devices WHERE id=?").get(device_id);
  await fsSet('devices', dev.id, dev);
  io.emit('device_connected', { device_id, name, platform });
  console.log(`[Appareil] ${name||device_id} connecté (${platform||'?'})`);
  res.json({ ok: true });
});

// Réception des messages depuis Android (avec LISTE BLANCHE)
app.post('/api/messages', requireDeviceAuth, async (req, res) => {
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const inserted = [];
  let dropped = 0;

  const insert = db.prepare(`INSERT OR IGNORE INTO messages
      (id,device_id,device_name,type,sender,sender_name,content,app_name,app_package,call_type,call_duration,timestamp,received_at)
    VALUES
      (@id,@device_id,@device_name,@type,@sender,@sender_name,@content,@app_name,@app_package,@call_type,@call_duration,@timestamp,@received_at)`);
  const updateDev = db.prepare("UPDATE devices SET last_seen=@ts WHERE id=@id");

  db.transaction((msgs) => {
    for (const msg of msgs) {
      const verdict = classify(msg);
      if (!verdict.keep) { dropped++; continue; }   // ← expéditeur non autorisé : ignoré
      const row = {
        id:            msg.id            || uuidv4(),
        device_id:     msg.device_id     || 'unknown',
        device_name:   msg.device_name   || null,
        type:          msg.type          || 'notification',
        sender:        msg.sender        || null,
        sender_name:   verdict.override  || msg.sender_name || null,
        content:       msg.content       || null,
        app_name:      msg.app_name      || null,
        app_package:   msg.app_package   || null,
        call_type:     msg.call_type     || null,
        call_duration: msg.call_duration || null,
        timestamp:     msg.timestamp     || Date.now(),
        received_at:   Date.now(),
      };
      if (insert.run(row).changes > 0) {
        row.is_read = 0; row.status = null;
        inserted.push(row);
        console.log(`[${row.type.toUpperCase()}] ${row.sender_name||row.sender||row.app_name} → "${(row.content||'').slice(0,60)}"`);
      }
      updateDev.run({ ts: Date.now(), id: row.device_id });
    }
  })(messages);

  // Miroir durable Firestore (attendu pour garantir la persistance)
  if (inserted.length > 0) await fsBatchSet('messages', inserted, r => r.id);

  if (inserted.length > 0) {
    io.to('admins').emit('new_messages', inserted);
    const seenUsers = new Set();
    for (const [, u] of socketUsers) {
      if (u.role === 'admin' || seenUsers.has(u.id)) continue;
      seenUsers.add(u.id);
      const allowedDevs = new Set(db.prepare('SELECT device_id FROM device_permissions WHERE user_id=?').all(u.id).map(p => p.device_id));
      const userMsgs = inserted.filter(m => allowedDevs.has(m.device_id));
      if (userMsgs.length > 0) io.to('user_' + u.id).emit('new_messages', userMsgs);
    }
  }
  res.json({ ok: true, inserted: inserted.length, dropped });
});

// ── Routes : Messages (dashboard) ───────────────────────────────────────────
app.get('/api/messages', requireDashboardAuth, (req, res) => {
  try {
    const user = req.user;
    const { type, device, search, sender, limit=100, offset=0 } = req.query;
    let whereClauses = [], params = [];
    if (type)   { whereClauses.push("type = ?"); params.push(type); }
    if (device) { whereClauses.push("device_id = ?"); params.push(device); }
    if (search) { whereClauses.push("(content LIKE ? OR sender LIKE ? OR app_name LIKE ? OR sender_name LIKE ?)"); params.push('%'+search+'%','%'+search+'%','%'+search+'%','%'+search+'%'); }
    if (sender) { whereClauses.push("COALESCE(sender_name, sender, app_name, '') = ?"); params.push(sender); }
    if (user.role !== 'admin') {
      const allowedDevices = db.prepare("SELECT device_id FROM device_permissions WHERE user_id=?").all(user.id).map(p => p.device_id);
      if (allowedDevices.length === 0) return res.json([]);
      whereClauses.push(`device_id IN (${allowedDevices.map(() => '?').join(',')})`);
      params.push(...allowedDevices);
      const allowedSenders = db.prepare('SELECT sender FROM user_sender_permissions WHERE user_id = ?').all(user.id).map(r => r.sender);
      if (allowedSenders.length === 0) return res.json([]);
      whereClauses.push(`COALESCE(sender_name, sender, app_name, '') IN (${allowedSenders.map(() => '?').join(',')})`);
      params.push(...allowedSenders);
    }
    const where = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
    const rows = db.prepare('SELECT * FROM messages ' + where + ' ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(...params, parseInt(limit), parseInt(offset));
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/senders', requireDashboardAuth, (req, res) => {
  const allowed = getUserDevices(req.user);
  let query  = `SELECT COALESCE(sender_name,sender,app_name,'Inconnu') as display_name,
    sender, sender_name, app_name, type, COUNT(*) as count,
    SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) as unread, MAX(timestamp) as last_ts
    FROM messages WHERE 1=1`;
  let params = {};
  ({ query, params } = addDeviceFilter(query, params, allowed));
  query += ` GROUP BY COALESCE(sender_name,sender,app_name,'Inconnu') ORDER BY last_ts DESC`;
  let rows = db.prepare(query).all(params);
  if (req.user.role !== 'admin') {
    const allowedSenders = new Set(db.prepare('SELECT sender FROM user_sender_permissions WHERE user_id = ?').all(req.user.id).map(r => r.sender));
    rows = rows.filter(r => allowedSenders.has(r.display_name));
  }
  res.json(rows);
});

app.patch('/api/messages/:id/status', requireDashboardAuth, async (req, res) => {
  const { status } = req.body;
  if (!['approuve','pas_de_commande',null].includes(status))
    return res.status(400).json({ error: 'Statut invalide' });
  const result = db.prepare('UPDATE messages SET status=? WHERE id=?').run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Message non trouvé' });
  await fsSet('messages', req.params.id, db.prepare('SELECT * FROM messages WHERE id=?').get(req.params.id));
  io.emit('message_status_updated', { id: req.params.id, status });
  res.json({ ok: true, id: req.params.id, status });
});

app.get('/api/stats', requireDashboardAuth, (req, res) => {
  const allowed = getUserDevices(req.user);
  let base   = 'FROM messages WHERE 1=1', params = {};
  ({ query: base, params } = addDeviceFilter(base, params, allowed));
  res.json({
    total:         db.prepare(`SELECT COUNT(*) as c ${base}`).get(params).c,
    sms:           db.prepare(`SELECT COUNT(*) as c ${base} AND type='sms'`).get(params).c,
    notifications: db.prepare(`SELECT COUNT(*) as c ${base} AND type='notification'`).get(params).c,
    calls:         db.prepare(`SELECT COUNT(*) as c ${base} AND type='call'`).get(params).c,
    unread:        db.prepare(`SELECT COUNT(*) as c ${base} AND is_read=0`).get(params).c,
    devices: req.user.role === 'admin' ? db.prepare('SELECT * FROM devices ORDER BY number ASC').all() : [],
  });
});

app.post('/api/messages/read', requireDashboardAuth, async (req, res) => {
  const { ids } = req.body;
  let changed = [];
  if (!ids || !ids.length) {
    db.prepare('UPDATE messages SET is_read=1 WHERE is_read=0').run();
    // (miroir « tout lu » volontairement non propagé en masse — is_read est cosmétique)
  } else {
    const s = db.prepare('UPDATE messages SET is_read=1 WHERE id=?');
    ids.forEach(id => { s.run(id); changed.push(id); });
    for (const id of changed) {
      const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id);
      if (row) await fsSet('messages', id, row);
    }
  }
  io.emit('messages_read', { ids });
  res.json({ ok: true });
});

app.get('/api/config', requireDeviceAuth, (req, res) => {
  res.json({ version: '2.0.0', server_time: Date.now(), sync_interval: 30000 });
});

// ── Import (restauration de la sauvegarde filtrée) ───────────────────────────
app.post('/api/admin/import', requireDashboardAuth, requireAdmin, async (req, res) => {
  const batch = Array.isArray(req.body) ? req.body : (req.body.messages || []);
  if (!Array.isArray(batch) || !batch.length) return res.status(400).json({ error: 'Aucun message à importer' });
  const insert = db.prepare(`INSERT OR IGNORE INTO messages
    (id,device_id,device_name,type,sender,sender_name,content,app_name,app_package,call_type,call_duration,timestamp,received_at,is_read,status)
    VALUES (@id,@device_id,@device_name,@type,@sender,@sender_name,@content,@app_name,@app_package,@call_type,@call_duration,@timestamp,@received_at,@is_read,@status)`);
  const rows = [];
  db.transaction(() => {
    for (const m of batch) {
      const verdict = classify(m);          // sécurité : on n'importe que les expéditeurs autorisés
      if (!verdict.keep) continue;
      const row = msgRow({ ...m, sender_name: verdict.override || m.sender_name });
      if (insert.run(row).changes > 0) rows.push(row);
    }
  })();
  await fsBatchSet('messages', rows, r => r.id);
  res.json({ ok: true, imported: rows.length, received: batch.length });
});

// ── Routes : Admin – Utilisateurs ───────────────────────────────────────────
app.get('/api/admin/users', requireDashboardAuth, requireAdmin, (req, res) => {
  const users    = db.prepare("SELECT id,username,role,is_active,created_at FROM users ORDER BY created_at ASC").all();
  const permsStmt= db.prepare("SELECT device_id FROM device_permissions WHERE user_id=?");
  res.json(users.map(u => ({ ...u, device_ids: permsStmt.all(u.id).map(p => p.device_id) })));
});

app.post('/api/admin/users', requireDashboardAuth, requireAdmin, async (req, res) => {
  const { username, password, role='user' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username et password requis' });
  if (!['user','admin'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  try {
    const r = db.prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?,?)")
                .run(username.trim(), bcrypt.hashSync(password, 10), role);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
    await fsSet('users', u.id, u);
    res.json({ ok: true, id: r.lastInsertRowid, username: username.trim(), role });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: "Nom d'utilisateur déjà pris" });
    throw e;
  }
});

app.delete('/api/admin/users/:id', requireDashboardAuth, requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id);
  if (uid === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
  const dps = db.prepare("SELECT device_id FROM device_permissions WHERE user_id=?").all(uid);
  const usps = db.prepare("SELECT sender FROM user_sender_permissions WHERE user_id=?").all(uid);
  db.prepare("DELETE FROM device_permissions WHERE user_id=?").run(uid);
  db.prepare("DELETE FROM users WHERE id=?").run(uid);
  await fsDelete('users', uid);
  for (const d of dps)  await fsDelete('device_permissions', `${uid}__${d.device_id}`);
  for (const s of usps) await fsDelete('user_sender_permissions', `${uid}__${sid(s.sender)}`);
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/password', requireDashboardAuth, requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Mot de passe requis' });
  const uid = parseInt(req.params.id);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(password, 10), uid);
  await fsSet('users', uid, db.prepare("SELECT * FROM users WHERE id=?").get(uid));
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/permissions', requireDashboardAuth, requireAdmin, async (req, res) => {
  const uid = parseInt(req.params.id);
  const { device_ids } = req.body;
  if (!Array.isArray(device_ids)) return res.status(400).json({ error: 'device_ids doit être un tableau' });
  const old = db.prepare("SELECT device_id FROM device_permissions WHERE user_id=?").all(uid);
  db.prepare("DELETE FROM device_permissions WHERE user_id=?").run(uid);
  const ins = db.prepare("INSERT OR IGNORE INTO device_permissions (user_id,device_id) VALUES (?,?)");
  db.transaction(ids => ids.forEach(did => ins.run(uid, did)))(device_ids);
  for (const d of old) await fsDelete('device_permissions', `${uid}__${d.device_id}`);
  await fsBatchSet('device_permissions', device_ids.map(did => ({ user_id: uid, device_id: did })), r => `${r.user_id}__${r.device_id}`);
  res.json({ ok: true });
});

app.patch('/api/admin/users/:id/access', requireDashboardAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const user = db.prepare('SELECT id, username, is_active FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const newState = user.is_active === 0 ? 1 : 0;
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newState, id);
  await fsSet('users', id, db.prepare("SELECT * FROM users WHERE id=?").get(id));
  res.json({ id: user.id, username: user.username, is_active: newState });
});

// ── Routes : Admin – Expéditeurs épinglés ────────────────────────────────────
app.get('/api/admin/senders', requireDashboardAuth, requireAdmin, (req, res) => {
  try {
    const pinned = new Set(db.prepare('SELECT sender FROM pinned_senders').all().map(r => r.sender));
    let msgSenders = [];
    try {
      msgSenders = db.prepare("SELECT DISTINCT COALESCE(sender_name, sender, app_name, '') AS s FROM messages WHERE COALESCE(sender_name, sender, app_name, '') != ''").all().map(r => r.s);
    } catch(e) {}
    const all = [...new Set([...pinned, ...msgSenders])];
    res.json(all.map(s => ({ sender: s, pinned: pinned.has(s) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/senders/pin', requireDashboardAuth, requireAdmin, async (req, res) => {
  const { sender } = req.body;
  if (!sender) return res.status(400).json({ error: 'sender requis' });
  db.prepare('INSERT OR IGNORE INTO pinned_senders (sender) VALUES (?)').run(sender);
  await fsSet('pinned_senders', sender, { sender });
  res.json({ ok: true, sender });
});

app.delete('/api/admin/senders/pin/:sender', requireDashboardAuth, requireAdmin, async (req, res) => {
  const sender = decodeURIComponent(req.params.sender);
  const usps = db.prepare('SELECT user_id FROM user_sender_permissions WHERE sender = ?').all(sender);
  db.prepare('DELETE FROM pinned_senders WHERE sender = ?').run(sender);
  db.prepare('DELETE FROM user_sender_permissions WHERE sender = ?').run(sender);
  await fsDelete('pinned_senders', sender);
  for (const u of usps) await fsDelete('user_sender_permissions', `${u.user_id}__${sid(sender)}`);
  res.json({ ok: true });
});

app.get('/api/admin/users/:id/senders', requireDashboardAuth, requireAdmin, (req, res) => {
  const senders = db.prepare('SELECT sender FROM user_sender_permissions WHERE user_id = ?').all(req.params.id).map(r => r.sender);
  res.json(senders);
});

app.post('/api/admin/users/:id/senders', requireDashboardAuth, requireAdmin, async (req, res) => {
  const { id } = req.params; const { sender } = req.body;
  if (!sender) return res.status(400).json({ error: 'sender requis' });
  db.prepare('INSERT OR IGNORE INTO user_sender_permissions (user_id, sender) VALUES (?, ?)').run(id, sender);
  await fsSet('user_sender_permissions', `${id}__${sid(sender)}`, { user_id: parseInt(id), sender });
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id/senders/:sender', requireDashboardAuth, requireAdmin, async (req, res) => {
  const { id } = req.params; const sender = decodeURIComponent(req.params.sender);
  db.prepare('DELETE FROM user_sender_permissions WHERE user_id = ? AND sender = ?').run(id, sender);
  await fsDelete('user_sender_permissions', `${id}__${sid(sender)}`);
  res.json({ ok: true });
});

// ── Routes : Admin – Appareils ───────────────────────────────────────────────
app.get('/api/admin/devices', requireDashboardAuth, requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM devices ORDER BY number ASC, last_seen DESC").all());
});

app.put('/api/admin/devices/:id', requireDashboardAuth, requireAdmin, async (req, res) => {
  const { display_name, number } = req.body;
  const updates = [], params  = { id: req.params.id };
  if (display_name !== undefined) { updates.push('display_name=@display_name'); params.display_name = display_name; }
  if (number       !== undefined) { updates.push('number=@number');             params.number       = number;       }
  if (updates.length) db.prepare(`UPDATE devices SET ${updates.join(',')} WHERE id=@id`).run(params);
  await fsSet('devices', req.params.id, db.prepare("SELECT * FROM devices WHERE id=?").get(req.params.id));
  res.json({ ok: true });
});

// ── WebSocket ────────────────────────────────────────────────────────────────
const socketUsers = new Map();
io.on('connection', (socket) => {
  const authToken = socket.handshake.auth && socket.handshake.auth.token;
  if (authToken) {
    try {
      const user = jwt.verify(authToken, SECRET_KEY);
      socketUsers.set(socket.id, user);
      socket.join('user_' + user.id);
      if (user.role === 'admin') socket.join('admins');
    } catch(e) {}
  }
  console.log(`[WebSocket] Dashboard connecté (${socket.id})`);
  socket.on('disconnect', () => { socketUsers.delete(socket.id); });
});

// ── Démarrage (asynchrone : hydratation puis écoute) ─────────────────────────
async function main() {
  await hydrate();

  // Compte admin par défaut
  const adminExists = db.prepare("SELECT id FROM users WHERE role='admin'").get();
  if (!adminExists) {
    const hash = bcrypt.hashSync(DASHBOARD_PASSWORD, 10);
    const r = db.prepare("INSERT OR IGNORE INTO users (username,password_hash,role) VALUES ('admin',?,'admin')").run(hash);
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
    if (u) await fsSet('users', u.id, u);
    console.log('[Auth] Compte admin créé (DASHBOARD_PASSWORD).');
  }
  // Expéditeurs épinglés par défaut = la liste blanche
  for (const s of ['Wave Business', '+454', 'MobileMoney', 'MoovMoney']) {
    db.prepare('INSERT OR IGNORE INTO pinned_senders (sender) VALUES (?)').run(s);
    await fsSet('pinned_senders', s, { sender: s });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✓ Serveur démarré sur le port ${PORT}`);
    console.log(`📱 Token Android  : ${DEVICE_TOKEN}`);
    console.log(`🔐 Mot de passe   : ${DASHBOARD_PASSWORD}`);
    console.log(`🧱 Persistance    : ${fsdb ? 'Firestore (durable)' : 'SQLite seul (NON durable)'}\n`);
  });
}
main().catch(e => { console.error('Erreur fatale au démarrage:', e); process.exit(1); });
