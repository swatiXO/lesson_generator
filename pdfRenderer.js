// pdfRenderer.js — compiles generated lesson content into a styled print-ready PDF using Puppeteer
const fs = require('fs');
const path = require('path');
const { getChromePath } = require('./puppeteerHelper');

// Dynamically import puppeteer since it's installed via npm
let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  console.warn('[pdfRenderer] Puppeteer not loaded yet.');
}

/**
 * Converts markdown-like text to basic HTML tags
 */
function markdownToHtml(text) {
  if (!text) return '';
  
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
    
  // Headings
  html = html.replace(/^#### (.*)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Lists
  // Simple bullet conversion
  html = html.replace(/^[-•*]\s+(.*)$/gm, '<li>$1</li>');
  // Simple number list conversion
  html = html.replace(/^\d+[\.\)]\s+(.*)$/gm, '<li>$1</li>');
  
  // Paragraphs
  const lines = html.split('\n');
  let inList = false;
  let finalHtml = [];
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) {
      if (inList) {
        finalHtml.push('</ul>');
        inList = false;
      }
      continue;
    }
    
    if (line.startsWith('<li>')) {
      if (!inList) {
        finalHtml.push('<ul>');
        inList = true;
      }
      finalHtml.push(line);
    } else if (line.startsWith('<h') || line.startsWith('</h')) {
      if (inList) {
        finalHtml.push('</ul>');
        inList = false;
      }
      finalHtml.push(line);
    } else {
      if (inList) {
        finalHtml.push('</ul>');
        inList = false;
      }
      
      // Check if it's an image block placeholder we inserted
      if (line.startsWith('__IMAGE__:')) {
        const imgPath = line.replace('__IMAGE__:', '');
        // Embed image
        finalHtml.push(`<div class="image-container"><img src="file:///${imgPath.replace(/\\/g, '/')}" /></div>`);
      } else {
        finalHtml.push(`<p>${line}</p>`);
      }
    }
  }
  
  if (inList) {
    finalHtml.push('</ul>');
  }
  
  return finalHtml.join('\n');
}

/**
 * Builds a complete HTML document from the lesson structure and generated sections
 */
function buildHtmlDocument(structure, generatedSections, imagesMap = {}) {
  const { chapter, lessons } = structure;
  
  let contentHtml = '';
  
  // Chapter Page
  contentHtml += `
    <div class="chapter-page page-break">
      <div class="chapter-badge">CHAPTER ${chapter.number}</div>
      <h1 class="chapter-title">${chapter.title}</h1>
      <div class="meta-row">Grade ${chapter.grade} &bull; ${chapter.strand || 'Mathematics'} &bull; National Curriculum</div>
      <div class="divider"></div>
      <p class="chapter-overview">${chapter.overview || ''}</p>
    </div>
  `;
  
  // Each Lesson
  for (let li = 0; li < lessons.length; li++) {
    const lesson = lessons[li];
    const sections = generatedSections[li] || {};
    
    contentHtml += `
      <div class="lesson-header page-break-before">
        <div class="lesson-num">LESSON ${lesson.number}</div>
        <h2 class="lesson-title">${lesson.title}</h2>
        <p class="lesson-desc">${lesson.description || ''}</p>
        
        <div class="slo-box">
          <div class="slo-title">Student Learning Outcomes (SLOs)</div>
          <p>By the end of this lesson, students will be able to:</p>
          <ul>
            ${lesson.slos.map((code, idx) => `<li><strong>${code}:</strong> ${lesson.slo_descriptions[idx] || ''}</li>`).join('')}
          </ul>
        </div>
      </div>
    `;
    
    const sectionOrder = [
      { key: 'warmUp',            label: '🌟 Warm-Up'             },
      { key: 'conceptBuilding',   label: '📖 Concept Building'    },
      { key: 'examples',          label: '💡 Worked Examples'     },
      { key: 'popUpQuiz',         label: '✏️ Pop-Up Quiz'         },
      { key: 'mentalMaths',       label: '🧠 Mental Maths'        },
      { key: 'practiceQuestions', label: '📝 Practice Questions'  },
      { key: 'keyTakeaways',      label: '⭐ Key Takeaways'       },
    ];
    
    for (const sec of sectionOrder) {
      let text = sections[sec.key];
      if (!text) continue;
      
      // Inject image placeholder if there is a generated image for this section
      const imageRelPath = imagesMap[li] && imagesMap[li][sec.key];
      if (imageRelPath) {
        const fullPath = path.join(__dirname, 'public', imageRelPath);
        // Put placeholder line
        text = `__IMAGE__:${fullPath}\n\n` + text;
      }
      
      contentHtml += `
        <div class="section-container">
          <h3 class="section-heading">${sec.label}</h3>
          <div class="section-body">
            ${markdownToHtml(text)}
          </div>
        </div>
      `;
    }
  }
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Chapter ${chapter.number}: ${chapter.title}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        
        @page {
          size: A4;
          margin: 20mm;
          @bottom-center {
            content: counter(page);
          }
        }
        
        body {
          font-family: 'Inter', sans-serif;
          color: #212529;
          line-height: 1.6;
          font-size: 11pt;
          background: white;
          margin: 0;
          padding: 0;
        }
        
        /* Layout & structure */
        .page-break { page-break-after: always; }
        .page-break-before { page-break-before: always; }
        
        .divider {
          height: 4px;
          background: #1A7A4A;
          margin: 24px 0;
          border-radius: 2px;
        }
        
        /* Chapter cover page */
        .chapter-page {
          padding-top: 50mm;
          text-align: center;
        }
        .chapter-badge {
          display: inline-block;
          background: #E8F4EE;
          color: #1A7A4A;
          padding: 6px 16px;
          border-radius: 20px;
          font-size: 10pt;
          font-weight: 700;
          letter-spacing: 1px;
          margin-bottom: 16px;
        }
        .chapter-title {
          font-size: 32pt;
          font-weight: 700;
          color: #1A7A4A;
          margin: 0 0 16px 0;
          line-height: 1.2;
        }
        .meta-row {
          font-size: 12pt;
          color: #6C757D;
          margin-bottom: 32px;
        }
        .chapter-overview {
          font-size: 12pt;
          max-width: 600px;
          margin: 0 auto;
          color: #495057;
        }
        
        /* Lesson Header */
        .lesson-header {
          border-bottom: 2px solid #E9ECEF;
          padding-bottom: 16px;
          margin-bottom: 24px;
        }
        .lesson-num {
          font-size: 11pt;
          font-weight: 700;
          color: #1F5C99;
          letter-spacing: 0.5px;
        }
        .lesson-title {
          font-size: 22pt;
          font-weight: 700;
          color: #1F5C99;
          margin: 4px 0 8px 0;
        }
        .lesson-desc {
          font-size: 11pt;
          color: #6C757D;
          font-style: italic;
          margin: 0 0 16px 0;
        }
        
        /* SLO box */
        .slo-box {
          background: #F4F7FA;
          border-left: 4px solid #1F5C99;
          padding: 16px 20px;
          border-radius: 0 8px 8px 0;
          margin-top: 16px;
        }
        .slo-title {
          font-weight: 700;
          color: #1F5C99;
          margin-bottom: 8px;
          font-size: 11pt;
        }
        .slo-box ul {
          margin: 0;
          padding-left: 20px;
        }
        
        /* Sections */
        .section-container {
          margin-bottom: 32px;
          page-break-inside: avoid;
        }
        .section-heading {
          font-size: 15pt;
          font-weight: 600;
          color: #1F5C99;
          border-bottom: 1px solid #DEE2E6;
          padding-bottom: 6px;
          margin: 24px 0 16px 0;
        }
        .section-body h4 {
          font-size: 12pt;
          font-weight: 600;
          color: #212529;
          margin: 16px 0 8px 0;
        }
        .section-body p {
          margin: 0 0 12px 0;
        }
        .section-body ul, .section-body ol {
          margin: 0 0 16px 0;
          padding-left: 20px;
        }
        .section-body li {
          margin-bottom: 6px;
        }
        
        /* Images */
        .image-container {
          text-align: center;
          margin: 16px 0;
        }
        .image-container img {
          max-width: 80%;
          max-height: 250px;
          border-radius: 6px;
          box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        }
      </style>
    </head>
    <body>
      ${contentHtml}
    </body>
    </html>
  `;
}

/**
 * Renders HTML page to PDF file using Puppeteer
 */
async function renderHtmlToPdf(htmlContent, destPdfPath) {
  if (!puppeteer) throw new Error('Puppeteer is not installed.');
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: getChromePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files']
    });
    
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    await page.pdf({
      path: destPdfPath,
      format: 'A4',
      margin: {
        top: '20mm',
        bottom: '20mm',
        left: '20mm',
        right: '20mm'
      },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>', // empty header
      footerTemplate: `
        <div style="font-family: 'Inter', sans-serif; font-size: 8pt; color: #6C757D; width: 100%; text-align: center; padding: 5px 20mm; border-top: 1px solid #E9ECEF;">
          Page <span class="pageNumber"></span> of <span class="totalPages"></span>
        </div>
      `
    });
    
    await browser.close();
    console.log(`[pdfRenderer] PDF successfully saved: ${destPdfPath}`);
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }
}

/**
 * Builds and renders the lesson PDF
 */
async function buildLessonPdf(structure, generatedSections, imagesMap, destPdfPath) {
  const html = buildHtmlDocument(structure, generatedSections, imagesMap);
  await renderHtmlToPdf(html, destPdfPath);
}

module.exports = { buildLessonPdf, renderHtmlToPdf, markdownToHtml };
