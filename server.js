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

// Basic Auth â€” protects all routes except /health
const DASH_USER = process.env.DASHBOARD_USER || 'kaskad';
const DASH_PASS = process.env.DASHBOARD_PASSWORD || '';
app.use((req, res, next) => {
  if (req.path === '/health') return next(); // allow health checks unauthenticated
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (user === DASH_USER && pass === DASH_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Kaskad Dashboard"');
  res.status(401).send('Unauthorized');
});

// Serve static files â€” no-cache for HTML to always get fresh deploys
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  }
}));

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

// GET /api/state â€” load all keys
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

// POST /api/state â€” save all keys
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

// â”€â”€ GEO BENCHMARK â”€â”€
const https = require('https');
const http = require('http');
const GEO_ADMIN_TOKEN = process.env.GEO_ADMIN_TOKEN || 'kaskad-geo-admin-2026';
const GEO_URLS = ['https://kaskad.app', 'https://testnet.kaskad.live'];

function fetchUrl(url, timeoutMs = 10000, redirectCount = 0, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: extraHeaders }, res => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return fetchUrl(next, timeoutMs, redirectCount + 1, extraHeaders).then(resolve).catch(reject);
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

// Agentic readiness checks â€” full agent capability map (discovery + what agents can actually do)
async function auditAgenticReadiness() {
  const checks = {
    // --- DISCOVERY ---
    mcp_repo_discoverable: false,    // kaskad-mcp repo public and accessible to agents
    llms_txt_references_mcp: false,  // kaskad.app/llms.txt points agents to MCP
    robots_txt_testnet: false,       // testnet.kaskad.live has robots.txt for crawlers
    // --- READ CAPABILITY ---
    testnet_dapp_live: false,        // testnet.kaskad.live is reachable (MCP data source live)
    historical_data: false,          // subgraph endpoint live (agents can check trends)
    // --- WRITE CAPABILITY ---
    write_tools: false,              // MCP exposes supply/borrow/repay tools
    // --- MONITORING ---
    health_factor_alerts: false,     // agent can subscribe to health factor breach alerts
  };

  // MCP repo discoverable
  try {
    const r = await fetchUrl('https://api.github.com/repos/Kaskad-Lending/kaskad-mcp', 8000, 0, {'User-Agent': 'kaskad-readiness/1.0'});
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      checks.mcp_repo_discoverable = !data.private && (data.size > 0 || data.pushed_at != null);
    }
  } catch(e) {}

  // llms.txt references MCP
  try {
    const r = await fetchUrl('https://kaskad.app/llms.txt', 5000);
    if (r.status === 200) {
      checks.llms_txt_references_mcp = r.body.includes('mcp') || r.body.includes('MCP') || r.body.includes('kaskad-mcp');
    }
  } catch(e) {}

  // AGENTS.md present in MCP repo with comprehensive tokenomics (>5KB)
  try {
    const r = await fetchUrl('https://api.github.com/repos/Kaskad-Lending/kaskad-mcp/contents/AGENTS.md', 8000, 0, {'User-Agent': 'kaskad-readiness/1.0'});
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      checks.agents_md_present = data.size > 5000;
    }
  } catch(e) {}

  // robots.txt on testnet
  try {
    const r = await fetchUrl('https://testnet.kaskad.live/robots.txt', 5000);
    checks.robots_txt_testnet = r.status === 200 && (r.headers['content-type']||'').includes('text/plain') && r.body.includes('User-agent');
  } catch(e) {}

  // Testnet dApp live (MCP data source)
  try {
    const r = await fetchUrl('https://testnet.kaskad.live', 8000);
    checks.testnet_dapp_live = r.status === 200;
  } catch(e) {}

  // Historical data â€” subgraph live check (POST required for GraphQL)
  try {
    const sgPostData = JSON.stringify({ query: '{ reserves(first: 1) { id symbol } }' });
    const sgResult = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'testnet.kaskad.live',
        path: '/subgraphs/name/galleon-testnet-aave-v3',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sgPostData) },
        timeout: 8000
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(sgPostData);
      req.end();
    });
    if (sgResult.status === 200) {
      const sgData = JSON.parse(sgResult.body);
      checks.historical_data = !!(sgData.data && sgData.data.reserves && sgData.data.reserves.length > 0);
    }
  } catch(e) {}

  // Write tools - verify supply/borrow/repay exist in Kaskad-Lending/kaskad-mcp
  try {
    const wtR = await fetchUrl('https://raw.githubusercontent.com/Kaskad-Lending/kaskad-mcp/main/src/index.ts', 8000, 0, {'User-Agent': 'kaskad-readiness/1.0'});
    if (wtR.status === 200) {
      checks.write_tools = wtR.body.includes('"supply"') && wtR.body.includes('"borrow"') && wtR.body.includes('"repay"');
    }
  } catch(e) {}

  // Health factor alerts â€” check for webhook/alert endpoint
  // checks.health_factor_alerts = false; // hardcoded until alert system is built

  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;
  const score = Math.round((passed / total) * 100);

  return { checks, score, passed, total };
}

// POST /api/autocheck â€” run all automatable checks, update geo_benchmark + critical issues list
app.post('/api/autocheck', async (req, res) => {
  const token = req.headers['x-admin-token'] || '';
  if (token !== GEO_ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });

  try {
    const agenticResult = await auditAgenticReadiness();
    const checks = agenticResult.checks;

    // Load current geo_benchmark
    const gbRow = await pool.query("SELECT value FROM kaskad_state WHERE key='geo_benchmark'");
    let geo = gbRow.rows.length ? JSON.parse(gbRow.rows[0].value) : {};
    geo.agentic = agenticResult;
    geo.track2_score = agenticResult.score;
    // Recompute composite score
    const track1 = geo.track1_score || geo.geo_score || 43;
    geo.geo_score = Math.round(track1 * 0.6 + agenticResult.score * 0.4);
    geo.date = new Date().toISOString().slice(0, 10);

    // Rebuild critical_issues list preserving manual ones, updating auto ones
    // Only preserve manually-set critical issues (Track 1 discoverability)
    // Auto-checks now surface in Track 2 UI directly â€” no duplicate critical issue entries
    const AUTO_ISSUE_KEYS = ['No MCP server', 'Testnet RPC', 'GitHub repo', 'galleon-testnet'];
    const existingIssues = (geo.critical_issues || []).filter(i =>
      !AUTO_ISSUE_KEYS.some(k => i.includes(k))
    );
    geo.critical_issues = existingIssues;

    // Rebuild quick_wins
    const AUTO_WIN_KEYS = ['llms_txt'];
    const existingWins = (geo.quick_wins || []).filter(w =>
      !AUTO_WIN_KEYS.some(k => w.includes(k))
    );
    const autoWins = [];
    if (!checks.llms_txt_references_mcp) autoWins.push('Add MCP reference to kaskad.app/llms.txt (2 lines â€” Marius)');
    geo.quick_wins = [...existingWins, ...autoWins];

    await pool.query(`
      INSERT INTO kaskad_state (key, value, updated_at) VALUES ('geo_benchmark', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [JSON.stringify(geo)]);

    res.json({ ok: true, agentic: agenticResult, critical_issues: geo.critical_issues, quick_wins: geo.quick_wins });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/geo/score â€” public
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

// POST /api/geo/run â€” admin only
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
      if (!r.ssr) criticalIssues.push(`${d}: client-side only - AI crawlers see no content`);
      if (!r.robots_txt) criticalIssues.push(`${d}: no robots.txt`);
      if (!r.llms_txt && r.url.includes('kaskad.app')) quickWins.push(`${d}: add llms.txt`);
      if (!r.structured_data) quickWins.push(`${d}: add JSON-LD structured data`);
    }

    // Agentic issues
    const ag = agenticResult.checks;
    if (!ag.mcp_repo_discoverable) criticalIssues.push('MCP repo not discoverable - check Kaskad-Lending/kaskad-mcp visibility');
    if (!ag.write_tools) criticalIssues.push('MCP write tools missing - supply/borrow/repay not found in MCP');
    if (!ag.robots_txt_testnet) quickWins.push('testnet.kaskad.live: add robots.txt');
    if (!ag.health_factor_alerts) quickWins.push('Implement health factor alert tool in MCP (last remaining agentic gap)');

    // Composite score: Track 1 discoverability (60%) + Track 2 agentic (40%)
    const compositeScore = Math.round(geoScore * 0.6 + agenticResult.score * 0.4);

    const report = {
      geo_score: compositeScore, date,
      track1_score: geoScore,
      track2_score: agenticResult.score,
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
