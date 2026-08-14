// slidesGenerator.js — generates a styled classroom slide deck (pptx) using pptxgenjs
const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');

// Color Theme (matches DocBuilder)
const C = {
  bgGreen:    '1A7A4A',
  bgBlue:     '1F5C99',
  bgSubBlue:  '2E75B6',
  bgLight:    'F8F9FA',
  textDark:   '212121',
  textLight:  'FFFFFF',
  grey:       '6C757D',
};

/**
 * Parses section text into clean slides (each slide gets a title and list of bullets/paragraphs)
 */
function parseSectionToSlides(sectionLabel, rawText) {
  const slides = [];
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  
  let currentBullets = [];
  let slideTitle = sectionLabel;
  let slideSub = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip the main emoji header (already used as slide title)
    if (/^[🌟✏️🧠⭐📝💡🌍]/.test(line)) {
      continue;
    }
    
    // Headings can start new slides or serve as sub-headers
    if (line.startsWith('#') || line.startsWith('##') || line.startsWith('###')) {
      if (currentBullets.length > 0) {
        slides.push({ title: slideTitle, subtitle: slideSub, bullets: currentBullets });
        currentBullets = [];
      }
      slideTitle = line.replace(/^#+\s+/, '');
      continue;
    }
    
    // Example headings
    if (/^(Example|Step|Part [A-C]|Answer:|Working:)\b/.test(line)) {
      if (currentBullets.length > 4) {
        slides.push({ title: slideTitle, subtitle: slideSub, bullets: currentBullets });
        currentBullets = [];
      }
      currentBullets.push({ text: line, bold: true });
      continue;
    }
    
    // Bold labels
    if (/^\*\*(.+)\*\*$/.test(line)) {
      const txt = line.replace(/\*\*/g, '');
      currentBullets.push({ text: txt, bold: true });
      continue;
    }
    
    // Bullet or number formats
    if (/^[-•*\d+[\.\)]\s]/.test(line)) {
      const cleanLine = line.replace(/^([-•*]|\d+[\.\)])\s+/, '');
      currentBullets.push({ text: cleanLine, indent: 1 });
      continue;
    }
    
    // Regular text
    currentBullets.push({ text: line });
    
    // Split slide if it gets too full (cap at 4 bullets to prevent overflow)
    if (currentBullets.length >= 4) {
      slides.push({ title: slideTitle, subtitle: slideSub, bullets: currentBullets });
      currentBullets = [];
    }
  }
  
  if (currentBullets.length > 0) {
    slides.push({ title: slideTitle, subtitle: slideSub, bullets: currentBullets });
  }
  
  // Ensure we have at least one slide for the section
  if (slides.length === 0) {
    slides.push({ title: sectionLabel, subtitle: '', bullets: [{ text: rawText.slice(0, 300) }] });
  }
  
  return slides;
}

/**
 * Builds the PPTX presentation and returns a Buffer
 */
async function buildSlides(lesson, generatedSections, imagesMap = {}) {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';
  
  // ─── 1. Title Slide ───
  const titleSlide = pptx.addSlide();
  
  // Background Block
  titleSlide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: '100%', h: '100%',
    fill: { color: C.bgBlue }
  });
  
  // Lesson Title
  titleSlide.addText(`Lesson ${lesson.number}`, {
    x: 0.8, y: 1.5, w: 11.5, h: 0.8,
    fontSize: 28, bold: true, color: C.textLight, fontFace: 'Arial'
  });
  
  titleSlide.addText(lesson.title, {
    x: 0.8, y: 2.3, w: 11.5, h: 1.5,
    fontSize: 44, bold: true, color: C.textLight, fontFace: 'Arial'
  });
  
  // Description & Metadata
  titleSlide.addText(lesson.description || '', {
    x: 0.8, y: 4.0, w: 11.5, h: 1.0,
    fontSize: 18, color: 'E8F4FD', italic: true, fontFace: 'Arial'
  });
  
  titleSlide.addText(`Grade ${lesson.grade || 4} Mathematics  |  Curriculum NCP 2022`, {
    x: 0.8, y: 5.5, w: 11.5, h: 0.5,
    fontSize: 14, color: 'B8D8F0', fontFace: 'Arial'
  });
  
  // ─── 2. SLO Slide ───
  const sloSlide = pptx.addSlide();
  
  // Title
  sloSlide.addText('Student Learning Outcomes (SLOs)', {
    x: 0.8, y: 0.6, w: 11.5, h: 0.8,
    fontSize: 28, bold: true, color: C.bgBlue, fontFace: 'Arial'
  });
  
  // Underline
  sloSlide.addShape(pptx.ShapeType.line, {
    x: 0.8, y: 1.4, w: 11.5, h: 0.05,
    line: { color: C.bgSubBlue, width: 2 }
  });
  
  // SLO list
  const sloTextObjects = lesson.slos.map((code, idx) => {
    return { text: `${code}: ${lesson.slo_descriptions[idx] || ''}`, options: { bullet: true, fontFace: 'Arial', fontSize: 16, color: C.textDark, margin: [0, 0, 10, 0] } };
  });
  
  sloSlide.addText(sloTextObjects, {
    x: 0.8, y: 1.8, w: 11.5, h: 4.5,
    valign: 'top'
  });
  
  // ─── 3. Content Sections ───
  const sectionDefs = [
    { key: 'warmUp',            label: '🌟 Warm-Up'             },
    { key: 'conceptBuilding',   label: '📖 Concept Building'    },
    { key: 'examples',          label: '💡 Worked Examples'     },
    { key: 'keyTakeaways',      label: '⭐ Key Takeaways'       },
  ];
  
  for (const sec of sectionDefs) {
    const rawText = generatedSections[sec.key];
    if (!rawText) continue;
    
    let parsedSlides = parseSectionToSlides(sec.label, rawText);
    
    const hasImage = imagesMap[sec.key] ? true : false;
    
    parsedSlides.forEach((slideData, slideIdx) => {
      const slide = pptx.addSlide();
      
      // Header
      slide.addText(slideData.title, {
        x: 0.8, y: 0.5, w: 11.5, h: 0.6,
        fontSize: 24, bold: true, color: C.bgBlue, fontFace: 'Arial'
      });
      
      slide.addShape(pptx.ShapeType.line, {
        x: 0.8, y: 1.1, w: 11.5, h: 0.02,
        line: { color: C.bgSubBlue, width: 1.5 }
      });
      
      // Footer slide number / lesson title
      slide.addText(`Lesson ${lesson.number}: ${lesson.title}`, {
        x: 0.8, y: 6.8, w: 10.0, h: 0.3,
        fontSize: 10, color: C.grey, fontFace: 'Arial'
      });
      
      // If slide has image (and this is the first slide of the section), place side-by-side
      const imageRelPath = imagesMap[sec.key];
      if (hasImage && slideIdx === 0 && imageRelPath) {
        const fullImagePath = path.join(__dirname, 'public', imageRelPath);
        
        if (fs.existsSync(fullImagePath)) {
          // Left side: Text
          const bulletObjects = slideData.bullets.map(b => {
            return {
              text: b.text,
              options: {
                bullet: b.indent ? true : false,
                bold: b.bold ? true : false,
                fontSize: 14,
                color: C.textDark,
                fontFace: 'Arial'
              }
            };
          });
          
          slide.addText(bulletObjects, {
            x: 0.8, y: 1.4, w: 5.8, h: 4.8,
            valign: 'top'
          });
          
          // Right side: Image
          slide.addImage({
            path: fullImagePath,
            x: 7.0, y: 1.6, w: 5.3, h: 4.0,
            sizing: { type: 'contain' }
          });
        } else {
          // Fallback if image doesn't exist
          renderBulletsFullWidth(slide, slideData.bullets);
        }
      } else {
        // Full width text
        renderBulletsFullWidth(slide, slideData.bullets);
      }
    });
  }
  
  // Return slide deck buffer
  return await pptx.write('nodebuffer');
}

function renderBulletsFullWidth(slide, bullets) {
  const bulletObjects = bullets.map(b => {
    return {
      text: b.text,
      options: {
        bullet: b.indent ? true : false,
        bold: b.bold ? true : false,
        fontSize: 15,
        color: C.textDark,
        fontFace: 'Arial'
      }
    };
  });
  
  slide.addText(bulletObjects, {
    x: 0.8, y: 1.4, w: 11.5, h: 5.0,
    valign: 'top'
  });
}

module.exports = { buildSlides };
