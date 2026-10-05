// puppeteerHelper.js — one shared headless Chrome for SVG renders and PDF builds.
// Launching Chrome costs ~1s each time; a lesson can trigger a dozen renders.
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

/**
 * Path to a Chrome binary in Puppeteer's cache, or undefined to let Puppeteer
 * resolve its own (it normally can; this covers a cache/version mismatch).
 */
function getChromePath() {
  try {
    const baseDir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
    if (!fs.existsSync(baseDir)) return undefined;
    const versions = fs.readdirSync(baseDir).sort().reverse(); // newest first
    for (const ver of versions) {
      const fullPath = path.join(baseDir, ver, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(fullPath)) return fullPath;
    }
  } catch (_) {}
  return undefined;
}

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath: getChromePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    }).then((browser) => {
      // If Chrome crashes or is closed, launch a fresh one on next use.
      browser.on('disconnected', () => { browserPromise = null; });
      return browser;
    }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/**
 * Runs fn(page) on a fresh page in the shared browser; the page is always closed afterwards.
 */
async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    await (await pending).close();
  } catch (_) {}
}

module.exports = { getChromePath, getBrowser, withPage, closeBrowser };
