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

// ── GEO BENCHMARK ──
const https = require('https');
const http = require('http');
const GEO_ADMIN_TOKEN = process.env.GEO_ADMIN_TOKEN || 'kaskad-geo-admin-2026';
const GEO_URLS = ['https://kaskad.app', 'https://testnet.kaskad.live'];

function fetchUrl(url, timeoutMs = 10000, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, res => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return fetchUrl(next, timeoutMs, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function auditUrl(url) {
  const result = { url, robots_txt: false, llms_txt: false, ssr: false, structured_data: false, citability_score: 0 };
  const domain = url.replace('https://', '');

  try {
    const r = await fetchUrl(`${url}/robots.txt`);
    const ct = (r.headers['content-type'] || '');
    result.robots_txt = r.status === 200 && ct.includes('text/plain') && r.body.includes('User-agent');
  } catch(e) {}

  try {
    const r = await fetchUrl(`${url}/llms.txt`);
    const ct = (r.headers['content-type'] || '');
    result.llms_txt = r.status === 200 && ct.includes('text/plain') && r.body.length > 20;
  } catch(e) {}

  try {
    const r = await fetchUrl(url);
    const body = r.body;
    // SSR check: meaningful text content server-rendered
    const textLen = body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().length;
    result.ssr = textLen > 500;
    // Structured data check
    result.structured_data = body.includes('application/ld+json') || body.includes('schema.org');
    // Citability: count paragraphs with 100+ chars
    const paras = (body.match(/<p[^>]*>([^<]{100,})<\/p>/gi) || []).length;
    result.citability_score = Math.min(paras * 5, 15);
  } catch(e) {}

  return result;
}

function computeGeoScore(urlResults) {
  const scores = urlResults.map(r => {
    let s = 0;
    if (r.robots_txt) s += 15;
    if (r.llms_txt) s += 20;
    if (r.ssr) s += 30;
    if (r.structured_data) s += 20;
    s += r.citability_score || 0;
    return s;
  });
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// Agentic readiness checks — testnet.kaskad.live endpoints
async function auditAgenticReadiness() {
  const BASE = 'https://testnet.kaskad.live';
  const checks = {
    mcp_server: false,
    advisor_epoch_context: false,
    advisor_signals: false,
    llms_txt_references_api: false,
    ai_toggle_dapp: false,
    scoped_agent_approvals: false,
  };

  // MCP server — must return JSON with content-type application/json
  for (const path of ['/.well-known/mcp', '/mcp', '/api/mcp']) {
    try {
      const r = await fetchUrl(`${BASE}${path}`, 5000);
      const ct = (r.headers['content-type'] || '');
      if (r.status === 200 && ct.includes('application/json')) { checks.mcp_server = true; break; }
    } catch(e) {}
  }

  // Advisor API endpoints — must return JSON, not HTML catch-all
  try {
    const r = await fetchUrl(`${BASE}/api/advisor/epoch-context`, 5000);
    const ct = (r.headers['content-type'] || '');
    checks.advisor_epoch_context = r.status === 200 && ct.includes('application/json');
  } catch(e) {}

  try {
    const r = await fetchUrl(`${BASE}/api/advisor/signals`, 5000);
    const ct = (r.headers['content-type'] || '');
    checks.advisor_signals = r.status === 200 && ct.includes('application/json');
  } catch(e) {}

  // llms.txt references API
  try {
    const r = await fetchUrl(`https://kaskad.app/llms.txt`, 5000);
    if (r.status === 200) {
      checks.llms_txt_references_api = r.body.includes('/api/') || r.body.includes('advisor') || r.body.includes('mcp');
    }
  } catch(e) {}

  // AI toggle on dApp — check for any AI/advisor UI hint in page source
  try {
    const r = await fetchUrl(BASE, 8000);
    checks.ai_toggle_dapp = r.body.includes('advisor') || r.body.includes('ai-toggle') || r.body.includes('position-analysis');
  } catch(e) {}

  // Scoped agent approvals — must return JSON
  try {
    const r = await fetchUrl(`${BASE}/api/agent/scope`, 5000);
    const ct = (r.headers['content-type'] || '');
    checks.scoped_agent_approvals = r.status === 200 && ct.includes('application/json');
  } catch(e) {}

  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  const score = Math.round((passed / total) * 100);

  return { checks, score, passed, total };
}

// GET /api/geo/score — public
app.get('/api/geo/score', async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM kaskad_state WHERE key = 'geo_benchmark'");
    if (!result.rows.length) return res.json({ status: 'no_data', geo_score: 15, date: '2026-03-19' });
    const data = JSON.parse(result.rows[0].value);
    res.json({ status: 'ok', ...data });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/geo/run — admin only
app.post('/api/geo/run', async (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  if (token !== GEO_ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });

  try {
    const [urlResults, agenticResult] = await Promise.all([
      Promise.all(GEO_URLS.map(auditUrl)),
      auditAgenticReadiness()
    ]);
    const geoScore = computeGeoScore(urlResults);
    const date = new Date().toISOString().slice(0, 10);

    const criticalIssues = [];
    const quickWins = [];
    for (const r of urlResults) {
      const d = r.url.replace('https://', '');
      if (!r.ssr) criticalIssues.push(`${d}: client-side only — AI crawlers see no content`);
      if (!r.robots_txt) criticalIssues.push(`${d}: no robots.txt`);
      if (!r.llms_txt && r.url.includes('kaskad.app')) quickWins.push(`${d}: add llms.txt`);
      if (!r.structured_data) quickWins.push(`${d}: add JSON-LD structured data`);
    }

    // Agentic issues
    const ag = agenticResult.checks;
    if (!ag.mcp_server) criticalIssues.push('No MCP server detected on testnet.kaskad.live');
    if (!ag.advisor_epoch_context) quickWins.push('Build /api/advisor/epoch-context (Pierrick)');
    if (!ag.advisor_signals) quickWins.push('Build /api/advisor/signals (Pierrick)');

    const report = {
      geo_score: geoScore, date,
      urls: Object.fromEntries(urlResults.map(r => [r.url.replace('https://', ''), r])),
      agentic: agenticResult,
      critical_issues: criticalIssues,
      quick_wins: quickWins,
      status: 'ok'
    };

    await pool.query(`
      INSERT INTO kaskad_state (key, value, updated_at) VALUES ('geo_benchmark', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [JSON.stringify(report)]);

    res.json(report);
  } catch(err) {
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
