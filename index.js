const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://animekhor.org';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_TTL   = 30 * 60 * 1000;
const EPISODE_TTL = 10 * 60 * 1000;
const DISK_CACHE  = path.join('/tmp', 'animekhor_all.json');

function setCache(key, value, ttl = CACHE_TTL) {
  cache.set(key, { value, expires: Date.now() + ttl });
}
function getCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { cache.delete(key); return null; }
  return e.value;
}
function saveToDisk(data) {
  try { fs.writeFileSync(DISK_CACHE, JSON.stringify(data)); } catch (_) {}
}
function loadFromDisk() {
  try { if (fs.existsSync(DISK_CACHE)) return JSON.parse(fs.readFileSync(DISK_CACHE, 'utf8')); } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': BASE_URL,
};

async function fetchHTML(url, ttl = CACHE_TTL) {
  const cached = getCache(url);
  if (cached) return cached;
  const res = await fetch(url, { headers: HEADERS, timeout: 15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  setCache(url, html, ttl);
  return html;
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------
function makeId(slug)   { return `animekhor|${slug}`; }
function slugFromId(id) { return id.replace(/^animekhor[|:]/, ''); }

// ---------------------------------------------------------------------------
// Parse catalog cards  (article.bs structure confirmed from inspector)
//   article.bs
//     a[href="/anime/slug/"]
//       div.ply
//       div.bt
//       img.ts-post-image   ← poster
//       div.tt              ← title
// ---------------------------------------------------------------------------
function parseCards($) {
  const results = [];
  const seen = new Set();

  $('article.bs').each((_, el) => {
    const a     = $(el).find('a').first();
    const href  = a.attr('href') || '';
    if (!href || !href.includes('/anime/') || seen.has(href)) return;

    const title =
      $(el).find('.tt').first().text().trim() ||
      $(el).find('img').first().attr('title') ||
      $(el).find('img').first().attr('alt') || '';
    if (!title) return;

    const img    = $(el).find('img').first();
    const poster = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';

    seen.add(href);
    const full = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    const slug = full.replace(BASE_URL, '').replace(/^\/anime\//, '').replace(/\/$/, '');
    if (slug) results.push({ slug, title, poster });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Scrape episode list
//
// Confirmed HTML structure from debug/html endpoint:
//   div.eplister
//     div.ephead  (header row — skip)
//     ul
//       li[data-index="0"]
//         a href="https://animekhor.org/the-demon-hunter-season-3-episode-5-subtitles-english-indonesian/"
//           div.epl-num   → "5"
//           div.epl-title → "Episode 5"
//           div.epl-date  → "April 24, 2026"
// ---------------------------------------------------------------------------
async function scrapeAnimePage(slug) {
  const url = `${BASE_URL}/anime/${slug}/`;
  const key = `ep_${slug}`;
  let html  = getCache(key);

  if (!html) {
    const res = await fetch(url, { headers: HEADERS, timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
    setCache(key, html, EPISODE_TTL);
  }

  const $ = cheerio.load(html);

  // Metadata
  const title       = $('h1.entry-title, h1').first().text().trim();
  const poster      = $('img.ts-post-image').first().attr('src') || '';
  const description = $('div.entry-content p, div.synp p').first().text().trim() || '';
  const status      = $('span.statuson').first().text().trim() || '';

  // Episodes — scoped to div.eplister ul li ONLY (confirmed structure)
  const episodes = [];
  const seen     = new Set();

  $('div.eplister ul li').each((_, li) => {
    const a      = $(li).find('a').first();
    const href   = a.attr('href') || '';
    if (!href) return;

    const numText = $(li).find('.epl-num').first().text().trim();
    const epNum   = parseInt(numText, 10);
    if (isNaN(epNum) || epNum <= 0 || seen.has(epNum)) return;

    const dateText = $(li).find('.epl-date').first().text().trim();
    let released   = new Date(0).toISOString();
    if (dateText) {
      const d = new Date(dateText);
      if (!isNaN(d.getTime())) released = d.toISOString();
    }

    seen.add(epNum);
    episodes.push({
      epNum,
      url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
      released,
    });
  });

  episodes.sort((a, b) => a.epNum - b.epNum);
  console.log(`[meta] "${title}" slug="${slug}" episodes=${episodes.length}`);
  return { title, poster, status, description, episodes };
}

// ---------------------------------------------------------------------------
// A-Z scraper
// ---------------------------------------------------------------------------
async function scrapeAZ(letter, page = 1) {
  const url  = page === 1
    ? `${BASE_URL}/a-z-lists/?show=${letter}`
    : `${BASE_URL}/a-z-lists/page/${page}/?show=${letter}`;
  const html = await fetchHTML(url);
  const $    = cheerio.load(html);
  return {
    series:  parseCards($),
    hasNext: $('a.next, a[rel="next"], .next.page-numbers').length > 0,
  };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// ---------------------------------------------------------------------------
// MANIFEST
// No "stream" resource — we are a CATALOG+META addon only.
// Your streaming addons (AIOStreams, FlixHQ, etc.) handle streams based on
// the show name + episode number we expose via meta.
// ---------------------------------------------------------------------------
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.animekhor.catalog',
    version: '1.4.0',
    name: 'AnimeKhor Donghua',
    description: 'Catalog & metadata for Chinese donghua from AnimeKhor.org. Install alongside your streaming addons.',
    logo: 'https://animekhor.org/wp-content/uploads/2021/11/AnimeKhor_darkmode.png',
    resources: ['catalog', 'meta'],   // ← NO "stream" — let your other addons handle that
    types: ['series'],
    idPrefixes: ['animekhor|'],
    catalogs: [
      {
        type: 'series',
        id: 'animekhor_ongoing',
        name: 'AnimeKhor – Ongoing',
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
      },
      {
        type: 'series',
        id: 'animekhor_all',
        name: 'AnimeKhor – All Donghua',
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
      }
    ],
    behaviorHints: { adult: false, p2p: false }
  });
});

// ---------------------------------------------------------------------------
// Ongoing
// ---------------------------------------------------------------------------
async function getOngoing() {
  const cached = getCache('ongoing');
  if (cached) return cached;

  for (const url of [
    `${BASE_URL}/donghua-series/?status=Ongoing&order=latest`,
    `${BASE_URL}/donghua-series/`,
    `${BASE_URL}/`,
  ]) {
    try {
      const html  = await fetchHTML(url);
      const $     = cheerio.load(html);
      const cards = parseCards($);
      if (cards.length > 0) {
        const metas = cards.map(s => ({
          id: makeId(s.slug), type: 'series',
          name: s.title, poster: s.poster, posterShape: 'poster'
        }));
        setCache('ongoing', metas);
        return metas;
      }
    } catch (e) { console.error('Ongoing:', e.message); }
  }
  return [];
}

// ---------------------------------------------------------------------------
// All series
// ---------------------------------------------------------------------------
let scraping = false;

async function getAllSeries(search) {
  if (search) {
    try {
      const html = await fetchHTML(`${BASE_URL}/?s=${encodeURIComponent(search)}`, 5 * 60 * 1000);
      const $    = cheerio.load(html);
      return parseCards($).map(s => ({
        id: makeId(s.slug), type: 'series',
        name: s.title, poster: s.poster, posterShape: 'poster'
      }));
    } catch (e) { console.error('Search:', e.message); return []; }
  }

  const mem  = getCache('all_series');
  if (mem) return mem;

  const disk = loadFromDisk();
  if (disk && disk.length > 0) { setCache('all_series', disk); return disk; }

  if (!scraping) { scraping = true; scrapeAllLetters().finally(() => { scraping = false; }); }
  return getOngoing(); // placeholder while scrape runs
}

async function scrapeAllLetters() {
  console.log('A-Z scrape starting…');
  const letters = ['0-9', ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')];
  const all = [], seen = new Set();

  for (const letter of letters) {
    let page = 1, hasNext = true;
    while (hasNext && page <= 20) {
      try {
        const r = await scrapeAZ(letter, page);
        for (const s of r.series) {
          if (!seen.has(s.slug)) {
            seen.add(s.slug);
            all.push({ id: makeId(s.slug), type: 'series', name: s.title, poster: s.poster, posterShape: 'poster' });
          }
        }
        hasNext = r.hasNext;
        page++;
        await new Promise(r => setTimeout(r, 350));
      } catch (e) { console.error(`A-Z [${letter} p${page}]:`, e.message); hasNext = false; }
    }
  }

  if (all.length > 0) { console.log(`A-Z done: ${all.length}`); setCache('all_series', all); saveToDisk(all); }
  return all;
}

// ---------------------------------------------------------------------------
// CATALOG  (handles /catalog/:type/:id.json AND /catalog/:type/:id/extra.json)
// ---------------------------------------------------------------------------
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { id, extra } = req.params;
  let search = req.query.search || '';
  let skip   = parseInt(req.query.skip || '0');
  if (extra) {
    for (const p of extra.split('&')) {
      const [k, v] = p.split('=');
      if (k === 'search') search = decodeURIComponent(v || '');
      if (k === 'skip')   skip   = parseInt(v || '0');
    }
  }
  try {
    let metas = [];
    if (id === 'animekhor_ongoing') {
      metas = await getOngoing();
      if (search) { const q = search.toLowerCase(); metas = metas.filter(m => m.name.toLowerCase().includes(q)); }
    } else if (id === 'animekhor_all') {
      metas = await getAllSeries(search);
    }
    res.json({ metas: metas.slice(skip, skip + 20) });
  } catch (e) { console.error('Catalog:', e.message); res.json({ metas: [] }); }
});

// ---------------------------------------------------------------------------
// META
// ---------------------------------------------------------------------------
app.get('/meta/:type/:id.json', async (req, res) => {
  const rawId = req.params.id;
  const slug  = slugFromId(rawId);
  try {
    const data = await scrapeAnimePage(slug);
    if (!data.title) return res.json({ meta: null });

    const videos = data.episodes.map(ep => ({
      id:       `${rawId}:${ep.epNum}`,
      title:    `Episode ${ep.epNum}`,
      season:   1,
      episode:  ep.epNum,
      released: ep.released,
      overview: `Episode ${ep.epNum} of ${data.title}`,
    }));

    res.json({
      meta: {
        id: rawId, type: 'series',
        name: data.title, poster: data.poster,
        description: data.description, status: data.status,
        videos, posterShape: 'poster',
      }
    });
  } catch (e) { console.error('Meta:', e.message); res.json({ meta: null }); }
});

// ---------------------------------------------------------------------------
// Debug & health
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    addon: 'AnimeKhor v1.4',
    install: `${req.protocol}://${req.get('host')}/manifest.json`,
    catalog_ready: !!getCache('all_series') || fs.existsSync(DISK_CACHE),
    scraping,
  });
});

app.get('/warmup', async (req, res) => {
  if (scraping) return res.json({ status: 'already running' });
  if (getCache('all_series')) return res.json({ status: 'warm', count: getCache('all_series').length });
  scraping = true;
  scrapeAllLetters().finally(() => { scraping = false; });
  res.json({ status: 'started' });
});

// Test episode scraping: /debug/meta/the-demon-hunter-season-3-cang-yuan-tu-season-3
app.get('/debug/meta/:slug(*)', async (req, res) => {
  try { res.json(await scrapeAnimePage(req.params.slug)); }
  catch (e) { res.json({ error: e.message }); }
});

// See raw HTML the server receives: /debug/html/the-demon-hunter-season-3-cang-yuan-tu-season-3
app.get('/debug/html/:slug(*)', async (req, res) => {
  try {
    const url  = `${BASE_URL}/anime/${req.params.slug}/`;
    const r    = await fetch(url, { headers: HEADERS, timeout: 15000 });
    const html = await r.text();
    const idx  = html.indexOf('eplister');
    res.json({
      status: r.status, htmlBytes: html.length,
      hasEplister: idx > -1, hasEplNum: html.includes('epl-num'),
      eplisterSnippet: idx > -1 ? html.substring(idx, idx + 800) : 'NOT FOUND',
    });
  } catch (e) { res.json({ error: e.message }); }
});

// Test A-Z card parsing: /debug/az/A
app.get('/debug/az/:letter', async (req, res) => {
  try { res.json(await scrapeAZ(req.params.letter.toUpperCase())); }
  catch (e) { res.json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`AnimeKhor addon on port ${PORT}`);
  const disk = loadFromDisk();
  if (disk && disk.length > 0) { setCache('all_series', disk); console.log(`Disk cache: ${disk.length} series`); }
});
