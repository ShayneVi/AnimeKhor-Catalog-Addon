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
const CACHE_TTL = 30 * 60 * 1000;
const EPISODE_CACHE_TTL = 10 * 60 * 1000;
const DISK_CACHE_PATH = path.join('/tmp', 'animekhor_all.json');

function setCache(key, value, ttl = CACHE_TTL) {
  cache.set(key, { value, expires: Date.now() + ttl });
}
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.value;
}
function saveToDisk(data) {
  try { fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify(data)); } catch (_) {}
}
function loadFromDisk() {
  try {
    if (fs.existsSync(DISK_CACHE_PATH)) return JSON.parse(fs.readFileSync(DISK_CACHE_PATH, 'utf8'));
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
async function fetchHTML(url) {
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
  setCache(url, html);
  return html;
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------
function makeId(slug) { return `animekhor|${slug}`; }
function slugFromId(id) { return id.replace(/^animekhor[|:]/, ''); }

// ---------------------------------------------------------------------------
// Parse series cards from a listing page (sidebar already removed by caller)
// ---------------------------------------------------------------------------
function parseSeriesCards($) {
  const results = [];
  const seen = new Set();

  function add(link, title, poster) {
    if (!link || !title || seen.has(link) || !link.includes('/anime/')) return;
    seen.add(link);
    const fullLink = link.startsWith('http') ? link : `${BASE_URL}${link}`;
    const slug = fullLink.replace(BASE_URL, '').replace(/^\/anime\//, '').replace(/\/$/, '');
    if (slug) results.push({ slug, title: title.trim(), poster: poster || '' });
  }

  // Card-based layouts
  $('article, .bs, .bsx, .flw-item').each((_, el) => {
    const a = $(el).find('a[href*="/anime/"]').first();
    const title =
      $(el).find('h2, h3, .title, .tt, .titleCont, .animename').first().text().trim() ||
      a.attr('title') || $(el).find('img').attr('alt') || '';
    const img = $(el).find('img').first();
    const poster = img.attr('data-lazy-src') || img.attr('data-src') || img.attr('src') || '';
    add(a.attr('href') || '', title, poster);
  });

  // Fallback: bare anchor links
  if (results.length === 0) {
    $('a[href*="/anime/"]').each((_, el) => {
      const img = $(el).find('img').first();
      const title = $(el).attr('title') || img.attr('alt') || img.attr('title') || $(el).text().trim();
      const poster = img.attr('data-lazy-src') || img.attr('data-src') || img.attr('src') || '';
      add($(el).attr('href') || '', title, poster);
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scrape anime detail page for episodes
//
// KEY FIX: We remove the entire sidebar before parsing so that "Popular Series"
// links (which show episode counts like "Episode 652") are never mistaken for
// this show's own episodes.
//
// AnimeKhor's episode table (confirmed from screenshot):
//   Ep | Title | Release Date
//   Each row links to /anime/slug/episode-N/
// ---------------------------------------------------------------------------
async function scrapeAnimePage(slug) {
  const url = `${BASE_URL}/anime/${slug}/`;
  const cacheKey = `anime_${slug}`;
  const cached = getCache(cacheKey);
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
    setCache(cacheKey, html, EPISODE_CACHE_TTL);
  }

  const $ = cheerio.load(html);

  // ---- CRITICAL: nuke the sidebar before anything else ----
  $('aside, .sidebar, #sidebar, [class*="sidebar"], [id*="sidebar"]').remove();
  $('[class*="popular"], [class*="history"], [class*="widget"], .epz_last, .releases').remove();

  // ---- Metadata ----
  const title = $('h1').first().text().trim();
  const poster =
    $('.thumb img, .poster img, .film-poster img, .animeposter img')
      .first().attr('src') ||
    $('img[class*="poster"], img[class*="thumb"]').first().attr('src') || '';
  const description =
    $('[class*="synopsis"] p, [class*="entry-content"] > p, div.synp p, [class*="desc"] > p')
      .first().text().trim() || '';
  const status =
    $('span.statuson, span:contains("Ongoing"), span:contains("Completed")')
      .first().text().trim() || '';

  // ---- Episodes ----
  const episodes = [];
  const seenEp = new Set();

  function addEp(epNum, epUrl, releaseDate) {
    if (epNum > 0 && !seenEp.has(epNum)) {
      seenEp.add(epNum);
      const fullUrl = epUrl.startsWith('http') ? epUrl : `${BASE_URL}${epUrl}`;
      episodes.push({ epNum, url: fullUrl, releaseDate: releaseDate || null });
    }
  }

  // Strategy 1: Table rows — Ep | Title | Release Date
  $('table tr, tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const epNum = parseInt($(cells[0]).text().trim());
    if (isNaN(epNum) || epNum <= 0) return;

    const link = $(row).find('a').first().attr('href') || '';
    // Verify this link actually goes to an episode page
    if (!link.match(/episode/i)) return;

    const releaseTd = cells.length >= 3 ? $(cells[2]).text().trim() : $(cells[cells.length - 1]).text().trim();
    const releaseDate = releaseTd !== String(epNum) ? releaseTd : null;
    addEp(epNum, link, releaseDate);
  });

  // Strategy 2: Links containing "episode-N" in this show's URL space
  if (episodes.length === 0) {
    // The episode URLs will contain the show slug
    const slugCore = slug.replace(/-cang-yuan-tu.*|-season-\d+.*/i, '').split('-').slice(0, 3).join('-');
    $('a[href*="episode"]').each((_, el) => {
      const link = $(el).attr('href') || '';
      // Must reference an episode URL pattern like /episode-5/ or /episode-5
      const urlEpMatch = link.match(/\/episode[-\s]?(\d+)\/?$/i);
      if (!urlEpMatch) return;
      const epNum = parseInt(urlEpMatch[1]);
      addEp(epNum, link, null);
    });
  }

  // Strategy 3: Build from range if we can detect first + latest episode buttons
  if (episodes.length === 0) {
    const epLinks = [];
    $('a[href*="episode"]').each((_, el) => {
      epLinks.push($(el).attr('href') || '');
    });
    // Find the highest episode number from any episode link on the page
    let maxEp = 0;
    let baseUrl = '';
    for (const link of epLinks) {
      const m = link.match(/\/episode[-\s]?(\d+)\/?$/i);
      if (m) {
        const n = parseInt(m[1]);
        if (n > maxEp) { maxEp = n; baseUrl = link.replace(/episode[-\s]?\d+\/?$/i, ''); }
      }
    }
    if (maxEp > 0 && maxEp <= 500) { // sanity cap
      for (let i = 1; i <= maxEp; i++) {
        addEp(i, `${baseUrl}episode-${i}/`, null);
      }
    }
  }

  episodes.sort((a, b) => a.epNum - b.epNum);
  console.log(`scrapeAnimePage("${slug}"): title="${title}", episodes=${episodes.length}`);
  return { title, poster, status, description, episodes };
}

// ---------------------------------------------------------------------------
// Scrape A-Z page
// ---------------------------------------------------------------------------
async function scrapeAZPage(letter, page = 1) {
  const url = page === 1
    ? `${BASE_URL}/a-z-lists/?show=${letter}`
    : `${BASE_URL}/a-z-lists/page/${page}/?show=${letter}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  $('aside, .sidebar, #sidebar, [class*="sidebar"]').remove();
  const series = parseSeriesCards($);
  const hasNext = $('a.next, a[rel="next"]').length > 0 || $('a:contains("Next")').length > 0;
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
    version: '1.2.0',
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
// ---------------------------------------------------------------------------
async function getOngoing() {
  const cached = getCache('ongoing');
  if (cached) return cached;

  for (const url of [
    `${BASE_URL}/donghua-series/?status=Ongoing&order=latest`,
    `${BASE_URL}/ongoing/`,
    `${BASE_URL}/?status=Ongoing`,
  ]) {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      $('aside, .sidebar, #sidebar, [class*="sidebar"]').remove();
      const cards = parseSeriesCards($);
      if (cards.length > 0) {
        const metas = cards.map(s => ({
          id: makeId(s.slug), type: 'series', name: s.title, poster: s.poster, posterShape: 'poster'
        }));
        setCache('ongoing', metas);
        return metas;
      }
    } catch (e) { console.error(`getOngoing ${url}:`, e.message); }
  }
  return [];
}

// ---------------------------------------------------------------------------
// All series
// ---------------------------------------------------------------------------
let scrapeInProgress = false;

async function getAllSeries(searchQuery) {
  if (searchQuery) {
    try {
      const url = `${BASE_URL}/?s=${encodeURIComponent(searchQuery)}`;
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      $('aside, .sidebar, #sidebar, [class*="sidebar"]').remove();
      return parseSeriesCards($).map(s => ({
        id: makeId(s.slug), type: 'series', name: s.title, poster: s.poster, posterShape: 'poster'
      }));
    } catch (e) { console.error('Search error:', e.message); return []; }
  }

  const memCached = getCache('all_series');
  if (memCached) return memCached;

  const disk = loadFromDisk();
  if (disk && disk.length > 0) {
    setCache('all_series', disk);
    return disk;
  }

  // Start background scrape; return ongoing as visible placeholder
  if (!scrapeInProgress) {
    scrapeInProgress = true;
    scrapeAllLetters().finally(() => { scrapeInProgress = false; });
  }
  console.log('Full catalog not ready yet — serving ongoing as placeholder');
  return getOngoing();
}

async function scrapeAllLetters() {
  console.log('A-Z scrape starting…');
  const letters = ['0-9', ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')];
  const all = [];
  const seen = new Set();

  for (const letter of letters) {
    let page = 1, hasNext = true;
    while (hasNext && page <= 15) {
      try {
        const result = await scrapeAZPage(letter, page);
        for (const s of result.series) {
          if (!seen.has(s.slug)) {
            seen.add(s.slug);
            all.push({ id: makeId(s.slug), type: 'series', name: s.title, poster: s.poster, posterShape: 'poster' });
          }
        }
        hasNext = result.hasNext;
        page++;
        await new Promise(r => setTimeout(r, 400));
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
// CATALOG route — handles Stremio's extra-in-path format
// ---------------------------------------------------------------------------
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { id, extra } = req.params;
  let search = req.query.search || '';
  let skip = parseInt(req.query.skip || '0');

  if (extra) {
    for (const part of extra.split('&')) {
      const [k, v] = part.split('=');
      if (k === 'search') search = decodeURIComponent(v || '');
      if (k === 'skip') skip = parseInt(v || '0');
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
  const slug = slugFromId(rawId);

  try {
    const data = await scrapeAnimePage(slug);
    if (!data.title) return res.json({ meta: null });

    const videos = data.episodes.map(ep => {
      let released = new Date(0).toISOString();
      if (ep.releaseDate) {
        const parsed = new Date(ep.releaseDate);
        if (!isNaN(parsed.getTime())) released = parsed.toISOString();
      }
      return {
        id: `${rawId}:${ep.epNum}`,
        title: `Episode ${ep.epNum}`,
        season: 1,
        episode: ep.epNum,
        released,
        overview: `Episode ${ep.epNum} of ${data.title}`
      };
    });

    res.json({
      meta: {
        id: rawId, type: 'series', name: data.title, poster: data.poster,
        description: data.description, status: data.status, videos, posterShape: 'poster'
      }
    });
  } catch (e) {
    console.error('Meta error:', e.message);
    res.json({ meta: null });
  }
});

// ---------------------------------------------------------------------------
// STREAM
// ---------------------------------------------------------------------------
app.get('/stream/:type/:id.json', async (req, res) => {
  const fullId = req.params.id;
  const lastColon = fullId.lastIndexOf(':');
  if (lastColon === -1) return res.json({ streams: [] });

  const epNum = parseInt(fullId.slice(lastColon + 1));
  const slug = slugFromId(fullId.slice(0, lastColon));

  try {
    const data = await scrapeAnimePage(slug);
    const ep = data.episodes.find(e => e.epNum === epNum);
    if (!ep) return res.json({ streams: [] });

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
// Utility routes
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    message: 'AnimeKhor Stremio Addon v1.2',
    install: `${req.protocol}://${req.get('host')}/manifest.json`,
    catalog_ready: !!getCache('all_series') || fs.existsSync(DISK_CACHE_PATH),
    scrape_in_progress: scrapeInProgress
  });
});

app.get('/warmup', async (req, res) => {
  if (scrapeInProgress) return res.json({ status: 'already running' });
  if (getCache('all_series')) return res.json({ status: 'warm', count: getCache('all_series').length });
  scrapeInProgress = true;
  scrapeAllLetters().finally(() => { scrapeInProgress = false; });
  res.json({ status: 'started' });
});

// Debug: test episode scraping directly
// e.g. GET /debug/meta/the-demon-hunter-season-3-cang-yuan-tu-season-3
app.get('/debug/meta/:slug', async (req, res) => {
  try {
    const data = await scrapeAnimePage(req.params.slug);
    res.json(data);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`AnimeKhor addon on port ${PORT}`);
  const disk = loadFromDisk();
  if (disk && disk.length > 0) {
    setCache('all_series', disk);
    console.log(`Loaded ${disk.length} series from disk.`);
  }
});
