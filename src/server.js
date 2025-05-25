// src/server.js
// @ts-check
const express      = require('express');
const fs           = require('fs').promises;
const path         = require('path');
const axios        = require('axios');
const winston      = require('winston');
const { chromium } = require('playwright');
const { XMLParser }= require('fast-xml-parser');

const app      = express();
const PORT     = process.env.PORT || 3000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                   'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                   'Chrome/114.0.0.0 Safari/537.36';

// Logger setup: writes to file and console
const logDir = path.resolve(__dirname, '..', 'logs');
fs.mkdir(logDir, { recursive: true }).catch(() => {});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'server.log') }),
    new winston.transports.Console()
  ]
});

// Launch a single browser instance at startup
let browser;
(async () => {
  browser = await chromium.launch({ headless: true });
  logger.info('Browser launched');
})();

// XML parser instance (reusable)
const parser = new XMLParser({ ignoreAttributes: false });

// In-memory cache for captions: { '<videoID>_<lang>': { timestamp, data } }
const captionCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

app.use(express.json());
app.use((req, res, next) => {
  logger.info(`=== ${req.method} ${req.originalUrl}`);
  next();
});

/**
 * Parse XML captions into [{start,dur,text},...]
 */
function parseXmlTranscript(xmlString) {
  const json  = parser.parse(xmlString);
  const texts = (json.transcript && json.transcript.text) || [];
  return texts.map(node => ({
    start: parseFloat(node['@_start']) || 0,
    dur:   parseFloat(node['@_dur'])   || 0,
    text:  (node['#text'] || '').trim(),
  }));
}

/**
 * Scrape captionTracks from YouTube page using a fresh browser context
 */
async function getCaptionTracks(videoID) {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  const page = await context.newPage();

  await page.waitForTimeout(500 + Math.random() * 1000);
  await page.goto(`https://www.youtube.com/watch?v=${videoID}`, { waitUntil: 'networkidle' });

  const tracks = await page.evaluate(() => {
    try {
      const pr = window.ytInitialPlayerResponse;
      return pr.captions.playerCaptionsTracklistRenderer.captionTracks.map(t => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode
      }));
    } catch {
      return [];
    }
  });

  await context.close();
  return tracks;
}

/**
 * Take a screenshot of the video page
 */
async function takeScreenshot(videoID, lang) {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  await page.waitForTimeout(500 + Math.random() * 1000);
  await page.goto(`https://www.youtube.com/watch?v=${videoID}`, { waitUntil: 'networkidle' });
  await page.click('button.ytp-large-play-button').catch(() => {});
  await page.waitForTimeout(1000);

  const screenshotDir = path.resolve(__dirname, '..', 'screenshots');
  await fs.mkdir(screenshotDir, { recursive: true });
  const shotPath = path.join(screenshotDir, `shot_${videoID}_${lang}_${Date.now()}.png`);
  await page.screenshot({ path: shotPath });

  await context.close();
  return shotPath;
}

/**
 * /captions endpoint: tries each available track URL until it finds non-empty captions
 * Supports `nocache=true` to bypass both cache reads and writes.
 */
app.get('/captions', async (req, res) => {
  const videoID   = req.query.video;
  const lang      = req.query.lang || 'en';
  const wantShot  = req.query.screenshot === 'true';
  const noCache   = req.query.nocache === 'true';

  if (!videoID) {
    logger.warn('`video` query parameter missing');
    return res.status(400).json({ error: '`video` query parameter required' });
  }

  const cacheKey = `${videoID}_${lang}`;
  if (!noCache) {
    const cached = captionCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      logger.info(`Cache hit for ${cacheKey}`);
      return res.json(cached.data);
    }
  }

  try {
    const tracks = await getCaptionTracks(videoID);
    let captions = [];
    let successfulTrack = null;

    for (let t of tracks) {
      // Only consider tracks matching the requested language
      if (t.languageCode !== lang && !t.languageCode.startsWith(lang)) continue;

      const url = t.baseUrl;
      logger.info(`Trying captions URL: ${url}`);
      try {
        const resp = await axios.get(url, {
          timeout: 10000,
          headers: { 'User-Agent': USER_AGENT }
        });

        const parsed = parseXmlTranscript(resp.data);
        if (parsed.length > 0) {
          captions = parsed;
          successfulTrack = t;
          logger.info(`✔️ Picked ${url} with ${parsed.length} lines`);
          break;
        } else {
          logger.info(`– Empty transcript from ${url}, skipping`);
        }
      } catch (err) {
        logger.warn(`– Error fetching ${url}: ${err.message}`);
      }
    }

    if (!successfulTrack) logger.warn('No captionTracks produced any data');

    const result = { video: videoID, lang, captions };
    if (wantShot) {
      try {
        result.screenshot = await takeScreenshot(videoID, lang);
      } catch (shotErr) {
        logger.error(`Screenshot error: ${shotErr.message}`);
      }
    }

    // only cache if caching is allowed
    if (!noCache) {
      captionCache.set(cacheKey, { timestamp: Date.now(), data: result });
    }

    res.json(result);
  } catch (err) {
    logger.error(`Error in /captions: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  logger.info(`API listening on port ${PORT}`);
});
