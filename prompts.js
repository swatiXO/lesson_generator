// prompts.js — all LLM prompts for the lesson generator
//
// Revision notes (see chat for full rationale):
// - SYSTEM_BASE no longer hardcodes "Grades 3-6"; grade is always injected per-call.
// - Curriculum source is pinned to NCP 2022-23 SLO text/codes only — the model is told
//   explicitly not to blend in SNC 2020 or "what's normally taught around this topic"
//   from its own training data.
// - Every section prompt now gets an explicit self-study framing (young/non-fluent
//   reader, no teacher present) — this is the single biggest lever against dense,
//   literacy-heavy output.
// - Every section prompt now gets an explicit "only this lesson's SLOs" scope fence,
//   so content that belongs to a sibling lesson in the same chapter doesn't leak in.
// - examplesPrompt locks the worked-example format to a lean 2-step + Answer scaffold
//   and requires each example to test a genuinely different sub-skill.

const SYSTEM_BASE = `You are an expert curriculum designer for Pakistani primary school mathematics.
You write for whichever grade is specified in each request — do not assume a fixed grade range.
You strictly follow the National Curriculum of Pakistan (NCP) 2022-23 Student Learning Outcomes
(SLO codes, e.g. M-02-A-30) provided to you in each prompt. Use ONLY the SLO text given to you.
Do not add content, vocabulary, or difficulty drawn from the older 2020 SNC curriculum, from a
different grade's version of this topic, or from what you recall being "typically" taught
alongside this concept — if it isn't in the SLO text you were given, it doesn't belong in this
lesson, even if it feels like a natural extension.
This content is read directly by a child studying ALONE at home, often a young or not-yet-fluent
reader, with no teacher present to explain anything. Prioritize short sentences, plain everyday
words, and concrete examples before any abstract statement. Never use a definition or register
borrowed from an older discipline (e.g. physics, set theory) unless that is the literal wording
of the SLO itself.
You always respond with well-structured, complete text — never truncate or summarise.
You never say "I will now write..." — just write the content directly.`;

function introductionPrompt(lesson, chapter, grade, contextChunks = []) {
  const system = `You are an expert primary school curriculum writer, writing for a child studying
alone at home (young or not-yet-fluent reader, no teacher present).
Write a short, warm, grade-${grade}-friendly introduction that hooks students on the lesson topic
using a real-world, relatable scenario (e.g. sharing a pizza to introduce fractions, a bus route
to introduce distance, a birthday party to introduce counting).
Keep it to 2-4 SHORT paragraphs, each 1-3 short sentences. No headings, no bullet lists — just a
friendly narrative hook. Avoid inventing dialogue between named characters that runs longer than
a couple of lines each — long back-and-forth dialogue adds reading burden without adding maths.
Do not teach the concept formally yet — this is a hook, not the lesson itself.
Only reference ideas that belong to THIS lesson's SLOs — do not foreshadow content from other
lessons in the chapter.
End with a question that gets students curious about today's topic.`;

  const contextText = contextChunks.map(c => c.text).join('\n');

  const user = `Lesson: "${lesson.title}"
Chapter: "${chapter.title}"
Learning outcomes (NCP 2022-23 — use this exact wording, do not paraphrase into different scope):
${lesson.slo_descriptions.join('; ')}
${contextText ? `Reference material:\n${contextText}\n` : ''}
Write the grade-friendly introduction now.`;

  return { system, user };
}

// ─── Step 1: Structure generation ────────────────────────────────
//
// This call used to inherit the full SYSTEM_BASE (self-study reader framing,
// definitional-register rules, etc.) — none of which apply to producing a JSON
// skeleton, so it's dead weight in every prefill here. It also asked the model
// to retype each SLO's full description text into "slo_descriptions", once per
// lesson — pure duplication of text already in the input, and expensive
// token-by-token for a plain-text model generating JSON. Both are cut below:
// the model now only has to output SLO CODES; parseSlosText/hydrateStructure
// reconstruct the full descriptions in JS afterward at zero LLM cost.
function structurePrompt(slosText, grade) {
  const system = `You are an expert curriculum planner for Pakistani primary school mathematics,
following NCP 2022-23 SLOs. Respond ONLY with a valid JSON object — no markdown code fences, no
explanation before or after, just the raw JSON.

When splitting SLOs into lessons:
- Copy each SLO's CODE exactly as given below into "slos" — never paraphrase or invent a code.
- Keep SLOs that test genuinely different skill types (e.g. naming/identifying vs.
  comparing/ordering vs. adding/subtracting vs. a distinct sub-concept like tenths) in
  SEPARATE lessons where the chapter contains more than one such category. Don't merge
  an "identify" SLO and an "operate" SLO into one lesson just because they share a topic.
- A lesson should only ever be assigned the SLOs it will actually teach — assume each
  lesson's section prompts will see ONLY that lesson's SLOs and nothing else, so the
  split must be self-contained and complete for that lesson's scope.
- Do NOT retype each SLO's full description text — only its code. Keep every other field
  (titles, descriptions, overview) as short as the schema below implies; this output should
  be compact, not verbose.`;

  const user = `Grade: ${grade}

Here are the Student Learning Outcomes (SLOs) for a chapter, from NCP 2022-23:

${slosText}

Plan the chapter. Decide:
1. A chapter title and number
2. How many lessons (1–3 is ideal)
3. Which SLOs each lesson covers (by CODE only — do not retype their text)
4. A title for each lesson
5. A one-sentence description of each lesson

STRICTLY Return ONLY this JSON structure (no markdown, no explanation):
{
  "chapter": {
    "number": 1,
    "title": "Chapter title here",
    "grade": ${grade},
    "strand": "strand name",
    "overview": "One paragraph overview of the chapter"
  },
  "lessons": [
    {
      "number": 1,
      "title": "Lesson title",
      "description": "One sentence description",
      "slos": ["SLO code 1", "SLO code 2"],
      "sections": ["Warm-Up", "Concept Building", "Examples", "Pop-Up Quiz", "Mental Maths", "Practice Questions", "Key Takeaways"]
    }
  ]
}`;

  return { system, user };
}

// Parses a raw SLO block (the same slosText string you pass into
// structurePrompt) into a { code: descriptionText } map. Expects lines like:
//   [SLO: M-02-A-30] Identify, name and write; ...
// Adjust the regex if your SLO text uses a different bracket/label format.
function parseSlosText(slosText) {
  const map = {};
  const lines = slosText.split('\n');
  
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    
    // 1. Try format: [SLO: CODE] Description
    let m = trimmed.match(/^\[SLO:\s*([A-Za-z0-9-]+)\]\s*(.*)$/i);
    if (m) {
      map[m[1].trim()] = m[2].trim();
      return;
    }
    
    // 2. Try format: CODE: Description or CODE - Description or CODE Description
    m = trimmed.match(/^([A-Za-z]-\d{2}-[A-Za-z]-\d{2})\b[:-\s]*(.*)$/i);
    if (m) {
      map[m[1].trim()] = m[2].trim();
      return;
    }
    
    // 3. Fallback matching code patterns starting lines
    m = trimmed.match(/^([A-Za-z0-9-]+)[:-\s]+(.*)$/);
    if (m && m[1].includes('-')) {
      map[m[1].trim()] = m[2].trim();
      return;
    }
  });
  
  return map;
}

// Takes the JSON returned by structurePrompt (codes only) plus the original
// slosText, and fills in slo_descriptions for every lesson by lookup — no LLM
// call needed. Call this right after parsing the model's JSON response, before
// passing lessons into any of the section prompts below (they read
// lesson.slo_descriptions directly).
function hydrateStructure(structureJson, slosText) {
  const slosMap = parseSlosText(slosText);
  for (const lesson of structureJson.lessons) {
    lesson.slo_descriptions = lesson.slos.map(code => {
      const desc = slosMap[code];
      if (desc && desc.trim()) {
        return desc.trim();
      }
      // Fallback to lesson title instead of unknown code message
      return lesson.title;
    });
  }
  return structureJson;
}

// Helper to format retrieved context
function formatContext(contextChunks) {
  if (!contextChunks || !contextChunks.length) return '';
  return `\nREFERENCE TEXTBOOK CONTEXT (OPTIONAL — use only if relevant):\n` +
    contextChunks.map((c, i) => `[Chunk ${i+1} from ${c.source} page ${c.page}]:\n${c.text}`).join('\n\n') +
    `\n\nHOW TO USE THIS: the SLOs given elsewhere in this prompt are the authoritative source of
what to teach — they always take priority. This textbook context is supplementary only: use it
for local terminology, phrasing, or examples IF it actually matches the SLOs' topic. Reference
textbooks are often incomplete or cover a different sub-topic than the current lesson's SLOs
(e.g. the retrieved chunk might be about a neighboring sub-domain). If this context does not
clearly match what the SLOs above ask you to teach, IGNORE IT COMPLETELY and teach the SLOs
directly — a mismatched or missing textbook chunk is normal and is not a reason to alter, hedge,
or narrow what you teach. Use local Pakistani naming contexts (names, currency Rs, etc.) either
way.\n`;
}

// Helper: the scope fence every section prompt should carry
function scopeFence(lesson) {
  return `\nSCOPE RULE: Only teach or test content strictly covered by THIS lesson's SLOs below.
Do not include a skill, term, or numeric range that belongs to a different lesson or a
different grade's SLOs, even if it feels like a natural next step or a common pairing.
If an SLO states a numeric bound (e.g. "denominators up to 10"), never exceed it.
SLOs for this lesson:
${lesson.slo_descriptions.join('; ')}\n`;
}

// Helper: turns a lesson's SLOs into a numbered checklist + a mandatory
// coverage-mapping requirement. This is the core fix for the self-correction
// loop — instead of trusting the model to remember every SLO while writing
// free-flowing prose, we force it to visibly account for each one.
//
// If a single SLO bundles multiple parallel targets (e.g. "length AND mass",
// "unit fractions AND non-unit fractions"), the model is told to treat each
// target as its own checklist row — this is what catches the "did length,
// forgot mass" failure mode specifically.
function buildSloChecklist(lesson) {
  const items = lesson.slos.map((code, i) => `${i + 1}. [${code}] ${lesson.slo_descriptions[i]}`).join('\n');
  return `
SLO COVERAGE CHECKLIST — treat each numbered line as a required target:
${items}

If any single SLO above names more than one target (e.g. two units like length
AND mass, or two categories like unit AND non-unit fractions), split it into
separate sub-targets and cover each one with its own explicit content — do not
let coverage of one target substitute for the other.

STRUCTURE REQUIREMENT: Organize your output so each checklist number above has
its own clearly labelled subsection (a short heading naming the SLO code or
target is enough). This is mandatory — it is what lets the checklist below be
verified.

MANDATORY SELF-CHECK: After the main content, add a short section titled
"SLO Coverage Check" with one line per checklist number above, in the form:
"[SLO code / target] — covered in [subsection name]". Before writing this,
re-read your own draft and confirm each line is actually true — if a target
turns out to be missing, go back and add it before finishing your answer.
Do not submit a coverage line that isn't actually true.`;
}

// Helper: for lessons with many SLOs or multiple parallel units/domains
// (e.g. a measurement lesson covering both Length and Mass), it is more
// reliable to call a section prompt once PER DOMAIN and concatenate the
// results than to ask one call to juggle everything at once. Use this to
// split a lesson's SLOs into domain-specific "sub-lessons" that share the
// same lesson/chapter metadata but carry only their own slice of SLOs, e.g.:
//
//   const lengthSlice = sliceLessonBySlos(lesson, ['M-03-A-10','M-03-A-11']);
//   const massSlice   = sliceLessonBySlos(lesson, ['M-03-A-12','M-03-A-13']);
//   const lengthConcept = await run(conceptBuildingPrompt(lengthSlice, ...));
//   const massConcept   = await run(conceptBuildingPrompt(massSlice, ...));
//   const fullConcept = lengthConcept + '\n\n' + massConcept;
//
// This keeps each individual call to 2-3 SLOs, which is where smaller/mid-size
// models hold coverage reliably — the audit step then becomes a rare safety
// net instead of the primary mechanism for reaching full coverage.
function sliceLessonBySlos(lesson, sloCodes) {
  const idxs = lesson.slos.map((c, i) => sloCodes.includes(c) ? i : -1).filter(i => i !== -1);
  return {
    ...lesson,
    slos: idxs.map(i => lesson.slos[i]),
    slo_descriptions: idxs.map(i => lesson.slo_descriptions[i]),
  };
}

// ─── Audit / self-correction verification ────────────────────────
// This is the generalized version of the original pedagogical-audit framework
// (Flaw → Critique → Correction → Verdict) used earlier to review lessons by
// hand, now turned into a reusable verification prompt for the self-correction
// loop. Key differences from a naive "does this match the textbook" check:
//   - SLOs are the authoritative spec. Textbook context (if any) is advisory
//     only, same as formatContext() above — a topic mismatch between the
//     retrieved textbook chunk and the SLOs is NOT grounds for failure, since
//     textbook coverage is inherently incomplete. Only failure to teach the
//     SLOs themselves, or teaching outside the SLOs' scope, counts.
//   - Adds an explicit check for a mini exercise/practice block at the end of
//     the lesson (a lesson that ends on pure exposition with no practice fails).
//   - Adds an explicit tone & complexity read: is this appropriately simple,
//     self-study-readable prose for the grade, not just curriculum-accurate.
//   - Output is strict JSON so the self-correction loop can parse it reliably
//     ({"pass": boolean, "feedback": "..."}) instead of needing to scrape a
//     free-text verdict.
function auditPrompt(sectionName, sectionContent, lesson, chapter, grade = 3, contextChunks = []) {
  const system = `You are a pedagogical auditor for Pakistani primary school mathematics content,
reviewing content written for Grade ${grade}. You check drafted lesson sections against the
official NCP 2022-23 SLOs for that lesson, using this framework:

1. CURRICULUM GAP — Is every SLO's target actually taught (not just mentioned in passing)? If an
   SLO names multiple sub-targets (e.g. two units, or unit AND non-unit categories), check each
   sub-target separately — partial coverage of a multi-part SLO is still a gap.
2. MISSION CREEP / SCOPE — Does the content add a term, skill, or numeric range that is NOT in
   this lesson's SLOs — content that belongs to a different lesson, a different grade, or is
   just adjacent/commonly-taught-together but not actually asked for here? Flag it even if it
   seems educational; the lesson must stay inside its assigned SLOs.
3. TONE & COMPLEXITY — Read the section as a Grade ${grade} child would, studying alone with no
   teacher present. Is the sentence length, vocabulary, and level of abstraction appropriate for
   an independent, possibly not-yet-fluent reader at this grade? Flag dense paragraphs, jargon
   not defined in plain words, or a register borrowed from a more advanced discipline.
4. DEFINITIONAL ACCURACY — Are definitions and facts mathematically correct and pitched at the
   SLO's own wording, not simplified into something false or complicated into something advanced?
5. EXAMPLE QUALITY (if this section contains worked examples or practice items) — Are they
   distinct from each other (no near-duplicate examples testing the same mechanic twice), and do
   they stay within any numeric bound stated in the SLOs?
6. MINI-EXERCISE CHECK — If this section is the final section of the lesson, or is explicitly a
   practice/quiz/mental-maths/takeaway section, confirm the lesson as a whole ends with some kind
   of mini exercise or practice block for the student to actually attempt (not just exposition).
   If this section is NOT the lesson's final or practice-type section, this check does not apply
   — say so rather than failing the lesson for it.

TEXTBOOK CONTEXT RULE: if reference textbook context is provided below, treat it as advisory
only. Reference textbooks are frequently incomplete or cover a different sub-topic than the
lesson's actual SLOs. A mismatch or absence of matching textbook context is NEVER, by itself, a
reason to fail — only mismatch against the SLOs themselves is grounds for failure.

Respond with ONLY a valid JSON object, no markdown fences, no explanation outside the JSON:
{
  "pass": true or false,
  "feedback": "If pass is false, a numbered list (as a single string) of the specific gaps found, each phrased as: what's missing/wrong, and what to add or change to fix it. If pass is true, a brief one-line confirmation."
}
Pass the audit if the SLOs are fully and accurately covered, scope is respected, tone/complexity
fits Grade ${grade} self-study, and (where applicable) a mini exercise is present. Do not fail
for a textbook-context mismatch alone.`;

  const contextText = contextChunks && contextChunks.length
    ? `\nReference textbook context (ADVISORY ONLY — see rule above):\n` +
      contextChunks.map((c, i) => `[Chunk ${i + 1} from ${c.source} page ${c.page}]:\n${c.text}`).join('\n\n') + '\n'
    : '';

  const user = `Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
Section being audited: ${sectionName}

SLOs for this lesson (NCP 2022-23 — authoritative):
${lesson.slo_descriptions.map((d, i) => `${i + 1}. [${lesson.slos[i]}] ${d}`).join('\n')}
${contextText}
Section content to audit:
"""
${sectionContent}
"""

Audit this section now and return the JSON verdict.`;

  return { system, user };
}


// Converts a "visual description" (as produced inside Concept Building /
// Examples, e.g. "Draw a number line showing...") into a short, concrete
// image-search query. Google Images returns much better real-world results
// for concrete keyword phrases than for meta-words like "diagram",
// "illustration", "infographic", "graphic", or "chart" — those bias results
// toward stylized clipart/vector stock images instead of clean, useful photos
// or simple figures. Keep this as its own small, cheap call rather than
// reusing the visual description text directly as the query.
function imageSearchQueryPrompt(visualDescription, topic, grade) {
  const system = `You turn a lesson's visual description into a short Google Images search query.
Output ONLY the query text — no quotes, no explanation, nothing else.
Rules:
- 3 to 6 words, concrete and specific to the actual subject matter.
- Never include meta-words about image TYPE: no "diagram", "illustration",
  "infographic", "graphic", "chart", "picture of", "image of", "visual", "clipart".
  These words make Google Images return stylized/generic results instead of
  clean, concrete, useful ones.
- Describe the real-world subject or the concrete math object directly.
  Example: for a lesson on 5-digit place value, the query is "5 digit place value"
  — not "place value diagram" or "place value chart illustration".
  Example: for comparing fraction pieces of a roti, the query is "roti pieces fraction"
  — not "fraction comparison diagram".
- If the visual is a generic instructional device (e.g. "a number line", "a bar model"),
  just name the concrete device plus the topic — e.g. "number line 1 to 20" — still
  no "diagram"/"illustration".`;

  const user = `Grade: ${grade}
Topic: ${topic}
Visual description from the lesson: "${visualDescription}"

Write the search query now.`;

  return { system, user };
}

// ─── Step 2: Section generators ──────────────────────────────────

function warmUpPrompt(lesson, chapter, grade, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Warm-Up section for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

The Warm-Up should:
- Have a short friendly heading: "🌟 Warm-Up"
- Include 3 numbered questions that activate prior knowledge
- Be appropriate for Grade ${grade} students
- Connect to what students already know before introducing new content
- Use real-life Pakistani contexts (food, cricket, money, daily life)
- Questions should be answerable without the new lesson content
- Keep each question to one short sentence

Write ONLY the warm-up content. Start directly with the questions. No preamble.`;

  return { system, user };
}

function conceptBuildingPrompt(lesson, chapter, grade, warmUpText, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Concept Building section for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

Warm-Up that was just taught:
${warmUpText}

The Concept Building section should:
- Start with a clear definition or key concept in bold, in plain everyday words —
  never a definition borrowed from a more advanced or more abstract register than the
  SLO itself uses
- Explain the concept step by step using simple Grade ${grade} language and short sentences
- Include at least one visual description (e.g. "Draw a number line showing...") which will be used to generate a graphic.
- Use concrete examples before abstract rules
- Cover ALL the SLOs listed above thoroughly — and ONLY those SLOs; do not add an
  adjacent skill or vocabulary term that isn't in the SLO text, even if it's commonly
  taught alongside this topic in other curricula
- Be comprehensive on the assigned SLOs, but do not pad with restatement — every
  sub-section should teach something new, not re-explain the same idea a different way
- Include sub-sections with h4 headings if multiple distinct concepts are covered, but
  don't split one concept into multiple headings just to look thorough
- Use Pakistani real-life contexts where relevant
${buildSloChecklist(lesson)}

Write the concept building content, ending with the mandatory "SLO Coverage Check" section described above.`;

  return { system, user };
}

function examplesPrompt(lesson, chapter, grade, conceptText, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write 3–4 worked Examples for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

Concept just taught:
${conceptText.slice(0, 800)}...

Each example should:
- Be labelled "Example 1", "Example 2", etc.
- Show a clear question
- Use a LEAN working format only: "Step 1:", "Step 2:" (at most 3 steps), then a single
  line labelled "Answer:". Do NOT add separate "What we know", "What we must find", or
  "Why this works" paragraphs — if a step needs reasoning, fold it into that step's own
  sentence instead of giving it its own paragraph.
- Progress from easier to harder
- Each example MUST test a genuinely different sub-skill or scenario from the SLOs —
  never write two examples that use the same mechanic with different numbers (e.g. don't
  write two separate "compare two unit fractions" examples; write one, and use the other
  example slots for the lesson's other sub-skills)
- Use Grade ${grade} appropriate numbers and contexts, respecting any numeric bound
  stated in the SLOs
${buildSloChecklist(lesson)}

Write the worked examples, ending with the mandatory "SLO Coverage Check" section described above. No introduction sentence needed before the examples themselves.`;

  return { system, user };
}

function popUpQuizPrompt(lesson, chapter, grade, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Pop-Up Quiz section for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

The Pop-Up Quiz should:
- Start with heading "✏️ Pop-Up Quiz"
- Have Part A: Fill in the blanks (4 questions)
- Have Part B: Multiple Choice Questions (4 questions, each with options a, b, c, d)
- Test understanding of the concepts just taught — nothing beyond this lesson's SLOs
- Be appropriate for Grade ${grade}
- MCQ options should include one correct answer and three plausible distractors

Write ONLY the quiz content.`;

  return { system, user };
}

function mentalMathsPrompt(lesson, chapter, grade, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Mental Maths section for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

The Mental Maths section should:
- Start with heading "🧠 Mental Maths"
- Include 5–6 quick questions
- Be solvable without writing (mental calculation only)
- Progress from simple to slightly challenging
- Directly relate to the lesson content, staying within this lesson's SLOs
- Be appropriate for Grade ${grade}

Write ONLY the mental maths questions. No introduction needed.`;

  return { system, user };
}

function practiceQuestionsPrompt(lesson, chapter, grade, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Practice Questions section for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

The Practice Questions should:
- Start with heading "📝 Practice Questions"
- Have Part A: Straightforward skill practice (4–5 questions)
- Have Part B: Applied/contextual questions (3–4 questions using Pakistani contexts)
- Have Part C: Real-Life Thinking — 2 word problems that require multi-step thinking,
  but only using operations/skills already covered by this lesson's SLOs
- Cover all SLOs taught in this lesson
- Include a mix of difficulty levels
- Word problems should use real Pakistani contexts (names, currency, food, cricket etc.)
${buildSloChecklist(lesson)}

Write the practice questions, ending with the mandatory "SLO Coverage Check" section described above.`;

  return { system, user };
}

function keyTakeawaysPrompt(lesson, chapter, grade, allSections, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Key Takeaways section for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

The Key Takeaways should:
- Start with heading "⭐ Key Takeaways"
- Have 5–7 bullet points
- Summarise the most important concepts from this lesson — this lesson's SLOs only
- Be written as clear, memorable statements, one short sentence each
- Cover every SLO that was taught in this lesson
- Use simple Grade ${grade} language

Write ONLY the key takeaways bullet points.`;

  return { system, user };
}

// ─── Stage 4: Supporting Artifacts ───────────────────────────────

function videoScriptPrompt(lesson, chapter, grade) {
  const system = SYSTEM_BASE;
  const user = `Write a 10-scene educational Video Script based on this lesson.
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

The script must have two recurring characters:
1. **Amina**: The teacher/guide who explains concepts.
2. **Zahid**: A curious Grade ${grade} student who asks practical questions.

Structure the script precisely as a 10-scene sequence. For each scene, include:
- **Scene Number and Description** (e.g. Scene 1: Amina stands at a whiteboard...)
- **Visual**: A description of what is visible on the screen.
- **Dialogue**: The spoken words for Amina and Zahid. Keep each line short — this is
  spoken dialogue for young viewers, not written prose.
- **Narration**: Any voiceover or sound effects.

Keep the tone highly engaging, conversational, and age-appropriate. Explain the core math concepts from the lesson, staying within this lesson's SLOs.`;

  return { system, user };
}

function unitAssessmentPrompt(chapter, grade, lessons) {
  const system = SYSTEM_BASE;

  const lessonsSummaries = lessons.map(l =>
    `Lesson ${l.number}: ${l.title} (SLOs: ${l.slo_descriptions.join(', ')})`
  ).join('\n');

  const user = `Write a comprehensive Unit Assessment covering the entire chapter.

Chapter: ${chapter.title} (Grade ${grade})
Strand: ${chapter.strand || 'Mathematics'}

Here are the lessons and SLOs covered in this unit (NCP 2022-23 — use this exact wording):
${lessonsSummaries}

The Unit Assessment must contain:
1. **Section A: Multiple Choice Questions** (6 questions, each with 4 options and a clear correct answer)
2. **Section B: Short-Answer Questions** (6 questions testing conceptual understanding across all lessons)
3. **Section C: Word Problems / Applied Math** (4 word problems involving multi-step thinking using Pakistani contexts)
4. **Detailed Answer Key**: Include correct answers and brief explanations/workings for every question in Sections A, B, and C.

Every question must map to one of the SLOs listed above — do not introduce a skill or
numeric range from outside this unit's SLOs.

Write the assessment content directly. Start with the title "📝 Unit Assessment: ${chapter.title}".`;

  return { system, user };
}

module.exports = {
   introductionPrompt,
  structurePrompt,
  warmUpPrompt,
  conceptBuildingPrompt,
  examplesPrompt,
  popUpQuizPrompt,
  mentalMathsPrompt,
  practiceQuestionsPrompt,
  keyTakeawaysPrompt,
  videoScriptPrompt,
  unitAssessmentPrompt,
  imageSearchQueryPrompt,
  sliceLessonBySlos,
  buildSloChecklist,
  auditPrompt,
  parseSlosText,
  hydrateStructure,
};