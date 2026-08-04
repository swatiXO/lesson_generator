// docBuilder.js — assembles LLM-generated text into a formatted .docx
const docx = require('docx');
const {
  Document, Packer, Paragraph, TextRun,
  Header, Footer, AlignmentType, LevelFormat, HeadingLevel,
  BorderStyle, PageNumber, PageBreak,
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

// ─── Text parser ─────────────────────────────────────────────────
// Converts raw LLM text into docx paragraphs by analysing line patterns
function parseTextToParas(rawText) {
  const paras = [];
  const lines = rawText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { paras.push(gap(80)); continue; }

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
      paras.push(new Paragraph({
        spacing: { before: 120, after: 60 },
        children: [run(line.replace(/\*\*/g, ''), { bold: true })],
      }));
      continue;
    }
    if (/^(Example|Step|Part [A-C]|Answer:|Working:)\b/.test(line)) {
      paras.push(new Paragraph({
        spacing: { before: 100, after: 60 },
        children: [run(line, { bold: true })],
      }));
      continue;
    }

    // Numbered list items: "1." "2." "1)" "2)"
    if (/^\d+[\.\)]\s/.test(line)) {
      paras.push(numPara(line.replace(/^\d+[\.\)]\s/, '')));
      continue;
    }

    // Bullet items: "- " "• " "* "
    if (/^[-•*]\s/.test(line)) {
      paras.push(bulletPara(line.replace(/^[-•*]\s/, '')));
      continue;
    }

    // Letter sub-items: "a." "b." "a)" "b)"
    if (/^[a-d][\.\)]\s/.test(line)) {
      paras.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { left: 480 },
        children: [run(line)],
      }));
      continue;
    }

    // Indented lines (4+ spaces or tab)
    if (/^(\s{4}|\t)/.test(lines[i])) {
      paras.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { left: 480 },
        children: [run(line)],
      }));
      continue;
    }

    // Normal paragraph
    paras.push(para(line));
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