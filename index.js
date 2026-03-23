const express = require('express');
const app = express();
app.use(express.json({ limit: '50kb' }));
 
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
 
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + RATE_WINDOW_MS; }
  record.count++;
  rateLimitMap.set(ip, record);
  if (record.count > RATE_LIMIT) return res.status(429).json({ error: 'too many requests' });
  next();
}
 
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const SOLSCAN_API_KEY = process.env.SOLSCAN_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU = 'claude-haiku-4-5-20251001';
 
if (!ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }
 
async function cacheGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${key}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const data = await res.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch { return null; }
}
 
async function cacheSet(key, value, ttlSeconds) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}/set/${key}?ex=${ttlSeconds}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch {}
}
 
async function callClaude(body) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || 'Anthropic API error'); }
  return res.json();
}
 
// ── ETHERSCAN HELPERS ─────────────────────────────────────────
const CHAIN_IDS = {
  'ethereum': '1', 'eth': '1',
  'base': '8453',
  'bsc': '56', 'binance-smart-chain': '56',
  'arbitrum': '42161', 'arbitrum-one': '42161',
  'polygon': '137', 'matic': '137',
  'optimism': '10',
  'avalanche': '43114',
};

function getChainId(chainId) {
  return CHAIN_IDS[chainId?.toLowerCase()] || null;
}

async function etherscanFetch(chainNumericId, params) {
  if (!ETHERSCAN_API_KEY) return null;
  try {
    const url = new URL('https://api.etherscan.io/v2/api');
    Object.entries({ ...params, chainid: chainNumericId, apikey: ETHERSCAN_API_KEY }).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.status === '0' && data.message === 'NOTOK') return null;
    return data.result;
  } catch { return null; }
}
 
async function getEthOnchainData(contractAddress, chainId) {
  const chainNumericId = getChainId(chainId);
if (!chainNumericId) return null;
const base = chainNumericId;
  try {
    const [transfers, contractInfo, creationTx] = await Promise.all([
      etherscanFetch(base, { module: 'account', action: 'tokentx', contractaddress: contractAddress, page: 1, offset: 50, sort: 'desc' }),
      etherscanFetch(base, { module: 'contract', action: 'getsourcecode', address: contractAddress }),
      etherscanFetch(base, { module: 'account', action: 'tokentx', contractaddress: contractAddress, page: 1, offset: 1, sort: 'asc' }),
    ]);

    const deployer = creationTx?.[0]?.from || null;

    let deployerHistory = null;
    if (deployer) {
      deployerHistory = await etherscanFetch(base, {
        module: 'account', action: 'tokentx', address: deployer, page: 1, offset: 50, sort: 'desc'
      });
    }

    // infer holder concentration from recent transfers
    const holderMap = {};
    (transfers || []).forEach(tx => {
      const to = tx.to?.toLowerCase();
      const from = tx.from?.toLowerCase();
      const val = parseFloat(tx.value || 0);
      if (to) holderMap[to] = (holderMap[to] || 0) + val;
      if (from) holderMap[from] = (holderMap[from] || 0) - val;
    });
    const positiveHolders = Object.entries(holderMap)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const totalInferred = positiveHolders.reduce((s, [, v]) => s + v, 0);
    const top10 = positiveHolders.slice(0, 10).map(([addr, val]) => ({
      address: addr.slice(0, 8) + '...',
      pct: totalInferred > 0 ? ((val / totalInferred) * 100).toFixed(1) : '?'
    }));
    const top10pct = top10.reduce((s, h) => s + parseFloat(h.pct || 0), 0);

    // recent transfers (last 10)
    const recentTransfers = (transfers || []).slice(0, 10).map(tx => ({
      from: (tx.from || '').slice(0, 8) + '...',
      to: (tx.to || '').slice(0, 8) + '...',
      value: parseFloat(tx.value || 0) / Math.pow(10, parseInt(tx.tokenDecimal || 18)),
      time: tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—',
    }));

    const deployerOtherTokens = deployerHistory
      ? new Set(deployerHistory.map(tx => tx.contractAddress?.toLowerCase()).filter(Boolean)).size
      : 0;

    const isVerified = !!(contractInfo?.[0]?.SourceCode && contractInfo[0].SourceCode !== '');

    return {
      chain: chainId,
      deployer: deployer ? deployer.slice(0, 10) + '...' : 'unknown',
      deployerFull: deployer,
      top10holders: top10,
      top10concentration: top10pct.toFixed(1),
      top10note: 'estimated from recent 50 transfers',
      recentTransfers,
      deployerOtherTokens,
      isVerified,
      serialRuggerSignal: deployerOtherTokens > 3
    };
  } catch (e) { return null; }
}
 
async function getSolanaOnchainData(mintAddress) {
  if (!SOLSCAN_API_KEY) return null;
  try {
    const headers = { token: SOLSCAN_API_KEY };
 
    const [holdersRes, transfersRes, metaRes] = await Promise.all([
      fetch('https://pro-api.solscan.io/v2.0/token/holders?address=' + mintAddress + '&page=1&page_size=10', { headers }),
      fetch('https://pro-api.solscan.io/v2.0/token/transfer?address=' + mintAddress + '&page=1&page_size=20', { headers }),
      fetch('https://pro-api.solscan.io/v2.0/token/meta?address=' + mintAddress, { headers }),
    ]);
 
    const holdersData = await holdersRes.json();
    const transfersData = await transfersRes.json();
    const metaData = await metaRes.json();
 
    const holders = holdersData?.data?.items || holdersData?.data || [];
    const transfers = transfersData?.data?.items || transfersData?.data || [];
    const meta = metaData?.data || {};
 
    const totalSupply = parseFloat(meta.supply || 0);
    const decimals = parseInt(meta.decimals || 6);
 
    const processedHolders = holders.slice(0, 10).map(h => ({
      address: (h.address || h.owner || '').slice(0, 8) + '...',
      pct: totalSupply > 0 ? ((parseFloat(h.amount || h.uiAmount || 0) / (totalSupply / Math.pow(10, decimals))) * 100).toFixed(1) : '?',
    }));
 
    const top10pct = processedHolders.reduce((s, h) => s + parseFloat(h.pct || 0), 0);
 
    const recentTransfers = transfers.slice(0, 10).map(tx => ({
      from: (tx.src_owner || tx.from_address || '').slice(0, 8) + '...',
      to: (tx.dst_owner || tx.to_address || '').slice(0, 8) + '...',
      value: parseFloat(tx.amount || 0) / Math.pow(10, decimals),
      time: tx.block_time ? new Date(tx.block_time * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—',
    }));
 
    return {
      chain: 'solana',
      mintAuthority: meta.mint_authority || 'null',
      freezeAuthority: meta.freeze_authority || 'null',
      mintAuthorityEnabled: !!meta.mint_authority && meta.mint_authority !== 'null' && meta.mint_authority !== '',
      freezeAuthorityEnabled: !!meta.freeze_authority && meta.freeze_authority !== 'null' && meta.freeze_authority !== '',
      top10holders: processedHolders,
      top10concentration: top10pct.toFixed(1),
      recentTransfers,
      totalSupply: meta.supply,
      decimals,
    };
  } catch { return null; }
}
 
// ── API ROUTES ────────────────────────────────────────────────
app.get('/api/key', rateLimit, (req, res) => {
  const origin = req.headers.referer || req.headers.origin || '';
  if (!origin.includes('ct-pulse.vercel.app') && !origin.includes('localhost')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ key: ANTHROPIC_API_KEY });
});
 
app.post('/api/onchain', rateLimit, async (req, res) => {
  const { contractAddress, chainId } = req.body;
  if (!contractAddress || !chainId) return res.status(400).json({ error: 'missing contractAddress or chainId' });
  try {
    let data = null;
    if (chainId === 'solana') {
      data = await getSolanaOnchainData(contractAddress);
    } else {
      data = await getEthOnchainData(contractAddress, chainId);
    }
    if (!data) return res.json({ available: false, reason: 'chain not supported or API unavailable' });
    res.json({ available: true, ...data });
  } catch (e) {
    res.json({ available: false, reason: e.message });
  }
});
 
app.post('/api/narratives', rateLimit, async (req, res) => {
  try {
    const CACHE_KEY = 'ct_narratives_v6';
    const cached = await cacheGet(CACHE_KEY);
    if (cached && cached.narratives && cached.timestamp) {
      const age = Date.now() - cached.timestamp;
      if (age < CACHE_TTL_MS) {
        return res.json({ narratives: cached.narratives, cached: true, cachedAt: cached.timestamp, nextRefresh: cached.timestamp + CACHE_TTL_MS });
      }
    }
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const userMsg = 'Today is ' + today + '. You are a crypto researcher tracking emerging tech in blockchain. Return ONLY a valid JSON array, no markdown. Exactly 6 objects covering: AI agents with wallets (Virtuals, ai16z, ElizaOS), agentic commerce and infrastructure, decentralised AI compute, new on-chain behaviours from automation. Name actual projects and teams. Fields: name, summary, hype_score, fundamentals_score, cycle_stage, talk_score, verdict, why_trending, comparable, next_move. cycle_stage must be one of: early, mid-cycle, peak hype, late / cooling. All strings single line no apostrophes. Sort by talk_score descending.';
    const data = await callClaude({ model: HAIKU, max_tokens: 2000, messages: [{ role: 'user', content: userMsg }] });
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const cleaned = txt.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON in Claude response');
    const narratives = JSON.parse(match[0]);
    const payload = { narratives, timestamp: Date.now() };
    await cacheSet(CACHE_KEY, payload, 4 * 60 * 60);
    res.json({ narratives, cached: false, cachedAt: payload.timestamp, nextRefresh: payload.timestamp + CACHE_TTL_MS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
 
module.exports = app;
 
