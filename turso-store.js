class TursoKVStore {
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
    await this._query(`CREATE TABLE IF NOT EXISTS baileys_auth (
      key_name TEXT PRIMARY KEY,
      value_text TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.ready = true;
  }

  async get(key) {
    await this._ensureTable();
    const rows = await this._query('SELECT value_text FROM baileys_auth WHERE key_name = ?', [key]);
    return rows.length ? rows[0].value_text : null;
  }

  async set(key, value) {
    await this._ensureTable();
    await this._query(
      'INSERT OR REPLACE INTO baileys_auth (key_name, value_text, updated_at) VALUES (?, ?, ?)',
      [key, value, new Date().toISOString()]
    );
  }

  async delete(key) {
    await this._ensureTable();
    await this._query('DELETE FROM baileys_auth WHERE key_name = ?', [key]);
  }
}

module.exports = TursoKVStore;
