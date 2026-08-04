// imageGenerator.js — handles SVG generation and web image search fallback via Puppeteer
const fs = require('fs');
const path = require('path');
const http = require('http');
const { generate } = require('./ollama');
const { getChromePath } = require('./puppeteerHelper');

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
 * Uses Puppeteer to search DuckDuckGo Images and find the first image link
 */
async function searchWebImage(query) {
  if (!puppeteer) throw new Error('Puppeteer is not installed.');
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: getChromePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    // Use DuckDuckGo Lite or Standard Image search
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;
    console.log(`[imageGenerator] Searching DuckDuckGo for: "${query}"`);
    
    await page.goto(searchUrl, { waitUntil: 'networkidle2' });
    
    // Wait for the tiles to load
    await page.waitForSelector('.tile--img img', { timeout: 10000 });
    
    // Extract first image URL
    const imageUrl = await page.evaluate(() => {
      const img = document.querySelector('.tile--img img');
      // Some images on DDG are base64, others are hotlinked
      // We want the hotlinked URL if possible
      if (img) {
        // DDG wraps real source URLs in query params or datasets
        // E.g., if img is parented by an anchor containing the source URL
        const parent = img.closest('.tile--img');
        if (parent) {
          // Look for direct link dataset
          const data = parent.getAttribute('data-image-val') || parent.getAttribute('data-src');
          if (data) return data;
        }
        return img.src;
      }
      return null;
    });
    
    await browser.close();
    
    if (!imageUrl) {
      throw new Error('No images found on page.');
    }
    
    // Sometimes the returned URL is a relative path or base64
    if (imageUrl.startsWith('data:')) {
      // It's a base64 inline image, we can return it directly or write it
      return { type: 'base64', data: imageUrl };
    }
    
    console.log(`[imageGenerator] Found image URL: ${imageUrl}`);
    return { type: 'url', url: imageUrl };
    
  } catch (err) {
    if (browser) await browser.close();
    throw err;
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
    // 1. Classify required visual
    console.log(`[imageGenerator] Classifying required visual for: "${sectionName}"...`);
    const systemClassify = 'You are an educational assistant. Respond with ONLY one of the following words: "diagram", "photo", or "none". Do not write anything else.';
    const userClassify = `Grade: ${grade} ${subject}
Section: ${sectionName}
Content: ${sectionContent.slice(0, 1000)}

Does this section need a visual illustration?
- Respond "diagram" for conceptual mathematical visualizations (number lines, models, shapes, graphs, place value charts).
- Respond "photo" for real-world concrete objects (e.g., photos of apples, groups of children, coins, sports balls, toys).
- Respond "none" if no visual is needed.
Answer:`;

    const classification = (await generate(systemClassify, userClassify)).toLowerCase().trim();
    console.log(`[imageGenerator] Classification: "${classification}"`);
    
    if (classification.includes('none')) {
      return null;
    }
    
    if (classification.includes('diagram')) {
      // Generate SVG and render to PNG
      const svg = await generateSvgDiagram(sectionContent);
      await renderSvgToPng(svg, destPngPath);
      return `/images_temp/${baseFilename}.png`;
    }
    
    if (classification.includes('photo')) {
      // Find a search term from the content
      const searchPrompt = `Given this lesson content, write a short, specific search query (2-4 words) for an educational image search engine to find a photo illustrating this context. Respond ONLY with the search query.
Content: ${sectionContent.slice(0, 500)}`;
      const query = (await generate('You are a search query assistant. Respond with ONLY the query.', searchPrompt)).replace(/"/g, '').trim();
      
      console.log(`[imageGenerator] Searching for: "${query}"`);
      const searchResult = await searchWebImage(query);
      
      if (searchResult.type === 'base64') {
        const base64Data = searchResult.data.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(destPngPath, Buffer.from(base64Data, 'base64'));
        console.log(`[imageGenerator] Saved base64 image: ${destPngPath}`);
      } else {
        await downloadImage(searchResult.url, destPngPath);
        console.log(`[imageGenerator] Downloaded image: ${destPngPath}`);
      }
      
      // Verification (if enabled)
      if (!disableVerification) {
        const ok = await verifyImageWithVision(destPngPath, query);
        if (!ok) {
          console.warn('[imageGenerator] Image failed verification. Falling back to SVG diagram.');
          const svg = await generateSvgDiagram(sectionContent);
          await renderSvgToPng(svg, destPngPath);
        }
      }
      
      return `/images_temp/${baseFilename}.png`;
    }
    
  } catch (err) {
    console.error(`[imageGenerator] Failed to generate image for ${sectionName}:`, err.message);
    // Graceful fallback to SVG placeholder on error
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
