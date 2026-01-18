let token = null;
let me = null;

let ws = null;
let selectedUser = null;

// msgId -> { el, fromUserId }
const msgDomById = new Map();

const $ = (id) => document.getElementById(id);

const usersEl = $('users');
const chatEl = $('chat');
const chatTitleEl = $('chatTitle');
const statusEl = $('status');
const meEl = $('me');

const loginDialog = $('loginDialog');
const loginForm = $('loginForm');
const loginError = $('loginError');
const logoutBtn = $('logoutBtn');

const textEl = $('text');
const sendBtn = $('send');
const composer = $('composer');

function setStatus(text) {
  statusEl.textContent = text;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function wsUrl() {
  // si el servidor está detrás de HTTPS, el navegador usará wss automáticamente
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function enableChat(enabled) {
  textEl.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

function appendMsg({ msgId, fromUserId, body, delivered = false }) {
  const isMe = fromUserId === me?.id;
  const div = document.createElement('div');
  div.className = `msg ${isMe ? 'me' : ''}`;
  div.dataset.msgId = msgId;

  const checks = isMe ? `<span class="meta">${delivered ? '✓✓' : '✓'}</span>` : '';
  div.innerHTML = `
    <div>${escapeHtml(body)}</div>
    <div class="meta">${isMe ? 'Tú' : 'Ell@'} ${checks}</div>
  `;

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;

  msgDomById.set(Number(msgId), { el: div, fromUserId });
}

function markDelivered(msgId) {
  const entry = msgDomById.get(Number(msgId));
  if (!entry) return;

  // solo tiene sentido pintar doble-check en mensajes míos
  if (entry.fromUserId !== me?.id) return;

  const meta = entry.el.querySelector('.meta');
  if (!meta) return;

  // reemplaza el último check por doble check
  meta.innerHTML = `Tú <span class="meta">✓✓</span>`;
}

function clearChat() {
  chatEl.innerHTML = '';
  msgDomById.clear();
}

// --- Login (HTTP)
async function doLogin(login, password) {
  const res = await fetch('/api/login', {           // fetch para POST JSON [web:99]
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'login_failed');

  token = data.token;
  me = data.user;

  meEl.textContent = `(${me.username})`;
}

// --- WebSocket
function connectWs() {
  ws = new WebSocket(wsUrl()); // API WebSocket nativa [web:90]

  ws.addEventListener('open', () => {
    setStatus('Conectado, autenticando…');
    ws.send(JSON.stringify({ type: 'hello', token })); // enviar JSON por WS [web:95][web:101]
  });

  ws.addEventListener('message', (event) => { // evento message [web:88]
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { return; }

    if (msg.type === 'hello_ok') {
      setStatus('Online');
      enableChat(!!selectedUser);
      return;
    }

    if (msg.type === 'users') {
      renderUsers(msg.users);
      return;
    }

    if (msg.type === 'msg_sent') {
      // confirmación servidor: pinta el mensaje como "✓"
      // (el cuerpo lo tenemos localmente; aquí solo confirmamos msgId)
      return;
    }

    if (msg.type === 'msg_new') {
      // Si no está seleccionado el chat con ese usuario, igual lo mostramos (simple)
      const fromUserId = Number(msg.fromUserId);
      const body = String(msg.body ?? '');
      const msgId = Number(msg.msgId);

      // pintar
      appendMsg({ msgId, fromUserId, body, delivered: false });

      // ACK al servidor (doble check) para cualquier mensaje recibido
      ws.send(JSON.stringify({ type: 'msg_delivered', msgId })); // ack delivered
      return;
    }

    if (msg.type === 'msg_delivered') {
      // el servidor notifica al emisor que el receptor recibió el mensaje
      markDelivered(msg.msgId);
      return;
    }

    if (msg.type === 'error') {
      setStatus(`Error: ${msg.error}`);
      return;
    }
  });

  ws.addEventListener('close', () => { // evento close [web:89]
    setStatus('Desconectado');
    enableChat(false);
  });

  ws.addEventListener('error', () => {
    setStatus('Error de conexión');
  });
}

function renderUsers(users) {
  usersEl.innerHTML = '';

  for (const u of users) {
    if (u.id === me?.id) continue;

    const li = document.createElement('li');
    li.className = 'user';
    li.innerHTML = `
      <div>
        <div>${escapeHtml(u.username)}</div>
        <small>${escapeHtml(u.email)}</small>
      </div>
      <div class="${u.online ? 'online' : 'offline'}">${u.online ? 'online' : 'offline'}</div>
    `;

    li.addEventListener('click', () => {
      selectedUser = u;
      chatTitleEl.textContent = `Chat con ${u.username}`;
      clearChat();
      enableChat(ws && ws.readyState === WebSocket.OPEN); // readyState OPEN = 1 [web:97]
    });

    usersEl.appendChild(li);
  }
}

const registerForm = document.getElementById('registerForm');
const registerError = document.getElementById('registerError');

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  registerError.textContent = '';

  const username = document.getElementById('regUsername').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const p1 = document.getElementById('regPassword').value;
  const p2 = document.getElementById('regPassword2').value;

  if (p1 !== p2) {
    registerError.textContent = 'Las contraseñas no coinciden.';
    return;
  }

  const res = await fetch('/api/register', {       // fetch POST JSON [web:99]
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password: p1 })
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 409 && data.error === 'user_exists') {
    registerError.textContent = 'Ese usuario o email ya existe.';
    return;
  }
  if (!res.ok) {
    registerError.textContent = `No se pudo registrar: ${data.error || 'error'}`;
    return;
  }

  registerError.textContent = 'Cuenta creada. Ahora haz login arriba.';
  registerForm.reset();
});


// --- Enviar mensaje
composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!selectedUser) return;

  const text = textEl.value.trim();
  if (!text) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) return; // OPEN [web:97]

  // Enviamos al servidor y pintamos localmente como "✓" (aceptado al guardar/enviar)
  ws.send(JSON.stringify({
    type: 'msg_send',
    toUserId: selectedUser.id,
    body: text
  }));

  // Como el servidor genera msgId, aquí pintamos un "temporal" simple:
  // Para simplificar (y no cambiar servidor), lo pintamos sin msgId real.
  // Si quieres ids reales en UI, se añade clientMsgId y el server lo devuelve.
  appendMsg({ msgId: `tmp-${Date.now()}`, fromUserId: me.id, body: text, delivered: false });

  textEl.value = '';
});

// --- UI login
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';

  try {
    await doLogin($('login').value.trim(), $('password').value);
    loginDialog.close();
    connectWs();
  } catch (err) {
    loginError.textContent = 'Login incorrecto (usuario/email o contraseña).';
  }
});

logoutBtn.addEventListener('click', () => {
  token = null;
  me = null;
  selectedUser = null;

  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  ws = null;

  meEl.textContent = '';
  setStatus('Desconectado');
  enableChat(false);
  usersEl.innerHTML = '';
  chatTitleEl.textContent = 'Selecciona un usuario…';
  clearChat();

  loginDialog.showModal();
});

// Arranque
window.addEventListener('load', () => {
  loginDialog.showModal();
});
