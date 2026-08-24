const fs = require('fs');

class TursoStore {
  constructor({ url, token }) {
    this.url = url;
    this.token = token;
    this.ready = false;
  }

  async _query(sql, args = []) {
    const stmt = { sql };
    if (args.length) {
      stmt.args = args.map(a => ({ type: 'text', value: String(a) }));
    }
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt }, { type: 'close' }] })
    });
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
    const data = await res.json();
    const execResult = data.results && data.results[0];
    if (!execResult || execResult.type === 'error') {
      throw new Error((execResult && execResult.error && execResult.error.message) || 'Turso query failed');
    }
    const result = execResult.response.result;
    const cols = (result.cols || []).map(c => c.name);
    return (result.rows || []).map(row => {
      const obj = {};
      row.forEach((cell, i) => { obj[cols[i]] = cell.type === 'null' ? null : cell.value; });
      return obj;
    });
  }

  async _ensureTable() {
    if (this.ready) return;
    await this._query(`CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      session_name TEXT PRIMARY KEY,
      data_base64 TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.ready = true;
  }

  async sessionExists({ session }) {
    await this._ensureTable();
    const rows = await this._query('SELECT 1 FROM whatsapp_sessions WHERE session_name = ?', [session]);
    return rows.length > 0;
  }

  async save({ session }) {
    await this._ensureTable();
    const buffer = fs.readFileSync(`${session}.zip`);
    const base64 = buffer.toString('base64');
    await this._query(
      'INSERT OR REPLACE INTO whatsapp_sessions (session_name, data_base64, updated_at) VALUES (?, ?, ?)',
      [session, base64, new Date().toISOString()]
    );
    console.log(`[TursoStore] Saved session "${session}" (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  async extract({ session, path }) {
    await this._ensureTable();
    const rows = await this._query('SELECT data_base64 FROM whatsapp_sessions WHERE session_name = ?', [session]);
    if (!rows.length) throw new Error(`No stored session found for "${session}"`);
    fs.writeFileSync(path, Buffer.from(rows[0].data_base64, 'base64'));
    console.log(`[TursoStore] Restored session "${session}" from database`);
  }

  async delete({ session }) {
    await this._ensureTable();
    await this._query('DELETE FROM whatsapp_sessions WHERE session_name = ?', [session]);
  }
}

module.exports = TursoStore;
