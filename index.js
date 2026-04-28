const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://animekhor.org';

// ---------------------------------------------------------------------------
// Cache — two-layer: in-memory (fast) + disk (survives restarts on paid plans)
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 min
const DISK_CACHE_PATH = path.join('/tmp', 'animekhor_all.json');

function setCache(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL });
}
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.value;
}

// Persist the expensive full-catalog to disk so cold restarts reuse it
function saveToDisk(data) {
  try { fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify(data)); } catch (_) {}
}
function loadFromDisk() {
  try {
    if (fs.existsSync(DISK_CACHE_PATH)) {
      const raw = fs.readFileSync(DISK_CACHE_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------
async function fetchHTML(url) {
  const cached = getCache(url);
  if (cached) return cached;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  setCache(url, html);
  return html;
}

// ---------------------------------------------------------------------------
// Scraping helpers
// ---------------------------------------------------------------------------

// Parse series cards — AnimeKhor uses WordPress with a filmography theme.
// The actual selectors depend on the theme; we try several common ones.
function parseSeriesCards($, container) {
  const results = [];
  const seen = new Set();

  // Strategy 1: direct <article> or .bs / .bsx cards
  $(container).find('article, .bs, .bsx, .flw-item').each((_, el) => {
    const a = $(el).find('a[href*="/anime/"]').first();
    const link = a.attr('href') || '';
    const title =
      $(el).find('h2, h3, .title, .tt, .titleCont').first().text().trim() ||
      a.attr('title') || '';
    const img = $(el).find('img').first();
    const poster = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';

    if (link && title && !seen.has(link)) {
      seen.add(link);
      const slug = link.replace(BASE_URL, '').replace(/^\/anime\//, '').replace(/\/$/, '');
      results.push({ slug, title, poster });
    }
  });

  // Strategy 2: standalone <a href="/anime/..."> with an img child (grid layouts)
  if (results.length === 0) {
    $(container).find('a[href*="/anime/"]').each((_, el) => {
      const link = $(el).attr('href') || '';
      if (seen.has(link)) return;
      const img = $(el).find('img').first();
      const title =
        $(el).attr('title') ||
        img.attr('alt') || img.attr('title') ||
        $(el).text().trim();
      const poster = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';
      if (link && title) {
        seen.add(link);
        const slug = link.replace(BASE_URL, '').replace(/^\/anime\//, '').replace(/\/$/, '');
        results.push({ slug, title, poster });
      }
    });
  }

  return results;
}

async function scrapeAZPage(letter, page = 1) {
  const url = page === 1
    ? `${BASE_URL}/a-z-lists/?show=${letter}`
    : `${BASE_URL}/a-z-lists/page/${page}/?show=${letter}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const series = parseSeriesCards($, 'body');

  // Detect next page
  const hasNext =
    $('a.next, a[rel="next"]').length > 0 ||
    $('a:contains("Next")').length > 0 ||
    $(`.page-numbers a:contains("${page + 1}")`).length > 0;

  return { series, hasNext };
}

async function scrapeAnimePage(slug) {
  const url = `${BASE_URL}/anime/${slug}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const title = $('h1').first().text().trim();

  // Poster — try common selectors
  const poster =
    $('.thumb img, .poster img, .film-poster img, .detail_page-infor img, .anime-image img, img.attachment-post-thumbnail')
      .first().attr('src') ||
    $('img[class*="poster"], img[class*="thumb"]').first().attr('src') || '';

  // Status
  const status =
    $('span:contains("Status:")').next().text().trim() ||
    $('*').filter((_, el) => {
      const text = $(el).clone().children().remove().end().text();
      return /^Status:/.test(text);
    }).first().text().replace('Status:', '').trim() || '';

  // Description
  const description =
    $('[class*="synopsis"] p, [class*="entry-content"] p, [class*="desc"] p').first().text().trim() ||
    $('div.synp p, div.entry p').first().text().trim() || '';

  // Episodes — AnimeKhor typically lists them in a <ul> with <li> items
  const episodes = [];
  const seenEp = new Set();

  // Primary: look for links with "episode" in the href
  $('a[href*="episode"]').each((_, el) => {
    const epLink = $(el).attr('href') || '';
    const text = $(el).text().trim() || $(el).find('*').text().trim();
    const match = text.match(/\d+/) || epLink.match(/episode[- ]?(\d+)/i);
    const epNum = match ? parseInt(match[match.length === 1 ? 0 : 1]) : 0;
    if (epLink && epNum > 0 && !seenEp.has(epNum)) {
      seenEp.add(epNum);
      episodes.push({ epNum, url: epLink });
    }
  });

  // Fallback: numbered list items
  if (episodes.length === 0) {
    $('li').each((_, el) => {
      const a = $(el).find('a').first();
      const link = a.attr('href') || '';
      if (!link || link.includes('/anime/')) return;
      const numText = $(el).find('[class*="ep"], [class*="num"], [class*="ep-num"]').text().trim() ||
                      a.text().trim();
      const epNum = parseInt(numText.match(/\d+/)?.[0] || '0');
      if (epNum > 0 && !seenEp.has(epNum)) {
        seenEp.add(epNum);
        episodes.push({ epNum, url: link });
      }
    });
  }

  episodes.sort((a, b) => a.epNum - b.epNum);
  return { title, poster, status, description, episodes };
}

// ---------------------------------------------------------------------------
// ID helpers — use pipe | instead of colon to avoid Express param splitting
// ---------------------------------------------------------------------------
function makeId(slug) {
  // Stremio IDs can't have colons reliably in URL paths — use pipe character
  return `animekhor|${slug}`;
}
function slugFromId(id) {
  return id.replace(/^animekhor[|:]/, '');
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
    version: '1.1.0',
    name: 'AnimeKhor Donghua',
    description: 'Full catalog of Chinese donghua from AnimeKhor.org — each season is its own entry.',
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
// CATALOG helpers
// ---------------------------------------------------------------------------
async function getOngoing() {
  const cached = getCache('ongoing');
  if (cached) return cached;

  // Try a few URL patterns AnimeKhor might use
  const urls = [
    `${BASE_URL}/donghua-series/?status=Ongoing&order=latest`,
    `${BASE_URL}/ongoing-donghua/`,
    `${BASE_URL}/?status=Ongoing`,
  ];

  for (const url of urls) {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      const cards = parseSeriesCards($, 'body');
      if (cards.length > 0) {
        const metas = cards.map(s => ({
          id: makeId(s.slug),
          type: 'series',
          name: s.title,
          poster: s.poster,
          posterShape: 'poster'
        }));
        setCache('ongoing', metas);
        return metas;
      }
    } catch (e) {
      console.error(`getOngoing failed for ${url}:`, e.message);
    }
  }
  return [];
}

// Background scrape flag — prevents multiple simultaneous full scrapes
let scrapeInProgress = false;

async function getAllSeries(searchQuery) {
  // Search takes priority — hit the site's own search endpoint
  if (searchQuery) {
    try {
      const url = `${BASE_URL}/?s=${encodeURIComponent(searchQuery)}`;
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      return parseSeriesCards($, 'body').map(s => ({
        id: makeId(s.slug),
        type: 'series',
        name: s.title,
        poster: s.poster,
        posterShape: 'poster'
      }));
    } catch (e) {
      console.error('Search error:', e.message);
      return [];
    }
  }

  // Full catalog — memory first, disk second, then scrape
  const memCached = getCache('all_series');
  if (memCached) return memCached;

  const disk = loadFromDisk();
  if (disk && disk.length > 0) {
    setCache('all_series', disk);
    return disk;
  }

  // If a scrape is already running, return empty (Stremio will retry)
  if (scrapeInProgress) return [];

  // Kick off the scrape; return empty immediately so Stremio doesn't timeout
  scrapeInProgress = true;
  scrapeAllLetters().finally(() => { scrapeInProgress = false; });
  return [];
}

async function scrapeAllLetters() {
  console.log('Starting full A-Z scrape…');
  const letters = ['0-9', ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')];
  const all = [];
  const seen = new Set();

  for (const letter of letters) {
    let page = 1;
    let hasNext = true;
    while (hasNext && page <= 15) {
      try {
        const result = await scrapeAZPage(letter, page);
        for (const s of result.series) {
          if (!seen.has(s.slug)) {
            seen.add(s.slug);
            all.push({
              id: makeId(s.slug),
              type: 'series',
              name: s.title,
              poster: s.poster,
              posterShape: 'poster'
            });
          }
        }
        hasNext = result.hasNext;
        page++;
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        console.error(`A-Z scrape error [${letter} p${page}]:`, e.message);
        hasNext = false;
      }
    }
  }

  console.log(`A-Z scrape complete — ${all.length} series found.`);
  setCache('all_series', all);
  saveToDisk(all);
  return all;
}

// ---------------------------------------------------------------------------
// CATALOG route
// Stremio calls both:
//   /catalog/series/animekhor_all.json
//   /catalog/series/animekhor_all/search=foo.json
//   /catalog/series/animekhor_all/skip=20.json
// Express doesn't handle the second form by default — we capture it with a
// wildcard and parse it ourselves.
// ---------------------------------------------------------------------------
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { type, id, extra } = req.params;

  // Parse Stremio "extra" path segment like "search=Naruto" or "skip=20"
  let search = req.query.search || '';
  let skip = parseInt(req.query.skip || '0');
  if (extra) {
    const parts = extra.split('&');
    for (const part of parts) {
      const [k, v] = part.split('=');
      if (k === 'search') search = decodeURIComponent(v || '');
      if (k === 'skip') skip = parseInt(v || '0');
    }
  }

  const PAGE_SIZE = 20;

  try {
    let metas = [];

    if (id === 'animekhor_ongoing') {
      metas = await getOngoing();
    } else if (id === 'animekhor_all') {
      metas = await getAllSeries(search);
    }

    // Client-side filter only for non-search (search path already filtered server-side)
    if (search && id === 'animekhor_ongoing') {
      const q = search.toLowerCase();
      metas = metas.filter(m => m.name.toLowerCase().includes(q));
    }

    const page = metas.slice(skip, skip + PAGE_SIZE);
    res.json({ metas: page });
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
  const slug = slugFromId(rawId);

  try {
    const data = await scrapeAnimePage(slug);

    const videos = data.episodes.map(ep => ({
      id: `${rawId}:${ep.epNum}`,
      title: `Episode ${ep.epNum}`,
      season: 1,
      episode: ep.epNum,
      released: new Date(0).toISOString(), // use epoch so Stremio doesn't hide future eps
      overview: `Episode ${ep.epNum} of ${data.title}`
    }));

    res.json({
      meta: {
        id: rawId,
        type: 'series',
        name: data.title,
        poster: data.poster,
        description: data.description,
        status: data.status,
        videos,
        posterShape: 'poster'
      }
    });
  } catch (e) {
    console.error('Meta error:', e.message);
    res.json({ meta: null });
  }
});

// ---------------------------------------------------------------------------
// STREAM
// The video ID is  animekhor|slug:epNum
// ---------------------------------------------------------------------------
app.get('/stream/:type/:id.json', async (req, res) => {
  const fullId = req.params.id; // e.g. animekhor|the-demon-hunter-s3:5

  // Split off the episode number (last colon-separated segment)
  const lastColon = fullId.lastIndexOf(':');
  if (lastColon === -1) return res.json({ streams: [] });

  const epNum = parseInt(fullId.slice(lastColon + 1));
  const animeId = fullId.slice(0, lastColon);
  const slug = slugFromId(animeId);

  try {
    const data = await scrapeAnimePage(slug);
    const ep = data.episodes.find(e => e.epNum === epNum);

    if (!ep) return res.json({ streams: [] });

    res.json({
      streams: [
        {
          title: '🌐 Watch on AnimeKhor',
          externalUrl: ep.url,
          behaviorHints: { notWebReady: true }
        }
      ]
    });
  } catch (e) {
    console.error('Stream error:', e.message);
    res.json({ streams: [] });
  }
});

// ---------------------------------------------------------------------------
// Health / warm-up endpoint
// Call GET /warmup to kick off the full catalog scrape manually
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    message: 'AnimeKhor Stremio Catalog Addon',
    install: `${req.protocol}://${req.get('host')}/manifest.json`,
    catalog_ready: !!getCache('all_series') || fs.existsSync(DISK_CACHE_PATH)
  });
});

app.get('/warmup', async (req, res) => {
  if (scrapeInProgress) {
    return res.json({ status: 'scrape already in progress' });
  }
  if (getCache('all_series')) {
    return res.json({ status: 'cache already warm', count: getCache('all_series').length });
  }
  scrapeInProgress = true;
  scrapeAllLetters().finally(() => { scrapeInProgress = false; });
  res.json({ status: 'scrape started — check back in a few minutes' });
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`AnimeKhor addon running on port ${PORT}`);
  console.log(`Install URL: http://localhost:${PORT}/manifest.json`);

  // Auto-warm the cache on startup using disk if available
  const disk = loadFromDisk();
  if (disk && disk.length > 0) {
    setCache('all_series', disk);
    console.log(`Loaded ${disk.length} series from disk cache.`);
  }
});
