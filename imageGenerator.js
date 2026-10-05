// imageGenerator.js — handles SVG generation and web image search fallback via Puppeteer
require('./env');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { generate, generateFast } = require('./ollama');
const { withPage } = require('./puppeteerHelper');
const { imageSearchQueryPrompt } = require('./prompts');

const TEMP_DIR = path.join(__dirname, 'public', 'images_temp');
const DOWNLOAD_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Downloads an image from a URL to a local destination. Follows redirects and
 * rejects non-image responses (hotlink-protection HTML pages etc.), so the
 * caller moves on to the next candidate instead of saving a broken file.
 */
function downloadImage(url, destPath, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': BROWSER_UA } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return downloadImage(next, destPath, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Failed to download image. Status: ${res.statusCode}`));
      }
      const type = res.headers['content-type'] || '';
      if (type && !type.startsWith('image/')) {
        res.resume();
        return reject(new Error(`Not an image (content-type: ${type})`));
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(() => resolve()));
      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
  });
}

/**
 * Finds a vision model (minicpm-v / llava) on a LOCAL Ollama, if one is running.
 */
function findVisionModel() {
  return new Promise((resolve) => {
    const req = http.get({ hostname: 'localhost', port: 11434, path: '/api/tags' }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const models = JSON.parse(data).models?.map(m => m.name) || [];
          resolve(models.find(m => m.includes('minicpm-v') || m.includes('llava')) || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(3000, () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * Asks a local vision model whether the image depicts the concept.
 * Any failure (or no vision model) counts as a pass.
 */
async function verifyImageWithVision(imagePath, concept) {
  try {
    const visionModel = await findVisionModel();
    if (!visionModel) {
      console.log('[imageGenerator] No vision model found in Ollama, skipping verification.');
      return true;
    }

    console.log(`[imageGenerator] Verifying image against concept "${concept}" using ${visionModel}...`);
    const body = JSON.stringify({
      model: visionModel,
      stream: false,
      options: { temperature: 0.1 },
      messages: [{
        role: 'user',
        content: `Does this image depict or represent "${concept}"? Respond with only the word "yes" or "no".`,
        images: [fs.readFileSync(imagePath).toString('base64')],
      }],
    });

    return await new Promise((resolve) => {
      const req = http.request(
        { hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          let data = '';
          res.on('data', c => { data += c; });
          res.on('end', () => {
            try {
              const answer = JSON.parse(data).message?.content?.toLowerCase() || '';
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
    return true;
  }
}

function getJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`returned status code ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
  });
}

/**
 * Finds image candidates via Google Custom Search (if GOOGLE_API_KEY/GOOGLE_CX
 * are set) or Openverse. Returns [{ type: 'url', url, title }], best match first.
 */
async function searchWebImage(query, maxResults = 5) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;

  if (apiKey && cx) {
    console.log(`[imageGenerator] Querying Google Custom Search API for: "${query}"`);
    const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&searchType=image&key=${apiKey}&cx=${cx}&num=${maxResults}`;
    let json;
    try {
      json = await getJson(url);
    } catch (err) {
      throw new Error(`Google API ${err.message}`);
    }
    if (json.error) throw new Error(json.error.message);
    if (!json.items?.length) throw new Error('No results found on Google.');
    const candidates = json.items.map(item => ({ type: 'url', url: item.link, title: item.title }));
    console.log(`[imageGenerator] Found ${candidates.length} Google image candidate(s) for "${query}"`);
    return candidates;
  }

  console.log(`[imageGenerator] Querying Openverse API (fallback) for: "${query}"`);
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${maxResults}`;
  let json;
  try {
    json = await getJson(url, { headers: { 'User-Agent': 'LessonPlanGeneratorBot/1.0 (contact: support@mediatiz.com) Node.js/https' } });
  } catch (err) {
    throw new Error(`Openverse API ${err.message}`);
  }
  if (!json.results?.length) throw new Error('No results found on Openverse.');
  const candidates = json.results.map(result => ({ type: 'url', url: result.url, title: result.title }));
  console.log(`[imageGenerator] Found ${candidates.length} Openverse image candidate(s) for "${query}"`);
  return candidates;
}

/**
 * Renders an SVG string to a PNG file (2x resolution, transparent background).
 */
async function renderSvgToPng(svgString, destPngPath) {
  await withPage(async (page) => {
    await page.setContent(`<!DOCTYPE html>
      <html>
      <head>
        <style>
          body { margin: 0; padding: 0; background: transparent; display: inline-block; }
          svg { display: block; }
        </style>
      </head>
      <body>${svgString}</body>
      </html>`);

    const rect = await page.evaluate(() => {
      const svg = document.querySelector('svg');
      if (!svg) return { x: 0, y: 0, width: 400, height: 200 };
      const bbox = svg.getBoundingClientRect();
      return { x: bbox.left, y: bbox.top, width: bbox.width || 400, height: bbox.height || 200 };
    });

    await page.setViewport({ width: Math.ceil(rect.width), height: Math.ceil(rect.height), deviceScaleFactor: 2 });
    await page.screenshot({ path: destPngPath, clip: rect, omitBackground: true });
  });
  console.log(`[imageGenerator] Successfully rendered SVG to PNG: ${destPngPath}`);
}

// Geometric/structural concepts (number lines, rays, shapes, place-value grids…)
// can't be found as stock photos, so they're drawn as SVG diagrams instead of
// burning search quota. Keywords are deliberately specific ("point a", not
// "point") to avoid matching ordinary prose like "at this point".
const DIAGRAM_KEYWORDS = [
  'number line', 'line segment', ' ray ', ' rays', 'endpoint', 'point a', 'point b',
  'coordinate', 'protractor', 'venn diagram', 'place value chart', 'place value grid',
  'bar model', 'fraction bar', 'pie chart', 'bar chart', 'polygon', 'triangle',
  'quadrilateral', 'rectangle', 'parallelogram', 'parallel lines', 'perpendicular',
  'symmetry', 'vertex', 'vertices', 'axis', 'axes', 'angle', 'degree measure',
  'horizontal line', 'vertical line', 'diagonal', 'diameter', 'radius', 'circumference',
];

function isDiagramContent(text) {
  if (!text) return false;
  const lower = ` ${text.toLowerCase()} `; // pad so " ray " can match at the edges
  return DIAGRAM_KEYWORDS.some(kw => lower.includes(kw));
}

const SVG_SYSTEM_PROMPT = `You are a professional SVG generator.
You generate valid, clean SVG illustrations for school mathematics concepts.
You respond ONLY with raw SVG code starting with <svg> and ending with </svg>.
Do NOT wrap the SVG in markdown code blocks (e.g. do NOT write \`\`\`xml or \`\`\`svg).
Do NOT include any introduction, explanations, notes, or warning text.
Ensure all elements are visible, coordinates are correct, text labels are large and readable (font-family Arial), and background is transparent or white.
Use this color palette: Green (#1A7A4A), Blue (#1F5C99), Light Blue (#2E75B6), Dark Gray (#333333).

LAYOUT RULES (critical — text overlapping shapes is the most common failure in this task):
- For bar charts (horizontal or vertical): reserve a fixed margin for category labels BEFORE
  placing any bar. For horizontal bars, category labels go in a left margin (e.g. x=0 to x=90)
  and bars start AFTER that margin (e.g. x=100 onward) — never place a label at the same x
  range a bar will occupy, or the bar will be drawn on top of it. For vertical bars, category
  labels go below the x-axis, not inside or behind the bar.
- For pie charts specifically: computing correct pie slice geometry requires real trigonometry
  (the arc endpoint for a slice at cumulative angle θ is at x = cx + r*cos(θ), y = cy + r*sin(θ),
  converting each percentage to (percentage/100)*360 degrees first). Work through this
  calculation explicitly and carefully before writing the path — a common mistake is drawing
  slices that don't add up to a full 360° circle (e.g. leaving part of the circle blank) or
  slices that don't match their stated percentage. Double-check that your slice angles sum to
  exactly 360 degrees before finalizing. Place each slice's label OUTSIDE the circle with a
  short connecting line if the slice is small, rather than inside a slice too narrow to hold text.
- Never place two text elements, or a text element and a shape, at overlapping coordinates.
  Leave at least 10-15px of clear space around every label.`;

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Asks the model to write an SVG diagram for the concept.
 */
async function generateSvgDiagram(conceptText) {
  console.log('[imageGenerator] Requesting LLM to write SVG code...');

  const userPrompt = `Generate a diagram showing: "${conceptText}"
Ensure the diagram is clear, accurate, and helpful for primary school students.
Use lines, shapes, grids, place value columns, or number lines. Add labels to clarify the concept.`;

  let svg = await generate(SVG_SYSTEM_PROMPT, userPrompt);
  svg = svg.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();

  if (!svg.startsWith('<svg')) {
    const match = svg.match(/<svg[\s\S]*<\/svg>/);
    svg = match ? match[0] : `<svg width="400" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#F8F9FA" rx="8"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="16" fill="#1F5C99">${escapeXml(conceptText)}</text>
      </svg>`;
  }
  return svg;
}

/**
 * Placeholder shown when no usable image was found. Embeds the search query
 * that was tried, so a course designer knows what to look for manually.
 */
function buildPlaceholderSvg(sectionName, query) {
  const wrapText = (text, maxCharsPerLine = 38) => {
    const lines = [];
    let cur = '';
    for (const w of text.split(' ')) {
      if ((cur + ' ' + w).trim().length > maxCharsPerLine) {
        if (cur) lines.push(cur.trim());
        cur = w;
      } else {
        cur = (cur + ' ' + w).trim();
      }
    }
    if (cur) lines.push(cur.trim());
    return lines.slice(0, 3);
  };

  const queryLines = query
    ? wrapText(`Suggested search: "${query}"`)
    : ['Image not available — add manually'];

  const lineHeight = 18;
  const startY = 110 - ((queryLines.length - 1) * lineHeight) / 2;
  const textLines = queryLines
    .map((line, i) => `<text x="50%" y="${startY + i * lineHeight}" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="13" fill="#1F5C99" font-style="italic">${escapeXml(line)}</text>`)
    .join('\n    ');

  return `<svg width="400" height="220" viewBox="0 0 400 220" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#F8F9FA" rx="8" stroke="#1F5C99" stroke-width="2"/>
    <text x="50%" y="70" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="13" fill="#333333">🖼️ Image placeholder — ${escapeXml(sectionName)}</text>
    ${textLines}
  </svg>`;
}

const isTransientNetworkError = (err) =>
  /ECONNRESET|decryption failed|bad record mac|socket hang up|EPIPE|ETIMEDOUT/i.test(err.message || '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Tries each candidate in order until one downloads; transient network/TLS
 * errors (often antivirus HTTPS scanning on Windows) get one same-URL retry.
 */
async function downloadFirstCandidate(candidates, destPngPath) {
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const maxAttempts = candidate.type === 'base64' ? 1 : 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (candidate.type === 'base64') {
          const base64Data = candidate.data.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(destPngPath, Buffer.from(base64Data, 'base64'));
          console.log(`[imageGenerator] Saved base64 image (candidate ${i + 1}/${candidates.length}): ${destPngPath}`);
        } else {
          await downloadImage(candidate.url, destPngPath);
          console.log(`[imageGenerator] Downloaded image (candidate ${i + 1}/${candidates.length}, attempt ${attempt}): ${destPngPath}`);
        }
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts && isTransientNetworkError(err)) {
          console.warn(`[imageGenerator] Candidate ${i + 1}/${candidates.length} hit a transient network/TLS error ("${err.message}") — retrying same URL once...`);
          await sleep(500);
        } else {
          console.warn(`[imageGenerator] Candidate ${i + 1}/${candidates.length} failed ("${candidate.url}"): ${err.message}. Trying next...`);
          break;
        }
      }
    }
  }

  const finalErr = lastErr || new Error('All image candidates failed to download.');
  if (isTransientNetworkError(finalErr)) {
    console.error(`[imageGenerator] All ${candidates.length} candidates failed with network/TLS errors even after retries. ` +
      `This usually means something is intercepting HTTPS — check antivirus "HTTPS scanning"/web-shield settings or a VPN/proxy.`);
  }
  throw finalErr;
}

/**
 * Creates an image for a section: an SVG diagram for geometric content,
 * otherwise a (vision-verified) web image, otherwise a placeholder.
 *
 * Returns { path, query, isPlaceholder, source } where source is
 *   'websearch'   — a real photo (vision-verified if a vision model exists)
 *   'svg_diagram' — an AI-drawn diagram; real but unverified, caption recommended
 *   'placeholder' — nothing usable found; the caption shows the query
 *
 * disableSvgDiagrams skips the diagram path (an LLM call plus a render, the most
 * expensive step here) and treats diagram content like any other.
 */
async function generateImageForSection(sectionName, sectionContent, grade, subject = 'Mathematics', disableVerification = false, disableSvgDiagrams = false) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const baseFilename = `section_${sectionName.replace(/\s+/g, '_')}_${Date.now()}`;
  const destPngPath = path.join(TEMP_DIR, `${baseFilename}.png`);
  const webPath = `/images_temp/${baseFilename}.png`;
  let query = null; // outside try so the placeholder can show the query that failed

  const placeholder = async () => {
    await renderSvgToPng(buildPlaceholderSvg(sectionName, query), destPngPath);
    return { path: webPath, query, isPlaceholder: true, source: 'placeholder' };
  };

  if (isDiagramContent(sectionContent)) {
    if (disableSvgDiagrams) {
      console.log(`[imageGenerator] "${sectionName}" is diagram content, but SVG diagrams are disabled for this run — using web search.`);
    } else {
      try {
        console.log(`[imageGenerator] "${sectionName}" classified as diagram content — generating SVG directly (skipping web image search).`);
        const svg = await generateSvgDiagram(sectionContent.slice(0, 500));
        await renderSvgToPng(svg, destPngPath);
        return { path: webPath, query: null, isPlaceholder: false, source: 'svg_diagram' };
      } catch (err) {
        console.error(`[imageGenerator] Diagram generation failed for ${sectionName}, falling back to web search:`, err.message);
      }
    }
  }

  try {
    const { system, user } = imageSearchQueryPrompt(sectionContent.slice(0, 600), `${subject} — ${sectionName}`, grade);
    query = (await generateFast(system, user)).replace(/"/g, '').trim();
    console.log(`[imageGenerator] Generated search query: "${query}"`);

    const candidates = await searchWebImage(query, 5);
    await downloadFirstCandidate(candidates, destPngPath);

    if (!disableVerification && !(await verifyImageWithVision(destPngPath, query))) {
      console.warn('[imageGenerator] Image failed vision verification. Falling back to placeholder with search query.');
      return await placeholder();
    }
    return { path: webPath, query, isPlaceholder: false, source: 'websearch' };
  } catch (err) {
    console.error(`[imageGenerator] Failed to generate image for ${sectionName}:`, err.message);
    try {
      return await placeholder();
    } catch (_) {
      return { path: null, query, isPlaceholder: true, source: 'placeholder' };
    }
  }
}

module.exports = { generateImageForSection };
