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
  if (record.count > RATE_LIMIT) return res.status(429).json({ error: 'too many requests — slow down, degen' });
  next();
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function cacheGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
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

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

if (!ANTHROPIC_API_KEY) { console.error('ERROR: ANTHROPIC_API_KEY not set'); process.exit(1); }

async function callClaude(body) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || 'Anthropic API error'); }
  return res.json();
}

app.post('/api/narratives', rateLimit, async (req, res) => {
  try {
    const CACHE_KEY = 'ct_narratives_v1';
    const cached = await cacheGet(CACHE_KEY);
    if (cached && cached.narratives && cached.timestamp) {
      const age = Date.now() - cached.timestamp;
      if (age < CACHE_TTL_MS) {
        return res.json({ narratives: cached.narratives, cached: true, cachedAt: cached.timestamp, nextRefresh: cached.timestamp + CACHE_TTL_MS });
      }
    }

    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const data = await callClaude({
      model: MODEL, max_tokens: 800,
      messages: [{ role: 'user', content: content: `Today is ${today}. You are a degenerate crypto trader who spends 16 hours a day on Crypto Twitter, pump.fun, and dexscreener. You know every memecoin meta, every AI agent narrative, every CT influencer call. Your job is to give the REAL picture of what degens are actually aping into right now.

Focus ONLY on:
- Memecoins: what animal meta is running (dogs, cats, frogs, penguins etc), what pump.fun tokens are going viral, what CT influencers are shilling, what's getting 10x-100x talk right now
- AI agent tokens specifically: Virtuals protocol agents, ai16z ecosystem, autonomous AI agents that hold wallets and trade, any new AI agent launchpad getting attention
- Degen narratives: anything wild, controversial, or drama-driven that's moving money right now
- New L1/L2 ecosystems if memecoins are exploding on them specifically

Do NOT include: boring DeFi, RWA, institutional stuff, or anything a suit would care about. This is pure degen territory.

For each narrative be SPECIFIC — name actual tokens, name actual CT accounts talking about it, name specific price moves or events driving it. No vague generic takes.

Return ONLY a valid JSON array, no markdown, no extra text. Exactly 6 objects:
{
  "name": "short punchy name (2-4 words)",
  "summary": "one sharp degen sentence — what it is, what's happening RIGHT NOW, and why CT can't stop talking about it",
  "hype_score": integer 1-10,
  "fundamentals_score": integer 1-10,
  "cycle_stage": "early" or "mid-cycle" or "peak hype" or "late / cooling",
  "talk_score": integer 1-10,
  "verdict": "one line real degen take — are we early, is this a rug waiting to happen, is this the next 100x meta or is it cooked",
  "why_trending": "2 specific sentences — name the exact catalyst, the CT accounts, the price move or event that started this",
  "comparable": "what past memecoin or crypto narrative does this remind you of, what happened to that one",
  "next_move": "honest degen prediction — pump continues, rotation incoming, or rug incoming and why"
}
Sort by talk_score descending. Be brutally specific, not generic.`
    });

    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = txt.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON in Claude response');
    const narratives = JSON.parse(match[0]);
    const payload = { narratives, timestamp: Date.now() };
    await cacheSet(CACHE_KEY, payload, 4 * 60 * 60);
    res.json({ narratives, cached: false, cachedAt: payload.timestamp, nextRefresh: payload.timestamp + CACHE_TTL_MS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyse', rateLimit, async (req, res) => {
  try {
    const { tokenData, candles1h, candles4h, levels1h, levels4h } = req.body;
    if (!tokenData || !candles1h || !candles4h || !levels1h || !levels4h) return res.status(400).json({ error: 'missing required fields' });
    if (!Array.isArray(candles1h) || !Array.isArray(candles4h)) return res.status(400).json({ error: 'candles must be arrays' });
    if (candles1h.length > 100 || candles4h.length > 100) return res.status(400).json({ error: 'too many candles' });

    const summarise = (candles) => candles.slice(-30).map(c => ({ t: new Date(c.timestamp * 1000).toISOString().slice(11, 16), o: +Number(c.open).toFixed(8), h: +Number(c.high).toFixed(8), l: +Number(c.low).toFixed(8), c: +Number(c.close).toFixed(8), v: +Number(c.volume || 0).toFixed(0) }));
    const fmtLevels = (lvls) => ({ support: lvls.support.map((s, i) => `S${i + 1}: ${s}`).join(', ') || 'none clear', resistance: lvls.resistance.map((r, i) => `R${i + 1}: ${r}`).join(', ') || 'none clear' });
    const l1h = fmtLevels(levels1h);
    const l4h = fmtLevels(levels4h);

    const prompt = `You are a professional crypto technical analyst. Return ONLY valid JSON. TOKEN: ${tokenData.name} ($${tokenData.symbol}) CHAIN: ${tokenData.chain} PRICE: ${tokenData.price} 24H: ${tokenData.change24h}% LIQ: ${tokenData.liquidity} VOL: ${tokenData.volume24h} MCAP: ${tokenData.marketCap} AGE: ${tokenData.age} 1H SUPPORT: ${l1h.support} 1H RESISTANCE: ${l1h.resistance} 4H SUPPORT: ${l4h.support} 4H RESISTANCE: ${l4h.resistance} 1H CANDLES: ${JSON.stringify(summarise(candles1h))} 4H CANDLES: ${JSON.stringify(summarise(candles4h))} Return ONLY: { "formation": "pattern name", "bias": "bullish|bearish|neutral", "pattern_description": "3 sentences on 4H macro + 1H entry timing", "momentum": "2 sentences on buying vs selling pressure", "key_levels": "walk through each level with prices", "volume_story": "2 sentences on volume trend", "entry_zones": [{"label": "ideal entry", "price": number, "timeframe": "1H or 4H", "reasoning": "specific reason"}, {"label": "safe entry", "price": number, "timeframe": "1H or 4H", "reasoning": "specific reason"}, {"label": "aggressive entry", "price": number, "timeframe": "1H or 4H", "reasoning": "only if relevant"}], "invalidation": "exact price + what breaking it means", "verdict": "2 sentences honest take like a smart CT friend" }`;

    const data = await callClaude({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No analysis in Claude response');
    res.json({ analysis: JSON.parse(match[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;
