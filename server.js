require('dotenv').config();

// Safety net: log unexpected errors instead of letting one bad promise
// crash the entire bridge and force a re-pair. The real fixes are the
// batched Turso writes in turso-store.js/baileys-auth.js — this is just
// a backstop in case something else slips through.
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const TursoKVStore = require('./turso-store');
const useTursoAuthState = require('./baileys-auth');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'changeme';
const MAPPING_FILE = path.join(__dirname, 'groups-config.json');

// ---------- state ----------
let latestQr = null;
let isReady = false;
let userInfo = null;
let sock = null;

// Group mapping used to live in a local groups-config.json file. On
// Render's free tier, the filesystem is wiped every time the instance
// spins down from inactivity and back up, so that mapping kept vanishing
// silently. It's now stored in Turso (same as the WhatsApp session
// creds) under a single key, so it actually persists.
async function loadMapping() {
  try {
    const raw = await kvStore.get('group-mapping');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('[server] failed to load group mapping from Turso, falling back to local file:', e.message);
    try {
      return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
    } catch (e2) {
      return {};
    }
  }
}
async function saveMapping(mapping) {
  await kvStore.set('group-mapping', JSON.stringify(mapping));
  // Best-effort local copy too, purely as a debugging convenience — not relied on.
  try { fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2)); } catch (e) {}
}
function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

// ---------- whatsapp connection (Baileys — no Chrome needed) ----------
const kvStore = new TursoKVStore({
  url: process.env.TURSO_DB_URL,
  token: process.env.TURSO_DB_TOKEN
});

async function startSock() {
  const { state, saveCreds } = await useTursoAuthState(kvStore);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.toDataURL(qr).then(dataUrl => { latestQr = dataUrl; });
      isReady = false;
      console.log('New QR code generated. Visit /qr to scan it, or /pair?phone=YOURNUMBER for a pairing code instead.');
    }

    if (connection === 'open') {
      isReady = true;
      latestQr = null;
      userInfo = sock.user;
      console.log('WhatsApp connected as', userInfo && (userInfo.name || userInfo.id));
    }

    if (connection === 'close') {
      isReady = false;
      const statusCode = new Boom(lastDisconnect && lastDisconnect.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log('Connection closed. Status code:', statusCode, loggedOut ? '(logged out — clearing stale session and generating a new QR/code)' : '(reconnecting...)');
      if (loggedOut) {
        // The stored session is dead and will never be accepted again —
        // wipe it so the next startSock() starts fresh and actually
        // offers a new QR code instead of getting stuck here forever.
        kvStore.clearAll()
          .catch(e => console.error('[server] failed to clear stale session:', e.message))
          .finally(() => startSock());
      } else {
        startSock();
      }
    }
  });
}

startSock();

// ---------- express app ----------
const app = express();
app.use(cors());
app.use(express.json());

function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  }
  next();
}

// Status/admin page
app.get('/', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>CarryBee WhatsApp Bridge</title>
    <style>
      body{font-family:'Plus Jakarta Sans',Arial,sans-serif;background:#FFFDF7;color:#1c1c1c;max-width:640px;margin:60px auto;padding:0 20px;}
      h1{font-family:'Space Grotesk',sans-serif;font-size:20px;}
      .badge{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:600;font-size:13px;}
      .on{background:#e9f6ee;color:#2E8B57;}
      .off{background:#fdeceb;color:#D64545;}
      a{color:#141414;font-weight:600;}
      code{background:#faf8f0;padding:2px 6px;border-radius:4px;}
      footer{margin-top:40px;font-size:11px;color:#7a7566;}
    </style>
  </head>
  <body>
    <h1>🐝 CarryBee WhatsApp Bridge</h1>
    <p>Status: <span class="badge ${isReady ? 'on' : 'off'}">${isReady ? 'Connected' : 'Not connected'}</span></p>
    ${isReady ? `<p>Logged in as: <strong>${userInfo ? (userInfo.name || userInfo.id) : ''}</strong></p>` : `<p>Connect via <a href="/qr">/qr</a> (scan) or <a href="/pair">/pair</a> (type a code)</p>`}
    <p>List your WhatsApp groups (and their IDs) at: <a href="/api/groups">/api/groups</a> (requires <code>x-api-key</code> header)</p>
    <p>Current dashboard → WhatsApp group mapping is in <code>groups-config.json</code>, or manage it via <code>POST /api/mapping</code>.</p>
    <footer>Powered by NAHID</footer>
  </body>
  </html>
  `);
});

// QR code page
app.get('/qr', (req, res) => {
  if (isReady) {
    return res.send('<p style="font-family:sans-serif">Already connected. <a href="/">Back to status</a></p>');
  }
  if (!latestQr) {
    return res.send('<p style="font-family:sans-serif">Waiting for QR code to generate... refresh in a few seconds.</p>');
  }
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Scan to connect</title>
    <style>body{font-family:sans-serif;text-align:center;margin-top:60px;background:#FFFDF7;}
    h1{font-family:sans-serif;color:#141414;}</style></head>
    <body>
      <h1>Scan with WhatsApp on your phone</h1>
      <p>WhatsApp → Linked devices → Link a device</p>
      <img src="${latestQr}" style="width:280px;height:280px;border:8px solid #FFC72C;border-radius:12px;" />
      <p style="margin-top:24px;"><a href="/pair">Prefer a code instead of scanning?</a></p>
    </body></html>
  `);
});

// Pairing code page — type this into WhatsApp instead of scanning a QR code
app.get('/pair', async (req, res) => {
  if (isReady) {
    return res.send('<p style="font-family:sans-serif">Already connected. <a href="/">Back to status</a></p>');
  }

  const rawPhone = (req.query.phone || '').replace(/[^\d]/g, '');

  const pageWrap = (body) => `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Link with phone number</title>
    <style>
      body{font-family:sans-serif;text-align:center;margin-top:60px;background:#FFFDF7;color:#141414;}
      input{font-size:18px;padding:10px;border-radius:8px;border:1px solid #ccc;width:260px;}
      button{font-size:16px;padding:10px 20px;border-radius:8px;border:none;background:#FFC72C;font-weight:700;cursor:pointer;margin-left:8px;}
      code{font-size:36px;letter-spacing:6px;background:#faf8f0;padding:16px 24px;border-radius:12px;border:8px solid #FFC72C;display:inline-block;margin-top:20px;}
    </style></head>
    <body>${body}</body></html>
  `;

  if (!rawPhone) {
    return res.send(pageWrap(`
      <h1>Link with phone number</h1>
      <p>Enter the CarryBee WhatsApp number, with country code, no spaces, no + sign.<br>Example for Bangladesh: 8801XXXXXXXXX</p>
      <form action="/pair" method="GET">
        <input type="text" name="phone" placeholder="8801XXXXXXXXX" required />
        <button type="submit">Get code</button>
      </form>
      <p style="margin-top:24px;"><a href="/qr">Prefer to scan a QR code instead?</a></p>
    `));
  }

  if (!sock || !sock.authState || sock.authState.creds.registered) {
    return res.send(pageWrap(`
      <h1>Not ready yet</h1>
      <p>The bridge is still starting up, or is already registered. Wait a few seconds and reload, or check <a href="/">the status page</a>.</p>
    `));
  }

  try {
    const code = await sock.requestPairingCode(rawPhone);
    res.send(pageWrap(`
      <h1>Enter this code in WhatsApp</h1>
      <p>On the CarryBee phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead"</p>
      <code>${code}</code>
      <p style="margin-top:24px;color:#7a7566;font-size:13px;">Code expires after a short time — if it stops working, reload this page for a new one.</p>
    `));
  } catch (e) {
    res.send(pageWrap(`
      <h1>Something went wrong</h1>
      <p>${e.message}</p>
      <p><a href="/pair">Try again</a></p>
    `));
  }
});

// Connection status (JSON)
app.get('/api/status', (req, res) => {
  res.json({ ready: isReady, name: userInfo ? (userInfo.name || userInfo.id) : null });
});

// List all WhatsApp groups this account is a member of
app.get('/api/groups', requireApiKey, async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp client not connected yet' });
  try {
    const groupsObj = await sock.groupFetchAllParticipating();
    const groups = Object.values(groupsObj).map(g => ({ id: g.id, name: g.subject }));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// View current mapping
app.get('/api/mapping', requireApiKey, async (req, res) => {
  res.json(await loadMapping());
});

// Add or update a mapping entry: { "dashboard_name": "...", "group_id": "...@g.us" }
app.post('/api/mapping', requireApiKey, async (req, res) => {
  const { dashboard_name, group_id } = req.body;
  if (!dashboard_name || !group_id) {
    return res.status(400).json({ error: 'dashboard_name and group_id are required' });
  }
  const mapping = await loadMapping();
  mapping[normalizeName(dashboard_name)] = { label: dashboard_name, group_id };
  await saveMapping(mapping);
  res.json({ ok: true, mapping });
});

// Remove a mapping entry
app.delete('/api/mapping/:dashboard_name', requireApiKey, async (req, res) => {
  const mapping = await loadMapping();
  const key = normalizeName(req.params.dashboard_name);
  delete mapping[key];
  await saveMapping(mapping);
  res.json({ ok: true, mapping });
});

// Main endpoint: dashboard calls this when a KAM saves a remark
// body: { group_name: "CarryBee Issue Group || NN1", message: "...(fully formatted by the dashboard)..." }
app.post('/api/send-remark', requireApiKey, async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp client not connected yet' });

  const { group_name, message } = req.body;
  if (!group_name || !message) {
    return res.status(400).json({ error: 'group_name and message are required' });
  }

  const mapping = await loadMapping();
  const entry = mapping[normalizeName(group_name)];
  if (!entry) {
    return res.status(404).json({
      error: `No WhatsApp group mapped for "${group_name}". Add it via POST /api/mapping first.`
    });
  }

  try {
    await sock.sendMessage(entry.group_id, { text: message });
    res.json({ ok: true, sent_to: entry.label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One-click admin page — no commands, no headers to type by hand.
// The API key you enter here stays only in your browser and is sent
// automatically with each button click.
app.get('/admin', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>CarryBee Bridge Admin</title>
    <style>
      body{font-family:'Plus Jakarta Sans',Arial,sans-serif;background:#FFFDF7;color:#1c1c1c;max-width:760px;margin:40px auto;padding:0 20px;}
      h1{font-family:'Space Grotesk',sans-serif;font-size:22px;}
      h2{font-size:15px;margin-top:36px;border-top:1px solid #eee;padding-top:24px;}
      label{display:block;font-size:12px;font-weight:600;color:#555;margin-bottom:4px;margin-top:12px;}
      input{width:100%;box-sizing:border-box;font-size:14px;padding:9px 10px;border-radius:8px;border:1px solid #ccc;}
      button{font-size:13px;padding:9px 16px;border-radius:8px;border:none;background:#FFC72C;font-weight:700;cursor:pointer;margin-top:12px;}
      button.secondary{background:#eee;}
      table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px;}
      td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;}
      .msg{font-size:13px;padding:8px 10px;border-radius:6px;margin-top:10px;}
      .msg.ok{background:#e9f6ee;color:#2E8B57;}
      .msg.err{background:#fdeceb;color:#D64545;}
      .row{display:flex;gap:8px;align-items:end;}
      .row > div{flex:1;}
      code{background:#faf8f0;padding:1px 5px;border-radius:4px;font-size:12px;}
    </style>
  </head>
  <body>
    <h1>🐝 CarryBee Bridge Admin</h1>

    <label>Bridge API Key</label>
    <input type="password" id="apiKey" placeholder="paste your API_KEY here" />
    <p style="font-size:11px;color:#888;">This stays only in your browser tab — it's sent with each button click below, nothing is saved anywhere.</p>

    <h2>1. Your WhatsApp groups</h2>
    <button onclick="loadGroups()">Load my WhatsApp groups</button>
    <div id="groupsMsg"></div>
    <table id="groupsTable" style="display:none;">
      <thead><tr><th>Group name</th><th>Group ID</th></tr></thead>
      <tbody id="groupsBody"></tbody>
    </table>

    <h2>2. Map a dashboard group name → WhatsApp group</h2>
    <div class="row">
      <div>
        <label>Dashboard group name (exact text, e.g. "CarryBee Issue Group || NN1")</label>
        <input type="text" id="mapName" placeholder="CarryBee Issue Group || NN1" />
      </div>
    </div>
    <label>WhatsApp group</label>
    <select id="mapGroupSelect" style="width:100%;padding:9px 10px;border-radius:8px;border:1px solid #ccc;font-size:14px;">
      <option value="">Load groups above first</option>
    </select>
    <button onclick="saveMapping()">Save mapping</button>
    <div id="mapMsg"></div>

    <h2>3. Current mappings</h2>
    <button class="secondary" onclick="loadMappings()">Refresh current mappings</button>
    <div id="mappingsMsg"></div>
    <table id="mappingsTable" style="display:none;">
      <thead><tr><th>Dashboard group name</th><th>WhatsApp group ID</th><th></th></tr></thead>
      <tbody id="mappingsBody"></tbody>
    </table>

    <script>
      function key() { return document.getElementById('apiKey').value.trim(); }
      function showMsg(elId, text, ok) {
        document.getElementById(elId).innerHTML = '<div class="msg ' + (ok ? 'ok' : 'err') + '">' + text + '</div>';
      }
      async function api(path, opts = {}) {
        const res = await fetch(path, {
          ...opts,
          headers: { 'Content-Type': 'application/json', 'x-api-key': key(), ...(opts.headers || {}) }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status));
        return data;
      }

      let lastGroups = [];

      async function loadGroups() {
        if (!key()) { showMsg('groupsMsg', 'Enter your API key first.', false); return; }
        showMsg('groupsMsg', 'Loading...', true);
        try {
          const data = await api('/api/groups');
          lastGroups = data.groups || [];
          const body = document.getElementById('groupsBody');
          body.innerHTML = lastGroups.map(g => '<tr><td>' + g.name + '</td><td><code>' + g.id + '</code></td></tr>').join('');
          document.getElementById('groupsTable').style.display = lastGroups.length ? 'table' : 'none';
          const select = document.getElementById('mapGroupSelect');
          select.innerHTML = lastGroups.map(g => '<option value="' + g.id + '">' + g.name + '</option>').join('');
          showMsg('groupsMsg', 'Loaded ' + lastGroups.length + ' groups.', true);
        } catch (e) {
          showMsg('groupsMsg', e.message, false);
        }
      }

      async function saveMapping() {
        if (!key()) { showMsg('mapMsg', 'Enter your API key first.', false); return; }
        const dashboard_name = document.getElementById('mapName').value.trim();
        const group_id = document.getElementById('mapGroupSelect').value;
        if (!dashboard_name || !group_id) { showMsg('mapMsg', 'Fill in both the dashboard name and pick a WhatsApp group.', false); return; }
        try {
          await api('/api/mapping', { method: 'POST', body: JSON.stringify({ dashboard_name, group_id }) });
          showMsg('mapMsg', 'Saved: "' + dashboard_name + '" → that WhatsApp group.', true);
          document.getElementById('mapName').value = '';
          loadMappings();
        } catch (e) {
          showMsg('mapMsg', e.message, false);
        }
      }

      async function loadMappings() {
        if (!key()) { showMsg('mappingsMsg', 'Enter your API key first.', false); return; }
        try {
          const data = await api('/api/mapping');
          const entries = Object.entries(data);
          const body = document.getElementById('mappingsBody');
          body.innerHTML = entries.map(([k, v]) =>
            '<tr><td>' + v.label + '</td><td><code>' + v.group_id + '</code></td>' +
            '<td><button class="secondary" onclick="removeMapping(\\'' + v.label.replace(/'/g, "\\\\'") + '\\')">Remove</button></td></tr>'
          ).join('');
          document.getElementById('mappingsTable').style.display = entries.length ? 'table' : 'none';
          showMsg('mappingsMsg', entries.length + ' mapping(s) saved.', true);
        } catch (e) {
          showMsg('mappingsMsg', e.message, false);
        }
      }

      async function removeMapping(name) {
        if (!key()) return;
        try {
          await api('/api/mapping/' + encodeURIComponent(name), { method: 'DELETE' });
          loadMappings();
        } catch (e) {
          showMsg('mappingsMsg', e.message, false);
        }
      }
    </script>
  </body>
  </html>
  `);
});

app.listen(PORT, () => {
  console.log(`CarryBee WhatsApp Bridge running on port ${PORT}`);
});
