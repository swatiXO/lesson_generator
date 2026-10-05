// slidesGenerator.js — Mediatiz Foundation template
// Structure: Title → SLOs → Content slides (concept + examples only) → Summary grid → Practice → Thank You
const fs   = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  navy:     '1B3A5C',
  teal:     '0E7C86',
  ltTeal:   '9FD8DE',
  paleTeal: 'CFE7EA',
  card:     'F4F9FA',
  white:    'FFFFFF',
  body:     '222222',
  grey:     '666666',
};

// ── Tag / noise stripping ─────────────────────────────────────────────────────

function stripGenericNoise(text) {
  if (!text) return '';
  return text
    .replace(/\[VISUAL:[^\]]*\]/gi, '')
    // SLO_CHECK / QUALITY_CHECK are separate <!-- X_START --> / <!-- X_END -->
    // tags, so match the pair by name to remove the text between them too.
    .replace(/<!--\s*(\w+)_START\s*-->[\s\S]*?<!--\s*\1_END\s*-->/gi, '')
    // Any leftover unpaired comment tag
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*←+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripEntireBoxes(text, tagNames) {
  if (!text) return text;
  let result = text;
  for (const tag of tagNames) {
    const regex = new RegExp(`\\[${tag}_START\\][\\s\\S]*?\\[${tag}_END\\]`, 'gi');
    result = result.replace(regex, '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function extractPracticeQuestionsForSlide(rawText, maxCount = 6) {
  if (!rawText) return [];
  let text = stripEntireBoxes(rawText, ['ANSWERKEY']);
  text = text.replace(/\[(WORDPROBLEM|CHALLENGE)_START\]([\s\S]*?)\[\1_END\]/gi, (match, tag, inner) => {
    return inner.split(/Answer Key:/i)[0];
  });
  text = stripGenericNoise(text)
    .replace(/^\s*\[\w+_START\]\s*$/gim, '')
    .replace(/^\s*\[\w+_END\]\s*$/gim, '');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines
    .filter(l => /^\d+[.)]\s|^[-•]\s|^\(?[ivxIVX]+\)\s/.test(l))
    .map(l => l.replace(/^([-•*]|\d+[.)]|\(?[ivxIVX]+\))\s*/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .slice(0, maxCount);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function addSectionBadge(slide, pptx, num) {
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 0.42, y: 0.52, w: 0.56, h: 0.56,
    fill: { color: C.teal }, line: { width: 0 },
  });
  slide.addText(String(num), {
    x: 0.42, y: 0.52, w: 0.56, h: 0.56,
    fontSize: 20, bold: true, color: C.white,
    fontFace: 'Calibri', align: 'center', valign: 'middle', margin: 0,
  });
}

function addSlideTitle(slide, title) {
  slide.addText(title, {
    x: 1.15, y: 0.42, w: 11.8, h: 0.72,
    fontSize: 30, bold: true, color: C.navy,
    fontFace: 'Cambria', valign: 'middle', margin: 0,
  });
}

function addFooter(slide, lessonLabel, pageNum) {
  slide.addText(lessonLabel, {
    x: 0.3, y: 7.15, w: 12.0, h: 0.25,
    fontSize: 8, color: C.grey, fontFace: 'Calibri', align: 'left', margin: 0,
  });
  slide.addText(String(pageNum), {
    x: 12.8, y: 7.15, w: 0.4, h: 0.25,
    fontSize: 8, color: C.grey, fontFace: 'Calibri', align: 'right', margin: 0,
  });
}

function addBullets(slide, items, opts = {}) {
  const { x = 0.42, y = 1.4, w = 11.9, h = 5.4 } = opts;
  if (!items || items.length === 0) return;
  const paras = items.map((item, i) => ({
    text: (item.text || item || '').replace(/\*\*/g, ''),
    options: {
      // Everything is bulleted except in-slide sub-headers (noBullet).
      // Must be the boolean form: pptxgenjs silently ignores { type: 'bullet' }.
      bullet: item.noBullet ? false : true,
      bold:   item.bold   ? true : false,
      fontSize: 15,
      color: C.body,
      fontFace: 'Calibri',
      paraSpaceAfter: 10,
      breakLine: i < items.length - 1,
    },
  }));
  slide.addText(paras, { x, y, w, h, valign: 'top', margin: 0 });
}

// ── Parser ────────────────────────────────────────────────────────────────────
//
// A new slide starts when the accumulated bullets would overflow the text box,
// estimated from character counts (pptxgenjs can't measure wrapped height).
// Budgets for the narrower image-present layout (6.8in) because whether an
// image gets attached isn't known yet; slight under-fill beats overflow.
const CHARS_PER_LINE_ESTIMATE = 70;   // conservative estimate for the narrower (image-present) 6.8in-wide layout at 15pt
const MAX_ESTIMATED_LINES = 13;       // budget for the 5.4in-tall bullet box at 15pt font + paragraph spacing
const MAX_BULLETS_HARD_CAP = 10;      // safety net so one slide never gets absurdly fragment-heavy regardless of estimate

function estimateLines(text) {
  return Math.max(1, Math.ceil((text || '').length / CHARS_PER_LINE_ESTIMATE));
}

function parseSectionToSlides(sectionLabel, rawText) {
  const text = stripGenericNoise(rawText);

  const slides = [];
  const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);

  let currentTitle       = sectionLabel;
  let currentBullets     = [];
  let estimatedLinesUsed = 0;

  const flush = () => {
    if (currentBullets.length > 0) {
      slides.push({ title: currentTitle, bullets: [...currentBullets] });
      currentBullets = [];
      estimatedLinesUsed = 0;
    }
  };

  const addBullet = (bulletObj) => {
    const thisEstimate = estimateLines(bulletObj.text);
    // Flush BEFORE adding if this bullet would overflow the estimated
    // budget — unless the slide is currently empty (always allow at least
    // one bullet per slide, even an unusually long one, rather than
    // producing an empty slide or looping forever).
    if (currentBullets.length > 0 &&
        (estimatedLinesUsed + thisEstimate > MAX_ESTIMATED_LINES ||
         currentBullets.length >= MAX_BULLETS_HARD_CAP)) {
      flush();
    }
    currentBullets.push(bulletObj);
    estimatedLinesUsed += thisEstimate;
  };

  for (const line of lines) {
    if (/^\[.+\]$/.test(line)) continue;

    const isWorkedExampleLabel = /^⭐\s*Worked Example/i.test(line);
    if (!isWorkedExampleLabel && /^[\u{1F300}-\u{1FAFF}\u2705\u2728\u2b50]+\s/u.test(line) && line.length < 60) continue;

    if (/^\*{0,2}(SLO Coverage Check|Quality Self-Check|Every Part has|Every worked example|Sub-concepts opening)/i.test(line)) continue;

    if (/^#{1,3}\s/.test(line)) {
      flush();
      currentTitle = line.replace(/^#+\s+/, '').replace(/\*\*/g, '');
      continue;
    }

    if (isWorkedExampleLabel) {
      addBullet({ text: line, bold: true, noBullet: true });
    }
    else if (/^\*\*(.+)\*\*$/.test(line)) {
      addBullet({ text: line.replace(/\*\*/g, ''), bold: true });
    }
    else if (/^[-•*]|\d+[.)]\s/.test(line)) {
      addBullet({
        text: line.replace(/^([-•*]|\d+[.)]) ?/, '').replace(/\*\*/g, ''),
        indent: 1,
      });
    }
    else {
      addBullet({ text: line.replace(/\*\*/g, '') });
    }
  }

  flush();

  if (slides.length === 0) {
    slides.push({ title: sectionLabel, bullets: [{ text: text.slice(0, 300) }] });
  }

  return slides;
}

// ── Main Export ───────────────────────────────────────────────────────────────
async function buildSlides(lesson, generatedSections, imagesMap = {}) {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';

  const footerLabel = `Lesson ${lesson.number}: ${lesson.title}`;
  let pageNum = 1;

  {
    const s = pptx.addSlide();
    s.background = { color: C.navy };

    s.addShape(pptx.ShapeType.ellipse, {
      x: 10.6, y: -1.6, w: 4.2, h: 4.2,
      fill: { color: C.teal, transparency: 70 }, line: { width: 0 },
    });
    s.addShape(pptx.ShapeType.ellipse, {
      x: -1.4, y: 5.4, w: 3.6, h: 3.6,
      fill: { color: C.teal, transparency: 75 }, line: { width: 0 },
    });

    s.addText('MEDIATIZ FOUNDATION', {
      x: 0.8, y: 0.7, w: 11.73, h: 0.4,
      fontSize: 13, bold: true, color: C.ltTeal,
      fontFace: 'Calibri', align: 'center', margin: 0,
    });
    s.addText(`Self-Study Mathematics Program — Grade ${lesson.grade || 4}`, {
      x: 0.8, y: 1.1, w: 11.73, h: 0.4,
      fontSize: 14, color: C.paleTeal,
      fontFace: 'Calibri', align: 'center', margin: 0,
    });
    s.addText(lesson.description || `Grade ${lesson.grade || 4} Mathematics`, {
      x: 0.8, y: 2.9, w: 11.73, h: 0.5,
      fontSize: 18, bold: true, color: C.paleTeal,
      fontFace: 'Calibri', align: 'center', margin: 0,
    });
    s.addText(lesson.title, {
      x: 0.8, y: 3.35, w: 11.73, h: 1.1,
      fontSize: 44, bold: true, color: C.white,
      fontFace: 'Cambria', align: 'center', margin: 0,
    });

    s.addShape(pptx.ShapeType.roundRect, {
      x: 3.16, y: 4.65, w: 7.0, h: 0.75,
      fill: { color: C.teal }, line: { width: 0 }, rectRadius: 0.15,
    });
    s.addText(`Lesson ${lesson.number}: ${lesson.title}`, {
      x: 3.16, y: 4.65, w: 7.0, h: 0.75,
      fontSize: 15, bold: true, color: C.white,
      fontFace: 'Calibri', align: 'center', valign: 'middle', margin: 0,
    });

    pageNum++;
  }

  {
    const s = pptx.addSlide();
    s.background = { color: C.white };

    s.addText('Student Learning Outcomes', {
      x: 0.7, y: 0.5, w: 11.93, h: 0.8,
      fontSize: 32, bold: true, color: C.navy, fontFace: 'Cambria', margin: 0,
    });
    s.addText('By the end of this lesson, students will be able to:', {
      x: 0.7, y: 1.25, w: 11.93, h: 0.38,
      fontSize: 15, color: C.grey, fontFace: 'Calibri', margin: 0,
    });

    const slos  = lesson.slos || [];
    const descs = lesson.slo_descriptions || [];
    const count = Math.min(slos.length, 6);
    const cardH  = count <= 4 ? 1.05 : 0.82;
    const startY = 1.75;
    const gap    = 0.08;

    for (let i = 0; i < count; i++) {
      const y = startY + i * (cardH + gap);
      s.addShape(pptx.ShapeType.roundRect, {
        x: 0.7, y, w: 11.93, h: cardH,
        fill: { color: C.card }, line: { width: 0 }, rectRadius: 0.08,
      });
      s.addShape(pptx.ShapeType.ellipse, {
        x: 1.0, y: y + (cardH - 0.58) / 2, w: 0.58, h: 0.58,
        fill: { color: C.teal }, line: { width: 0 },
      });
      s.addText(String(i + 1), {
        x: 1.0, y: y + (cardH - 0.58) / 2, w: 0.58, h: 0.58,
        fontSize: 20, bold: true, color: C.white,
        fontFace: 'Calibri', align: 'center', valign: 'middle', margin: 0,
      });
      s.addText(slos[i] || '', {
        x: 1.72, y: y + (cardH - 0.5) / 2, w: 1.7, h: 0.5,
        fontSize: 13, bold: true, color: C.teal, fontFace: 'Calibri', margin: 0,
      });
      s.addText(descs[i] || '', {
        x: 3.6, y: y + 0.08, w: 8.8, h: cardH - 0.16,
        fontSize: 15, color: C.body, fontFace: 'Calibri', valign: 'middle', margin: 0,
      });
    }

    addFooter(s, footerLabel, pageNum++);
  }

  // ── SLIDE 3 — Introduction ────────────────────────────────────────────────
  // Rendered as flowing prose, deliberately NOT bulleted — introductionPrompt
  // produces continuous narrative (a hook, no headings, one closing preview
  // sentence), and breaking that into bullet points would fragment a story
  // into disconnected fragments. Split on blank lines if the model happened
  // to produce paragraph breaks; otherwise shown as one flowing block.
  {
    const rawIntro = stripGenericNoise(generatedSections.introduction || '');
    if (rawIntro) {
      const s = pptx.addSlide();
      s.background = { color: C.white };

      s.addText('Introduction', {
        x: 0.7, y: 0.5, w: 11.93, h: 0.8,
        fontSize: 32, bold: true, color: C.navy, fontFace: 'Cambria', margin: 0,
      });

      const introParagraphs = rawIntro
        .split(/\n\s*\n/)
        .map(p => p.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      const paras = (introParagraphs.length ? introParagraphs : [rawIntro]).map((p, i) => ({
        text: p,
        options: {
          fontSize: 17,
          color: C.body,
          fontFace: 'Calibri',
          paraSpaceAfter: 16,
          breakLine: i < introParagraphs.length - 1,
        },
      }));

      s.addText(paras, { x: 0.7, y: 1.7, w: 11.93, h: 5.0, valign: 'top', margin: 0 });

      addFooter(s, footerLabel, pageNum++);
    }
  }

  {
    const rawConceptWithBoxes = generatedSections.conceptBuilding;
    if (rawConceptWithBoxes) {
      const rawConcept = stripEntireBoxes(rawConceptWithBoxes, ['YOURTURN', 'WARMUP']);
      const parsedSlides  = parseSectionToSlides('Concept Building', rawConcept);
      const sectionImages = imagesMap.conceptBuilding || {};

      parsedSlides.forEach((slideData, slideIdx) => {
        const s = pptx.addSlide();
        s.background = { color: C.white };

        addSectionBadge(s, pptx, slideIdx + 1);
        addSlideTitle(s, slideData.title);

        const imageEntry =
          sectionImages[slideData.title] ||
          (slideIdx === 0 ? Object.values(sectionImages)[0] || null : null);

        const imageRelPath = imageEntry ? imageEntry.path : null;
        const fullImagePath = imageRelPath
          ? path.join(__dirname, 'public', imageRelPath)
          : null;
        const useImage = fullImagePath && fs.existsSync(fullImagePath);

        if (useImage) {
          addBullets(s, slideData.bullets, { x: 0.42, y: 1.4, w: 6.8, h: 5.4 });
          s.addImage({
            path: fullImagePath,
            x: 7.4, y: 1.3, w: 5.5, h: 5.5,
            sizing: { type: 'contain' },
          });
          let caption = null;
          if (imageEntry.source === 'placeholder') {
            caption = imageEntry.query
              ? `Suggested image: "${imageEntry.query}"`
              : 'Image not available — please add manually';
          } else if (imageEntry.source === 'svg_diagram') {
            caption = 'AI-generated diagram — verify before use';
          }
          if (caption) {
            s.addText(caption, {
              x: 7.4, y: 6.85, w: 5.5, h: 0.3,
              fontSize: 9, italic: true, color: C.grey,
              fontFace: 'Calibri', align: 'center', margin: 0,
            });
          }
        } else {
          addBullets(s, slideData.bullets, { x: 0.42, y: 1.4, w: 11.9, h: 5.4 });
        }

        addFooter(s, footerLabel, pageNum++);
      });
    }
  }

  {
    const rawTakeaways = stripGenericNoise(generatedSections.keyTakeaways || '');

    const summaryPoints = rawTakeaways
      .split('\n')
      .map(l => l.trim())
      .filter(l =>
        l &&
        !/^#{1,3}\s/.test(l) &&
        !/^[\u{1F300}-\u{1FAFF}\u2705\u2728\u2b50]+\s/u.test(l) &&
        !/^\[.+\]$/.test(l) &&
        !/^(Answer Key|Quality Self-Check|SLO Coverage)/i.test(l)
      )
      .map(l => l.replace(/^([-•*]|\d+[.)]) ?/, '').replace(/\*\*/g, '').trim())
      .filter(Boolean)
      .slice(0, 6);

    if (summaryPoints.length > 0) {
      const s = pptx.addSlide();
      s.background = { color: C.white };

      s.addText('Key Summary Points', {
        x: 0.7, y: 0.42, w: 11.93, h: 0.8,
        fontSize: 32, bold: true, color: C.navy, fontFace: 'Cambria', margin: 0,
      });

      const cols = 2, cW = 5.9, cH = 1.55;
      const startX = 0.55, startY = 1.45, gX = 0.3, gY = 0.2;

      summaryPoints.forEach((pt, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = startX + col * (cW + gX);
        const y = startY + row * (cH + gY);

        s.addShape(pptx.ShapeType.roundRect, {
          x, y, w: cW, h: cH,
          fill: { color: C.card }, line: { width: 0 }, rectRadius: 0.1,
        });
        s.addText('★', {
          x: x + 0.15, y: y + 0.15, w: 0.4, h: 0.4,
          fontSize: 16, color: C.teal, fontFace: 'Calibri', align: 'center', margin: 0,
        });
        s.addText(pt, {
          x: x + 0.6, y: y + 0.1, w: cW - 0.75, h: cH - 0.2,
          fontSize: 13.5, color: C.body, fontFace: 'Calibri', valign: 'middle', margin: 0,
        });
      });

      addFooter(s, footerLabel, pageNum++);
    }
  }

  {
    const questions = extractPracticeQuestionsForSlide(generatedSections.practiceQuestions, 6);

    if (questions.length > 0) {
      const s = pptx.addSlide();
      s.background = { color: C.card };

      s.addText('Practice Questions', {
        x: 0.7, y: 0.42, w: 11.5, h: 0.8,
        fontSize: 32, bold: true, color: C.navy, fontFace: 'Cambria', margin: 0,
      });

      s.addShape(pptx.ShapeType.ellipse, {
        x: 12.1, y: 0.35, w: 0.8, h: 0.8,
        fill: { color: C.teal }, line: { width: 0 },
      });
      s.addText('?', {
        x: 12.1, y: 0.35, w: 0.8, h: 0.8,
        fontSize: 26, bold: true, color: C.white,
        fontFace: 'Calibri', align: 'center', valign: 'middle', margin: 0,
      });

      s.addText('Answer each question in your notebook.', {
        x: 0.7, y: 1.25, w: 11.93, h: 0.35,
        fontSize: 14, color: C.grey, fontFace: 'Calibri', margin: 0,
      });

      const cols = 2, cW = 6.0, cH = 1.55;
      const startX = 0.55, startY = 1.75, gX = 0.2, gY = 0.15;

      questions.forEach((q, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = startX + col * (cW + gX);
        const y = startY + row * (cH + gY);

        s.addShape(pptx.ShapeType.roundRect, {
          x, y, w: cW, h: cH,
          fill: { color: C.white }, line: { width: 0 }, rectRadius: 0.1,
        });
        s.addText(String(i + 1) + '.', {
          x: x + 0.15, y: y + 0.1, w: 0.45, h: cH - 0.2,
          fontSize: 15, bold: true, color: C.teal,
          fontFace: 'Calibri', valign: 'top', margin: 0,
        });
        s.addText(q, {
          x: x + 0.6, y: y + 0.1, w: cW - 0.75, h: cH - 0.2,
          fontSize: 14, color: C.body,
          fontFace: 'Calibri', valign: 'middle', margin: 0,
        });
      });

      addFooter(s, footerLabel, pageNum++);
    }
  }

  {
    const s = pptx.addSlide();
    s.background = { color: C.navy };

    s.addShape(pptx.ShapeType.ellipse, {
      x: 10.6, y: -1.6, w: 4.2, h: 4.2,
      fill: { color: C.teal, transparency: 70 }, line: { width: 0 },
    });
    s.addShape(pptx.ShapeType.ellipse, {
      x: -1.4, y: 5.4, w: 3.6, h: 3.6,
      fill: { color: C.teal, transparency: 75 }, line: { width: 0 },
    });

    s.addText('Thank You!', {
      x: 0.8, y: 2.5, w: 11.73, h: 1.0,
      fontSize: 44, bold: true, color: C.white,
      fontFace: 'Cambria', align: 'center', margin: 0,
    });
    s.addText(`Great work completing Lesson ${lesson.number}!`, {
      x: 0.8, y: 3.65, w: 11.73, h: 0.5,
      fontSize: 18, color: C.paleTeal,
      fontFace: 'Calibri', align: 'center', margin: 0,
    });
    s.addText('Mediatiz Foundation  —  Self-Study Mathematics Program', {
      x: 0.8, y: 6.9, w: 11.73, h: 0.35,
      fontSize: 11, color: C.ltTeal,
      fontFace: 'Calibri', align: 'center', margin: 0,
    });
  }

  return await pptx.write('nodebuffer');
}

module.exports = { buildSlides };