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
    const allParams = { ...params, chainid: String(chainNumericId), apikey: ETHERSCAN_API_KEY };
    Object.entries(allParams).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const res = await fetch(url.toString());
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (data.status === '0' && data.message === 'NOTOK') return null;
    return data.result;
  } catch { return null; }
}
 
async function getEthOnchainData(contractAddress, chainId) {
  const chainNumericId = getChainId(chainId);
  if (!chainNumericId) return null;
  try {
    const [contractInfo, txList] = await Promise.all([
      etherscanFetch(chainNumericId, {
        module: 'contract', action: 'getsourcecode', address: contractAddress
      }),
      etherscanFetch(chainNumericId, {
        module: 'account', action: 'txlist', address: contractAddress,
        page: 1, offset: 10, sort: 'asc'
      }),
    ]);
 
    const deployer = txList?.[0]?.from || null;
    const deployerFundedAt = txList?.[0]?.timeStamp ? new Date(parseInt(txList[0].timeStamp) * 1000).toISOString().slice(0, 10) : null;
 
    let deployerOtherTokens = 0;
    let deployerAge = null;
    if (deployer) {
      const deployerTxs = await etherscanFetch(chainNumericId, {
        module: 'account', action: 'txlist', address: deployer,
        page: 1, offset: 50, sort: 'asc'
      });
      deployerOtherTokens = (deployerTxs || []).filter(tx => !tx.to || tx.to === '').length;
      if (deployerTxs?.[0]?.timeStamp) {
        const firstTxDate = new Date(parseInt(deployerTxs[0].timeStamp) * 1000);
        const ageDays = Math.floor((Date.now() - firstTxDate.getTime()) / 86400000);
        deployerAge = ageDays;
      }
    }
 
    const recentTxs = await etherscanFetch(chainNumericId, {
      module: 'account', action: 'txlist', address: contractAddress,
      page: 1, offset: 10, sort: 'desc'
    });
 
    const recentTransfers = (recentTxs || []).slice(0, 8).map(tx => ({
      from: (tx.from || '').slice(0, 8) + '...',
      to: (tx.to || '').slice(0, 8) + '...',
      value: parseFloat(tx.value || 0) / 1e18,
      time: tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—',
    }));
 
    const isVerified = !!(contractInfo?.[0]?.SourceCode && contractInfo[0].SourceCode !== '');
 
    // contract address pattern flags
    const contractPatternFlags = [];
    if (deployerAge !== null && deployerAge < 30) contractPatternFlags.push('deployer wallet is less than 30 days old — fresh wallet is a classic rug setup');
    if (deployerOtherTokens > 5) contractPatternFlags.push('deployer has launched ' + deployerOtherTokens + ' contracts — serial deployer pattern');
    if (!isVerified) contractPatternFlags.push('contract source code not verified — team is hiding the code');
    if (deployerAge !== null && deployerAge < 7 && deployerOtherTokens > 1) contractPatternFlags.push('new wallet deploying multiple contracts rapidly — coordinated rug operation pattern');
 
    return {
      chain: chainId,
      deployer: deployer ? deployer.slice(0, 10) + '...' : 'unknown',
      deployerFull: deployer,
      deployerAge,
      deployerFundedAt,
      top10holders: [],
      top10concentration: 'N/A',
      recentTransfers,
      deployerOtherTokens,
      isVerified,
      serialRuggerSignal: deployerOtherTokens > 5,
      contractPatternFlags,
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
      contractPatternFlags: [],
    };
  } catch { return null; }
}
 
// ── PRICE IMPACT + LIQUIDITY ANALYSIS ────────────────────────
function analysePairs(pairs) {
  const totalLiq = pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0);
 
  // price impact using constant product AMM formula: impact = sellSize / (liq + sellSize)
  const calcImpact = (sellUsd, liqUsd) => {
    if (!liqUsd || liqUsd <= 0) return 100;
    return ((sellUsd / (liqUsd + sellUsd)) * 100);
  };
 
  const priceImpact = [1000, 5000, 10000, 50000].map(size => ({
    size,
    impact: calcImpact(size, totalLiq),
    label: size >= 1000 ? '$' + (size / 1000) + 'K' : '$' + size
  }));
 
  // per-pair liquidity breakdown
  const pairBreakdown = pairs
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
    .slice(0, 8)
    .map(p => ({
      dex: p.dexId || 'unknown',
      chain: p.chainId || '',
      liq: p.liquidity?.usd || 0,
      vol24h: p.volume?.h24 || 0,
      pct: totalLiq > 0 ? (((p.liquidity?.usd || 0) / totalLiq) * 100).toFixed(1) : '0',
      pairAddress: p.pairAddress ? p.pairAddress.slice(0, 8) + '...' : '—'
    }));
 
  // largest single pair concentration
  const topPairPct = pairBreakdown.length > 0 ? parseFloat(pairBreakdown[0].pct) : 0;
 
  // multi-pair trap detection
  const multiPairFlags = [];
  if (pairs.length > 8 && totalLiq < 500000) {
    multiPairFlags.push('token spread across ' + pairs.length + ' pairs with only ' + formatUsd(totalLiq) + ' total liquidity — each exit point is razor thin, slippage will be extreme');
  }
  if (pairs.length > 3 && topPairPct < 30) {
    multiPairFlags.push('liquidity is fragmented — largest single pool holds only ' + topPairPct + '% of total liquidity, no clean exit exists');
  }
  if (topPairPct > 95 && pairs.length > 1) {
    multiPairFlags.push('95%+ of liquidity sits in one pool — if that pool is drained the entire token becomes illiquid instantly');
  }
  const thinPairs = pairs.filter(p => (p.liquidity?.usd || 0) < 5000 && (p.volume?.h24 || 0) > 1000);
  if (thinPairs.length > 2) {
    multiPairFlags.push(thinPairs.length + ' pairs have under $5K liquidity but active trading volume — wash trading or honeypot trap to create illusion of activity');
  }
 
  // ── BUY/SELL PRESSURE RATIO ──────────────────────────────────
  const totalBuys1h = pairs.reduce((s, p) => s + (p.txns?.h1?.buys || 0), 0);
  const totalSells1h = pairs.reduce((s, p) => s + (p.txns?.h1?.sells || 0), 0);
  const totalBuys24h = pairs.reduce((s, p) => s + (p.txns?.h24?.buys || 0), 0);
  const totalSells24h = pairs.reduce((s, p) => s + (p.txns?.h24?.sells || 0), 0);
  const totalTxns1h = totalBuys1h + totalSells1h;
  const totalTxns24h = totalBuys24h + totalSells24h;
  const buyPct1h = totalTxns1h > 0 ? ((totalBuys1h / totalTxns1h) * 100).toFixed(0) : null;
  const buyPct24h = totalTxns24h > 0 ? ((totalBuys24h / totalTxns24h) * 100).toFixed(0) : null;
 
  const buySellFlags = [];
  if (buyPct1h !== null) {
    const bp = parseInt(buyPct1h);
    const bp24 = parseInt(buyPct24h || 50);
    // only flag if BOTH 1h and 24h are extreme AND volume is high enough to be meaningful
    if (bp >= 95 && bp24 >= 90 && totalTxns1h > 30 && totalTxns24h > 200) {
      buySellFlags.push('1H buy ratio ' + bp + '% AND 24H buy ratio ' + bp24 + '% — sustained extreme buy dominance across both timeframes with ' + totalTxns24h + ' total transactions. this level of one-sided pressure with high volume is consistent with coordinated bot activity');
    } else if (bp <= 10 && bp24 <= 20 && totalTxns1h > 20) {
      buySellFlags.push('1H sell ratio ' + (100-bp) + '% AND 24H sell ratio ' + (100-bp24) + '% — overwhelming sell pressure sustained across both timeframes (' + totalSells24h + ' sells vs ' + totalBuys24h + ' buys). coordinated exit pattern');
    }
  }
 
  // ── LIQUIDITY AGE WARNING ─────────────────────────────────────
  const now = Date.now();
  const liqAgeFlags = [];
  const pairAges = pairs
    .filter(p => p.pairCreatedAt && (p.liquidity?.usd || 0) > 1000)
    .map(p => ({ age: (now - p.pairCreatedAt) / 3600000, liq: p.liquidity?.usd || 0, dex: p.dexId || 'unknown' }))
    .sort((a, b) => a.age - b.age);
 
  if (pairAges.length > 0) {
    const newestPair = pairAges[0];
    if (newestPair.age < 24) {
      liqAgeFlags.push('new liquidity pool opened ' + newestPair.age.toFixed(1) + 'h ago on ' + newestPair.dex + ' with ' + formatUsd(newestPair.liq) + ' — fresh liquidity injection on existing token is a classic pre-pump setup');
    } else if (newestPair.age < 48) {
      liqAgeFlags.push('liquidity added to ' + newestPair.dex + ' within last 48h (' + newestPair.age.toFixed(0) + 'h ago) — recent liquidity injection, monitor for coordinated pump');
    }
    // check if multiple new pools opened recently
    const veryNewPools = pairAges.filter(p => p.age < 48);
    if (veryNewPools.length >= 2) {
      liqAgeFlags.push(veryNewPools.length + ' new liquidity pools opened within 48h — rapid multi-pool deployment is a known tactic to create trading activity illusion');
    }
  }
 
  // ── EXIT TIME ESTIMATOR ───────────────────────────────────────
  
 
  return {
    priceImpact, pairBreakdown, multiPairFlags, topPairPct,
    totalPairs: pairs.length, totalLiq,
    buyPct1h, buyPct24h, totalBuys1h, totalSells1h, totalBuys24h, totalSells24h,
    buySellFlags, liqAgeFlags
  };
}
 
function formatUsd(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Number(n).toFixed(2);
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
 
app.post('/api/pairanalysis', rateLimit, async (req, res) => {
  const { pairs } = req.body;
  if (!pairs || !Array.isArray(pairs)) return res.status(400).json({ error: 'missing pairs array' });
  try {
    const analysis = analysePairs(pairs);
    res.json(analysis);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
 
