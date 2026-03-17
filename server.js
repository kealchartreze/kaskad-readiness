const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal')
    ? false  // internal Railway network, no SSL needed
    : { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(__dirname));

// Init table on startup
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kaskad_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('DB ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}

// GET /api/state — load all keys
app.get('/api/state', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM kaskad_state');
    const state = {};
    for (const row of result.rows) {
      try { state[row.key] = JSON.parse(row.value); }
      catch { state[row.key] = row.value; }
    }
    res.json({ ok: true, state });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/state — save all keys
app.post('/api/state', async (req, res) => {
  try {
    const { state } = req.body;
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid payload' });
    }
    for (const [key, value] of Object.entries(state)) {
      const val = typeof value === 'string' ? value : JSON.stringify(value);
      await pool.query(`
        INSERT INTO kaskad_state (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key, val]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Listening on ${PORT}`));
});
