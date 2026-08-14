// imageGenerator.js — handles SVG generation and web image search fallback via Puppeteer
const fs = require('fs');
const path = require('path');
const http = require('http');
const { generate, generateFast } = require('./ollama');
const { getChromePath } = require('./puppeteerHelper');
const { imageSearchQueryPrompt } = require('./prompts');

// Manually load environment variables from .env if it exists in root
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    lines.forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        if (val.length > 0 && val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') {
          val = val.substring(1, val.length - 1);
        }
        process.env[key] = val.trim();
      }
    });
  }
}
loadEnv();
// Dynamically import puppeteer since it's installed via npm
let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.warn('[imageGenerator] Puppeteer not loaded yet. Make sure to install dependencies.');
}

/**
 * Downloads a file from a URL to a local destination
 */
async function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    // If Unsplash source URL or standard URL
    const client = url.startsWith('https') ? require('https') : require('http');
    
    // Set user-agent header to look like a browser
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };

    client.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        // Handle redirect
        if (res.statusCode === 301 || res.statusCode === 302) {
          return downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
        }
        return reject(new Error(`Failed to download image. Status: ${res.statusCode}`));
      }
      
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      
      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

/**
 * Calls Ollama vision model to verify if image matches concept
 */
async function verifyImageWithVision(imagePath, concept) {
  try {
    // Read local image and encode in base64
    const imgBuffer = fs.readFileSync(imagePath);
    const base64Img = imgBuffer.toString('base64');
    
    // Check if a vision model exists (e.g. minicpm-v, llava)
    const visionModel = await findVisionModel();
    if (!visionModel) {
      console.log('[imageGenerator] No vision model found in Ollama, skipping verification.');
      return true; // fallback to true
    }
    
    console.log(`[imageGenerator] Verifying image against concept "${concept}" using ${visionModel}...`);
    
    const body = JSON.stringify({
      model: visionModel,
      stream: false,
      options: { temperature: 0.1 },
      messages: [
        {
          role: 'user',
          content: `Does this image depict or represent "${concept}"? Respond with only the word "yes" or "no".`,
          images: [base64Img]
        }
      ]
    });
    
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const answer = json.message?.content?.toLowerCase() || '';
              const matches = answer.includes('yes');
              console.log(`[imageGenerator] Vision model verification result: ${matches} (Response: "${answer.trim()}")`);
              resolve(matches);
            } catch {
              resolve(true);
            }
          });
        }
      );
      req.on('error', () => resolve(true));
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('[imageGenerator] Vision verification error:', err.message);
    return true; // skip on error
  }
}

/**
 * Helper to find available vision models in Ollama
 */
async function findVisionModel() {
  return new Promise((resolve) => {
    http.get({ hostname: 'localhost', port: 11434, path: '/api/tags' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const models = json.models?.map(m => m.name) || [];
          // Look for minicpm-v or llava
          const found = models.find(m => m.includes('minicpm-v') || m.includes('llava'));
          resolve(found || null);
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Uses Google Custom Search JSON API (preferred) or Openverse API (fallback)
 * to find the top image candidates matching the query.
 * Returns an array of { type: 'url', url } candidates, best match first.
 */
async function searchWebImage(query, maxResults = 5) {
  const https = require('https');
  
  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;
  
  if (apiKey && cx) {
    // ─── Route A: Google Custom Search API ───
    return new Promise((resolve, reject) => {
      const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&searchType=image&key=${apiKey}&cx=${cx}&num=${maxResults}`;
      console.log(`[imageGenerator] Querying Google Custom Search API for: "${query}"`);
      
      https.get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Google API returned status code ${res.statusCode}`));
        }
        
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              return reject(new Error(json.error.message));
            }
            if (!json.items || !json.items.length) {
              return reject(new Error('No results found on Google.'));
            }
            const candidates = json.items.map(item => ({ type: 'url', url: item.link, title: item.title }));
            console.log(`[imageGenerator] Found ${candidates.length} Google image candidate(s) for "${query}"`);
            resolve(candidates);
          } catch (err) {
            reject(err);
          }
        });
      }).on('error', reject);
    });
  } else {
    // ─── Route B: Openverse API (Fallback) ───
    return new Promise((resolve, reject) => {
      const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${maxResults}`;
      console.log(`[imageGenerator] Querying Openverse API (fallback) for: "${query}"`);
      
      const options = {
        headers: {
          'User-Agent': 'LessonPlanGeneratorBot/1.0 (contact: support@mediatiz.com) Node.js/https'
        }
      };

      https.get(url, options, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Openverse API returned status code ${res.statusCode}`));
        }
        
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!json.results || !json.results.length) {
              return reject(new Error('No results found on Openverse.'));
            }
            const candidates = json.results.map(result => ({ type: 'url', url: result.url, title: result.title }));
            console.log(`[imageGenerator] Found ${candidates.length} Openverse image candidate(s) for "${query}"`);
            resolve(candidates);
          } catch (err) {
            reject(err);
          }
        });
      }).on('error', reject);
    });
  }
}

/**
 * Converts an SVG string into a PNG file using Puppeteer
 */
async function renderSvgToPng(svgString, destPngPath) {
  if (!puppeteer) throw new Error('Puppeteer is not installed.');
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: getChromePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Wrap SVG in a minimal HTML container
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { margin: 0; padding: 0; background: transparent; display: inline-block; }
          svg { display: block; }
        </style>
      </head>
      <body>
        ${svgString}
      </body>
      </html>
    `;
    
    await page.setContent(htmlContent);
    
    // Get the dimensions of the SVG element
    const rect = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      if (!svg) return { x: 0, y: 0, width: 400, height: 200 };
      const bbox = svg.getBoundingClientRect();
      return {
        x: bbox.left,
        y: bbox.top,
        width: bbox.width || 400,
        height: bbox.height || 200
      };
    });
    
    await page.setViewport({
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
      deviceScaleFactor: 2 // high resolution
    });
    
    // Take screenshot of the element
    await page.screenshot({
      path: destPngPath,
      clip: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      },
      omitBackground: true
    });
    
    console.log(`[imageGenerator] Successfully rendered SVG to PNG: ${destPngPath}`);
    await browser.close();
    
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }
}

/**
 * Generates an SVG concept diagram using Ollama
 */
async function generateSvgDiagram(conceptText) {
  console.log('[imageGenerator] Requesting LLM to write SVG code...');
  
  const systemPrompt = `You are a professional SVG generator.
You generate valid, clean SVG illustrations for school mathematics concepts.
You respond ONLY with raw SVG code starting with <svg> and ending with </svg>.
Do NOT wrap the SVG in markdown code blocks (e.g. do NOT write \`\`\`xml or \`\`\`svg).
Do NOT include any introduction, explanations, notes, or warning text.
Ensure all elements are visible, coordinates are correct, text labels are large and readable (font-family Arial), and background is transparent or white.
Use this color palette: Green (#1A7A4A), Blue (#1F5C99), Light Blue (#2E75B6), Dark Gray (#333333).`;

  const userPrompt = `Generate a diagram showing: "${conceptText}"
Ensure the diagram is clear, accurate, and helpful for primary school students.
Use lines, shapes, grids, place value columns, or number lines. Add labels to clarify the concept.`;

  let svg = await generate(systemPrompt, userPrompt);
  
  // Clean up code blocks if LLM failed to follow the instruction
  svg = svg.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  
  // Verify it contains <svg>
  if (!svg.startsWith('<svg')) {
    const match = svg.match(/<svg[\s\S]*<\/svg>/);
    if (match) {
      svg = match[0];
    } else {
      // Minimal fallback SVG
      svg = `<svg width="400" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#F8F9FA" rx="8"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="16" fill="#1F5C99">${conceptText}</text>
      </svg>`;
    }
  }
  
  return svg;
}

/**
 * Main function: attempts to create an image for a section.
 * Classifies, generates (SVG or Web Search), verifies, and returns the local file path.
 */
async function generateImageForSection(sectionName, sectionContent, grade, subject = 'Mathematics', disableVerification = false) {
  // Ensure a temp directory exists
  const tempDir = path.join(__dirname, 'public', 'images_temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const timestamp = Date.now();
  const baseFilename = `section_${sectionName.replace(/\s+/g, '_')}_${timestamp}`;
  const destPngPath = path.join(tempDir, `${baseFilename}.png`);
  
  try {
    // 1. Generate a search query for web images (every section now gets an image —
    //    no longer gated behind a "does this need a visual?" classification step).
    //    Routed through imageSearchQueryPrompt (prompts.js) so this stays in sync
    //    with the same constraints used elsewhere: 3-6 concrete keywords, and
    //    explicitly no "diagram"/"illustration"/"chart"/etc — those meta-words
    //    bias image search toward stylized clipart instead of clean, useful results.
    const { system: querySystem, user: queryUser } = imageSearchQueryPrompt(
      sectionContent.slice(0, 600),
      `${subject} — ${sectionName}`,
      grade
    );
    const query = (await generateFast(querySystem, queryUser)).replace(/"/g, '').trim();
    console.log(`[imageGenerator] Generated search query: "${query}"`);
    
    // 2. Search the web and try each candidate image until one downloads successfully
    const candidates = await searchWebImage(query, 5);

    let downloaded = false;
    let lastErr = null;

    // Errors like this are transient network/TLS corruption (a dropped or
    // mangled connection mid-download — often caused by antivirus HTTPS
    // scanning/interception on Windows) rather than a bad URL, so a same-URL
    // retry after a short pause is worth trying before giving up on it.
    const isTransientNetworkError = (err) =>
      /ECONNRESET|decryption failed|bad record mac|socket hang up|EPIPE|ETIMEDOUT/i.test(err.message || '');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      let attempt = 0;
      const maxAttempts = candidate.type === 'base64' ? 1 : 2; // only network downloads benefit from a retry
      while (attempt < maxAttempts && !downloaded) {
        attempt++;
        try {
          if (candidate.type === 'base64') {
            const base64Data = candidate.data.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(destPngPath, Buffer.from(base64Data, 'base64'));
            console.log(`[imageGenerator] Saved base64 image (candidate ${i + 1}/${candidates.length}): ${destPngPath}`);
          } else {
            await downloadImage(candidate.url, destPngPath);
            console.log(`[imageGenerator] Downloaded image (candidate ${i + 1}/${candidates.length}, attempt ${attempt}): ${destPngPath}`);
          }
          downloaded = true;
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts && isTransientNetworkError(err)) {
            console.warn(`[imageGenerator] Candidate ${i + 1}/${candidates.length} hit a transient network/TLS error ("${err.message}") — retrying same URL once...`);
            await sleep(500);
          } else {
            console.warn(`[imageGenerator] Candidate ${i + 1}/${candidates.length} failed ("${candidate.url}"): ${err.message}. Trying next...`);
          }
        }
      }
      if (downloaded) break;
    }

    if (!downloaded) {
      const finalErr = lastErr || new Error('All image candidates failed to download.');
      if (isTransientNetworkError(finalErr)) {
        console.error(`[imageGenerator] All ${candidates.length} candidates failed with network/TLS errors even after retries. ` +
          `This pattern (SSL decryption/ECONNRESET) usually means something is intercepting or corrupting HTTPS connections — ` +
          `check antivirus "HTTPS scanning"/web-shield settings or a VPN/proxy, then falling back to placeholder graphic.`);
      }
      throw finalErr;
    }
    
    // 3. Vision model verification (if enabled)
    if (!disableVerification) {
      const ok = await verifyImageWithVision(destPngPath, query);
      if (!ok) {
        console.warn('[imageGenerator] Image failed vision verification. Falling back to clean text graphic.');
        const fallbackSvg = `<svg width="400" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#F8F9FA" rx="8" stroke="#1F5C99" stroke-width="2"/>
          <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="14" fill="#1F5C99">${sectionName}: ${query}</text>
        </svg>`;
        await renderSvgToPng(fallbackSvg, destPngPath);
      }
    }
    
    return `/images_temp/${baseFilename}.png`;
    
  } catch (err) {
    console.error(`[imageGenerator] Failed to generate image for ${sectionName}:`, err.message);
    // Graceful fallback to clean SVG text placeholder on error
    try {
      const fallbackSvg = `<svg width="400" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#F8F9FA" rx="8" stroke="#1F5C99" stroke-width="2"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="14" fill="#1F5C99">${sectionName}</text>
      </svg>`;
      await renderSvgToPng(fallbackSvg, destPngPath);
      return `/images_temp/${baseFilename}.png`;
    } catch (_) {
      return null;
    }
  }
  
  return null;
}

module.exports = { generateImageForSection };