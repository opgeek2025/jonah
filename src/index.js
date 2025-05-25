// @ts-check
const { chromium, firefox, webkit } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// apply stealth
chromium.use(StealthPlugin());
firefox.use(StealthPlugin());
webkit.use(StealthPlugin());

/**
 * Parse the YouTube captions JSON3 payload into {start,dur,text}[]
 */
function parseEvents(events) {
  return events
    .filter(e => e.segs)
    .map(e => ({
      start: e.tStartMs / 1000,
      dur:   (e.dDurationMs || 0) / 1000,
      text:  e.segs.map(s => s.utf8 || s.text || '').join('').trim(),
    }));
}

(async () => {
  const videoID = 'f4cdu-QiKHo';

  for (const browserType of [chromium, firefox, webkit]) {
    const browser = await browserType.launch({ headless: false });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/114.0.5735.199 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      viewport: { width: 1280, height: 720 },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins',   { get: () => [1,2,3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    });

    const page = await context.newPage();

    // 1) Set up the interceptor
    const captionResponsePromise = page.waitForResponse(response =>
      response.url().includes('/api/timedtext') &&
      response.url().includes('fmt=json3') &&
      response.status() === 200
    );

    // 2) Navigate with captions forced on
    await page.goto(`https://www.youtube.com/watch?v=${videoID}&cc_load_policy=1`);
    await page.waitForSelector('button.ytp-large-play-button', { timeout: 7000 });
    await page.click('button.ytp-large-play-button');

    // 3) Grab and parse the captions
    const captionResponse = await captionResponsePromise;
    const payload = await captionResponse.json();
    const captions = parseEvents(payload.events);

    // 4) Write to JSON file
    const outDir = path.resolve(__dirname, '..', 'captions');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(
      outDir,
      `captions-${videoID}-${browserType.name()}.json`
    );
    fs.writeFileSync(outPath, JSON.stringify(captions, null, 2), 'utf-8');
    console.log(`✔ Saved ${captions.length} captions to ${outPath}`);

    // 5) (Optional) take screenshot
    await page.screenshot({ path: `example-${browserType.name()}.png` });

    await browser.close();
  }
})();
