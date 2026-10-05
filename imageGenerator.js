// imageGenerator.js — handles SVG generation and web image search fallback via Puppeteer
const fs = require('fs');
const path = require('path');
const http = require('http');
const { generate, generateFast } = require('./ollama');
const { getChromePath } = require('./puppeteerHelper');
const { imageSearchQueryPrompt } = require('./prompts');

require('./env');
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

// ─────────────────────────────────────────────────────────────────
// [FIX v2] Diagram routing
//
// Geometric/structural math concepts (number lines, points, rays, shapes,
// place-value grids, axes, etc.) are not things a stock photo or web image
// search can meaningfully depict — no photograph shows "a ray," and search
// engines return irrelevant stock imagery for these queries (which is also
// why they were burning API quota on searches that could never succeed).
// isDiagramContent() flags this content so generateImageForSection() can
// route it straight to generateSvgDiagram() below instead of searching.
//
// Keywords are deliberately specific (e.g. "point a" / "endpoint" rather
// than bare "point") to avoid false positives on ordinary sentences like
// "at this point in the lesson."
// ─────────────────────────────────────────────────────────────────
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
  const lower = ` ${text.toLowerCase()} `; // pad so " ray " etc. can match at string edges
  return DIAGRAM_KEYWORDS.some(kw => lower.includes(kw));
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
 * Builds a placeholder SVG shown when image search/download fails, or the
 * vision model rejects every candidate. Embeds the ACTUAL search query that
 * was used, so a human reviewing the output later (a course designer) knows
 * exactly what to search for manually instead of guessing from the section
 * name alone. If no query was ever generated (failure happened before that
 * step), falls back to a generic "add manually" message.
 */
function buildPlaceholderSvg(sectionName, query) {
  const escape = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Simple word-wrap so long queries don't run off the edge of the box
  const wrapText = (text, maxCharsPerLine = 38) => {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxCharsPerLine) {
        if (cur) lines.push(cur.trim());
        cur = w;
      } else {
        cur = (cur + ' ' + w).trim();
      }
    }
    if (cur) lines.push(cur.trim());
    return lines.slice(0, 3); // cap at 3 lines to keep the box readable
  };

  const queryLines = query
    ? wrapText(`Suggested search: "${query}"`)
    : ['Image not available — add manually'];

  const lineHeight = 18;
  const startY = 110 - ((queryLines.length - 1) * lineHeight) / 2;
  const textLines = queryLines
    .map((line, i) => `<text x="50%" y="${startY + i * lineHeight}" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="13" fill="#1F5C99" font-style="italic">${escape(line)}</text>`)
    .join('\n    ');

  return `<svg width="400" height="220" viewBox="0 0 400 220" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#F8F9FA" rx="8" stroke="#1F5C99" stroke-width="2"/>
    <text x="50%" y="70" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="13" fill="#333333">🖼️ Image placeholder — ${escape(sectionName)}</text>
    ${textLines}
  </svg>`;
}

/**
 * Main function: attempts to create an image for a section.
 * Classifies, generates (SVG or Web Search), verifies, and returns the local
 * file path along with the search query used (so callers can surface it as
 * a caption/note when a placeholder was used instead of a real image).
 *
 * Return shape:
 *   { path: string|null, query: string|null, isPlaceholder: boolean, source: 'websearch'|'svg_diagram'|'placeholder' }
 * `source` tells the caller exactly how this image was produced, so a doc
 * builder can decide whether it needs a visible "please verify" caption:
 *   - 'websearch'   — a real, vision-verified photo. No caption needed.
 *   - 'svg_diagram' — an AI-generated diagram (e.g. for geometric content
 *                     routed away from web search). A real image, but not
 *                     verified against ground truth — caption recommended.
 *   - 'placeholder' — web search found nothing usable at all. isPlaceholder
 *                     is also true in this case; caption shows the query.
 *
 * @param {boolean} disableSvgDiagrams - when true, skips the LLM-generated-
 *   SVG-diagram path entirely (the most expensive step in this pipeline —
 *   a full LLM call plus a Puppeteer render) and falls through to the
 *   normal web-search/placeholder flow instead, even for content that
 *   would otherwise be classified as diagram content.
 */
async function generateImageForSection(sectionName, sectionContent, grade, subject = 'Mathematics', disableVerification = false, disableSvgDiagrams = false) {
  // Ensure a temp directory exists
  const tempDir = path.join(__dirname, 'public', 'images_temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = Date.now();
  const baseFilename = `section_${sectionName.replace(/\s+/g, '_')}_${timestamp}`;
  const destPngPath = path.join(tempDir, `${baseFilename}.png`);

  // Hoisted OUTSIDE the try block on purpose — this fixes a bug where `query`
  // was declared with `const` inside try, so if searchWebImage/downloadImage
  // threw, the catch block below had no access to it and the placeholder
  // could never show the search term that actually failed.
  let query = null;

  // [FIX v2] Diagram routing — geometric/structural content skips web search
  // entirely and goes straight to an LLM-generated SVG diagram, which is
  // actually a better fit for this content AND avoids burning search-API
  // quota on queries that were never going to return something usable.
  //
  // [NEW] disableSvgDiagrams — this path is genuinely the most expensive
  // step in the whole image pipeline (a full LLM call to write SVG code,
  // then a Puppeteer render), so it's worth being able to turn off entirely
  // when generation speed matters more than diagram quality for a given
  // run. When disabled, diagram-classified content simply falls through to
  // the exact same web-search → placeholder flow used for everything else
  // — no separate "skip images" branch, it just behaves as if
  // isDiagramContent() had returned false.
  if (!disableSvgDiagrams && isDiagramContent(sectionContent)) {
    try {
      console.log(`[imageGenerator] "${sectionName}" classified as diagram content — generating SVG directly (skipping web image search).`);
      const svg = await generateSvgDiagram(sectionContent.slice(0, 500));
      await renderSvgToPng(svg, destPngPath);
      return { path: `/images_temp/${baseFilename}.png`, query: null, isPlaceholder: false, source: 'svg_diagram' };
    } catch (err) {
      console.error(`[imageGenerator] Diagram generation failed for ${sectionName}, falling back to web search:`, err.message);
      // Fall through to the web-search path below rather than giving up —
      // a real photo/diagram from search is still better than nothing.
    }
  } else if (disableSvgDiagrams && isDiagramContent(sectionContent)) {
    console.log(`[imageGenerator] "${sectionName}" would have been classified as diagram content, but SVG diagram generation is disabled for this run — falling through to web search.`);
  }

  try {
    // 1. Generate a search query for web images (every section now gets an
    //    image — no longer gated behind a "does this need a visual?" step).
    const { system: querySystem, user: queryUser } = imageSearchQueryPrompt(
      sectionContent.slice(0, 600),
      `${subject} — ${sectionName}`,
      grade
    );
    query = (await generate(querySystem, queryUser)).replace(/"/g, '').trim();
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
        console.warn('[imageGenerator] Image failed vision verification. Falling back to placeholder with search query.');
        const fallbackSvg = buildPlaceholderSvg(sectionName, query);
        await renderSvgToPng(fallbackSvg, destPngPath);
        return { path: `/images_temp/${baseFilename}.png`, query, isPlaceholder: true, source: 'placeholder' };
      }
    }

    return { path: `/images_temp/${baseFilename}.png`, query, isPlaceholder: false, source: 'websearch' };

  } catch (err) {
    console.error(`[imageGenerator] Failed to generate image for ${sectionName}:`, err.message);
    // Graceful fallback to a placeholder that shows the search query, so a
    // course designer can add the image manually without re-deriving it.
    try {
      const fallbackSvg = buildPlaceholderSvg(sectionName, query);
      await renderSvgToPng(fallbackSvg, destPngPath);
      return { path: `/images_temp/${baseFilename}.png`, query, isPlaceholder: true, source: 'placeholder' };
    } catch (_) {
      return { path: null, query, isPlaceholder: true, source: 'placeholder' };
    }
  }
}

module.exports = { generateImageForSection };