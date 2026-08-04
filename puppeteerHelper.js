const fs = require('fs');
const path = require('path');

/**
 * Returns the path to the Chrome binary downloaded by Puppeteer in the user's cache directory.
 * Returns undefined to fall back to Puppeteer's automatic resolution.
 */
function getChromePath() {
  const defaultPath = 'C:\\Users\\hashi\\.cache\\puppeteer\\chrome\\win64-151.0.7922.71\\chrome-win64\\chrome.exe';
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  try {
    const baseDir = 'C:\\Users\\hashi\\.cache\\puppeteer\\chrome';
    if (fs.existsSync(baseDir)) {
      const versions = fs.readdirSync(baseDir);
      for (const ver of versions) {
        const fullPath = path.join(baseDir, ver, 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      }
    }
  } catch (_) {}
  return undefined;
}

module.exports = { getChromePath };
