import 'dotenv/config';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import bcrypt from 'bcrypt';
import mariadb from 'mariadb';
import { WebSocketServer } from 'ws';

const __dirname = path.resolve();

const {
  PORT = 3000,
  DB_HOST,
  DB_PORT = 3306,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  AUTH_TOKEN_SECRET = 'dev-secret'
} = process.env;

// --- DB pool (Promise API)
const pool = mariadb.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  connectionLimit: 5
});

// --- Auth token simple (HMAC). Para producción, JWT real.
function signToken(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// --- Express
const app = express();
app.use(express.json());

// Sirve public/index.html y public/main.js directamente [web:133]
app.use(express.static(path.join(__dirname, 'public')));

// (Opcional) Fuerza que / devuelva index.html incluso si cambias opciones
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- API: login
app.post('/api/login', async (req, res) => {
  const { login, password } = req.body ?? {};
  if (!login || !password) return res.status(400).json({ error: 'login/password required' });

  const rows = await pool.query(
    `SELECT id, username, email, password_hash, is_active
     FROM users
     WHERE email = ? OR username = ?
     LIMIT 1`,
    [login, login]
  );

  if (!rows.length) return res.status(401).json({ error: 'invalid credentials' });
  const u = rows[0];
  if (!u.is_active) return res.status(403).json({ error: 'inactive user' });

  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });

  const token = signToken({ userId: u.id, username: u.username, iat: Date.now() });
  res.json({ token, user: { id: u.id, username: u.username, email: u.email } });
});

// --- API: register
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body ?? {};

  const u = String(username ?? '').trim();
  const e = String(email ?? '').trim().toLowerCase();
  const p = String(password ?? '');

  if (!u || !e || !p) return res.status(400).json({ error: 'username/email/password required' });
  if (u.length < 3) return res.status(400).json({ error: 'username_too_short' });
  if (p.length < 6) return res.status(400).json({ error: 'password_too_short' });

  const saltRounds = 10;
  const passwordHash = await bcrypt.hash(p, saltRounds);

  try {
    const r = await pool.query(
      `INSERT INTO users (username, email, password_hash, is_active)
       VALUES (?, ?, ?, 1)`,
      [u, e, passwordHash]
    );

    const userId = Number(r.insertId);
    res.status(201).json({ ok: true, userId });
  } catch (err) {
    // ER_DUP_ENTRY (errno 1062): duplicate entry típico de UNIQUE [web:115]
    if (err && (err.errno === 1062 || String(err.code).includes('ER_DUP_ENTRY'))) {
      return res.status(409).json({ error: 'user_exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- HTTP server + WS server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- Presencia en memoria
// userId -> Set(ws)
const connectionsByUser = new Map();

// ws -> { userId, username }
const sessionBySocket = new WeakMap();

function isUserOnline(userId) {
  const set = connectionsByUser.get(userId);
  return !!set && set.size > 0;
}

async function sendUsersList(toWs = null) {
  const users = await pool.query(`SELECT id, username, email, is_active FROM users ORDER BY username ASC`);
  const payload = users
    .filter(u => u.is_active)
    .map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      online: isUserOnline(u.id)
    }));

  const msg = JSON.stringify({ type: 'users', users: payload });

  if (toWs) {
    if (toWs.readyState === toWs.OPEN) toWs.send(msg);
    return;
  }
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendToUser(userId, obj) {
  const set = connectionsByUser.get(userId);
  if (!set) return;

  const data = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// --- Util: obtener (o crear) conversación DM entre dos usuarios
async function getOrCreateDM(userA, userB) {
  const [minId, maxId] = userA < userB ? [userA, userB] : [userB, userA];

  const rows = await pool.query(
    `
    SELECT c.id
    FROM conversations c
    JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
    JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
    WHERE c.type = 'dm'
    LIMIT 1
    `,
    [minId, maxId]
  );

  if (rows.length) return rows[0].id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const r = await conn.query(
      `INSERT INTO conversations (type, title, created_by) VALUES ('dm', NULL, ?)`,
      [userA]
    );
    const conversationId = Number(r.insertId);

    await conn.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES (?, ?, 'member'), (?, ?, 'member')`,
      [conversationId, userA, conversationId, userB]
    );

    await conn.commit();
    return conversationId;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// --- Offline queue: entregar pendientes al conectar
async function deliverPendingToUser(userId) {
  // Como message_receipts ahora tiene PK (message_id, user_id), no filtramos por device_id
  const rows = await pool.query(
    `
    SELECT m.id, m.conversation_id, m.sender_user_id, m.body, m.created_at
    FROM messages m
    JOIN conversation_members cm
      ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
    LEFT JOIN message_receipts r
      ON r.message_id = m.id AND r.user_id = ?
    WHERE r.delivered_at IS NULL
    ORDER BY m.created_at ASC
    LIMIT 500
    `,
    [userId, userId]
  );

  for (const m of rows) {
    sendToUser(userId, {
      type: 'msg_new',
      msgId: m.id,
      conversationId: m.conversation_id,
      fromUserId: m.sender_user_id,
      body: m.body,
      createdAt: m.created_at
    });
  }
}

// --- WS: conexión
wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return safeSend(ws, { type: 'error', error: 'invalid_json' });
    }

    // 1) handshake
    if (msg.type === 'hello') {
      const { token } = msg;
      const payload = verifyToken(token);
      if (!payload?.userId) {
        safeSend(ws, { type: 'error', error: 'unauthorized' });
        return ws.close(1008, 'unauthorized');
      }

      const userId = Number(payload.userId);

      const rows = await pool.query(`SELECT id, username, is_active FROM users WHERE id = ? LIMIT 1`, [userId]);
      if (!rows.length || !rows[0].is_active) {
        safeSend(ws, { type: 'error', error: 'unauthorized' });
        return ws.close(1008, 'unauthorized');
      }

      sessionBySocket.set(ws, { userId, username: rows[0].username });

      let set = connectionsByUser.get(userId);
      if (!set) connectionsByUser.set(userId, (set = new Set()));
      set.add(ws);

      safeSend(ws, { type: 'hello_ok', userId, username: rows[0].username });

      await sendUsersList();          // presencia en tiempo real
      await deliverPendingToUser(userId); // cola offline

      return;
    }

    // Requiere sesión
    const session = sessionBySocket.get(ws);
    if (!session) return safeSend(ws, { type: 'error', error: 'unauthorized' });

    // 2) enviar mensaje (DM)
    if (msg.type === 'msg_send') {
      const fromUserId = session.userId;
      const toUserId = Number(msg.toUserId);
      const body = String(msg.body ?? '').trim();

      if (!toUserId || !body) return safeSend(ws, { type: 'error', error: 'bad_request' });

      const blocked = await pool.query(
        `SELECT 1 FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ? LIMIT 1`,
        [toUserId, fromUserId]
      );
      if (blocked.length) return safeSend(ws, { type: 'error', error: 'blocked' });

      const conversationId = await getOrCreateDM(fromUserId, toUserId);

      const r = await pool.query(
        `INSERT INTO messages (conversation_id, sender_user_id, body, msg_type)
         VALUES (?, ?, ?, 'text')`,
        [conversationId, fromUserId, body]
      );
      const msgId = Number(r.insertId);

      // Entrega inmediata si está online; si no, quedará para deliverPendingToUser()
      sendToUser(toUserId, {
        type: 'msg_new',
        msgId,
        conversationId,
        fromUserId,
        body,
        createdAt: new Date().toISOString()
      });

      // confirmación al emisor
      safeSend(ws, { type: 'msg_sent', msgId, conversationId });

      return;
    }

    // 3) ACK entrega (doble check)
    if (msg.type === 'msg_delivered') {
      const userId = session.userId;
      const msgId = Number(msg.msgId);
      if (!msgId) return safeSend(ws, { type: 'error', error: 'bad_request' });

      await pool.query(
        `
        INSERT INTO message_receipts (message_id, user_id, delivered_at)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE delivered_at = COALESCE(delivered_at, VALUES(delivered_at))
        `,
        [msgId, userId]
      );

      const rows = await pool.query(
        `SELECT sender_user_id FROM messages WHERE id = ? LIMIT 1`,
        [msgId]
      );
      if (rows.length) {
        const senderId = Number(rows[0].sender_user_id);
        sendToUser(senderId, { type: 'msg_delivered', msgId, byUserId: userId });
      }

      return;
    }

    safeSend(ws, { type: 'error', error: 'unknown_type' });
  });

  ws.on('close', async () => {
    const session = sessionBySocket.get(ws);
    if (!session) return;

    const { userId } = session;

    const set = connectionsByUser.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) connectionsByUser.delete(userId);
    }

    await sendUsersList(); // lista de usuarios/presencia en tiempo real
  });
});

server.listen(Number(PORT), () => {
  console.log(`HTTP+WS listening on :${PORT}`);
});
