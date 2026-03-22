const express = require('express');
const app = express();

app.use(express.json({ limit: '50kb' }));

const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;

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

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';

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
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const data = await callClaude({
      model: MODEL, max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: `Today is ${today}. You are a hardcore crypto degen who lives on CT. Search the web for what memecoins, AI agent tokens, and wild crypto narratives are CURRENTLY trending on Crypto Twitter and crypto news today. Focus specifically on: hot new memecoins gaining traction right now, animal metas or character metas that are running, AI agent tokens (Virtuals protocol, ai16z ecosystem, etc), new pump.fun or launchpad tokens getting CT attention, wild narrative shifts or sector rotations happening today, any drama or catalysts moving specific tokens. Return ONLY a valid JSON array, no markdown, no extra text. Exactly 6 objects: { "name": "short punchy name (2-4 words)", "summary": "one sharp sentence", "hype_score": integer 1-10, "fundamentals_score": integer 1-10, "cycle_stage": "early" or "mid-cycle" or "peak hype" or "late / cooling", "talk_score": integer 1-10, "verdict": "one line real talk", "why_trending": "2 sentences on the specific catalyst driving this TODAY", "comparable": "one past crypto narrative this reminds you of", "next_move": "what most likely happens next in the next 1-2 weeks" }. Sort by talk_score descending.` }]
    });
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = txt.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON in Claude response');
    res.json({ narratives: JSON.parse(match[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyse', rateLimit, async (req, res) => {
  try {
    const { tokenData, candles1h, candles4h, levels1h, levels4h } = req.body;
    if (!tokenData || !candles1h || !candles4h || !levels1h || !levels4h) return res.status(400).json({ error: 'missing required fields' });
    if (!Array.isArray(candles1h) || !Array.isArray(candles4h)) return res.status(400).json({ error: 'candles must be arrays' });
    if (candles1h.length > 100 || candles4h.length > 100) return res.status(400).json({ error: 'too many candles' });

    const summarise = (candles) => candles.slice(-50).map(c => ({ t: new Date(c.timestamp * 1000).toISOString().slice(11, 16), o: +Number(c.open).toFixed(8), h: +Number(c.high).toFixed(8), l: +Number(c.low).toFixed(8), c: +Number(c.close).toFixed(8), v: +Number(c.volume || 0).toFixed(0) }));
    const fmtLevels = (lvls) => ({ support: lvls.support.map((s, i) => `S${i + 1}: ${s}`).join(', ') || 'none clear', resistance: lvls.resistance.map((r, i) => `R${i + 1}: ${r}`).join(', ') || 'none clear' });
    const l1h = fmtLevels(levels1h);
    const l4h = fmtLevels(levels4h);

    const prompt = `You are a professional crypto technical analyst. Return ONLY valid JSON.
TOKEN: ${tokenData.name} ($${tokenData.symbol}) | CHAIN: ${tokenData.chain}
PRICE: ${tokenData.price} | 24H: ${tokenData.change24h}% | LIQ: ${tokenData.liquidity} | VOL: ${tokenData.volume24h} | MCAP: ${tokenData.marketCap} | AGE: ${tokenData.age}
1H SUPPORT: ${l1h.support} | 1H RESISTANCE: ${l1h.resistance}
4H SUPPORT: ${l4h.support} | 4H RESISTANCE: ${l4h.resistance}
1H CANDLES: ${JSON.stringify(summarise(candles1h))}
4H CANDLES: ${JSON.stringify(summarise(candles4h))}
Return ONLY this JSON: { "formation": "pattern name", "bias": "bullish|bearish|neutral", "pattern_description": "3 sentences on 4H macro + 1H entry timing", "momentum": "2 sentences on buying vs selling pressure", "key_levels": "walk through each level with prices and why they matter", "volume_story": "2 sentences on volume trend", "entry_zones": [{"label": "ideal entry", "price": number, "timeframe": "1H or 4H", "reasoning": "specific reason"}, {"label": "safe entry", "price": number, "timeframe": "1H or 4H", "reasoning": "specific reason"}, {"label": "aggressive entry", "price": number, "timeframe": "1H or 4H", "reasoning": "only if relevant"}], "invalidation": "exact price + what it means if it breaks", "verdict": "2 sentences honest take written like a smart CT friend" }`;

    const data = await callClaude({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No analysis in Claude response');
    res.json({ analysis: JSON.parse(match[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = app;
