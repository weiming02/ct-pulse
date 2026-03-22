const express = require('express');
const path = require('path');
const app = express();
 
// ── SECURITY: request size limit (prevent oversized payloads) ─
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));
 
// ── SECURITY: simple in-memory rate limiter ───────────────────
// allows 10 requests per IP per minute across all API routes
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;
 
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_WINDOW_MS;
  }
  record.count++;
  rateLimitMap.set(ip, record);
  if (record.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'too many requests — slow down, degen' });
  }
  next();
}
 
// ── SECURITY: CORS — only allow your own domain ───────────────
// replace 'https://ct-pulse.vercel.app' with your actual Vercel URL once deployed
const ALLOWED_ORIGINS = [
  'https://ct-pulse.vercel.app',
  'http://localhost:3000'
];
 
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
 
// ── SECURITY: check API key exists at startup ─────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set');
  process.exit(1);
}
 
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';
 
async function callClaude(body) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Anthropic API error');
  }
  return res.json();
}
 
// ── NARRATIVES ROUTE ─────────────────────────────────────────
app.post('/api/narratives', rateLimit, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
 
    const data = await callClaude({
      model: MODEL,
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Today is ${today}.
 
You are a hardcore crypto degen who lives on CT. Search the web for what memecoins, AI agent tokens, and wild crypto narratives are CURRENTLY trending on Crypto Twitter and crypto news today.
 
Focus specifically on:
- Hot new memecoins gaining traction right now
- Animal metas or character metas that are running
- AI agent tokens (Virtuals protocol, ai16z ecosystem, etc)
- New pump.fun or launchpad tokens getting CT attention
- Wild narrative shifts or sector rotations happening today
- Any drama or catalysts moving specific tokens
 
Return ONLY a valid JSON array, no markdown, no extra text. Exactly 6 objects:
{
  "name": "short punchy name (2-4 words)",
  "summary": "one sharp sentence — what it is and why CT is going crazy about it TODAY specifically",
  "hype_score": integer 1-10,
  "fundamentals_score": integer 1-10,
  "cycle_stage": "early" or "mid-cycle" or "peak hype" or "late / cooling",
  "talk_score": integer 1-10,
  "verdict": "one line real talk — worth aping, worth watching, or avoid and exactly why",
  "why_trending": "2 sentences on the specific catalyst driving this TODAY",
  "comparable": "one past crypto narrative this reminds you of and what happened",
  "next_move": "what most likely happens next for this narrative in the next 1-2 weeks"
}
Sort by talk_score descending. Be specific and current, not generic.`
      }]
    });
 
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = txt.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON in Claude response');
    const narratives = JSON.parse(match[0]);
    res.json({ narratives });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
// ── CHART ANALYSIS ROUTE ─────────────────────────────────────
app.post('/api/analyse', rateLimit, async (req, res) => {
  try {
    const { tokenData, candles1h, candles4h, levels1h, levels4h } = req.body;
 
    if (!tokenData || !candles1h || !candles4h || !levels1h || !levels4h) {
      return res.status(400).json({ error: 'missing required fields' });
    }
    if (!Array.isArray(candles1h) || !Array.isArray(candles4h)) {
      return res.status(400).json({ error: 'candles must be arrays' });
    }
    if (candles1h.length > 100 || candles4h.length > 100) {
      return res.status(400).json({ error: 'too many candles' });
    }
 
    const summarise = (candles) => candles.slice(-50).map(c => ({
      t: new Date(c.timestamp * 1000).toISOString().slice(11, 16),
      o: +Number(c.open).toFixed(8),
      h: +Number(c.high).toFixed(8),
      l: +Number(c.low).toFixed(8),
      c: +Number(c.close).toFixed(8),
      v: +Number(c.volume || 0).toFixed(0)
    }));
 
    const fmtLevels = (lvls) => ({
      support: lvls.support.map((s, i) => `S${i + 1}: ${s}`).join(', ') || 'none clear',
      resistance: lvls.resistance.map((r, i) => `R${i + 1}: ${r}`).join(', ') || 'none clear'
    });
 
    const l1h = fmtLevels(levels1h);
    const l4h = fmtLevels(levels4h);
 
    const prompt = `You are a professional crypto technical analyst helping a degen decide whether to ape. Be direct and specific. Return ONLY valid JSON.
 
TOKEN: ${tokenData.name} ($${tokenData.symbol})
CHAIN: ${tokenData.chain}
CURRENT PRICE: ${tokenData.price}
24H CHANGE: ${tokenData.change24h}%
LIQUIDITY: ${tokenData.liquidity} | 24H VOL: ${tokenData.volume24h}
MARKET CAP: ${tokenData.marketCap}
TOKEN AGE: ${tokenData.age}
 
1H CHART — SUPPORT: ${l1h.support} | RESISTANCE: ${l1h.resistance}
4H CHART — SUPPORT: ${l4h.support} | RESISTANCE: ${l4h.resistance}
 
LAST 50 CANDLES — 1H TIMEFRAME:
${JSON.stringify(summarise(candles1h))}
 
LAST 50 CANDLES — 4H TIMEFRAME:
${JSON.stringify(summarise(candles4h))}
 
Analyse both timeframes together. The 4H gives the macro structure; the 1H gives the entry timing.
 
Return ONLY this JSON (no markdown, no extra text):
{
  "formation": "specific chart pattern name based on both timeframes",
  "bias": "bullish" | "bearish" | "neutral",
  "pattern_description": "3 sentences: what the 4H macro structure shows, what the 1H is doing right now, and what this means for a degen",
  "momentum": "2 sentences — is buying pressure building or fading across both timeframes, what do candle bodies and wicks reveal",
  "key_levels": "walk through each support and resistance level from both timeframes with specific prices and why they matter",
  "volume_story": "2 sentences — what volume on both timeframes tells us about accumulation vs distribution vs low conviction",
  "entry_zones": [
    {"label": "ideal entry", "price": <number>, "timeframe": "1H or 4H", "reasoning": "specific level this aligns with"},
    {"label": "safe entry", "price": <number>, "timeframe": "1H or 4H", "reasoning": "specific level this aligns with"},
    {"label": "aggressive entry", "price": <number>, "timeframe": "1H or 4H", "reasoning": "only if there is a real reason to buy at or above current price"}
  ],
  "invalidation": "exact price level + what it means if it breaks (e.g. 'close below $X on 4H — that kills the macro structure, next support at $Y')",
  "verdict": "2 sentences of honest direct take — good setup or not, risk/reward, written like a smart CT friend not a financial advisor"
}`;
 
    const data = await callClaude({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
 
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No analysis in Claude response');
    const analysis = JSON.parse(match[0]);
    res.json({ analysis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
const PORT = process.env.PORT || 3000;
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => console.log(`CT Pulse running on port ${PORT}`));
}
