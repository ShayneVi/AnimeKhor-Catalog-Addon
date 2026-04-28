const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://animekhor.org';

// Simple in-memory cache to avoid hammering AnimeKhor
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function setCache(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL });
}
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.value;
}

// Fetch HTML helper
async function fetchHTML(url) {
  const cached = getCache(url);
  if (cached) return cached;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StremioAddon/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  setCache(url, html);
  return html;
}

// Scrape all series from A-Z listing for a given letter
async function scrapeAZPage(letter, page = 1) {
  const url = page === 1
    ? `${BASE_URL}/a-z-lists/?show=${letter}`
    : `${BASE_URL}/a-z-lists/page/${page}/?show=${letter}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const series = [];

  $('.film-poster, .flw-item, article, .bs').each((_, el) => {
    const link = $(el).find('a').first().attr('href');
    const title = $(el).find('h2, .title, .tt').first().text().trim() ||
                  $(el).find('img').attr('title') || '';
    const poster = $(el).find('img').attr('src') ||
                   $(el).find('img').attr('data-src') || '';
    if (link && link.includes('/anime/') && title) {
      const id = link.replace(BASE_URL, '').replace('/anime/', '').replace(/\//g, '');
      series.push({ id, title, poster, link });
    }
  });

  // Check for next page
  const hasNext = $('a:contains("Next")').length > 0 ||
                  $('a.next').length > 0 ||
                  $(`.page-numbers:contains("${page + 1}")`).length > 0;

  return { series, hasNext };
}

// Scrape anime detail page for episode list
async function scrapeAnimePage(slug) {
  const url = `${BASE_URL}/anime/${slug}/`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const title = $('h1').first().text().trim();
  const poster = $('.film-poster img, .thumb img, .detail_page-infor img').first().attr('src') || '';
  const status = $('*:contains("Status:")').filter((_, el) => $(el).children().length === 0)
    .first().text().replace('Status:', '').trim() ||
    $('span:contains("Ongoing"), span:contains("Completed")').first().text().trim();
  const description = $('.entry-content p, .synopsis p, .desc').first().text().trim();

  const episodes = [];
  // Episode links are list items with a link
  $('ul li a[href*="episode"], .eps-item a, .episodeList a').each((_, el) => {
    const epLink = $(el).attr('href') || '';
    const epText = $(el).find('.ep-num, .num').text().trim() ||
                   $(el).text().trim();
    const epNum = parseInt(epText.match(/\d+/)?.[0] || '0');
    if (epLink && epNum > 0) {
      episodes.push({ epNum, url: epLink });
    }
  });

  // Fallback: look for the episode table rows
  if (episodes.length === 0) {
    $('li').each((_, el) => {
      const link = $(el).find('a').attr('href') || '';
      const numEl = $(el).find('[class*="ep"], [class*="num"]').first().text().trim();
      const epNum = parseInt(numEl || '0');
      if (link.includes('/') && epNum > 0 && !link.includes('/anime/')) {
        episodes.push({ epNum, url: link });
      }
    });
  }

  episodes.sort((a, b) => a.epNum - b.epNum);
  return { title, poster, status, description, episodes };
}

// Build Stremio ID from slug
function makeId(slug) {
  return `animekhor:${slug}`;
}
function slugFromId(id) {
  return id.replace('animekhor:', '');
}

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// --- MANIFEST ---
app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.animekhor.catalog',
    version: '1.0.0',
    name: 'AnimeKhor Donghua',
    description: 'Full catalog of Chinese donghua (anime) from AnimeKhor.org, with all seasons tracked separately.',
    logo: 'https://animekhor.org/wp-content/uploads/2021/11/AnimeKhor_darkmode.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    catalogs: [
      {
        type: 'series',
        id: 'animekhor_ongoing',
        name: 'AnimeKhor – Ongoing',
        extra: [{ name: 'search', isRequired: false }, { name: 'skip' }]
      },
      {
        type: 'series',
        id: 'animekhor_all',
        name: 'AnimeKhor – All Donghua',
        extra: [{ name: 'search', isRequired: false }, { name: 'skip' }]
      }
    ],
    behaviorHints: { adult: false, p2p: false }
  });
});

// --- CATALOG ---
// Scrape "Ongoing" from sidebar or donghua-series page
async function getOngoing() {
  const cached = getCache('ongoing');
  if (cached) return cached;

  const html = await fetchHTML(`${BASE_URL}/donghua-series/?status=Ongoing&order=latest`);
  const $ = cheerio.load(html);
  const metas = [];

  $('article, .bs, .flw-item').each((_, el) => {
    const link = $(el).find('a').attr('href') || '';
    const title = $(el).find('h2, .title, .tt').first().text().trim() ||
                  $(el).find('img').attr('title') || '';
    const poster = $(el).find('img').attr('src') ||
                   $(el).find('img').attr('data-src') || '';
    if (link.includes('/anime/') && title) {
      const slug = link.replace(BASE_URL, '').replace(/^\/anime\//, '').replace(/\/$/, '');
      metas.push({
        id: makeId(slug),
        type: 'series',
        name: title,
        poster,
        posterShape: 'poster'
      });
    }
  });

  setCache('ongoing', metas);
  return metas;
}

// Scrape all series from A-Z (paginated, all letters)
async function getAllSeries(searchQuery) {
  const letters = ['0-9', ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')];
  const all = [];

  // If searching, just do a direct search instead
  if (searchQuery) {
    try {
      const url = `${BASE_URL}/?s=${encodeURIComponent(searchQuery)}`;
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      $('article, .bs, .flw-item').each((_, el) => {
        const link = $(el).find('a').attr('href') || '';
        const title = $(el).find('h2, .title, .tt').first().text().trim() ||
                      $(el).find('img').attr('title') || '';
        const poster = $(el).find('img').attr('src') ||
                       $(el).find('img').attr('data-src') || '';
        if (link.includes('/anime/') && title) {
          const slug = link.replace(BASE_URL, '').replace(/^\/anime\//, '').replace(/\/$/, '');
          all.push({ id: makeId(slug), type: 'series', name: title, poster, posterShape: 'poster' });
        }
      });
      return all;
    } catch (e) {
      console.error('Search error:', e.message);
      return [];
    }
  }

  // Full A-Z scrape (cached as full list)
  const fullCached = getCache('all_series');
  if (fullCached) return fullCached;

  for (const letter of letters) {
    let page = 1;
    let hasNext = true;
    while (hasNext && page <= 10) {
      try {
        const result = await scrapeAZPage(letter, page);
        for (const s of result.series) {
          all.push({
            id: makeId(s.id),
            type: 'series',
            name: s.title,
            poster: s.poster,
            posterShape: 'poster'
          });
        }
        hasNext = result.hasNext;
        page++;
        await new Promise(r => setTimeout(r, 300)); // be polite
      } catch (e) {
        console.error(`Error scraping letter ${letter} page ${page}:`, e.message);
        hasNext = false;
      }
    }
  }

  setCache('all_series', all);
  return all;
}

app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const search = req.query.search || '';
  const skip = parseInt(req.query.skip || '0');
  const PAGE_SIZE = 20;

  try {
    let metas = [];

    if (id === 'animekhor_ongoing') {
      metas = await getOngoing();
    } else if (id === 'animekhor_all') {
      metas = await getAllSeries(search);
    }

    if (search) {
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

// --- META ---
app.get('/meta/:type/:id.json', async (req, res) => {
  const { id } = req.params;
  const slug = slugFromId(id);

  try {
    const data = await scrapeAnimePage(slug);
    const videos = data.episodes.map(ep => ({
      id: `${id}:${ep.epNum}`,
      title: `Episode ${ep.epNum}`,
      season: 1,
      episode: ep.epNum,
      released: new Date().toISOString(),
      overview: `Episode ${ep.epNum} of ${data.title}`
    }));

    res.json({
      meta: {
        id,
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

// --- STREAM ---
// AnimeKhor streams the video on the episode page — we return the page URL as an external link
// The existing AnimeKhor Stremio addon handles actual video extraction;
// this catalog addon's job is just to provide correct metadata so the right episode URL is found.
app.get('/stream/:type/:id.json', async (req, res) => {
  const fullId = req.params.id; // e.g. animekhor:the-demon-hunter-season-3-...:5
  const parts = fullId.split(':');
  const epNum = parts[parts.length - 1];
  const slug = parts.slice(0, parts.length - 1).join(':').replace('animekhor:', '');

  try {
    const data = await scrapeAnimePage(slug);
    const ep = data.episodes.find(e => e.epNum === parseInt(epNum));

    if (!ep) {
      return res.json({ streams: [] });
    }

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

// Health check
app.get('/', (req, res) => {
  res.json({
    message: 'AnimeKhor Stremio Catalog Addon',
    install: `${req.protocol}://${req.get('host')}/manifest.json`
  });
});

app.listen(PORT, () => {
  console.log(`AnimeKhor addon running on port ${PORT}`);
  console.log(`Install URL: http://localhost:${PORT}/manifest.json`);
});
