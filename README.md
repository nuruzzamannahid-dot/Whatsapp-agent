# CarryBee WhatsApp Bridge

Sends a message to a specific WhatsApp group automatically whenever a KAM saves a remark on the dashboard — using your personal CarryBee WhatsApp number, connected via `whatsapp-web.js`.

## ⚠️ Important — read before using

- `whatsapp-web.js` automates WhatsApp Web. It is **not** an official WhatsApp/Meta API, and using it goes against WhatsApp's Terms of Service. There is a real risk (usually low if usage stays moderate and human-like, but non-zero) that the connected number gets flagged, rate-limited, or banned.
- It connects to whichever number you scan the QR code with. You said you'll use your personal CarryBee number — that number is what will send every message.
- It needs a server that **stays running continuously** with a persistent session folder (`.wwebjs_auth/`). If that folder is wiped, you'll need to re-scan the QR code.
- If this number ever gets banned, there's no official appeal path the way there is with the Business API.

If you want zero risk long-term, the alternative is manually pasting remarks into WhatsApp, or later moving to the official WhatsApp Business API for 1:1 merchant messages (note: the official API does **not** support posting into groups at all, only individual chats).

## What it does

1. You run this service and scan a QR code once (like linking WhatsApp Web).
2. You tell it which WhatsApp group ID corresponds to each "group name" shown on your dashboard (one-time mapping, editable anytime).
3. Your dashboard calls one HTTP endpoint whenever a KAM saves a remark. This service sends that remark into the matching WhatsApp group.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set API_KEY to something private
npm start
```

On first run, open `http://localhost:3000/qr` (or your deployed URL + `/qr`) and scan it with:
**WhatsApp on your phone → Settings → Linked devices → Link a device**

Once connected, `http://localhost:3000/` shows "Connected".

## Map your dashboard group names to real WhatsApp groups

1. Make sure the WhatsApp account you connected is already a member of the target group(s).
2. Call:
   ```bash
   curl http://localhost:3000/api/groups -H "x-api-key: YOUR_API_KEY"
   ```
   This lists every group the account is in, with its `id` (looks like `1203630xxxxxxxxx@g.us`).
3. Map a dashboard group name to that ID:
   ```bash
   curl -X POST http://localhost:3000/api/mapping \
     -H "x-api-key: YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"dashboard_name": "CarryBee Issue Group || NN1", "group_id": "1203630xxxxxxxxx@g.us"}'
   ```
4. Repeat for every group name your dashboard uses. You can also remove a mapping with `DELETE /api/mapping/:dashboard_name`.

## Wiring it into your dashboard

Wherever your dashboard currently saves a KAM's remark (the code that writes it to Sheets/Turso), add one more call right after:

```javascript
await fetch('https://your-bridge-url.onrender.com/api/send-remark', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    group_name: 'CarryBee Issue Group || NN1',  // exactly as shown on your dashboard
    message: remarkText,
    ticket_id: 'CB-0816-00856',                  // optional, gets bolded at the top
    kam_name: 'Nuruzzaman Nahid'                  // optional, gets added as a signature
  })
});
```

If you share the dashboard's remark-saving code (or the repo), I can write this integration directly into it instead of you wiring it by hand.

## Deploying on Render

- Use a **paid** web service instance (not free tier) — free tier sleeps after inactivity, which drops the WhatsApp session.
- Add a **persistent disk** mounted at `.wwebjs_auth/` (Render → your service → Disks). Without persistent storage, every redeploy wipes the session and you'll need to re-scan the QR code.
- Set `API_KEY` as an environment variable in Render's dashboard, not committed to the repo.

## Endpoints summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Status page |
| GET | `/qr` | Scan to connect |
| GET | `/api/status` | JSON connection status |
| GET | `/api/groups` | List WhatsApp groups + IDs (needs `x-api-key`) |
| GET | `/api/mapping` | View current dashboard→group mapping |
| POST | `/api/mapping` | Add/update a mapping entry |
| DELETE | `/api/mapping/:dashboard_name` | Remove a mapping entry |
| POST | `/api/send-remark` | Send a remark to its mapped group |

---
Powered by NAHID
