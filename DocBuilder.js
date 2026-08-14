// docBuilder.js — assembles LLM-generated text into a formatted .docx
const docx = require('docx');
const {
  Document, Packer, Paragraph, TextRun,
  Header, Footer, AlignmentType, LevelFormat, HeadingLevel,
  BorderStyle, PageNumber, PageBreak,
  Table, TableRow, TableCell, WidthType,
  Math: DocxMath, MathRun, MathFraction, MathSuperScript, MathSubScript,
  MathSubSuperScript, MathRadical, MathRoundBrackets,
} = docx;

const C = {
  unitGreen:  "1A7A4A",
  lessonBlue: "1F5C99",
  subBlue:    "2E75B6",
  white:      "FFFFFF",
  textDark:   "212121",
  midGrey:    "6C757D",
};

// ─── Basic helpers ────────────────────────────────────────────────
function run(text, opts = {}) {
  return new TextRun({
    text: String(text),
    font: "Arial",
    size:    opts.size   || 22,
    color:   opts.color  || C.textDark,
    bold:    opts.bold   || false,
    italics: opts.italic || false,
  });
}

function para(text, before = 80, after = 80) {
  return new Paragraph({
    spacing: { before, after },
    children: [run(String(text))],
  });
}

function gap(sz = 160) {
  return new Paragraph({ spacing: { before: 0, after: sz }, children: [new TextRun("")] });
}

function pageBreak() { return new Paragraph({ children: [new PageBreak()] }); }

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 160 },
    children: [run(text, { bold: true, size: 36, color: C.unitGreen })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120 },
    children: [run(text, { bold: true, size: 30, color: C.lessonBlue })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 220, after: 100 },
    children: [run(text, { bold: true, size: 26, color: C.subBlue })],
  });
}

function h4(text) {
  return new Paragraph({
    spacing: { before: 160, after: 80 },
    children: [run(text, { bold: true, size: 24 })],
  });
}

function bulletPara(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { before: 60, after: 60 },
    children: [run(String(text))],
  });
}

function numPara(text) {
  return new Paragraph({
    numbering: { reference: "numbers", level: 0 },
    spacing: { before: 60, after: 60 },
    children: [run(String(text))],
  });
}

// ─── Math (equation) rendering ─────────────────────────────────────
// Converts a subset of LaTeX into docx OMML Math components.
// Supports: \frac{a}{b}, ^x / ^{xy} (superscript), _x / _{xy} (subscript),
// \sqrt{x} / \sqrt[n]{x}, ( ) grouping, and common symbols
// (\times \div \pm \mp \cdot \leq \geq \neq \approx \infty \pi \alpha \beta
//  \gamma \theta \Delta \degree).
const MATH_SYMBOLS = {
  '\\times':   '×',
  '\\div':     '÷',
  '\\pm':      '±',
  '\\mp':      '∓',
  '\\cdot':    '·',
  '\\leq':     '≤',
  '\\geq':     '≥',
  '\\neq':     '≠',
  '\\approx':  '≈',
  '\\infty':   '∞',
  '\\pi':      'π',
  '\\alpha':   'α',
  '\\beta':    'β',
  '\\gamma':   'γ',
  '\\theta':   'θ',
  '\\Delta':   'Δ',
  '\\degree':  '°',
  '\\%':       '%',
  '\\ ':       ' ',
};

function tokenizeLatex(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{') { tokens.push({ t: 'LBRACE' }); i++; continue; }
    if (ch === '}') { tokens.push({ t: 'RBRACE' }); i++; continue; }
    if (ch === '[') { tokens.push({ t: 'LBRACKET' }); i++; continue; }
    if (ch === ']') { tokens.push({ t: 'RBRACKET' }); i++; continue; }
    if (ch === '^') { tokens.push({ t: 'CARET' }); i++; continue; }
    if (ch === '_') { tokens.push({ t: 'UNDERSCORE' }); i++; continue; }
    if (ch === '\\') {
      // Command: \frac, \sqrt, \times, etc.
      let j = i + 1;
      if (j < src.length && !/[a-zA-Z]/.test(src[j])) {
        // Escaped symbol like \% or \ (space)
        tokens.push({ t: 'CMD', name: '\\' + src[j] });
        i = j + 1;
        continue;
      }
      while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
      tokens.push({ t: 'CMD', name: src.slice(i, j) });
      i = j;
      continue;
    }
    // Plain character — accumulate a run of non-special chars
    let j = i;
    while (j < src.length && !/[{}\[\]^_\\\s]/.test(src[j])) j++;
    if (j === i) j = i + 1; // safety
    tokens.push({ t: 'CHAR', value: src.slice(i, j) });
    i = j;
  }
  return tokens;
}

function parseLatexToMathChildren(src) {
  const tokens = tokenizeLatex(src);
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  // Parses a single braced group {...} and returns its inner MathComponent[]
  function parseGroup() {
    if (peek() && peek().t === 'LBRACE') {
      next(); // consume {
      const children = parseExpression(['RBRACE']);
      if (peek() && peek().t === 'RBRACE') next();
      return children;
    }
    // Not braced — take just the next atom (single char or command)
    return parseSingleAtom();
  }

  function parseBracketGroup() {
    if (peek() && peek().t === 'LBRACKET') {
      next();
      const children = parseExpression(['RBRACKET']);
      if (peek() && peek().t === 'RBRACKET') next();
      return children;
    }
    return null;
  }

  // Parses exactly one atom (char/command run), no postfix scripts
  function parseSingleAtom() {
    const tok = next();
    if (!tok) return [];
    if (tok.t === 'CHAR') return [new MathRun(tok.value)];
    if (tok.t === 'CMD') return [new MathRun(MATH_SYMBOLS[tok.name] || tok.name.replace('\\', ''))];
    return [];
  }

  // Parses one "base" element (possibly a command with arguments like \frac{}{} or \sqrt{}),
  // then applies any trailing ^ / _ scripts.
  function parseBaseWithScripts() {
    const tok = peek();
    let base;

    if (tok && tok.t === 'CMD' && tok.name === '\\frac') {
      next();
      const num = parseGroup();
      const den = parseGroup();
      base = [new MathFraction({ numerator: num, denominator: den })];
    } else if (tok && tok.t === 'CMD' && tok.name === '\\sqrt') {
      next();
      const degree = parseBracketGroup(); // optional [n]
      const radicand = parseGroup();
      base = [new MathRadical(degree ? { children: radicand, degree } : { children: radicand })];
    } else if (tok && tok.t === 'LBRACE') {
      base = parseGroup();
    } else if (tok && tok.t === 'CHAR' && tok.value === '(') {
      next();
      const inner = parseExpression(['CHAR_)']);
      base = [new MathRoundBrackets({ children: inner })];
    } else {
      base = parseSingleAtom();
    }

    // Check for postfix ^ and/or _
    let sup = null, sub = null;
    while (peek() && (peek().t === 'CARET' || peek().t === 'UNDERSCORE')) {
      const scriptTok = next();
      const scriptChildren = parseGroup();
      if (scriptTok.t === 'CARET') sup = scriptChildren;
      else sub = scriptChildren;
    }

    if (sup && sub) return [new MathSubSuperScript({ children: base, subScript: sub, superScript: sup })];
    if (sup) return [new MathSuperScript({ children: base, superScript: sup })];
    if (sub) return [new MathSubScript({ children: base, subScript: sub })];
    return base;
  }

  // Parses a sequence of atoms until a stop condition is hit.
  function parseExpression(stopTokens = []) {
    const result = [];
    while (peek()) {
      const tok = peek();
      if (tok.t === 'RBRACE' || tok.t === 'RBRACKET') break;
      if (tok.t === 'CHAR' && tok.value === ')' && stopTokens.includes('CHAR_)')) {
        next();
        break;
      }
      result.push(...parseBaseWithScripts());
    }
    return result;
  }

  return parseExpression();
}

// Splits a line of text into an array of docx run-like children (TextRun for
// plain text, Math for $...$ segments), for use inside a single Paragraph.
function parseInlineMath(line) {
  const parts = [];
  const regex = /\$([^$]+)\$/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(run(line.slice(lastIndex, match.index)));
    }
    try {
      const mathChildren = parseLatexToMathChildren(match[1]);
      if (mathChildren.length) {
        parts.push(new DocxMath({ children: mathChildren }));
      } else {
        parts.push(run(match[1])); // fallback: render raw if parse produced nothing
      }
    } catch (err) {
      parts.push(run(match[1])); // fallback on any parse error — never break the whole doc
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    parts.push(run(line.slice(lastIndex)));
  }

  if (parts.length === 0) parts.push(run(line));
  return parts;
}

function hasInlineMath(line) {
  return /\$[^$]+\$/.test(line);
}

// ─── Text parser ─────────────────────────────────────────────────
// Converts raw LLM text into docx paragraphs by analysing line patterns
function parseTextToParas(rawText) {
  const paras = [];
  const lines = rawText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { paras.push(gap(80)); continue; }

    // Display/block equations: $$ ... $$ (own centered paragraph)
    if (line.startsWith('$$') && line.endsWith('$$') && line.length > 4) {
      const latex = line.slice(2, -2).trim();
      try {
        const mathChildren = parseLatexToMathChildren(latex);
        paras.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 120 },
          children: [new DocxMath({ children: mathChildren })],
        }));
      } catch (err) {
        paras.push(para(latex));
      }
      continue;
    }

    // Parse markdown tables
    if (line.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      i--; // adjust index because loop will increment it

      const rows = [];
      tableLines.forEach((tLine, rIdx) => {
        let cellsText = tLine.split('|').map(c => c.trim());
        // Remove empty cells at margins
        if (cellsText[0] === '') cellsText.shift();
        if (cellsText[cellsText.length - 1] === '') cellsText.pop();

        // Skip separator row (e.g. |---|---|)
        const isSeparator = cellsText.every(c => /^:-*:?$/.test(c) || c.startsWith('-'));
        if (isSeparator) return;

        const cells = cellsText.map(cellTxt => {
          let isBold = false;
          let cleanText = cellTxt;
          if (cellTxt.startsWith('**') && cellTxt.endsWith('**')) {
            isBold = true;
            cleanText = cellTxt.slice(2, -2);
          } else if (rIdx === 0) {
            isBold = true; // Bold header row
          }

          const cellChildren = hasInlineMath(cleanText)
            ? parseInlineMath(cleanText)
            : [new TextRun({ text: cleanText, font: "Arial", size: 20, bold: isBold })];

          return new TableCell({
            width: { size: 100 / cellsText.length, type: WidthType.PERCENTAGE },
            margins: { top: 100, bottom: 100, left: 150, right: 150 },
            shading: rIdx === 0 ? { fill: "F2F2F2" } : undefined,
            children: [ new Paragraph({ children: cellChildren }) ]
          });
        });

        rows.push(new TableRow({ cells }));
      });

      if (rows.length > 0) {
        const table = new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows
        });
        paras.push(table);
      }
      continue;
    }

    // Headings
    if (line.startsWith('#### ')) { paras.push(h4(line.slice(5))); continue; }
    if (line.startsWith('### '))  { paras.push(h3(line.slice(4))); continue; }
    if (line.startsWith('## '))   { paras.push(h2(line.slice(3))); continue; }
    if (line.startsWith('# '))    { paras.push(h1(line.slice(2))); continue; }

    // Emoji section headers (Warm-Up, Key Takeaways, etc.)
    if (/^[🌟✏️🧠⭐📝💡🌍]/.test(line)) {
      paras.push(new Paragraph({
        spacing: { before: 160, after: 80 },
        children: [run(line, { bold: true, size: 24, color: C.lessonBlue })],
      }));
      continue;
    }

    // Bold label lines like "**Example 1**" or "Example 1:" or "Step 1:"
    if (/^\*\*(.+)\*\*$/.test(line)) {
      const inner = line.replace(/\*\*/g, '');
      const children = hasInlineMath(inner)
        ? parseInlineMath(inner)
        : [run(inner, { bold: true })];
      paras.push(new Paragraph({
        spacing: { before: 120, after: 60 },
        children,
      }));
      continue;
    }
    if (/^(Example|Step|Part [A-C]|Answer:|Working:)\b/.test(line)) {
      const children = hasInlineMath(line)
        ? parseInlineMath(line)
        : [run(line, { bold: true })];
      paras.push(new Paragraph({
        spacing: { before: 100, after: 60 },
        children,
      }));
      continue;
    }

    // Numbered list items: "1." "2." "1)" "2)"
    if (/^\d+[\.\)]\s/.test(line)) {
      const inner = line.replace(/^\d+[\.\)]\s/, '');
      if (hasInlineMath(inner)) {
        paras.push(new Paragraph({
          numbering: { reference: "numbers", level: 0 },
          spacing: { before: 60, after: 60 },
          children: parseInlineMath(inner),
        }));
      } else {
        paras.push(numPara(inner));
      }
      continue;
    }

    // Bullet items: "- " "• " "* "
    if (/^[-•*]\s/.test(line)) {
      const inner = line.replace(/^[-•*]\s/, '');
      if (hasInlineMath(inner)) {
        paras.push(new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          spacing: { before: 60, after: 60 },
          children: parseInlineMath(inner),
        }));
      } else {
        paras.push(bulletPara(inner));
      }
      continue;
    }

    // Letter sub-items: "a." "b." "a)" "b)"
    if (/^[a-d][\.\)]\s/.test(line)) {
      paras.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { left: 480 },
        children: hasInlineMath(line) ? parseInlineMath(line) : [run(line)],
      }));
      continue;
    }

    // Indented lines (4+ spaces or tab)
    if (/^(\s{4}|\t)/.test(lines[i])) {
      paras.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { left: 480 },
        children: hasInlineMath(line) ? parseInlineMath(line) : [run(line)],
      }));
      continue;
    }

    // Normal paragraph
    if (hasInlineMath(line)) {
      paras.push(new Paragraph({ spacing: { before: 80, after: 80 }, children: parseInlineMath(line) }));
    } else {
      paras.push(para(line));
    }
  }

  return paras;
}

// ─── SLO list ─────────────────────────────────────────────────────
function sloList(lesson) {
  const items = [];
  lesson.slos.forEach((code, i) => {
    items.push(new Paragraph({
      spacing: { before: 60, after: 60 },
      children: [
        run(code + ": ", { bold: true }),
        run(lesson.slo_descriptions[i] || ""),
      ],
    }));
  });
  return items;
}

// ─── Main builder ─────────────────────────────────────────────────
async function buildDocx(structure, generatedSections) {
  const { chapter, lessons } = structure;
  const children = [];

  // Chapter title page
  children.push(
    h1(`Chapter ${chapter.number}: ${chapter.title}`),
    gap(100),
    para(`Grade ${chapter.grade}  |  ${chapter.strand || "Mathematics"}`, 0, 60),
    gap(80),
    para(chapter.overview || ""),
    gap(160),
  );

  // Each lesson
  for (let li = 0; li < lessons.length; li++) {
    const lesson = lessons[li];
    const sections = generatedSections[li] || {};

    if (li > 0) children.push(pageBreak());

    // Lesson heading
    children.push(
      h2(`Lesson ${lesson.number}: ${lesson.title}`),
      para(lesson.description || "", 60, 80),
      gap(60),
    );

    // SLOs
    children.push(
      new Paragraph({
        spacing: { before: 100, after: 60 },
        children: [run("Student Learning Outcomes (SLOs)", { bold: true, size: 24 })],
      }),
      para("By the end of this lesson, students will be able to:"),
      ...sloList(lesson),
      gap(120),
    );

    // Each section in order
    const sectionOrder = [
      { key: "introduction",     label: "Introduction"       },
      { key: "warmUp",           label: "Warm-Up"            },
      { key: "conceptBuilding",  label: "Concept Building"   },
      { key: "examples",         label: "Worked Examples"    },
      { key: "popUpQuiz",        label: "Pop-Up Quiz"        },
      { key: "mentalMaths",      label: "Mental Maths"       },
      { key: "practiceQuestions",label: "Practice Questions" },
      { key: "keyTakeaways",     label: "Key Takeaways"      },
    ];

    for (const sec of sectionOrder) {
      const text = sections[sec.key];
      if (!text) continue;

      children.push(
        h3(sec.label),
        ...parseTextToParas(text),
        gap(100),
      );
    }
  }

  // Build document
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 }, spacing: { before: 60, after: 60 } } },
          }],
        },
        {
          reference: "numbers",
          levels: [{
            level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 }, spacing: { before: 60, after: 60 } } },
          }],
        },
      ],
    },
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal",
          run: { size: 36, bold: true, font: "Arial", color: C.unitGreen },
          paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal",
          run: { size: 30, bold: true, font: "Arial", color: C.lessonBlue },
          paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal",
          run: { size: 26, bold: true, font: "Arial", color: C.subBlue },
          paragraph: { spacing: { before: 220, after: 100 }, outlineLevel: 2 } },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: {
        default: new Header({ children: [new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.lessonBlue, space: 1 } },
          spacing: { after: 120 },
          children: [run(
            `Grade ${chapter.grade} Mathematics  |  Chapter ${chapter.number}: ${chapter.title}`,
            { size: 18, color: C.lessonBlue }
          )],
        })]}),
      },
      footers: {
        default: new Footer({ children: [new Paragraph({
          border: { top: { style: BorderStyle.SINGLE, size: 6, color: C.lessonBlue, space: 1 } },
          spacing: { before: 120 },
          alignment: AlignmentType.CENTER,
          children: [
            run("Page ", { size: 18, color: C.lessonBlue }),
            new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 18, color: C.lessonBlue }),
          ],
        })]})
      },
      children,
    }],
  });

  return await Packer.toBuffer(doc);
}

// ─── Pop Quiz Builder ──────────────────────────────────────────────
async function buildPopQuizDocx(lessons, generatedSections) {
  const children = [];
  children.push(
    h1("Pop Quizzes Compilation"),
    gap(160)
  );

  for (let li = 0; li < lessons.length; li++) {
    const lesson = lessons[li];
    const quizText = generatedSections[li]?.popUpQuiz;
    if (!quizText) continue;

    if (li > 0) children.push(pageBreak());

    children.push(
      h2(`Lesson ${lesson.number}: ${lesson.title}`),
      gap(80),
      ...parseTextToParas(quizText),
      gap(120)
    );
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 22 } } } },
    sections: [{ children }]
  });
  return await Packer.toBuffer(doc);
}

// ─── Video Script Builder ─────────────────────────────────────────
async function buildVideoScriptDocx(lessons, videoScripts) {
  const children = [];
  children.push(
    h1("Lesson Video Scripts"),
    gap(160)
  );

  for (let li = 0; li < lessons.length; li++) {
    const lesson = lessons[li];
    const scriptText = videoScripts[li];
    if (!scriptText) continue;

    if (li > 0) children.push(pageBreak());

    children.push(
      h2(`Lesson ${lesson.number}: ${lesson.title} — Video Script`),
      gap(80),
      ...parseTextToParas(scriptText),
      gap(120)
    );
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 22 } } } },
    sections: [{ children }]
  });
  return await Packer.toBuffer(doc);
}

// ─── Unit Assessment Builder ──────────────────────────────────────
async function buildUnitAssessmentDocx(chapter, unitAssessmentText) {
  const children = [];
  children.push(
    h1(`Unit Assessment: ${chapter.title}`),
    para(`Grade ${chapter.grade} | ${chapter.strand || "Mathematics"}`),
    gap(160),
    ...parseTextToParas(unitAssessmentText)
  );

  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 22 } } } },
    sections: [{ children }]
  });
  return await Packer.toBuffer(doc);
}

module.exports = { 
  buildDocx, 
  buildPopQuizDocx, 
  buildVideoScriptDocx, 
  buildUnitAssessmentDocx 
};