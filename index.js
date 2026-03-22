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
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-5';

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
    const CACHE_KEY = 'ct_narratives_v3';
    const cached = await cacheGet(CACHE_KEY);
    if (cached && cached.narratives && cached.timestamp) {
      const age = Date.now() - cached.timestamp;
      if (age < CACHE_TTL_MS) {
        return res.json({ narratives: cached.narratives, cached: true, cachedAt: cached.timestamp, nextRefresh: cached.timestamp + CACHE_TTL_MS });
      }
    }

    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const data = await callClaude({
      model: SONNET, max_tokens: 2500,
      messages: [{ role: 'user', content: `Today is ${today}. You are a degenerate crypto trader who lives on CT, pump.fun, and dexscreener. Give the REAL picture of what degens are aping into right now. Focus ONLY on memecoins (animal metas, pump.fun viral tokens, CT influencer calls), AI agent tokens (Virtuals protocol, ai16z, autonomous agents with wallets), and wild degen narratives. No DeFi, no RWA, no boring stuff. Be specific — name actual tokens and CT accounts. Return ONLY a valid JSON array, no markdown, no extra text. Exactly 6 objects with these exact fields: name, summary, hype_score, fundamentals_score, cycle_stage, talk_score, verdict, why_trending, comparable, next_move. cycle_stage must be one of: early, mid-cycle, peak hype, late / cooling. All values must be strings or integers. Sort by talk_score descending.` }]
    });

    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const cleaned = txt.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON in Claude response — Claude said: ' + cleaned.slice(0, 200));
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

    const summarise = (candles) => candles.slice(-20).map(c => ({
      t: new Date(c.timestamp * 1000).toISOString().slice(11, 16),
      o: +Number(c.open).toFixed(6),
      h: +Number(c.high).toFixed(6),
      l: +Number(c.low).toFixed(6),
      c: +Number(c.close).toFixed(6)
    }));

    const fmtLevels = (lvls) => ({
      support: lvls.support.map((s, i) => `S${i + 1}: ${s}`).join(', ') || 'none',
      resistance: lvls.resistance.map((r, i) => `R${i + 1}: ${r}`).join(', ') || 'none'
    });

    const l1h = fmtLevels(levels1h);
    const l4h = fmtLevels(levels4h);

    const prompt = `You are a crypto TA analyst. Return ONLY valid JSON, no markdown, no newlines inside string values, no special characters inside strings. Use only ASCII characters in your response.

TOKEN: ${tokenData.name} ($${tokenData.symbol}) on ${tokenData.chain}
PRICE: ${tokenData.price} | 24H: ${tokenData.change24h}% | LIQ: ${tokenData.liquidity} | AGE: ${tokenData.age}
1H SUPPORT: ${l1h.support} | 1H RESISTANCE: ${l1h.resistance}
4H SUPPORT: ${l4h.support} | 4H RESISTANCE: ${l4h.resistance}
1H CLOSES: ${summarise(candles1h).map(c => c.c).join(', ')}
4H CLOSES: ${summarise(candles4h).map(c => c.c).join(', ')}
1H HIGHS: ${summarise(candles1h).map(c => c.h).join(', ')}
1H LOWS: ${summarise(candles1h).map(c => c.l).join(', ')}
4H HIGHS: ${summarise(candles4h).map(c => c.h).join(', ')}
4H LOWS: ${summarise(candles4h).map(c => c.l).join(', ')}

Return ONLY this JSON object with detailed single-line string values and no newlines anywhere:
{"formation":"specific chart pattern name","bias":"bullish or bearish or neutral","pattern_description":"what 4H macro structure shows and what 1H is doing right now and what this means for a degen","momentum":"is buying or selling pressure dominant and what do candle shapes reveal","key_levels":"every support and resistance level from both timeframes with exact prices and why each matters","volume_story":"what volume trend tells us about accumulation or distribution","entry_zones":[{"label":"ideal entry","price":0,"timeframe":"1H or 4H","reasoning":"specific level and why"},{"label":"safe entry","price":0,"timeframe":"1H or 4H","reasoning":"specific level and why"},{"label":"aggressive entry","price":0,"timeframe":"1H or 4H","reasoning":"why valid or skip if not"}],"invalidation":"exact price that kills thesis and what it means","verdict":"honest take on setup quality and risk reward"}`;

    const data = await callClaude({ model: HAIKU, max_tokens: 900, messages: [{ role: 'user', content: prompt }] });
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const cleaned = txt.replace(/```json/g, '').replace(/```/g, '').replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No analysis in Claude response');
    let analysis;
    try {
      analysis = JSON.parse(match[0]);
    } catch (e2) {
      const safe = match[0].replace(/("(?:[^"\\]|\\.)*")|'([^'\\]|\\.)*'/g, m => m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'));
      analysis = JSON.parse(safe);
    }
    res.json({ analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;
