// DocBuilder.js — assembles LLM-generated text into a formatted .docx
//
// Matches the manually-authored reference lessons: navy section bars and
// colour-coded boxes (teal Warm-Up / Word Problem, purple Your Turn with
// highlighted answer keys, red Remember / Challenge, green Answer Key).
// Boxes come from marker pairs emitted by prompts.js ([WARMUP_START] …
// [WARMUP_END] etc.) and are rendered as single-cell bordered tables.
// Also handles image embedding, LaTeX → OMML math, and review-flag notes.
const fs = require('fs');
const docx = require('docx');
const {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Header, Footer, AlignmentType, LevelFormat,
  BorderStyle, PageNumber, PageBreak,
  Table, TableRow, TableCell, WidthType, ShadingType,
  Math: DocxMath, MathRun, MathFraction, MathSuperScript, MathSubScript,
  MathSubSuperScript, MathRadical, MathRoundBrackets,
} = docx;

// Shared with pdfRenderer.js so both agree where an image path lives on disk.
const { resolveImagePath } = require('./pdfRenderer');

// Removes <!-- SLO_CHECK --> / <!-- QUALITY_CHECK --> HTML-comment blocks.
// Separate from splitByBoxMarkers below, which handles [TAG_START] syntax.
const { stripInternalMarkers } = require('./prompts');

const { SECTIONS, SECTION_LABELS } = require('./sections');

// ─── Colour system ──────────────────────────────────────────────────
// Matches the manually-authored reference lessons exactly.
const C = {
  navy:    "1A237E",   // section bars, lesson title
  blue:    "1565C0",   // Part headings, sub-headings
  teal:    "006064",   // Warm-Up / Mental Maths / Word Problem box border
  tealFill:"E0F7FA",
  purple:  "6A1B9A",   // Your Turn box border
  purpleFill:"F3E5F5",
  red:     "CC0000",   // Remember / Challenge box border
  redFill: "FFEBEE",
  green:   "1B5E20",   // Answer Key text / Answer Key box border
  greenFill:"E8F5E9",
  orange:  "E65100",
  white:   "FFFFFF",
  textDark:"212121",
  midGrey: "6C757D",
  greyLine:"BDBDBD",
};

// ─── Basic helpers ────────────────────────────────────────────────
function run(text, opts = {}) {
  return new TextRun({
    text: String(text),
    font: "Times New Roman",
    size:      opts.size      || 22,
    color:     opts.color     || C.textDark,
    bold:      opts.bold      || false,
    italics:   opts.italic    || false,
    highlight: opts.highlight || undefined,
  });
}

function para(text, before = 60, after = 60) {
  return new Paragraph({
    spacing: { before, after },
    children: [run(String(text))],
  });
}

function gap(sz = 120) {
  return new Paragraph({ spacing: { before: 0, after: sz }, children: [new TextRun("")] });
}

function pageBreak() { return new Paragraph({ children: [new PageBreak()] }); }

function h1(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 40 },
    children: [run(text, { bold: true, size: 34, color: C.navy })],
  });
}

function h2(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 40 },
    children: [run(text, { bold: true, size: 28, color: C.navy })],
  });
}

// Part heading inside Concept Building ("## Part A: ...")
function h3(text) {
  return new Paragraph({
    spacing: { before: 200, after: 100 },
    children: [run(text, { bold: true, size: 26, color: C.navy })],
  });
}

// Sub-heading inside a Part ("### i. Parallel Lines")
function h4(text) {
  return new Paragraph({
    spacing: { before: 160, after: 80 },
    children: [run(text, { bold: true, size: 23, color: C.blue })],
  });
}

function bulletPara(text) {
  return new Paragraph({
    bullet: { level: 0 },
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

// ─── Section bar — replaces the old h3 heading for top-level sections ──
// A full-width navy table with centered white bold text, exactly matching
// the manually-authored reference lessons' "Introduction" / "Concept
// Building" / "Mental Maths" / "Practice Questions" / "Key Takeaways" bars.
function secBar(text) {
  return new Table({
    width: { size: 9300, type: WidthType.DXA },
    columnWidths: [9300],
    rows: [new TableRow({ children: [new TableCell({
      width: { size: 9300, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: C.navy },
      margins: { top: 100, bottom: 100, left: 200, right: 200 },
      borders: {
        top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      },
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0 },
        children: [run(text, { bold: true, size: 26, color: C.white })],
      })],
    })]})],
  });
}

// ─── Generic coloured box — wraps an array of already-built Paragraphs in
// a single-cell bordered/filled table. Used by all box types below. ──
function buildBoxTable(paras, fill, border) {
  return new Table({
    width: { size: 9300, type: WidthType.DXA },
    columnWidths: [9300],
    rows: [new TableRow({ children: [new TableCell({
      width: { size: 9300, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill },
      margins: { top: 140, bottom: 140, left: 220, right: 220 },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 6, color: border },
        bottom: { style: BorderStyle.SINGLE, size: 6, color: border },
        left: { style: BorderStyle.SINGLE, size: 6, color: border },
        right: { style: BorderStyle.SINGLE, size: 6, color: border },
      },
      children: paras.length ? paras : [para("")],
    })]})],
  });
}

// Box style lookup by marker tag name. Title text is what appears as the
// bold label inside the box before its content.
const BOX_STYLES = {
  WARMUP:      { fill: C.tealFill,   border: C.teal,   title: "Warm-Up Activity", titleColor: C.teal },
  YOURTURN:    { fill: C.purpleFill, border: C.purple, title: "Your Turn",        titleColor: C.purple },
  REMEMBER:    { fill: C.redFill,    border: C.red,    title: "Remember",         titleColor: C.red },
  WORDPROBLEM: { fill: C.tealFill,   border: C.teal,   title: "Word Problem",     titleColor: C.teal },
  CHALLENGE:   { fill: C.redFill,    border: C.red,    title: "Challenge Question", titleColor: C.red },
  ANSWERKEY:   { fill: C.greenFill,  border: C.green,  title: "Answer Key",       titleColor: C.green },
};

// ─── Shared markdown-table parsing ──────────────────────────────────
// Used both for plain text and inside boxes (models sometimes format an
// answer key as a pipe table).
//
// `lines` is an array of already-trimmed lines; `startIdx` is the first
// line starting with '|'. Returns { table: Table|null, nextIdx } where
// nextIdx is the first line after the table block.
function parseMarkdownTableBlock(lines, startIdx) {
  const tableLines = [];
  let i = startIdx;
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    tableLines.push(lines[i].trim());
    i++;
  }

  const rows = [];
  tableLines.forEach((tLine, rIdx) => {
    let cellsText = tLine.split('|').map(c => c.trim());
    if (cellsText[0] === '') cellsText.shift();
    if (cellsText[cellsText.length - 1] === '') cellsText.pop();

    const isSeparator = cellsText.every(c => /^:-*:?$/.test(c) || c.startsWith('-'));
    if (isSeparator) return;

    const cells = cellsText.map(cellTxt => {
      let isBold = false;
      let cleanText = cellTxt;
      if (cellTxt.startsWith('**') && cellTxt.endsWith('**')) {
        isBold = true;
        cleanText = cellTxt.slice(2, -2);
      } else if (rIdx === 0) {
        isBold = true;
      }

      const cellChildren = hasInlineMath(cleanText)
        ? parseInlineMath(cleanText)
        : [new TextRun({ text: cleanText, font: "Times New Roman", size: 20, bold: isBold })];

      return new TableCell({
        width: { size: 100 / cellsText.length, type: WidthType.PERCENTAGE },
        margins: { top: 100, bottom: 100, left: 150, right: 150 },
        shading: rIdx === 0 ? { fill: "F2F2F2" } : undefined,
        children: [new Paragraph({ children: cellChildren })],
      });
    });

    // TableRow takes { children }, not { cells } — the wrong key fails with
    // docx's cryptic "options2.children is not iterable".
    rows.push(new TableRow({ children: cells }));
  });

  const table = rows.length > 0
    ? new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })
    : null;

  return { table, nextIdx: i };
}

/**
 * Parses the INNER text of a box (already stripped of its [TAG_START] /
 * [TAG_END] markers) into paragraphs, with special handling for an
 * "Answer Key:" line: everything from that line onward is rendered in
 * green with a yellow highlight, matching the reference lessons' style.
 * Everything before it renders as plain question text. Bullets, numbered
 * lines and markdown tables are detected like the main line parser does.
 *
 * titleOverride: undefined → the tag's default title; a string → that
 * title; null → no title (for sections that are one box directly under a
 * section bar already showing the name).
 */
function buildAnswerAwareBox(innerText, tag, titleOverride) {
  const style = BOX_STYLES[tag] || { fill: "F5F5F5", border: C.greyLine, title: tag, titleColor: C.textDark };
  const skipTitle = titleOverride === null;
  const displayTitle = titleOverride || style.title;
  const lines = innerText.split('\n');
  const paras = [];

  if (!skipTitle) {
    paras.push(new Paragraph({
      spacing: { before: 0, after: 100 },
      children: [run(displayTitle, { bold: true, size: 23, color: style.titleColor })],
    }));
  }

  let inAnswer = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const line = raw.trim();
    if (!line) { paras.push(gap(60)); continue; }

    if (line.startsWith('|')) {
      const { table, nextIdx } = parseMarkdownTableBlock(lines.map(l => l.trim()), idx);
      if (table) paras.push(table);
      idx = nextIdx - 1; // the loop's idx++ advances past the table
      continue;
    }

    if (/^answer key\s*:?\s*$/i.test(line) || /^answers?\s*:\s*$/i.test(line)) {
      inAnswer = true;
      paras.push(new Paragraph({
        spacing: { before: 100, after: 60 },
        children: [run(line, { bold: true, color: C.green })],
      }));
      continue;
    }

    const opts = inAnswer ? { color: C.green, highlight: 'yellow' } : {};

    if (/^\d+[\.\)]\s/.test(line)) {
      const inner = line.replace(/^\d+[\.\)]\s/, '');
      const num = line.match(/^\d+/)[0];
      paras.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        children: (hasInlineMath(inner) || hasInlineBold(inner))
          ? [run(`${num}. `, opts), ...parseInlineMathStyled(inner, opts)]
          : [run(`${num}. ${inner}`, opts)],
      }));
      continue;
    }

    if (/^[-•*]\s/.test(line)) {
      const inner = line.replace(/^[-•*]\s/, '');
      paras.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { before: 40, after: 40 },
        children: (hasInlineMath(inner) || hasInlineBold(inner)) ? parseInlineMathStyled(inner, opts) : [run(inner, opts)],
      }));
      continue;
    }

    paras.push(new Paragraph({
      spacing: { before: 40, after: 40 },
      children: (hasInlineMath(line) || hasInlineBold(line)) ? parseInlineMathStyled(line, opts) : [run(line, opts)],
    }));
  }

  return buildBoxTable(paras, style.fill, style.border);
}

// ─── Image embedding ────────────────────────────────────────────────
function normalizeHeadingTitle(t) {
  return String(t || '')
    .trim()
    .toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/[:*_]+$/, '')
    .replace(/\s+/g, ' ');
}

function sniffImageType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) return 'bmp';
  return null;
}

function getPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function getJpegDimensions(buffer) {
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xFF) { offset++; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function getImageDimensions(buffer, type) {
  try {
    if (type === 'png') return getPngDimensions(buffer);
    if (type === 'jpg') return getJpegDimensions(buffer);
  } catch (_) { /* fall through to null */ }
  return null;
}

const MAX_IMAGE_WIDTH_PX = 460;
const MAX_IMAGE_HEIGHT_PX = 300;

function buildImageParagraph(relPath) {
  if (!relPath) return null;

  const fsPath = resolveImagePath(relPath);
  if (!fsPath) {
    console.warn(`[DocBuilder] Could not resolve image path: ${relPath}`);
    return null;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(fsPath);
  } catch (err) {
    console.warn(`[DocBuilder] Could not read image file ${fsPath}:`, err.message);
    return null;
  }

  const type = sniffImageType(buffer);
  if (!type) {
    console.warn(`[DocBuilder] Unrecognized image type for ${fsPath}, skipping.`);
    return null;
  }

  const dims = getImageDimensions(buffer, type) || { width: 4, height: 3 };
  const scale = Math.min(MAX_IMAGE_WIDTH_PX / dims.width, MAX_IMAGE_HEIGHT_PX / dims.height, 1);
  const width = Math.max(1, Math.round(dims.width * scale));
  const height = Math.max(1, Math.round(dims.height * scale));

  try {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 200 },
      children: [
        new ImageRun({
          type,
          data: buffer,
          transformation: { width, height },
        }),
      ],
    });
  } catch (err) {
    console.warn(`[DocBuilder] Failed to embed image ${fsPath}:`, err.message);
    return null;
  }
}

function buildImageCaptionParagraph(entry) {
  if (!entry || !entry.source || entry.source === 'websearch') return null;

  let text;
  if (entry.source === 'placeholder') {
    text = entry.query
      ? `Image not found automatically — suggested search: "${entry.query}". Please add manually.`
      : `Image not available — please add manually.`;
  } else if (entry.source === 'svg_diagram') {
    text = `AI-generated diagram — please verify it accurately represents the concept before use.`;
  } else {
    return null;
  }

  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 160 },
    children: [run(text, { italic: true, size: 18, color: C.midGrey })],
  });
}

// Shown right after a section heading when answerVerifier.js still flags
// answers after every regeneration attempt — i.e. a human needs to check.
const REVIEW_FLAG_COLOR = 'C0392B';

function buildReviewFlagParagraphs(issues) {
  if (!issues || !issues.length) return [];

  const paras = [
    new Paragraph({
      spacing: { before: 160, after: 80 },
      children: [run(
        `FLAGGED FOR REVIEW — ${issues.length} possible answer error${issues.length > 1 ? 's' : ''} ` +
        `survived automatic correction and need${issues.length > 1 ? '' : 's'} a human check:`,
        { bold: true, color: REVIEW_FLAG_COLOR, size: 24 }
      )],
    }),
  ];

  issues.forEach((issue, i) => {
    const q = (issue.question || '(question text unavailable)').slice(0, 200);
    const verdictLabel = (issue.verdict || 'mismatch').toUpperCase();
    let line = `${i + 1}. [${verdictLabel}] "${q}" — stated answer: ${issue.statedAnswer ?? 'N/A'}; ` +
      `independently computed: ${issue.computedAnswer ?? 'N/A'}.`;
    if (issue.explanation) line += ` ${issue.explanation}`;

    paras.push(new Paragraph({
      spacing: { before: 40, after: 40 },
      indent: { left: 360 },
      children: [run(line, { color: REVIEW_FLAG_COLOR, italic: true, size: 20 })],
    }));
  });

  paras.push(gap(120));
  return paras;
}

// ─── Math (equation) rendering ─────────────────────────────────────
// Converts a subset of LaTeX into docx OMML Math components.
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
      let j = i + 1;
      if (j < src.length && !/[a-zA-Z]/.test(src[j])) {
        tokens.push({ t: 'CMD', name: '\\' + src[j] });
        i = j + 1;
        continue;
      }
      while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
      tokens.push({ t: 'CMD', name: src.slice(i, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < src.length && !/[{}\[\]^_\\\s]/.test(src[j])) j++;
    if (j === i) j = i + 1;
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

  function parseGroup() {
    if (peek() && peek().t === 'LBRACE') {
      next();
      const children = parseExpression(['RBRACE']);
      if (peek() && peek().t === 'RBRACE') next();
      return children;
    }
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

  function parseSingleAtom() {
    const tok = next();
    if (!tok) return [];
    if (tok.t === 'CHAR') return [new MathRun(tok.value)];
    if (tok.t === 'CMD') return [new MathRun(MATH_SYMBOLS[tok.name] || tok.name.replace('\\', ''))];
    return [];
  }

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
      const degree = parseBracketGroup();
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

// Splits plain (non-math) text into TextRuns, turning **bold** spans
// anywhere in the line into bold runs.
function splitBoldSpans(text, opts = {}) {
  const parts = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(run(text.slice(lastIndex, match.index), opts));
    }
    parts.push(run(match[1], { ...opts, bold: true }));
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(run(text.slice(lastIndex), opts));
  }

  if (parts.length === 0) parts.push(run(text, opts));
  return parts;
}

function hasInlineBold(line) {
  return /\*\*(.+?)\*\*/.test(line);
}

function parseInlineMath(line) {
  const parts = [];
  const regex = /\$([^$]+)\$/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...splitBoldSpans(line.slice(lastIndex, match.index)));
    }
    try {
      const mathChildren = parseLatexToMathChildren(match[1]);
      if (mathChildren.length) {
        parts.push(new DocxMath({ children: mathChildren }));
      } else {
        parts.push(run(match[1]));
      }
    } catch (err) {
      parts.push(run(match[1]));
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    parts.push(...splitBoldSpans(line.slice(lastIndex)));
  }

  if (parts.length === 0) parts.push(...splitBoldSpans(line));
  return parts;
}

// Same as parseInlineMath but applies extra TextRun styling (e.g. the
// green+highlight styling used inside an Answer Key) to the plain-text
// segments, leaving embedded math runs unstyled (Math components don't
// take color/highlight the same way).
function parseInlineMathStyled(line, opts) {
  const parts = [];
  const regex = /\$([^$]+)\$/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...splitBoldSpans(line.slice(lastIndex, match.index), opts));
    }
    try {
      const mathChildren = parseLatexToMathChildren(match[1]);
      if (mathChildren.length) {
        parts.push(new DocxMath({ children: mathChildren }));
      } else {
        parts.push(run(match[1], opts));
      }
    } catch (err) {
      parts.push(run(match[1], opts));
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    parts.push(...splitBoldSpans(line.slice(lastIndex), opts));
  }

  if (parts.length === 0) parts.push(...splitBoldSpans(line, opts));
  return parts;
}

function hasInlineMath(line) {
  return /\$[^$]+\$/.test(line);
}

// ─── Box marker splitting ───────────────────────────────────────────
// Scans raw section text for [TAG_START]...[TAG_END] pairs and splits it
// into an ordered array of segments: { type: 'text', content } for
// everything outside a box, { type: 'box', tag, content } for everything
// inside one (content excludes the marker lines themselves). Malformed or
// unmatched markers are left as plain text — a missing END marker should
// never crash the whole document, it should just render as visible text
// so the gap is obvious to a human reviewing the output.
function splitByBoxMarkers(text) {
  const segments = [];
  const markerPattern = /\[(\w+)_START\]([\s\S]*?)\[\1_END\]/g;
  let lastIndex = 0;
  let match;

  while ((match = markerPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'box', tag: match[1], content: match[2].trim() });
    lastIndex = markerPattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments.length ? segments : [{ type: 'text', content: text }];
}

// ─── Text parser ─────────────────────────────────────────────────
// Converts raw LLM text into docx paragraphs/tables. Box-marked segments
// become coloured Table boxes (via buildAnswerAwareBox); everything else
// goes through the original line-by-line markdown-ish parser.
function stripVisualTags(text) {
  if (!text) return text;
  return text
    .replace(/^\s*\[VISUAL:[^\]]*\]\s*$/gim, '')
    .replace(/\[VISUAL:[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

// Drops lines that are only `**` or `---` (truncated generation or bare
// dividers), which would otherwise render as literal asterisks/dashes.
function stripStrayMarkdownArtifacts(text) {
  if (!text) return text;
  return text
    .split('\n')
    .filter(line => !/^\s*(\*{2,}|-{3,})\s*$/.test(line))
    .join('\n');
}

// Line-by-line parser for plain (non-box) text: headings, lists, tables,
// equations. Box segments are split out beforehand by splitByBoxMarkers.
function parsePlainTextToParas(rawText, sectionImages, imageLookup, usedTitles) {
  const paras = [];
  const lines = rawText.split('\n');

  const tryInsertImageForHeading = (headingText) => {
    const key = normalizeHeadingTitle(headingText);
    const entry = imageLookup[key];
    if (entry && !usedTitles.has(key)) {
      const imgPara = buildImageParagraph(entry.path);
      if (imgPara) {
        paras.push(imgPara);
        const captionPara = buildImageCaptionParagraph(entry);
        if (captionPara) paras.push(captionPara);
      }
      usedTitles.add(key);
    }
  };

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

    // Markdown tables
    if (line.startsWith('|')) {
      const { table, nextIdx } = parseMarkdownTableBlock(lines.map(l => l.trim()), i);
      if (table) paras.push(table);
      i = nextIdx - 1;
      continue;
    }

    // Headings
    if (line.startsWith('#### ')) { const t = line.slice(5); paras.push(h4(t)); tryInsertImageForHeading(t); continue; }
    if (line.startsWith('### '))  { const t = line.slice(4); paras.push(h4(t)); tryInsertImageForHeading(t); continue; }
    if (line.startsWith('## '))   { const t = line.slice(3); paras.push(h3(t)); tryInsertImageForHeading(t); continue; }
    if (line.startsWith('# '))    { const t = line.slice(2); paras.push(h3(t)); tryInsertImageForHeading(t); continue; }

    // "Worked Example — ..." sub-label — can appear multiple times within
    // one Part, so it gets its own smaller styling rather than a full
    // section header.
    if (/^(⭐\s*)?Worked Example/i.test(line)) {
      const cleanLine = line.replace(/^⭐\s*/, '');
      const children = (hasInlineMath(line) || hasInlineBold(line))
        ? parseInlineMathStyled(cleanLine, { bold: true, color: C.blue })
        : [run(cleanLine, { bold: true, color: C.blue })];
      paras.push(new Paragraph({
        spacing: { before: 140, after: 60 },
        children,
      }));
      tryInsertImageForHeading(cleanLine);
      continue;
    }

    // Bold label lines like "**Example 1**"
    if (/^\*\*(.+)\*\*$/.test(line)) {
      const inner = line.replace(/\*\*/g, '');
      const children = hasInlineMath(inner)
        ? parseInlineMath(inner)
        : [run(inner, { bold: true })];
      paras.push(new Paragraph({
        spacing: { before: 120, after: 60 },
        children,
      }));
      tryInsertImageForHeading(inner);
      continue;
    }
    // Label lines ("Example", "Step", "Answer:" …) are bold throughout;
    // nested **spans** and $math$ are still parsed.
    if (/^(Example|Step|Part [A-E]|Answer:|Working:)\b/.test(line)) {
      const children = (hasInlineMath(line) || hasInlineBold(line))
        ? parseInlineMathStyled(line, { bold: true })
        : [run(line, { bold: true })];
      paras.push(new Paragraph({
        spacing: { before: 100, after: 60 },
        children,
      }));
      continue;
    }

    // Numbered list items
    if (/^\d+[\.\)]\s/.test(line)) {
      const inner = line.replace(/^\d+[\.\)]\s/, '');
      if (hasInlineMath(inner) || hasInlineBold(inner)) {
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

    // Bullet items
    if (/^[-•*]\s/.test(line)) {
      const inner = line.replace(/^[-•*]\s/, '');
      if (hasInlineMath(inner) || hasInlineBold(inner)) {
        paras.push(new Paragraph({
          bullet: { level: 0 },
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
        children: (hasInlineMath(line) || hasInlineBold(line)) ? parseInlineMath(line) : [run(line)],
      }));
      continue;
    }

    // Indented lines (4+ spaces or tab)
    if (/^(\s{4}|\t)/.test(lines[i])) {
      paras.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { left: 480 },
        children: (hasInlineMath(line) || hasInlineBold(line)) ? parseInlineMath(line) : [run(line)],
      }));
      continue;
    }

    // Normal paragraph
    if (hasInlineMath(line) || hasInlineBold(line)) {
      paras.push(new Paragraph({ spacing: { before: 80, after: 80 }, children: parseInlineMath(line) }));
    } else {
      paras.push(para(line));
    }
  }

  return paras;
}

/**
 * Top-level entry point: parses a full section's raw text (which may
 * contain box markers) into an array of docx Paragraph/Table objects.
 * sectionImages: { subheadingTitle: {path, query, isPlaceholder, source} }
 */
function parseTextToParas(rawText, sectionImages = {}, titleOverrideByTag = {}) {
  const cleanedText = stripVisualTags(stripStrayMarkdownArtifacts(stripInternalMarkers(rawText)));

  const imageLookup = {};
  for (const [title, entry] of Object.entries(sectionImages || {})) {
    imageLookup[normalizeHeadingTitle(title)] = entry;
  }
  const usedTitles = new Set();

  const segments = splitByBoxMarkers(cleanedText);
  const paras = [];

  for (const seg of segments) {
    if (seg.type === 'box') {
      const trimmedContent = (seg.content || '').trim();
      // Skip empty or "..."-only boxes rather than render an empty coloured box.
      if (!trimmedContent || /^[.\s…]{1,5}$/.test(trimmedContent)) {
        console.warn(`[DocBuilder] Skipping empty/placeholder ${seg.tag} box (content was: "${trimmedContent}")`);
        continue;
      }
      paras.push(gap(80));
      // A key mapped to null means "no title" — distinct from an absent key.
      const hasOverride = Object.prototype.hasOwnProperty.call(titleOverrideByTag, seg.tag);
      const overrideValue = hasOverride ? titleOverrideByTag[seg.tag] : undefined;
      paras.push(buildAnswerAwareBox(seg.content, seg.tag, overrideValue));
      paras.push(gap(80));
    } else {
      paras.push(...parsePlainTextToParas(seg.content, sectionImages, imageLookup, usedTitles));
    }
  }

  // Any generated image that never matched a heading in the text still
  // gets shown — appended once at the end of the section.
  for (const [key, entry] of Object.entries(imageLookup)) {
    if (!usedTitles.has(key)) {
      const imgPara = buildImageParagraph(entry.path);
      if (imgPara) {
        paras.push(imgPara);
        const captionPara = buildImageCaptionParagraph(entry);
        if (captionPara) paras.push(captionPara);
      }
    }
  }

  return paras;
}

// "SLOs Covered in This Lesson" bar + plain-text SLO codes/descriptions —
// a structural block (not LLM-generated) shown at the top of every lesson,
// directly under the title, matching the reference lessons exactly.
function sloCoveredBlock(lesson) {
  const paras = [secBar("SLOs Covered in This Lesson"), gap(100)];
  lesson.slos.forEach((code, i) => {
    paras.push(new Paragraph({
      spacing: { before: 40, after: 40 },
      children: [
        run(`${code}:  `, { bold: true }),
        run(lesson.slo_descriptions[i] || ''),
      ],
    }));
  });
  paras.push(gap(140));
  return paras;
}

// ─── Main builder ─────────────────────────────────────────────────
async function buildDocx(structure, generatedSections, imagesBySubheading = {}, answerVerification = {}) {
  const { chapter, lessons } = structure;
  const children = [];

  // Chapter title page
  children.push(
    h1(`Chapter ${chapter.number}: ${chapter.title}`),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 100 },
      children: [run(`Grade ${chapter.grade}  ·  ${chapter.strand || "Mathematics"}`, { size: 20, color: "555555" })],
    }),
    gap(80),
    para(chapter.overview || ""),
    gap(200),
  );

  const sectionOrder = Object.entries(SECTION_LABELS).map(([key, label]) => ({ key, label }));

  for (let li = 0; li < lessons.length; li++) {
    const lesson = lessons[li];
    const sections = generatedSections[li] || {};
    const lessonImages = imagesBySubheading[li] || {};
    const lessonAnswerVerification = answerVerification[li] || {};

    if (li > 0) children.push(pageBreak());

    // Lesson title block — matches the reference lessons' centered title
    // with chapter name (small grey), lesson title (large navy), grade/
    // subject/SLO codes line (small grey).
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 40 },
        children: [run(`Chapter ${chapter.number}: ${chapter.title}`, { size: 22, color: "555555" })],
      }),
      h2(`Lesson ${lesson.number}: ${lesson.title}`),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 200 },
        children: [run(
          `Grade ${chapter.grade}  ·  ${chapter.strand || "Mathematics"}  ·  SLO: ${lesson.slos.join(', ')}`,
          { size: 20, color: "555555" }
        )],
      }),
    );

    // Structural "SLOs Covered in This Lesson" block
    children.push(...sloCoveredBlock(lesson));

    // Each section in order
    for (const sec of sectionOrder) {
      const text = sections[sec.key];
      if (!text) continue;

      const sectionImages = lessonImages[sec.key] || {};
      const verification = lessonAnswerVerification[sec.key];

      children.push(secBar(sec.label), gap(100));
      if (verification && verification.flagged && verification.issues?.length) {
        children.push(...buildReviewFlagParagraphs(verification.issues));
      }

      // Key Takeaways is always plain bulleted lines, one bullet per
      // non-empty line, regardless of whether the model included its own
      // dash/bullet character (it's instructed not to — the marker is
      // applied structurally here) — so it gets its own simple path
      // instead of the generic marker/heading-aware parser.
      if (sec.key === SECTIONS.KEY_TAKEAWAYS) {
        const lines = stripVisualTags(text).split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          const cleanLine = line.replace(/^[-•*]\s*/, ''); // strip a stray dash if the model added one anyway
          children.push(new Paragraph({
            bullet: { level: 0 },
            spacing: { before: 60, after: 60 },
            children: (hasInlineMath(cleanLine) || hasInlineBold(cleanLine)) ? parseInlineMath(cleanLine) : [run(cleanLine)],
          }));
        }
        children.push(gap(160));
        continue;
      }

      // Warm-Up and Mental Maths are a single box directly under the section
      // bar, so the box's own title would just repeat the bar.
      const titleOverrideByTag =
        (sec.key === SECTIONS.MENTAL_MATHS || sec.key === SECTIONS.WARM_UP)
          ? { WARMUP: null }
          : {};

      children.push(
        ...parseTextToParas(text, sectionImages, titleOverrideByTag),
        gap(160),
      );
    }
  }

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
      default: { document: { run: { font: "Times New Roman", size: 22 } } },
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
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.navy, space: 1 } },
          spacing: { after: 120 },
          children: [run(
            `Grade ${chapter.grade} Mathematics  |  Chapter ${chapter.number}: ${chapter.title}`,
            { size: 18, color: C.navy }
          )],
        })]}),
      },
      footers: {
        default: new Footer({ children: [new Paragraph({
          border: { top: { style: BorderStyle.SINGLE, size: 6, color: C.navy, space: 1 } },
          spacing: { before: 120 },
          alignment: AlignmentType.CENTER,
          children: [
            run("Page ", { size: 18, color: C.navy }),
            new TextRun({ children: [PageNumber.CURRENT], font: "Times New Roman", size: 18, color: C.navy }),
          ],
        })]})
      },
      children,
    }],
  });

  return await Packer.toBuffer(doc);
}

// ─── "Your Turn" compilation builder ────────────────────────────────
// Collects each lesson's Your Turn section into a standalone worksheet.
async function buildYourTurnDocx(lessons, generatedSections) {
  const children = [];
  children.push(h1("Your Turn — All Lessons Compilation"), gap(160));

  for (let li = 0; li < lessons.length; li++) {
    const lesson = lessons[li];
    const text = generatedSections[li]?.[SECTIONS.YOUR_TURN_FULL];
    if (!text) continue;

    if (li > 0) children.push(pageBreak());

    children.push(
      h2(`Lesson ${lesson.number}: ${lesson.title}`),
      gap(80),
      ...parseTextToParas(text),
      gap(120)
    );
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: "Times New Roman", size: 22 } } } },
    sections: [{ children }]
  });
  return await Packer.toBuffer(doc);
}


// ─── Video Script Builder ─────────────────────────────────────────
async function buildVideoScriptDocx(lessons, videoScripts) {
  const children = [];
  children.push(h1("Lesson Video Scripts"), gap(160));

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
    styles: { default: { document: { run: { font: "Times New Roman", size: 22 } } } },
    sections: [{ children }]
  });
  return await Packer.toBuffer(doc);
}

// ─── Unit Assessment Builder ──────────────────────────────────────
async function buildUnitAssessmentDocx(chapter, unitAssessmentText) {
  const children = [];
  children.push(
    h1(`Unit Assessment: ${chapter.title}`),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 100 },
      children: [run(`Grade ${chapter.grade} | ${chapter.strand || "Mathematics"}`, { size: 20, color: "555555" })],
    }),
    gap(160),
    ...parseTextToParas(unitAssessmentText)
  );

  const doc = new Document({
    styles: { default: { document: { run: { font: "Times New Roman", size: 22 } } } },
    sections: [{ children }]
  });
  return await Packer.toBuffer(doc);
}

module.exports = {
  buildDocx,
  buildYourTurnDocx,
  buildVideoScriptDocx,
  buildUnitAssessmentDocx,
};