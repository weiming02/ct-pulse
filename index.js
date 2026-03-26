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
      etherscanFetch(chainNumericId, { module: 'contract', action: 'getsourcecode', address: contractAddress }),
      etherscanFetch(chainNumericId, { module: 'account', action: 'txlist', address: contractAddress, page: 1, offset: 10, sort: 'asc' }),
    ]);
    const deployer = txList?.[0]?.from || null;
    const deployerFundedAt = txList?.[0]?.timeStamp ? new Date(parseInt(txList[0].timeStamp) * 1000).toISOString().slice(0, 10) : null;
    let deployerOtherTokens = 0, deployerAge = null;
    if (deployer) {
      const deployerTxs = await etherscanFetch(chainNumericId, { module: 'account', action: 'txlist', address: deployer, page: 1, offset: 50, sort: 'asc' });
      deployerOtherTokens = (deployerTxs || []).filter(tx => !tx.to || tx.to === '').length;
      if (deployerTxs?.[0]?.timeStamp) {
        deployerAge = Math.floor((Date.now() - parseInt(deployerTxs[0].timeStamp) * 1000) / 86400000);
      }
    }
    const recentTxs = await etherscanFetch(chainNumericId, { module: 'account', action: 'txlist', address: contractAddress, page: 1, offset: 10, sort: 'desc' });
    const recentTransfers = (recentTxs || []).slice(0, 8).map(tx => ({
      from: (tx.from || '').slice(0, 8) + '...', to: (tx.to || '').slice(0, 8) + '...',
      value: parseFloat(tx.value || 0) / 1e18,
      time: tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—',
    }));
    const isVerified = !!(contractInfo?.[0]?.SourceCode && contractInfo[0].SourceCode !== '');
    const contractPatternFlags = [];
    if (deployerAge !== null && deployerAge < 30) contractPatternFlags.push('deployer wallet is ' + deployerAge + ' days old — fresh wallet is a classic rug setup');
    if (deployerOtherTokens > 5) contractPatternFlags.push('deployer has launched ' + deployerOtherTokens + ' contracts — serial deployer pattern');
    if (!isVerified) contractPatternFlags.push('contract source code not verified — team is hiding the code');
    if (deployerAge !== null && deployerAge < 7 && deployerOtherTokens > 1) contractPatternFlags.push('new wallet deploying multiple contracts rapidly — coordinated rug operation pattern');
    return { chain: chainId, deployer: deployer ? deployer.slice(0, 10) + '...' : 'unknown', deployerFull: deployer, deployerAge, deployerFundedAt, top10holders: [], top10concentration: 'N/A', recentTransfers, deployerOtherTokens, isVerified, serialRuggerSignal: deployerOtherTokens > 5, contractPatternFlags };
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
    return { chain: 'solana', mintAuthority: meta.mint_authority || 'null', freezeAuthority: meta.freeze_authority || 'null', mintAuthorityEnabled: !!meta.mint_authority && meta.mint_authority !== 'null' && meta.mint_authority !== '', freezeAuthorityEnabled: !!meta.freeze_authority && meta.freeze_authority !== 'null' && meta.freeze_authority !== '', top10holders: processedHolders, top10concentration: top10pct.toFixed(1), recentTransfers, totalSupply: meta.supply, decimals, contractPatternFlags: [] };
  } catch { return null; }
}
 
function analysePairs(pairs) {
  const totalLiq = pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0);
  const calcImpact = (sellUsd, liqUsd) => { if (!liqUsd || liqUsd <= 0) return 100; return (sellUsd / (liqUsd + sellUsd)) * 100; };
  const priceImpact = [1000, 5000, 10000, 50000].map(size => ({ size, impact: calcImpact(size, totalLiq), label: '$' + (size >= 1000 ? (size / 1000) + 'K' : size) }));
  const pairBreakdown = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)).slice(0, 8).map(p => ({
    dex: p.dexId || 'unknown', chain: p.chainId || '', liq: p.liquidity?.usd || 0, vol24h: p.volume?.h24 || 0,
    pct: totalLiq > 0 ? (((p.liquidity?.usd || 0) / totalLiq) * 100).toFixed(1) : '0',
  }));
  const topPairPct = pairBreakdown.length > 0 ? parseFloat(pairBreakdown[0].pct) : 0;
  const multiPairFlags = [];
  if (pairs.length > 8 && totalLiq < 500000) multiPairFlags.push('token spread across ' + pairs.length + ' pairs with only ' + formatUsd(totalLiq) + ' total liquidity — each exit point is razor thin, slippage will be extreme');
  if (pairs.length > 3 && topPairPct < 30) multiPairFlags.push('liquidity is fragmented — largest single pool holds only ' + topPairPct + '% of total liquidity, no clean exit exists');
  if (topPairPct > 95 && pairs.length > 1) multiPairFlags.push('95%+ of liquidity sits in one pool — if that pool is drained the entire token becomes illiquid instantly');
  const thinPairs = pairs.filter(p => (p.liquidity?.usd || 0) < 5000 && (p.volume?.h24 || 0) > 1000);
  if (thinPairs.length > 2) multiPairFlags.push(thinPairs.length + ' pairs have under $5K liquidity but active trading volume — wash trading or honeypot trap');
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
    const bp = parseInt(buyPct1h), bp24 = parseInt(buyPct24h || 50);
    if (bp >= 95 && bp24 >= 90 && totalTxns1h > 30 && totalTxns24h > 200) buySellFlags.push('1H buy ratio ' + bp + '% AND 24H buy ratio ' + bp24 + '% — sustained extreme buy dominance across both timeframes with ' + totalTxns24h + ' total transactions. consistent with coordinated bot activity');
    else if (bp <= 10 && bp24 <= 20 && totalTxns1h > 20) buySellFlags.push('1H sell ratio ' + (100-bp) + '% AND 24H sell ratio ' + (100-bp24) + '% — overwhelming sell pressure sustained across both timeframes. coordinated exit pattern');
  }
  const now = Date.now();
  const liqAgeFlags = [];
  const pairAges = pairs.filter(p => p.pairCreatedAt && (p.liquidity?.usd || 0) > 1000).map(p => ({ age: (now - p.pairCreatedAt) / 3600000, liq: p.liquidity?.usd || 0, dex: p.dexId || 'unknown' })).sort((a, b) => a.age - b.age);
  if (pairAges.length > 0) {
    const newest = pairAges[0];
    if (newest.age < 24) liqAgeFlags.push('new liquidity pool opened ' + newest.age.toFixed(1) + 'h ago on ' + newest.dex + ' with ' + formatUsd(newest.liq) + ' — fresh liquidity injection on existing token is a classic pre-pump setup');
    else if (newest.age < 48) liqAgeFlags.push('liquidity added to ' + newest.dex + ' within last 48h (' + newest.age.toFixed(0) + 'h ago) — recent liquidity injection, monitor for coordinated pump');
    const veryNew = pairAges.filter(p => p.age < 48);
    if (veryNew.length >= 2) liqAgeFlags.push(veryNew.length + ' new liquidity pools opened within 48h — rapid multi-pool deployment is a known tactic to create trading activity illusion');
  }
  return { priceImpact, pairBreakdown, multiPairFlags, topPairPct, totalPairs: pairs.length, totalLiq, buyPct1h, buyPct24h, totalBuys1h, totalSells1h, totalBuys24h, totalSells24h, buySellFlags, liqAgeFlags };
}
 
function formatUsd(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Number(n).toFixed(2);
}
 
// ── RUG HALL OF FAME — static curated list ────────────────────
const RUG_HALL_OF_FAME = [
  { name: 'SQUID Game Token', symbol: 'SQUID', year: '2021', chain: 'BSC', peak_mcap: '$2.1B', loss: '99.99%', cause: 'Honeypot rug pull', narrative: 'Rode the Netflix Squid Game viral moment. Team created a token you could buy but not sell — classic honeypot. Price went from fractions to $2,800 in days.', warning_signs: 'Could not sell tokens. Anonymous team. No audit. Launched during peak Netflix show hype — pure narrative play with zero fundamentals.', lesson: 'If you cannot find a sell transaction on the blockchain, it is a honeypot. Always verify sells exist before buying. Viral pop culture tokens with anonymous teams are extremely high risk.' },
  { name: 'OneCoin', symbol: 'ONE', year: '2017', chain: 'None (not on blockchain)', peak_mcap: '$4B raised', loss: '100%', cause: 'Ponzi scheme — not a real blockchain', narrative: 'Marketed as the Bitcoin killer with a real blockchain. Had 3 million members globally. Founder Ruja Ignatova aka Cryptoqueen disappeared in 2017 with billions.', warning_signs: 'No public blockchain. Could not independently verify transactions. Relied entirely on trust in founders. Multi-level referral structure. Promised guaranteed returns.', lesson: 'If you cannot independently verify transactions on a public block explorer it does not exist. No legitimate crypto project requires referrals to earn. Guaranteed returns in crypto are always a lie.' },
  { name: 'Luna Classic', symbol: 'LUNC', year: '2022', chain: 'Terra', peak_mcap: '$40B', loss: '99.99%', cause: 'Algorithmic stablecoin death spiral', narrative: 'UST was supposed to be a decentralised stablecoin backed by LUNA. Anchor Protocol offered 20% APY on UST. Billions poured in chasing yield. When UST depegged LUNA was minted to restore the peg causing hyperinflation.', warning_signs: '20% yield on a stablecoin is not sustainable. Algorithmic stablecoins have no real backing. Concentration of UST in Anchor was 70%+ — single point of failure. Do Kwon publicly mocked critics on Twitter.', lesson: 'Unsustainable yields are the loudest warning sign in crypto. Algorithmic stablecoins are not stablecoins. Never put more than you can lose in any single yield protocol regardless of TVL.' },
  { name: 'FTX Token', symbol: 'FTT', year: '2022', chain: 'Ethereum', peak_mcap: '$9B', loss: '97%', cause: 'Exchange collapse — FTX balance sheet was mostly FTT', narrative: 'FTT was the native token of FTX exchange. Sam Bankman-Fried was celebrated as a genius philanthropist. FTX was seen as the most reputable exchange. CoinDesk leaked that Alameda balance sheet was majority FTT — triggering a bank run.', warning_signs: 'Exchange token whose main utility was discounts. Circular — FTX used FTT as collateral for Alameda loans. SBF was aggressively political and PR-focused. No proof of reserves. Binance offloaded FTT position publicly.', lesson: 'Exchange tokens are not investments they are liabilities. No proof of reserves means no trust. When a competitor publicly dumps your token that is a five-alarm fire. Centralised entities fail the same way banks do.' },
  { name: 'Bitconnect', symbol: 'BCC', year: '2018', chain: 'Bitcoin sidechain', peak_mcap: '$2.7B', loss: '100%', cause: 'Ponzi — lending bot was fake', narrative: 'Promised 1% daily returns via a trading bot. Had massive YouTuber promoter network. Carlos Matos became a meme. Required locking BCC for returns. Collapsed after receiving cease and desist letters.', warning_signs: '1% daily return = 3700% annually. No verifiable trading bot. Required buying their token to participate. MLM referral structure. Anonymous team. Promoted exclusively by paid influencers.', lesson: 'Daily guaranteed returns are mathematically impossible to sustain. Influencer promotions in crypto are paid advertisements not endorsements. If the product requires buying a token to earn returns it is a Ponzi.' },
  { name: 'Frosties NFT', symbol: 'FROSTIES', year: '2022', chain: 'Ethereum', peak_mcap: '$1.3M mint', loss: '100%', cause: 'Classic NFT rug pull — devs disappeared after mint', narrative: 'Cute ice cream NFT project promising staking rewards, metaverse land, and a game. Sold out in minutes. Team deleted Discord and Twitter immediately after mint.', warning_signs: 'Anonymous team. Promises of metaverse and game with no working product. Sold out fast creating FOMO. Discord was barely moderated. No funds held in escrow or timelock.', lesson: 'Anonymous NFT teams with no locked funds can disappear instantly after mint. Never mint a project where the team has no skin in the game beyond the art. Promises of games and metaverses without demos are empty.' },
  { name: 'Meerkat Finance', symbol: 'MEERKAT', year: '2021', chain: 'BSC', peak_mcap: '$31M TVL', loss: '100%', cause: 'Rug pull disguised as exploit', narrative: 'Yield vault on BSC. Launched on day one of BSC DeFi summer. Within 24 hours of launch claimed to have been exploited. Founders took $31M claiming it was a hack.', warning_signs: 'Launched with no audit. Vault contracts had admin keys that could drain funds. Team was anonymous. TVL grew too fast in 24 hours indicating coordinated deposits. BSC fees were low making rugs cheap.', lesson: 'Never deposit into an unaudited vault. Admin keys in smart contracts are a backdoor. Exploits that happen on day one of launch are almost always the team. Low-fee chains lower the cost of rugging.' },
  { name: 'Safemoon', symbol: 'SFM', year: '2021', chain: 'BSC', peak_mcap: '$6B', loss: '99%', cause: 'Misleading tokenomics and developer exit', narrative: 'Promised to go to the moon with a 10% tax on transactions — half burned, half to liquidity. Went viral on Reddit and TikTok. CTO was later charged by SEC for fraud and diverting funds.', warning_signs: 'High transaction taxes benefit early holders and developers disproportionately. No clear product. Viral social media growth without fundamental backing. Celebrity and influencer promotion. CTO John Karony later charged with fraud.', lesson: 'High transaction taxes are not tokenomics they are extraction mechanisms. Viral tokens with no product almost never deliver. SEC charges follow crypto fraud — anonymous teams with funds are not untouchable.' },
];
 
// ── RSS + REDDIT + TRENDS SCRAPER ────────────────────────────
const RSS_FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'Blockworks', url: 'https://blockworks.co/feed' },
  { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
];
 
const REDDIT_SUBS = ['CryptoCurrency', 'ethereum', 'solana', 'defi', 'ethfinance'];
 
async function fetchRSS(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CTpulse/1.0)' },
      signal: AbortSignal.timeout(5000)
    });
    const text = await res.text();
    // extract titles and descriptions from RSS XML
    const items = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(text)) !== null && items.length < 15) {
      const block = match[1];
      const title = (block.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/i) ||
                     block.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1] || '';
      const desc = (block.match(/<description[^>]*><!\[CDATA\[(.*?)\]\]><\/description>/i) ||
                    block.match(/<description[^>]*>(.*?)<\/description>/i) || [])[1] || '';
      const cleaned = (title + ' ' + desc).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (cleaned.length > 20) items.push(cleaned);
    }
    return { source: feed.name, items };
  } catch { return { source: feed.name, items: [] }; }
}
 
async function fetchReddit(sub) {
  try {
    const res = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=15`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CTpulse/1.0)' },
      signal: AbortSignal.timeout(5000)
    });
    const data = await res.json();
    const posts = (data?.data?.children || []).map(p => ({
      title: p.data?.title || '',
      score: p.data?.score || 0,
      comments: p.data?.num_comments || 0,
    })).filter(p => p.title.length > 10);
    return { sub, posts };
  } catch { return { sub, items: [] }; }
}
 
async function fetchGoogleTrends(keywords) {
  // use Google Trends RSS which is free and requires no API key
  const results = {};
  const promises = keywords.map(async kw => {
    try {
      const encoded = encodeURIComponent(kw);
      const res = await fetch(
        `https://trends.google.com/trends/trendingsearches/daily/rss?geo=US`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) }
      );
      const text = await res.text();
      const titles = [];
      const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/gi;
      let m;
      while ((m = titleRegex.exec(text)) !== null) titles.push(m[1].toLowerCase());
      const matched = titles.filter(t => t.includes(kw.toLowerCase()));
      results[kw] = matched.length;
    } catch { results[kw] = 0; }
  });
  await Promise.all(promises);
  return results;
}
 
async function getTrendingNarratives() {
  // fetch all sources in parallel with timeout
  const [rssResults, redditResults] = await Promise.all([
    Promise.all(RSS_FEEDS.map(f => fetchRSS(f))),
    Promise.all(REDDIT_SUBS.map(s => fetchReddit(s))),
  ]);
 
  // compile all headlines
  const headlines = [];
  rssResults.forEach(r => {
    r.items.forEach(item => headlines.push(`[${r.source}] ${item}`));
  });
 
  // compile reddit posts sorted by score
  const redditPosts = [];
  redditResults.forEach(r => {
    (r.posts || []).forEach(p => {
      if (p.score > 50) redditPosts.push(`[r/${r.sub} +${p.score}] ${p.title}`);
    });
  });
  redditPosts.sort((a, b) => {
    const scoreA = parseInt(a.match(/\+(\d+)/)?.[1] || 0);
    const scoreB = parseInt(b.match(/\+(\d+)/)?.[1] || 0);
    return scoreB - scoreA;
  });
 
  const topReddit = redditPosts.slice(0, 20);
  const allContent = [...headlines, ...topReddit];
 
  if (allContent.length < 5) throw new Error('insufficient data from sources');
 
  // send to Claude to identify narrative clusters
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const prompt = `Today is ${today}. You are a crypto narrative analyst. Analyze these real headlines and Reddit posts from the last 24-48 hours and identify the TOP 5 emerging or accelerating crypto narratives. A narrative is an IDEA or THEME spreading through CT — not just a coin. Examples: "AI agents that hold wallets", "Bitcoin as corporate treasury reserve", "RWA tokenization going mainstream". Return ONLY a valid JSON array, no markdown, no code blocks. Each narrative object has: name (short punchy name), summary (2 sentences max, no apostrophes), signal_strength (1-10, based on how many sources mention it), velocity (accelerating/steady/cooling — is this picking up or slowing down), evidence (specific headlines or posts that confirm this narrative is real, max 3, no apostrophes), why_now (what triggered this narrative RIGHT NOW, no apostrophes), tradeable (yes/no — is there a clear way to position for this), cycle_stage (early/mid-cycle/peak hype/late cooling). Sort by signal_strength descending. Only include narratives with genuine signal from the data — do not invent narratives not present in the content. HEADLINES AND POSTS:\n${allContent.slice(0, 60).join('\n')}`;
 
  const data = await callClaude({ model: HAIKU, max_tokens: 2500, messages: [{ role: 'user', content: prompt }] });
  const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const cleaned = txt.replace(/```json/g, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No narratives returned');
  const narratives = JSON.parse(match[0]);
  return { narratives, sourceCount: allContent.length, headlineCount: headlines.length, redditCount: topReddit.length };
}
 
// ── API ROUTES ────────────────────────────────────────────────
app.get('/api/key', rateLimit, (req, res) => {
  const origin = req.headers.referer || req.headers.origin || '';
  if (!origin.includes('ct-pulse.vercel.app') && !origin.includes('localhost')) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ key: ANTHROPIC_API_KEY });
});
 
app.get('/api/rugfame', rateLimit, (req, res) => {
  res.json({ rugs: RUG_HALL_OF_FAME });
});
 
app.post('/api/trending-narratives', rateLimit, async (req, res) => {
  try {
    const CACHE_KEY = 'ct_trending_narratives_v1';
    const cached = await cacheGet(CACHE_KEY);
    if (cached && cached.narratives && cached.timestamp) {
      const age = Date.now() - cached.timestamp;
      if (age < 2 * 60 * 60 * 1000) { // 2h cache — fresher than static narratives
        return res.json({ ...cached, cached: true });
      }
    }
    const result = await getTrendingNarratives();
    const payload = { ...result, timestamp: Date.now() };
    await cacheSet(CACHE_KEY, payload, 2 * 60 * 60);
    res.json({ ...payload, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 
app.post('/api/onchain', rateLimit, async (req, res) => {
  const { contractAddress, chainId } = req.body;
  if (!contractAddress || !chainId) return res.status(400).json({ error: 'missing contractAddress or chainId' });
  try {
    let data = null;
    if (chainId === 'solana') data = await getSolanaOnchainData(contractAddress);
    else data = await getEthOnchainData(contractAddress, chainId);
    if (!data) return res.json({ available: false, reason: 'chain not supported or API unavailable' });
    res.json({ available: true, ...data });
  } catch (e) { res.json({ available: false, reason: e.message }); }
});
 
app.post('/api/pairanalysis', rateLimit, async (req, res) => {
  const { pairs } = req.body;
  if (!pairs || !Array.isArray(pairs)) return res.status(400).json({ error: 'missing pairs array' });
  try { res.json(analysePairs(pairs)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
 
app.post('/api/narratives', rateLimit, async (req, res) => {
  try {
    const CACHE_KEY = 'ct_narratives_v6';
    const cached = await cacheGet(CACHE_KEY);
    if (cached && cached.narratives && cached.timestamp) {
      const age = Date.now() - cached.timestamp;
      if (age < CACHE_TTL_MS) return res.json({ narratives: cached.narratives, cached: true, cachedAt: cached.timestamp, nextRefresh: cached.timestamp + CACHE_TTL_MS });
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
 
