// pdfRenderer.js — renders lesson content to PDF via Puppeteer.
//
// Lesson JSON stores images as web paths (/images_temp/foo.png) that live
// under public/. They're resolved to real files and embedded as data URIs,
// which avoids Windows path/URL problems inside Chromium.
const fs = require('fs');
const path = require('path');
const { withPage } = require('./puppeteerHelper');
const { SECTION_LABELS } = require('./sections');

const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const IMAGE_TEMP_DIR = path.join(PUBLIC_DIR, 'images_temp');

function log(...args) {
  console.log('[pdfRenderer]', ...args);
}

/**
 * Resolves an image reference (/images_temp/foo.png, public/images_temp/foo.png,
 * an absolute path, …) to an existing file, or null.
 */
function resolveImagePath(imageSource) {
  if (!imageSource || typeof imageSource !== 'string') return null;

  let source = imageSource.trim();
  if (!source) return null;

  source = source.split('?')[0].split('#')[0].replace(/\//g, path.sep);

  // On Windows "/images_temp/foo.png" also counts as absolute, so only accept
  // an absolute path that actually exists, and otherwise keep resolving.
  if (path.isAbsolute(source) && fs.existsSync(source)) return source;

  const relativeSource = source
    .replace(/^[/\\]+/, '')
    .replace(/^public[/\\]+/i, '')
    .replace(/^\.[/\\]+/, '');

  const candidates = [
    path.join(PUBLIC_DIR, relativeSource),
    path.join(IMAGE_TEMP_DIR, path.basename(relativeSource)),
    path.join(PROJECT_ROOT, relativeSource),
    path.join(process.cwd(), relativeSource),
    path.join(process.cwd(), 'public', relativeSource),
    path.join(process.cwd(), 'public', 'images_temp', path.basename(relativeSource)),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.normalize(candidate);
    } catch (_) {}
  }
  return null;
}

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function imageToDataUri(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  try {
    const mimeType = MIME_TYPES[path.extname(imagePath).toLowerCase()] || 'image/png';
    return `data:${mimeType};base64,${fs.readFileSync(imagePath).toString('base64')}`;
  } catch (err) {
    log(`❌ Failed to read image: ${imagePath}`, err.message);
    return null;
  }
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// "marked" is used when installed; otherwise the lightweight renderer below.
let marked = null;
try {
  marked = require('marked');
} catch (_) {}

function simpleMarkdownToHtml(markdown) {
  if (!markdown) return '';
  let html = escapeHtml(markdown);

  html = html
    .replace(/^---$/gm, '<hr>')
    .replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^(?:-|\*) (.+)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*?<\/li>\s*)+)/gs, '<ul>$1</ul>')
    .replace(/^(?:\d+)\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n{2,}/g, '</p><p>');

  return `<p>${html}</p>`;
}

function markdownToHtml(markdown) {
  if (!markdown) return '';
  try {
    if (marked) {
      if (typeof marked.parse === 'function') return marked.parse(markdown);
      if (typeof marked === 'function') return marked(markdown);
    }
  } catch (err) {
    log('⚠️ Marked failed, using fallback markdown renderer:', err.message);
  }
  return simpleMarkdownToHtml(markdown);
}

/**
 * Turns a stored image path into a data URI, or null (with a log line saying why).
 */
function prepareImage(imageSource, lessonNum, sectionKey) {
  const resolvedPath = resolveImagePath(imageSource);
  if (!resolvedPath) {
    log(`❌ Could not resolve image for Lesson ${lessonNum} / ${sectionKey}: ${imageSource}`);
    return null;
  }
  const dataUri = imageToDataUri(resolvedPath);
  if (!dataUri) {
    log(`❌ Could not convert image to data URI: ${resolvedPath}`);
    return null;
  }
  return dataUri;
}

const LESSON_CSS = `
@page { size: A4; margin: 16mm 15mm 18mm 15mm; }
* { box-sizing: border-box; }
body { font-family: Arial, "Segoe UI", sans-serif; color: #222; font-size: 10.5pt; line-height: 1.55; margin: 0; padding: 0; }
h1 { font-size: 24pt; margin: 0 0 10px 0; color: #1A4D7A; }
h2 { font-size: 18pt; margin-top: 24px; margin-bottom: 10px; color: #1A4D7A; border-bottom: 1px solid #D8E2EC; padding-bottom: 5px; }
h3 { font-size: 14pt; margin-top: 18px; margin-bottom: 7px; color: #245B85; }
h4 { font-size: 12pt; color: #333; }
p { margin: 0 0 9px 0; }
ul, ol { margin-top: 5px; margin-bottom: 12px; padding-left: 22px; }
li { margin-bottom: 4px; }
strong { font-weight: 700; }
code { background: #F1F3F5; padding: 2px 4px; border-radius: 3px; }
hr { border: none; border-top: 1px solid #D9D9D9; margin: 18px 0; }
.cover { min-height: 240mm; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; page-break-after: always; }
.cover h1 { font-size: 30pt; margin-bottom: 15px; }
.cover h2 { border: none; font-size: 20pt; margin: 0; }
.cover-meta { margin-top: 30px; font-size: 13pt; color: #555; }
.lesson { page-break-before: always; }
.lesson:first-of-type { page-break-before: auto; }
.lesson-header { padding-bottom: 12px; margin-bottom: 20px; border-bottom: 3px solid #1A4D7A; }
.lesson-number { font-size: 11pt; font-weight: 700; color: #777; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.lesson-title { font-size: 25pt; font-weight: 700; color: #1A4D7A; }
.lesson-description { margin-top: 8px; color: #555; font-size: 11pt; }
.section { margin-top: 24px; page-break-inside: auto; }
.section-title { font-size: 18pt; color: #1A4D7A; border-bottom: 1px solid #D8E2EC; padding-bottom: 5px; margin-bottom: 12px; }
.section-image { display: block; width: 100%; max-width: 170mm; max-height: 85mm; object-fit: contain; margin: 12px auto 18px auto; page-break-inside: avoid; }
.image-container { width: 100%; text-align: center; margin: 12px 0 18px 0; page-break-inside: avoid; }
.slo-box { background: #F4F8FC; border-left: 4px solid #1A4D7A; padding: 10px 12px; margin: 15px 0; }
.page-break { page-break-after: always; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; }
th, td { border: 1px solid #CCC; padding: 6px 8px; text-align: left; }
th { background: #F0F4F8; }
blockquote { border-left: 4px solid #AAA; margin-left: 0; padding-left: 12px; color: #555; }
.math { font-family: "Times New Roman", serif; text-align: center; margin: 15px 0; }
.footer { position: fixed; bottom: -8mm; left: 0; right: 0; text-align: center; font-size: 8pt; color: #888; }
`;

// [key, label] in lesson order, shared with DocBuilder.js via sections.js
const SECTION_ORDER = Object.entries(SECTION_LABELS);

function buildLessonHtml(structure, generatedSections, images) {
  const chapter = structure.chapter || {};
  const lessons = structure.lessons || [];

  const parts = [`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>${LESSON_CSS}</style>
</head>
<body>
<div class="cover">
  <h1>${escapeHtml(chapter.title || 'Lesson Plan')}</h1>
  <h2>Grade ${escapeHtml(chapter.grade || '')}</h2>
  <div class="cover-meta">
    ${chapter.strand ? `<div>${escapeHtml(chapter.strand)}</div>` : ''}
    ${chapter.number !== undefined ? `<div>Chapter ${escapeHtml(chapter.number)}</div>` : ''}
  </div>
</div>`];

  lessons.forEach((lesson, lessonIndex) => {
    const lessonSections = generatedSections[lessonIndex] || generatedSections[lesson.number - 1] || {};
    const lessonImages = images?.[lessonIndex] || images?.[lesson.number - 1] || {};

    parts.push(`<div class="lesson">
  <div class="lesson-header">
    <div class="lesson-number">Lesson ${escapeHtml(lesson.number)}</div>
    <div class="lesson-title">${escapeHtml(lesson.title)}</div>
    ${lesson.description ? `<div class="lesson-description">${escapeHtml(lesson.description)}</div>` : ''}
  </div>`);

    if (lesson.slos?.length) {
      const items = lesson.slos.map((slo, i) => {
        const description = lesson.slo_descriptions?.[i];
        return `<li><strong>${escapeHtml(slo)}</strong>${description ? ` — ${escapeHtml(description)}` : ''}</li>`;
      });
      parts.push(`<div class="slo-box">
  <strong>Student Learning Outcomes</strong>
  <ul>${items.join('\n')}</ul>
</div>`);
    }

    for (const [sectionKey, sectionTitle] of SECTION_ORDER) {
      const content = lessonSections[sectionKey];
      if (!content || !String(content).trim()) continue;

      parts.push(`<div class="section">
  <div class="section-title">${escapeHtml(sectionTitle)}</div>`);

      const imageSource = lessonImages[sectionKey];
      const dataUri = imageSource && prepareImage(imageSource, lesson.number, sectionKey);
      if (dataUri) {
        parts.push(`<div class="image-container">
  <img class="section-image" src="${dataUri}" alt="${escapeHtml(sectionTitle)} illustration" />
</div>`);
      }

      parts.push(markdownToHtml(content), '</div>');
    }

    parts.push('</div>');
  });

  parts.push('</body>\n</html>');
  return parts.join('\n');
}

async function renderHtmlToPdf(html, outputPath) {
  log(`Rendering PDF: ${outputPath}`);

  await withPage(async (page) => {
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 }); // A4 at 150dpi
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await new Promise(resolve => setTimeout(resolve, 300)); // let layout settle

    const imageInfo = await page.evaluate(() => {
      const images = Array.from(document.images);
      return {
        count: images.length,
        failed: images.filter(img => img.complete && img.naturalWidth === 0).length,
      };
    });
    if (imageInfo.failed > 0) log(`⚠️ ${imageInfo.failed} of ${imageInfo.count} image(s) failed to load.`);

    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: '16mm', right: '15mm', bottom: '18mm', left: '15mm' },
    });
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Puppeteer finished but PDF was not created: ${outputPath}`);
  }
  log(`✅ PDF created: ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
  return outputPath;
}

async function buildLessonPdf(structure, generatedSections, images, outputPath) {
  log(`Building lesson PDF — Chapter: ${structure?.chapter?.title || 'Unknown'}, ` +
    `${structure?.lessons?.length || 0} lesson(s) → ${outputPath}`);
  const html = buildLessonHtml(structure, generatedSections, images || {});
  return renderHtmlToPdf(html, outputPath);
}

module.exports = {
  buildLessonPdf,
  renderHtmlToPdf,
  resolveImagePath,
  markdownToHtml,
};
