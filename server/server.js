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
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');

// ── Configuration ────────────────────────────────────────────────────────────
const PORT               = process.env.PORT               || 3000;
const SECRET_KEY         = process.env.SECRET_KEY         || 'changez-moi-' + Math.random().toString(36);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';
const DEVICE_TOKEN       = process.env.DEVICE_TOKEN       || 'token-android-' + Math.random().toString(36).slice(2, 10);
const HYDRATE_LIMIT      = parseInt(process.env.HYDRATE_LIMIT || '40000', 10); // messages récents chargés en SQLite au boot
const MSG_KEEP           = parseInt(process.env.MSG_KEEP || '45000', 10);       // plafond de lignes messages gardées dans SQLite

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
  const pkg = (msg.app_package || '').toLowerCase();
  const isWavePerso = k === 'wave' || pkg === 'com.wave.personal';
  // Wave (perso) « Transfert reçu » → bascule sous Wave Business (le super-bot y lit les dépôts entrants)
  if (isWavePerso && ck.includes('transfertrecu')) return { keep: true, override: 'Wave Business' };
  // Autres notifications Wave perso → gardées et visibles sous « Wave Personnel » (agents)
  if (isWavePerso) return { keep: true, override: 'Wave Personnel' };
  if (ALLOWED_SENDERS.has(k)) return { keep: true, override: null };
  return { keep: false, override: null };
}

/**
 * Clé de déduplication déterministe d'un message.
 * Pour les SMS transactionnels (Wave/OMCI/Moov/MobileMoney), le CONTENU est
 * naturellement unique (« Reference » + « Solde » propres à chaque transaction) :
 * on déduplique sur le contenu normalisé seul → deux captures du même SMS
 * fusionnent même si horodatage/device_id diffèrent.
 * Pour TOUT le reste (Telegram, Gmail, YouTube, alertes de bots, appels…), un
 * texte identique peut correspondre à des événements distincts : on garde donc
 * une clé STRICTE par événement (n'unifie que des renvois exactement identiques).
 */
function contentKey(m) {
  const eff   = m.sender_name || m.sender || m.app_name || '';
  const isTxn = (m.type === 'sms') || ALLOWED_SENDERS.has(normKey(eff));
  const c     = (m.content || '').replace(/\s+/g, ' ').trim();
  if (isTxn && c) {
    return 'm_' + crypto.createHash('sha1').update(c).digest('hex');
  }
  const parts = [
    m.device_id || 'unknown',
    m.type || 'notification',
    m.sender || m.sender_name || '',
    m.content || '',
    m.timestamp || '',
    m.call_type || '',
    m.call_duration || '',
  ];
  return 'm_' + crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex');
}

// Montant FCFA en entier : "1.000" → 1000, "4 950" → 4950, "990" → 990
function parseFcfa(s) {
  const d = String(s || '').replace(/[.\s\u00a0,]/g, '');
  return parseInt(d, 10) || 0;
}

/**
 * Wave perso prélève 1% au départ (1000 envoyés → 990 reçus).
 * On réécrit le montant affiché « Vous avez reçu Xf » avec le montant d'origine
 * (reçu ÷ 0,99, arrondi), pour que YapsonPress ET les bots voient le vrai montant.
 * N'affecte QUE les notifs Wave perso « Transfert reçu » (jamais les vrais Wave Business).
 */
function correctWavePersoAmount(content) {
  if (!content) return content;
  const m = content.match(/(avez\s+re[çc]u\s+)([\d\s\u00a0.,]+?)(\s*F)\b/i);
  if (!m) return content;
  const recu = parseFcfa(m[2]);
  if (!recu) return content;
  const origine = Math.round(recu / 0.99);
  if (origine === recu) return content;
  return content.slice(0, m.index) + m[1] + origine + m[3] + content.slice(m.index + m[0].length);
}

// ── Base de données SQLite (cache de travail) ────────────────────────────────
const _dbPath = process.env.DB_PATH || 'sms_mirror.db';
const _dbDir = require('path').dirname(_dbPath);
if (_dbDir !== '.') require('fs').mkdirSync(_dbDir, { recursive: true });
const db = new Database(_dbPath);

// Réglages de stockage : WAL + journal borné pour empêcher le fichier de gonfler.
try {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 1000');           // checkpoint régulier
  db.pragma('journal_size_limit = 67108864');       // WAL plafonné à 64 Mo
} catch (e) { console.error('[DB] PRAGMA:', e.message); }

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
  CREATE TABLE IF NOT EXISTS sender_schedules (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    sender    TEXT NOT NULL,
    action    TEXT NOT NULL,              -- 'enable' | 'disable'
    hour      INTEGER NOT NULL,           -- 0-23 (heure d'Abidjan = UTC)
    minute    INTEGER NOT NULL DEFAULT 0,
    active    INTEGER NOT NULL DEFAULT 1,
    last_run  TEXT                        -- 'YYYY-MM-DD' du dernier déclenchement (anti-doublon)
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

  const insSch = db.prepare(`INSERT OR REPLACE INTO sender_schedules (id,user_id,sender,action,hour,minute,active,last_run) VALUES (@id,@user_id,@sender,@action,@hour,@minute,@active,@last_run)`);
  const schsnap = await fsdb.collection('sender_schedules').get();
  db.transaction(() => schsnap.forEach(d => { const v = d.data(); insSch.run({ id: v.id, user_id: v.user_id, sender: v.sender, action: v.action, hour: v.hour, minute: v.minute||0, active: v.active==null?1:v.active, last_run: v.last_run||null }); }))();

  // Messages : on ne charge que les plus récents (working set)
  const insMsg = db.prepare(`INSERT OR REPLACE INTO messages
    (id,device_id,device_name,type,sender,sender_name,content,app_name,app_package,call_type,call_duration,timestamp,received_at,is_read,status)
    VALUES (@id,@device_id,@device_name,@type,@sender,@sender_name,@content,@app_name,@app_package,@call_type,@call_duration,@timestamp,@received_at,@is_read,@status)`);
  const msnap = await fsdb.collection('messages').orderBy('timestamp', 'desc').limit(HYDRATE_LIMIT).get();
  db.transaction(() => msnap.forEach(d => insMsg.run(msgRow(d.data()))))();

  console.log(`[Firestore] ✓ Hydraté : ${dsnap.size} appareils, ${usnap.size} utilisateurs, ${msnap.size} messages récents (limite ${HYDRATE_LIMIT}).`);
}

/**
 * Élague SQLite pour ne garder que les MSG_KEEP messages les plus récents.
 * N'agit QUE sur le cache local — Firestore conserve tout l'historique (statuts inclus).
 * Empêche le fichier SQLite (et donc le volume) de grossir sans fin.
 */
function pruneMessages() {
  try {
    const total = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
    if (total <= MSG_KEEP) return 0;
    const info = db.prepare(
      `DELETE FROM messages WHERE id IN (
         SELECT id FROM messages ORDER BY timestamp DESC LIMIT -1 OFFSET ?
       )`).run(MSG_KEEP);
    // Rendre l'espace au système si la base est en mode incremental (après un /compact)
    try { db.pragma('incremental_vacuum'); } catch {}
    if (info.changes) console.log(`[prune] ${info.changes} anciens messages retirés du cache local (garde ${MSG_KEEP}).`);
    return info.changes;
  } catch (e) { console.error('[prune]', e.message); return 0; }
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

// Tampon de débogage : derniers messages IGNORÉS par la liste blanche (pour diagnostic)
const droppedLog = [];
function pushDropped(msg) {
  droppedLog.unshift({
    app_name:    msg.app_name    || null,
    app_package: msg.app_package || null,
    sender:      msg.sender      || null,
    sender_name: msg.sender_name || null,
    content:     (msg.content || '').slice(0, 140),
    device:      msg.device_name || msg.device_id || null,
    ts:          Date.now(),
  });
  if (droppedLog.length > 80) droppedLog.length = 80;
}

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
      if (!verdict.keep) { dropped++; pushDropped(msg); continue; }   // ← expéditeur non autorisé : ignoré
      // Wave perso « Transfert reçu » (override = Wave Business) → corriger le montant (reçu ÷ 0,99)
      let _content = msg.content || null;
      if (verdict.override === 'Wave Business') _content = correctWavePersoAmount(_content);
      const row = {
        id:            contentKey(msg),
        device_id:     msg.device_id     || 'unknown',
        device_name:   msg.device_name   || null,
        type:          msg.type          || 'notification',
        sender:        msg.sender        || null,
        sender_name:   verdict.override  || msg.sender_name || null,
        content:       _content,
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
    // Masquer (affichage seulement, données conservées) les transferts SORTANTS de +454
    // ex: "Le transfert de 1010.00 FCFA vers le 0712117807 est un succes…" — ce ne sont pas des dépôts entrants.
    whereClauses.push("NOT (COALESCE(sender_name, sender, app_name, '') IN ('+454','454') AND LOWER(COALESCE(content,'')) LIKE '%vers le%')");
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

// ── Déduplication des messages existants (Firestore = source de vérité) ───────
// One-shot : regroupe les doublons (même appareil/contenu/horodatage), garde une
// seule copie en préservant le statut déjà attribué, et la replace sur l'id
// canonique (contentKey) pour que tout futur renvoi du même SMS soit idempotent.
//   body optionnel : { dryRun?: boolean, limit?: number }
app.post('/api/admin/dedup', requireDashboardAuth, requireAdmin, async (req, res) => {
  if (!fsdb) return res.status(503).json({ error: 'Firestore non configuré' });
  const dryRun = req.body && req.body.dryRun === true;
  const cap    = Math.min(parseInt((req.body && req.body.limit) || 200000, 10), 500000);

  // 1) Lecture paginée de tous les messages (curseur par snapshot → robuste aux timestamps égaux)
  const docs = [];
  let cursor = null;
  while (docs.length < cap) {
    let q = fsdb.collection('messages').orderBy('timestamp', 'desc').limit(5000);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach(d => docs.push({ docId: d.id, data: d.data() }));
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 5000) break;
  }

  // 2) Regroupement par clé de contenu déterministe
  const groups = new Map();
  for (const d of docs) {
    const k = contentKey(d.data);
    (groups.get(k) || groups.set(k, []).get(k)).push(d);
  }

  // 3) Pour chaque groupe à doublons : choisir le gardien et préparer le nettoyage
  const score = (data) => (data.status ? 2 : 0) + (data.is_read ? 1 : 0); // statut > lu > rien
  const toDelete = [];        // docIds Firestore à supprimer
  const toWrite  = [];        // lignes canoniques à (ré)écrire
  let dupGroups = 0, dupDocs = 0;

  for (const [canonicalId, list] of groups) {
    if (list.length < 2) continue;
    dupGroups++;
    dupDocs += list.length - 1;
    // gardien : meilleur statut, puis le plus ancien (received_at le plus bas)
    list.sort((a, b) =>
      score(b.data) - score(a.data) ||
      (a.data.received_at || 0) - (b.data.received_at || 0));
    const keep = list[0];
    const canonRow = msgRow({ ...keep.data, id: canonicalId });
    toWrite.push(canonRow);
    // tous les anciens docs du groupe sont supprimés (y compris l'ancien id du gardien)
    for (const d of list) toDelete.push(d.docId);
  }

  if (dryRun) {
    return res.json({ ok: true, dryRun: true, scanned: docs.length,
      duplicateGroups: dupGroups, duplicatesToRemove: dupDocs });
  }

  // 4) Appliquer — Firestore : supprimer les anciens docs, puis écrire les canoniques
  for (let i = 0; i < toDelete.length; i += 450) {
    const batch = fsdb.batch();
    for (const docId of toDelete.slice(i, i + 450)) batch.delete(fsdb.collection('messages').doc(docId));
    try { await batch.commit(); } catch (e) { console.error('[dedup] delete batch:', e.message); }
  }
  await fsBatchSet('messages', toWrite, r => r.id);

  // 5) Miroir SQLite (pour que l'affichage soit propre sans attendre un redéploiement)
  const delLocal = db.prepare('DELETE FROM messages WHERE id=?');
  const insLocal = db.prepare(`INSERT OR REPLACE INTO messages
    (id,device_id,device_name,type,sender,sender_name,content,app_name,app_package,call_type,call_duration,timestamp,received_at,is_read,status)
    VALUES (@id,@device_id,@device_name,@type,@sender,@sender_name,@content,@app_name,@app_package,@call_type,@call_duration,@timestamp,@received_at,@is_read,@status)`);
  db.transaction(() => {
    for (const docId of toDelete) delLocal.run(docId.replace(/_SLASH_/g, '/'));
    for (const r of toWrite) { delLocal.run(r.id); insLocal.run(r); }
  })();

  io.emit('messages_deduped', { removed: dupDocs, groups: dupGroups });
  console.log(`[dedup] ${dupGroups} groupes, ${dupDocs} doublons supprimés.`);
  res.json({ ok: true, scanned: docs.length, duplicateGroups: dupGroups, duplicatesRemoved: dupDocs });
});

// ── Compactage du cache SQLite (reprise d'espace disque du volume) ────────────
// Élague au plus MSG_KEEP messages, bascule en auto_vacuum incrémental, puis VACUUM.
// Ne touche jamais Firestore. À lancer une fois quand le volume se remplit.
app.post('/api/admin/compact', requireDashboardAuth, requireAdmin, (req, res) => {
  const fs = require('fs');
  const sizeOf = () => ['', '-wal', '-shm', '-journal'].reduce((s, ext) => {
    try { return s + fs.statSync(_dbPath + ext).size; } catch { return s; }
  }, 0);
  const before = sizeOf();
  try {
    const removed = pruneMessages();
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    // Passer la base en auto-vacuum incrémental pour les futures reprises d'espace,
    // puis compacter physiquement le fichier maintenant.
    try { db.pragma('auto_vacuum = INCREMENTAL'); } catch {}
    db.exec('VACUUM');
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    const after = sizeOf();
    const mb = n => Math.round(n / 1048576 * 10) / 10;
    console.log(`[compact] ${mb(before)}→${mb(after)} Mo (retirés: ${removed}).`);
    res.json({ ok: true, removed, before_mb: mb(before), after_mb: mb(after),
      freed_mb: mb(before - after), remaining_rows: db.prepare('SELECT COUNT(*) c FROM messages').get().c });
  } catch (e) {
    console.error('[compact]', e.message);
    res.status(500).json({ error: e.message, before_mb: Math.round(before / 1048576 * 10) / 10 });
  }
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

// ── PROGRAMMATION : activer/désactiver un expéditeur pour un agent à heure fixe ──
// Applique exactement la même opération que les boutons manuels (INSERT / DELETE).
async function applyScheduleAction(userId, sender, action) {
  if (action === 'enable') {
    db.prepare('INSERT OR IGNORE INTO user_sender_permissions (user_id, sender) VALUES (?, ?)').run(userId, sender);
    await fsSet('user_sender_permissions', `${userId}__${sid(sender)}`, { user_id: parseInt(userId), sender });
  } else {
    db.prepare('DELETE FROM user_sender_permissions WHERE user_id = ? AND sender = ?').run(userId, sender);
    await fsDelete('user_sender_permissions', `${userId}__${sid(sender)}`);
  }
  io.emit('permissions_updated', { user_id: parseInt(userId), sender, action });
}

// Boucle du planificateur : toutes les 30 s. Abidjan = UTC, on utilise donc l'heure UTC.
// Une programmation se déclenche une fois par jour, à son heure OU juste après (rattrapage
// si le serveur était éteint), grâce à last_run = 'YYYY-MM-DD'.
async function runSchedules() {
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);                 // YYYY-MM-DD (UTC)
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const due = db.prepare("SELECT * FROM sender_schedules WHERE active = 1 AND (last_run IS NULL OR last_run <> ?)").all(today);
    for (const s of due) {
      const targetMin = s.hour * 60 + (s.minute || 0);
      if (nowMin < targetMin) continue;                          // pas encore l'heure aujourd'hui
      await applyScheduleAction(s.user_id, s.sender, s.action);
      db.prepare("UPDATE sender_schedules SET last_run = ? WHERE id = ?").run(today, s.id);
      const row = db.prepare("SELECT * FROM sender_schedules WHERE id = ?").get(s.id);
      await fsSet('sender_schedules', String(s.id), row);
      const uname = (db.prepare("SELECT username FROM users WHERE id=?").get(s.user_id) || {}).username || s.user_id;
      console.log(`[Programmation] ${s.action === 'enable' ? 'ACTIVÉ' : 'DÉSACTIVÉ'} « ${s.sender} » pour ${uname} (prévu ${String(s.hour).padStart(2,'0')}:${String(s.minute||0).padStart(2,'0')})`);
    }
  } catch (e) { console.error('[Programmation] erreur:', e.message); }
}
setInterval(runSchedules, 30 * 1000);
setTimeout(runSchedules, 5000);   // premier passage peu après le démarrage

app.get('/api/admin/schedules', requireDashboardAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, u.username FROM sender_schedules s
    LEFT JOIN users u ON u.id = s.user_id
    ORDER BY s.hour, s.minute, u.username`).all();
  res.json(rows);
});

app.post('/api/admin/schedules', requireDashboardAuth, requireAdmin, async (req, res) => {
  let { user_id, sender, action, hour, minute } = req.body;
  user_id = parseInt(user_id); hour = parseInt(hour); minute = parseInt(minute) || 0;
  if (!user_id || !sender || !['enable','disable'].includes(action) || isNaN(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59)
    return res.status(400).json({ error: 'Paramètres invalides' });
  // Si l'heure du jour est déjà passée, on démarre demain (pas d'application immédiate surprise).
  const now = new Date();
  const passedToday = (now.getUTCHours()*60 + now.getUTCMinutes()) >= (hour*60 + minute);
  const last_run = passedToday ? now.toISOString().slice(0,10) : null;
  const info = db.prepare("INSERT INTO sender_schedules (user_id,sender,action,hour,minute,active,last_run) VALUES (?,?,?,?,?,1,?)")
                 .run(user_id, sender, action, hour, minute, last_run);
  const row = db.prepare("SELECT * FROM sender_schedules WHERE id=?").get(info.lastInsertRowid);
  await fsSet('sender_schedules', String(row.id), row);
  res.json({ ok: true, schedule: row });
});

app.put('/api/admin/schedules/:id', requireDashboardAuth, requireAdmin, async (req, res) => {
  const { active } = req.body;
  db.prepare("UPDATE sender_schedules SET active=? WHERE id=?").run(active ? 1 : 0, req.params.id);
  const row = db.prepare("SELECT * FROM sender_schedules WHERE id=?").get(req.params.id);
  if (row) await fsSet('sender_schedules', String(row.id), row);
  res.json({ ok: true });
});

app.delete('/api/admin/schedules/:id', requireDashboardAuth, requireAdmin, async (req, res) => {
  db.prepare("DELETE FROM sender_schedules WHERE id=?").run(req.params.id);
  await fsDelete('sender_schedules', String(req.params.id));
  res.json({ ok: true });
});

// ── EXPORT PDF des transactions ──────────────────────────────────────────────
function normAmount(raw) {
  let s = String(raw).replace(/[\s\u00a0]/g, '');
  s = s.replace(/[.,]\d{2}$/, '');   // enlève décimales ,00 / .00
  s = s.replace(/[.,]/g, '');        // enlève séparateurs de milliers
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}
function parsePhone(content) {
  const c = content || '';
  const pats = [
    /re[çc]u\s+du\s+\+?(?:225)?\s*(0\d{9})/i,   // Orange "reçu du 07..."
    /\(\+?(?:225)?\s*(0\d{9})\)/,                // Wave "(07...)"
    /\bde\b[^()]*?\+?(?:225)?\s*(0\d{9})/i,      // "de NOM 07..."
    /\+?(?:225)?\s*(0\d{9})/                     // fallback : 1er 0XXXXXXXXX
  ];
  for (const p of pats) { const m = c.match(p); if (m) return m[1]; }
  return null;
}
function parseAmount(content) {
  const c = (content || '').replace(/\u00a0/g, ' ');
  const pats = [
    /transfert de\s*([\d][\d\s.,]*)\s*F/i,
    /avez\s+re[çc]u\s*([\d][\d\s.,]*)\s*F/i,
    /re[çc]u(?:\s+un\s+transfert)?\s+de\s*([\d][\d\s.,]*)\s*F/i,
    /re[çc]u[^\d]*([\d][\d\s.,]*)\s*F/i,
    /([\d][\d\s.,]*)\s*F(?:\s?CFA)?\b/i          // fallback : 1er "X F"
  ];
  for (const p of pats) { const m = c.match(p); if (m) { const n = normAmount(m[1]); if (n) return n; } }
  return null;
}
function parseReference(content) {
  const c = content || '';
  const pats = [
    /\b(PP\d{6}\.\d+\.[A-Za-z0-9]+)\b/,                                                     // Orange PP...
    /(?:r[ée]f[ée]rence|r[ée]f|transaction\s*id|txn|financial\s*transaction\s*id|id\s*(?:de\s*)?(?:la\s*)?transaction)\s*[:#=]?\s*([A-Za-z0-9][A-Za-z0-9._\/-]{4,})/i,
    /\bID\s*[:#=]\s*([A-Za-z0-9][A-Za-z0-9._\/-]{4,})/i,
    /\b[A-Z0-9]{2,}\.[A-Z0-9.]{4,}\b/                                                        // token type XX.YYYY.ZZZ
  ];
  for (const p of pats) { const m = c.match(p); if (m) return (m[1] || m[0]).trim(); }
  return null;
}

app.post('/api/export/pdf', requireDashboardAuth, requireAdmin, (req, res) => {
  try {
    let { senders, users, from, to } = req.body || {};
    senders = Array.isArray(senders) ? senders : [];
    users   = Array.isArray(users) ? users.map(Number).filter(Boolean) : [];
    if (!senders.length && !users.length) return res.status(400).json({ error: 'Sélectionne au moins un expéditeur ou un utilisateur' });
    const fromTs = from ? Date.parse(from + 'T00:00:00Z') : 0;
    const toTs   = to   ? Date.parse(to   + 'T23:59:59.999Z') : Date.now();

    const clauses = [], params = [];
    clauses.push("COALESCE(timestamp, received_at) BETWEEN ? AND ?"); params.push(fromTs, toTs);
    // cohérence avec l'affichage : on masque les transferts SORTANTS de +454
    clauses.push("NOT (COALESCE(sender_name, sender, app_name, '') IN ('+454','454') AND LOWER(COALESCE(content,'')) LIKE '%vers le%')");
    if (senders.length) {
      clauses.push(`COALESCE(sender_name, sender, app_name, '') IN (${senders.map(() => '?').join(',')})`);
      params.push(...senders);
    }
    // Filtre par utilisateur(s) : messages provenant des APPAREILS autorisés de ces agents
    let userLabel = '';
    if (users.length) {
      const uph = users.map(() => '?').join(',');
      const devs = db.prepare(`SELECT DISTINCT device_id FROM device_permissions WHERE user_id IN (${uph})`).all(...users).map(r => r.device_id);
      userLabel = db.prepare(`SELECT username FROM users WHERE id IN (${uph})`).all(...users).map(u => u.username).join(', ');
      if (!devs.length) { clauses.push('1=0'); }   // agent(s) sans appareil → aucune transaction
      else { clauses.push(`device_id IN (${devs.map(() => '?').join(',')})`); params.push(...devs); }
    }
    const rows = db.prepare(`
      SELECT sender_name, sender, app_name, content, timestamp, received_at, device_id
      FROM messages
      WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(timestamp, received_at) ASC
    `).all(...params);

    const items = [];
    for (const r of rows) {
      const phone = parsePhone(r.content || '');
      const amount = parseAmount(r.content || '');
      if (!phone || !amount) continue;   // on ne garde que les vraies transactions
      items.push({
        ts: r.timestamp || r.received_at,
        sender: r.sender_name || r.sender || r.app_name || '',
        phone, amount,
        ref: parseReference(r.content || '') || '—'
      });
    }

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="export_${from || 'debut'}_${to || 'fin'}.pdf"`);
    doc.pipe(res);

    const p2 = n => String(n).padStart(2, '0');
    const fmtDate = ts => { const d = new Date(ts); return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
    const fmtAmount = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' F';

    doc.fontSize(16).font('Helvetica-Bold').text('Export des transactions — YapsonPress', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#555');
    if (senders.length) doc.text(`Expéditeur(s) : ${senders.join(', ')}`, { align: 'center' });
    if (userLabel)      doc.text(`Utilisateur(s) : ${userLabel}`, { align: 'center' });
    doc.text(`Période : ${from || 'début'} → ${to || 'fin'}   |   ${items.length} transaction(s)`, { align: 'center' });
    doc.fillColor('#000').moveDown(0.8);

    const cols = [
      { key: 'date',   label: 'Date',       x: 40,  w: 95 },
      { key: 'sender', label: 'Expéditeur', x: 135, w: 90 },
      { key: 'phone',  label: 'Numéro',     x: 225, w: 80 },
      { key: 'amount', label: 'Montant',    x: 305, w: 80, align: 'right' },
      { key: 'ref',    label: 'Référence',  x: 390, w: 165 },
    ];
    const drawHeader = (yy) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
      cols.forEach(c => doc.text(c.label, c.x, yy, { width: c.w, align: c.align || 'left' }));
      doc.moveTo(40, yy + 13).lineTo(555, yy + 13).strokeColor('#999').stroke();
    };
    let y = doc.y;
    drawHeader(y); y += 18;

    let total = 0;
    doc.font('Helvetica').fontSize(8.5);
    for (const it of items) {
      if (y > 780) { doc.addPage(); y = 40; drawHeader(y); y += 18; doc.font('Helvetica').fontSize(8.5); }
      const cells = { date: fmtDate(it.ts), sender: it.sender, phone: it.phone, amount: fmtAmount(it.amount), ref: it.ref };
      cols.forEach(c => doc.fillColor('#000').text(String(cells[c.key]), c.x, y, { width: c.w, align: c.align || 'left', lineBreak: false, ellipsis: true }));
      total += it.amount;
      y += 15;
    }

    if (!items.length) {
      doc.font('Helvetica-Oblique').fontSize(11).fillColor('#888').text('Aucune transaction trouvée pour cette sélection.', 40, y + 20);
    } else {
      doc.moveTo(40, y + 2).lineTo(555, y + 2).strokeColor('#999').stroke();
      y += 8;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
      doc.text('TOTAL', 225, y, { width: 80 });
      doc.text(fmtAmount(total), 305, y, { width: 80, align: 'right' });
    }
    doc.end();
  } catch (e) {
    console.error('[Export PDF] erreur:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
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

// Suppression d'un appareil (admin). Par défaut, les MESSAGES sont CONSERVÉS.
// Ajouter ?withMessages=1 pour aussi supprimer les messages de cet appareil.
app.delete('/api/admin/devices/:id', requireDashboardAuth, requireAdmin, async (req, res) => {
  const id  = req.params.id;
  const dev = db.prepare("SELECT * FROM devices WHERE id=?").get(id);
  if (!dev) return res.status(404).json({ error: 'Appareil introuvable' });
  const withMessages = req.query.withMessages === '1' || req.query.withMessages === 'true';
  // Permissions liées (SQLite + Firestore)
  const perms = db.prepare("SELECT user_id, device_id FROM device_permissions WHERE device_id=?").all(id);
  db.prepare("DELETE FROM device_permissions WHERE device_id=?").run(id);
  for (const p of perms) await fsDelete('device_permissions', `${p.user_id}__${p.device_id}`);
  // Messages : conservés par défaut
  let messagesDeleted = 0;
  if (withMessages) {
    const msgs = db.prepare("SELECT id FROM messages WHERE device_id=?").all(id);
    messagesDeleted = msgs.length;
    db.prepare("DELETE FROM messages WHERE device_id=?").run(id);
    for (const m of msgs) await fsDelete('messages', m.id);
  }
  // L'appareil lui-même (SQLite + Firestore)
  db.prepare("DELETE FROM devices WHERE id=?").run(id);
  await fsDelete('devices', id);
  io.emit('device_removed', { device_id: id });
  console.log(`[Appareil] supprimé: ${dev.display_name||dev.name||id}${withMessages?` (+${messagesDeleted} messages)`:' (messages conservés)'}`);
  res.json({ ok: true, deleted: id, messagesDeleted });
});

// Débogage : derniers messages IGNORÉS par la liste blanche (pour voir ce que les apps envoient réellement)
app.get('/api/admin/debug/dropped', requireDashboardAuth, requireAdmin, (req, res) => {
  res.json(droppedLog);
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
  pruneMessages();                                   // borne le cache local dès le boot
  setInterval(pruneMessages, 6 * 60 * 60 * 1000);    // puis toutes les 6 h

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
