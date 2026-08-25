require('dotenv').config();

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

let latestQr = null;
let isReady = false;
let userInfo = null;
let sock = null;

function loadMapping() {
  try {
    return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveMapping(mapping) {
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2));
}
function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

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
      console.log('Connection closed. Status code:', statusCode, loggedOut ? '(logged out — need new QR/code)' : '(reconnecting...)');
      if (!loggedOut) {
        startSock();
      }
    }
  });
}

startSock();

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

app.get('/api/status', (req, res) => {
  res.json({ ready: isReady, name: userInfo ? (userInfo.name || userInfo.id) : null });
});

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

app.get('/api/mapping', requireApiKey, (req, res) => {
  res.json(loadMapping());
});

app.post('/api/mapping', requireApiKey, (req, res) => {
  const { dashboard_name, group_id } = req.body;
  if (!dashboard_name || !group_id) {
    return res.status(400).json({ error: 'dashboard_name and group_id are required' });
  }
  const mapping = loadMapping();
  mapping[normalizeName(dashboard_name)] = { label: dashboard_name, group_id };
  saveMapping(mapping);
  res.json({ ok: true, mapping });
});

app.delete('/api/mapping/:dashboard_name', requireApiKey, (req, res) => {
  const mapping = loadMapping();
  const key = normalizeName(req.params.dashboard_name);
  delete mapping[key];
  saveMapping(mapping);
  res.json({ ok: true, mapping });
});

app.post('/api/send-remark', requireApiKey, async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp client not connected yet' });

  const { group_name, message, ticket_id, kam_name } = req.body;
  if (!group_name || !message) {
    return res.status(400).json({ error: 'group_name and message are required' });
  }

  const mapping = loadMapping();
  const entry = mapping[normalizeName(group_name)];
  if (!entry) {
    return res.status(404).json({
      error: `No WhatsApp group mapped for "${group_name}". Add it via POST /api/mapping first.`
    });
  }

  let formatted = message;
  if (ticket_id) formatted = `*${ticket_id}*\n${formatted}`;
  if (kam_name) formatted = `${formatted}\n— ${kam_name}`;

  try {
    await sock.sendMessage(entry.group_id, { text: formatted });
    res.json({ ok: true, sent_to: entry.label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`CarryBee WhatsApp Bridge running on port ${PORT}`);
});
