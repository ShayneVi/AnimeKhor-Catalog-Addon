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
const CACHE_TTL      = 30 * 60 * 1000; // 30 min  — catalog pages
const EPISODE_TTL    = 10 * 60 * 1000; // 10 min  — episode pages (update often)
const DISK_CACHE_PATH = path.join('/tmp', 'animekhor_all.json');

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
  try { fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify(data)); } catch (_) {}
}
function loadFromDisk() {
  try {
    if (fs.existsSync(DISK_CACHE_PATH))
      return JSON.parse(fs.readFileSync(DISK_CACHE_PATH, 'utf8'));
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
async function fetchHTML(url, ttl = CACHE_TTL) {
  const cached = getCache(url);
  if (cached) return cached;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': BASE_URL,
    },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  setCache(url, html, ttl);
  return html;
}

// ---------------------------------------------------------------------------
// ID helpers  (pipe separator — colons break Express :param parsing)
// ---------------------------------------------------------------------------
function makeId(slug)  { return `animekhor|${slug}`; }
function slugFromId(id) { return id.replace(/^animekhor[|:]/, ''); }

// ---------------------------------------------------------------------------
// Parse series cards from a listing / A-Z page
//
// From the inspector (images 4 & 5):
//   article.bs.bsx (or article.bs)
//     div.ply  — overlay
//     div.bt   — badge / type
//     img.ts-post-image  — poster  (src or loading="lazy" so check both)
//     div.tt   — title text
//   The <a> wrapping everything has the href
// ---------------------------------------------------------------------------
function parseSeriesCards($) {
  const results = [];
  const seen    = new Set();

  $('article.bs').each((_, el) => {
    // The whole card is usually wrapped in an <a>, or there's an <a> inside
    const cardLink = $(el).find('a').first();
    const href     = cardLink.attr('href') || $(el).closest('a').attr('href') || '';
    if (!href || !href.includes('/anime/') || seen.has(href)) return;

    const title =
      $(el).find('.tt').first().text().trim() ||
      $(el).find('img').first().attr('title') ||
      $(el).find('img').first().attr('alt') || '';
    if (!title) return;

    const img    = $(el).find('img').first();
    const poster =
      img.attr('src') ||
      img.attr('data-src') ||
      img.attr('data-lazy-src') || '';

    seen.add(href);
    const fullHref = href.startsWith('http') ? href : `${BASE_URL}${href}`;
    const slug = fullHref
      .replace(BASE_URL, '')
      .replace(/^\/anime\//, '')
      .replace(/\/$/, '');
    if (slug) results.push({ slug, title, poster });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Scrape an anime detail page for episodes
//
// From the inspector (images 1–3):
//   ul.eplister
//     li[data-index="N"]
//       a href="/the-demon-hunter-season-3-episode-5-subtitles-english-indonesian/"
//         div.epl-num   → "5"
//         div.epl-title → "Episode 5"
//         div.epl-date  → "April 24, 2026"
//
// NOTE: the episode URL is at the ROOT level (no /anime/ prefix).
// ---------------------------------------------------------------------------
async function scrapeAnimePage(slug) {
  const url      = `${BASE_URL}/anime/${slug}/`;
  const cacheKey = `anime_${slug}`;
  const cached   = getCache(cacheKey);
  let html;

  if (cached) {
    html = cached;
  } else {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': BASE_URL,
      },
      timeout: 15000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    html = await res.text();
    setCache(cacheKey, html, EPISODE_TTL);
  }

  const $ = cheerio.load(html);

  // ---- Basic metadata ----
  const title       = $('h1.entry-title, h1').first().text().trim();
  const poster      = $('img.ts-post-image').first().attr('src') ||
                      $('div.thumb img, .poster img').first().attr('src') || '';
  const description = $('div.entry-content p, div.synp p').first().text().trim() || '';
  const status      = $('span.statuson').first().text().trim() || '';

  // ---- Episodes — exact selectors from inspector ----
  const episodes = [];
  const seenEp   = new Set();

  $('ul.eplister li').each((_, li) => {
    const a      = $(li).find('a').first();
    const epLink = a.attr('href') || '';
    if (!epLink) return;

    // Episode number: div.epl-num inside the <a>
    const numText = $(li).find('.epl-num').first().text().trim();
    const epNum   = parseInt(numText, 10);
    if (isNaN(epNum) || epNum <= 0) return;

    // Release date: div.epl-date
    const releaseText = $(li).find('.epl-date').first().text().trim();
    let released      = new Date(0).toISOString();
    if (releaseText) {
      const parsed = new Date(releaseText);
      if (!isNaN(parsed.getTime())) released = parsed.toISOString();
    }

    if (!seenEp.has(epNum)) {
      seenEp.add(epNum);
      const fullUrl = epLink.startsWith('http') ? epLink : `${BASE_URL}${epLink}`;
      episodes.push({ epNum, url: fullUrl, released });
    }
  });

  episodes.sort((a, b) => a.epNum - b.epNum);

  console.log(`[scrape] "${title}" — ${episodes.length} episodes`);
  return { title, poster, status, description, episodes };
}

// ---------------------------------------------------------------------------
// Scrape A-Z listing page
// URL pattern: /a-z-lists/?show=A  or  /a-z-lists/page/2/?show=A
// ---------------------------------------------------------------------------
async function scrapeAZPage(letter, page = 1) {
  const url = page === 1
    ? `${BASE_URL}/a-z-lists/?show=${letter}`
    : `${BASE_URL}/a-z-lists/page/${page}/?show=${letter}`;
  const html    = await fetchHTML(url);
  const $       = cheerio.load(html);
  const series  = parseSeriesCards($);
  const hasNext = $('a.next, a[rel="next"], .next.page-numbers').length > 0;
  return { series, hasNext };
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
// ---------------------------------------------------------------------------
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.animekhor.catalog',
    version: '1.3.0',
    name: 'AnimeKhor Donghua',
    description: 'Full catalog of Chinese donghua from AnimeKhor.org.',
    logo: 'https://animekhor.org/wp-content/uploads/2021/11/AnimeKhor_darkmode.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
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
// Ongoing catalog
// AnimeKhor lists ongoing series at /donghua-series/?status=Ongoing
// Each card is article.bs  (same structure as A-Z)
// ---------------------------------------------------------------------------
async function getOngoing() {
  const cached = getCache('ongoing');
  if (cached) return cached;

  // Try multiple possible URLs
  const candidates = [
    `${BASE_URL}/donghua-series/?status=Ongoing&order=latest`,
    `${BASE_URL}/donghua-series/`,
    `${BASE_URL}/ongoing-donghua/`,
  ];

  for (const url of candidates) {
    try {
      const html  = await fetchHTML(url);
      const $     = cheerio.load(html);
      const cards = parseSeriesCards($);
      if (cards.length > 0) {
        const metas = cards.map(s => ({
          id: makeId(s.slug), type: 'series',
          name: s.title, poster: s.poster, posterShape: 'poster'
        }));
        setCache('ongoing', metas);
        return metas;
      }
    } catch (e) { console.error(`getOngoing ${url}:`, e.message); }
  }
  return [];
}

// ---------------------------------------------------------------------------
// All-series catalog  (A-Z scrape, background, disk-cached)
// ---------------------------------------------------------------------------
let scrapeInProgress = false;

async function getAllSeries(searchQuery) {
  // Search — use site's own search
  if (searchQuery) {
    try {
      const url  = `${BASE_URL}/?s=${encodeURIComponent(searchQuery)}`;
      const html = await fetchHTML(url, 5 * 60 * 1000);
      const $    = cheerio.load(html);
      return parseSeriesCards($).map(s => ({
        id: makeId(s.slug), type: 'series',
        name: s.title, poster: s.poster, posterShape: 'poster'
      }));
    } catch (e) { console.error('Search:', e.message); return []; }
  }

  // Memory
  const mem = getCache('all_series');
  if (mem) return mem;

  // Disk
  const disk = loadFromDisk();
  if (disk && disk.length > 0) {
    setCache('all_series', disk);
    return disk;
  }

  // Nothing ready — kick off background scrape, return ongoing as placeholder
  if (!scrapeInProgress) {
    scrapeInProgress = true;
    scrapeAllLetters().finally(() => { scrapeInProgress = false; });
  }
  console.log('Catalog not ready — returning ongoing as placeholder');
  return getOngoing();
}

async function scrapeAllLetters() {
  console.log('Starting A-Z scrape…');
  const letters = ['0-9', ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')];
  const all     = [];
  const seen    = new Set();

  for (const letter of letters) {
    let page = 1, hasNext = true;
    while (hasNext && page <= 20) {
      try {
        const result = await scrapeAZPage(letter, page);
        for (const s of result.series) {
          if (!seen.has(s.slug)) {
            seen.add(s.slug);
            all.push({
              id: makeId(s.slug), type: 'series',
              name: s.title, poster: s.poster, posterShape: 'poster'
            });
          }
        }
        hasNext = result.hasNext;
        page++;
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        console.error(`A-Z [${letter} p${page}]:`, e.message);
        hasNext = false;
      }
    }
  }

  if (all.length > 0) {
    console.log(`A-Z done: ${all.length} series`);
    setCache('all_series', all);
    saveToDisk(all);
  }
  return all;
}

// ---------------------------------------------------------------------------
// CATALOG route
// Handles both Stremio URL formats:
//   /catalog/series/animekhor_all.json
//   /catalog/series/animekhor_all/search=foo.json
//   /catalog/series/animekhor_all/skip=20.json
// ---------------------------------------------------------------------------
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { id, extra } = req.params;
  let search = req.query.search || '';
  let skip   = parseInt(req.query.skip || '0');

  if (extra) {
    for (const part of extra.split('&')) {
      const [k, v] = part.split('=');
      if (k === 'search') search = decodeURIComponent(v || '');
      if (k === 'skip')   skip   = parseInt(v || '0');
    }
  }

  try {
    let metas = [];
    if (id === 'animekhor_ongoing') {
      metas = await getOngoing();
      if (search) {
        const q = search.toLowerCase();
        metas = metas.filter(m => m.name.toLowerCase().includes(q));
      }
    } else if (id === 'animekhor_all') {
      metas = await getAllSeries(search);
    }
    res.json({ metas: metas.slice(skip, skip + 20) });
  } catch (e) {
    console.error('Catalog error:', e.message);
    res.json({ metas: [] });
  }
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
      overview: `Episode ${ep.epNum} of ${data.title}`
    }));

    res.json({
      meta: {
        id: rawId, type: 'series',
        name: data.title, poster: data.poster,
        description: data.description, status: data.status,
        videos, posterShape: 'poster'
      }
    });
  } catch (e) {
    console.error('Meta error:', e.message);
    res.json({ meta: null });
  }
});

// ---------------------------------------------------------------------------
// STREAM
// ID format coming from Stremio: animekhor|slug:epNum
// ---------------------------------------------------------------------------
app.get('/stream/:type/:id.json', async (req, res) => {
  const fullId    = req.params.id;
  const lastColon = fullId.lastIndexOf(':');
  if (lastColon === -1) return res.json({ streams: [] });

  const epNum  = parseInt(fullId.slice(lastColon + 1));
  const slug   = slugFromId(fullId.slice(0, lastColon));

  try {
    const data = await scrapeAnimePage(slug);
    const ep   = data.episodes.find(e => e.epNum === epNum);
    if (!ep) {
      console.log(`Stream: ep ${epNum} not in ${slug} (found: ${data.episodes.map(e=>e.epNum)})`);
      return res.json({ streams: [] });
    }
    res.json({
      streams: [{
        title: '🌐 Watch on AnimeKhor',
        externalUrl: ep.url,
        behaviorHints: { notWebReady: true }
      }]
    });
  } catch (e) {
    console.error('Stream error:', e.message);
    res.json({ streams: [] });
  }
});

// ---------------------------------------------------------------------------
// Health, warmup, debug
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    message: 'AnimeKhor Stremio Addon v1.3',
    install: `${req.protocol}://${req.get('host')}/manifest.json`,
    catalog_ready: !!getCache('all_series') || fs.existsSync(DISK_CACHE_PATH),
    scrape_in_progress: scrapeInProgress
  });
});

// Hit this once after deploy to warm the full catalog
app.get('/warmup', async (req, res) => {
  if (scrapeInProgress) return res.json({ status: 'already running' });
  if (getCache('all_series')) return res.json({ status: 'warm', count: getCache('all_series').length });
  scrapeInProgress = true;
  scrapeAllLetters().finally(() => { scrapeInProgress = false; });
  res.json({ status: 'started' });
});

// Test episode parsing for any slug without opening Stremio
// e.g. GET /debug/meta/the-demon-hunter-season-3-cang-yuan-tu-season-3
app.get('/debug/meta/:slug(*)', async (req, res) => {
  try {
    const data = await scrapeAnimePage(req.params.slug);
    res.json(data);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Test catalog card parsing for a single A-Z letter
// e.g. GET /debug/az/A
app.get('/debug/az/:letter', async (req, res) => {
  try {
    const result = await scrapeAZPage(req.params.letter.toUpperCase());
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`AnimeKhor addon on port ${PORT}`);
  console.log(`Install: http://localhost:${PORT}/manifest.json`);

  // Pre-warm from disk on startup
  const disk = loadFromDisk();
  if (disk && disk.length > 0) {
    setCache('all_series', disk);
    console.log(`Loaded ${disk.length} series from disk.`);
  }
});
