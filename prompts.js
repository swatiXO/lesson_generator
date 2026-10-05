// prompts.js — all LLM prompts for the lesson generator
//
// ═══════════════════════════════════════════════════════════════════════════
// DESIGN PRINCIPLES (v7 — realigned to the approved manual lesson format;
// v8 — cross-lesson prerequisite awareness + structure-prompt hardening)
// ═══════════════════════════════════════════════════════════════════════════
//
// This file generates a full Pakistani school math lesson (SNC 2022 / NCP
// 2022-23 curriculum) as a sequence of section prompts, each calling a local
// LLM (qwen3:14b via Ollama) once. The section flow and box vocabulary below
// were rebuilt to exactly match the manually-authored reference lessons
// (Chapter 7 Geometry, Grade 6) that this pipeline is meant to reproduce:
//
//   Title block (structural)
//   -> "SLOs Covered in This Lesson" (structural)
//   -> Introduction (LLM)
//   -> Student Learning Outcomes bullet list (structural)
//   -> Opening Warm-Up (LLM, boxed)
//   -> Concept Building, split into Parts (LLM). EVERY Part ends with a
//     mandatory Your Turn box (questions + highlighted Answer Key) AND a
//     mandatory Warm-Up box (quick oral check) - not optional extras.
//   -> Mental Maths (LLM, boxed)
//   -> Full "Your Turn" section, two columns A/B (LLM, boxed)
//   -> Practice Questions: Parts A/B/C/D + a Word Problem box + an optional
//     Challenge box + a full Answer Key box (LLM)
//   -> Key Takeaways (LLM, plain bullets)
//
// v7 changes from the previous version, and why:
//
// 1. TEXTBOOK CONTEXT IS NOW A HARD DEPTH CEILING, NOT ADVISORY FLAVOR.
//    The previous system prompt told the model textbook context was
//    optional and a mismatch was "never grounds for failure." In practice
//    this let content drift beyond both the SLO and the textbook's actual
//    depth (e.g. introducing a named formula or coordinate-algebra method
//    the source textbook never uses for that topic) while staying nominally
//    "on-topic" for the SLO's one-line description. SLOs are a single
//    sentence; they cannot by themselves bound HOW FAR a technique goes.
//    The textbook chunk is what bounds that. Every prompt and the auditor
//    now treat supplied textbook context as authoritative for depth,
//    vocabulary, and technique - not just topic.
//
// 2. REPEATING WARM-UP + YOUR TURN AFTER EVERY PART IS NOW STRUCTURAL, NOT
//    OPTIONAL. The previous "occasional quick-check" instruction is gone.
//    Every Part in Concept Building MUST close with a boxed Your Turn
//    (answer key included) and a boxed Warm-Up (short oral check bridging
//    to the next Part). This is a hard requirement in conceptBuildingPrompt
//    and is checked by the in-generation self-check block.
//
// 3. BOX MARKERS. DocBuilder.js now renders coloured boxes (navy section
//    bars, teal Warm-Up, purple Your Turn, red Remember/Challenge, teal
//    Word Problem, green Answer Key) instead of flat paragraphs. Prompts
//    emit machine-readable markers - [WARMUP_START]...[WARMUP_END],
//    [YOURTURN_START]...[YOURTURN_END], [REMEMBER_START]...[REMEMBER_END],
//    [WORDPROBLEM_START]...[WORDPROBLEM_END], [CHALLENGE_START]...
//    [CHALLENGE_END], [ANSWERKEY_START]...[ANSWERKEY_END] - so DocBuilder
//    can reliably find box boundaries. These markers are never visible to
//    students; DocBuilder consumes them and renders the box instead.
//
// 4. Pop-Up Quiz is renamed/restructured into the full "Your Turn" section
//    (two columns, A and B) that sits between Mental Maths and Practice
//    Questions, matching the approved format exactly. Think Time is
//    retired as a standalone section - its actual purpose (catching a
//    likely misconception) now lives as the OPTIONAL Challenge box inside
//    Practice Questions, used only when it fits within the same textbook
//    depth ceiling as everything else (never an excuse to go deeper).
//
// Everything else - grade-band tone calibration, real-life context variety,
// cross-section variety tracking, the audit/retry loop, independent answer
// verification - is kept, because it was already solving real problems
// unrelated to the structural gap this revision closes.
//
// [FIX — grades 7-12] SYSTEM_BASE_TEMPLATE previously only defined distinct
// tone/complexity bands up to "Grade 5-6" — anything above that fell into
// the same top band, meaning a Grade 11 student got calibrated identically
// to a Grade 6 student. This was discovered when ingest.py's grade regex
// (separately) turned out to be capped at 1-6 too, and the actual scope of
// this app is Grades 1-12, not primary-only. Added three more bands
// (7-8, 9-10, 11-12) reflecting the real jump in abstraction, vocabulary,
// and sentence complexity across secondary school — see the tone table
// immediately below.
//
// v8 CHANGES, AND WHY:
//
// 5. CROSS-LESSON PREREQUISITE AWARENESS (chapterProgressBlock, new). Each
//    lesson's RAG context was scoped only to that lesson's own SLOs, with
//    zero awareness of what earlier or later lessons IN THE SAME CHAPTER
//    cover. In practice this produced real forward-references: a lesson
//    generated early (e.g. "Selecting Appropriate Graphs") would freely use
//    a term ("continuous data") that a LATER lesson in the same chapter
//    ("Understanding Data Types") is the one actually responsible for
//    teaching — usually because a RAG-retrieved textbook chunk mentioned
//    the term in passing while covering the current lesson's own topic, and
//    nothing told the model that term belonged to unwritten material.
//    chapterProgressBlock() gives every section prompt an explicit, ordered
//    list of this chapter's OTHER lessons — split into "already taught,
//    safe to build on" and "not yet taught, do not assume the student knows
//    this" — built from `chapter.lessons`, which server.js now sets once
//    (structure.lessons) before the generation loop starts. This does not
//    replace per-lesson SLO scoping (scopeFence still governs WHAT this
//    lesson may teach); it only prevents an early lesson from silently
//    assuming knowledge that, in THIS chapter's own planned order, hasn't
//    been introduced yet.
//
// 6. structurePrompt() now explicitly instructs the model to double-check
//    that every supplied SLO code appears in some lesson's "slos" array
//    before responding, and to prefer a lesson titled "Miscellaneous" or
//    folding a stray SLO into the most topically-adjacent existing lesson
//    over silently dropping it. This is a first line of defense only —
//    the actual enforcement (parsing the response, diffing SLO codes,
//    retrying if any are missing) now happens in server.js's /api/structure
//    handler, since only code can guarantee that check runs; this prompt
//    change just makes the model less likely to need that retry in the
//    first place.
//
// ═══════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────
// SYSTEM_BASE_TEMPLATE — the shared foundation every section prompt builds on
// ─────────────────────────────────────────────────────────────────
const SYSTEM_BASE_TEMPLATE = (grade) => {
  const g = parseInt(grade, 10);

  let toneBand;
  if (g <= 2) {
    toneBand = `- Sentences: 5-8 words each. One idea per sentence.
- Vocabulary: only the most common everyday words. No multi-syllable words unless absolutely
  required by the SLO's own terminology.
- Abstraction: concrete objects and actions only (counting real things, simple comparisons).
  Never introduce a rule before showing 2+ concrete instances of it.
- Numbers/examples: keep quantities small and countable on fingers or a simple drawing.`;
  } else if (g <= 4) {
    toneBand = `- Sentences: 8-14 words each, mostly simple sentences; an occasional short compound
  sentence ("...and so...", "...but...") is fine.
- Vocabulary: everyday words; a new math term is allowed only if it is defined immediately,
  in the same sentence or the next one, using a concrete comparison.
- Abstraction: introduce a rule only AFTER at least one worked concrete example. Avoid
  multi-step abstract chains — one new idea at a time.
- Numbers/examples: whole numbers and simple fractions/decimals a Grade 3-4 child could
  picture (money in tens/hundreds, small distances, small counts).`;
  } else if (g <= 6) {
    toneBand = `- Sentences: up to 18-20 words where needed for precision, but default to shorter.
  A Grade 5-6 reader can hold a slightly longer sentence, but never sacrifice clarity for length.
- Vocabulary: everyday words preferred, but grade-appropriate math terms (from the SLO's own
  wording, or from the supplied textbook context) can be used directly once defined once — no
  need to re-explain a term every time it reappears.
- Abstraction: a short chain of 2 connected ideas is fine (e.g. a rule plus why it works),
  but always anchor it to a concrete example first. Avoid pure symbol manipulation with no
  grounding context.
- Numbers/examples: negative numbers, larger quantities, multi-step word problems are fine
  if the SLO calls for them — do not artificially simplify below what the SLO requires, and do
  not artificially exceed the depth actually shown in any supplied textbook context.`;
  } else if (g <= 8) {
    toneBand = `- Sentences: up to 20-28 words where precision calls for it — a Grade 7-8 reader can hold a
  genuinely complex sentence, but don't pad length just to sound advanced.
- Vocabulary: formal mathematical/scientific terms are expected, not just tolerated — use the
  SLO's own technical wording directly, defining it clearly on first use rather than avoiding it.
  A concrete anchor is still valuable for engagement, but is no longer a comprehension crutch —
  a formal definition CAN lead, with the concrete example following to reinforce it, not always
  the other way around.
- Abstraction: multi-step reasoning chains (3+ connected ideas) are appropriate — early algebraic
  manipulation, multi-step derivations, and short logical justifications ("this is true because...,
  which means...") are all within reach. Still ground new abstract ideas in a worked instance
  before asking the student to generalize from it.
- Numbers/examples: negative numbers, fractions, early algebraic expressions, and multi-step
  word problems combining 2+ operations are all standard here — do not simplify below the SLO's
  actual demand, and match whatever depth the supplied textbook context shows.`;
  } else if (g <= 10) {
    toneBand = `- Sentences: up to 30 words where genuinely needed for a precise mathematical/scientific
  statement — this reader can track a formally-structured sentence with a subordinate clause.
- Vocabulary: full technical register expected — use standard notation and terminology (e.g.
  formal algebraic notation, named theorems, standard scientific vocabulary) exactly as a
  Grade 9-10 (matriculation-level) textbook would, defining a genuinely new term once, briefly,
  without over-explaining terms a student at this level should already carry from earlier grades.
- Abstraction: formal definitions and derivations can lead a section outright — a concrete
  real-world anchor is a valuable engagement device, not a required comprehension scaffold at
  this level. Multi-step proofs, chained algebraic manipulation, and abstract generalization
  from a single worked case are all appropriate.
- Numbers/examples: full real-number range, multi-step algebraic/geometric problems, and
  compound word problems requiring 3+ chained operations are standard — match the SLO's actual
  demand and the depth shown in any supplied textbook context, without artificial softening.`;
  } else {
    toneBand = `- Sentences: length is governed by precision, not a word-count ceiling — this reader (Grade
  11-12, intermediate/pre-university level) can track a fully-formal mathematical or scientific
  register, including nested clauses, provided every clause earns its place.
- Vocabulary: use the full technical and notational register a Grade 11-12 textbook would —
  formal definitions, standard notation, named results — without re-deriving vocabulary this
  student should already carry from Grade 9-10. Define a genuinely new term once, precisely.
- Abstraction: lead with formal statement, derivation, or proof where the SLO calls for it;
  a real-world anchor is optional flavor at this level, not a scaffold the student needs to
  understand the abstraction itself. Multi-step derivations and chained abstract reasoning
  across several steps are the expected default, not an exception.
- Numbers/examples: full real-number range, multi-step algebraic/calculus-adjacent or advanced
  geometric reasoning as the SLO calls for it — never soften below the SLO's actual demand or
  the depth shown in any supplied textbook context.`;
  }

  return `You are an expert curriculum designer writing Pakistani school mathematics lessons for a
Word-document courseware pipeline. You write for whichever grade is specified in each request —
do not assume a fixed grade range. You strictly follow the Single National Curriculum (SNC) 2022
Student Learning Outcomes (SLO codes, e.g. M-06-D-05) provided to you in each prompt. Use ONLY
the SLO text given to you.

GRADE ${g} TONE CALIBRATION (follow this exactly — do not default to a generic "keep it simple"
register that ignores grade level):
${toneBand}

═══════════════════════════════════════════════════════════════════════
SCOPE DISCIPLINE — READ THIS CAREFULLY, IT IS THE MOST IMPORTANT RULE HERE
═══════════════════════════════════════════════════════════════════════
Three independent boundaries apply, and ALL must be respected — being inside one does not excuse
violating another:

(a) THE SLO IS THE TOPIC BOUNDARY. Do not teach or test a skill, term, or numeric range that
    is not named in the SLO text you were given, even if it feels like a natural extension of
    the same general subject.

(b) THE SUPPLIED TEXTBOOK CONTEXT, WHEN PRESENT, IS THE DEPTH CEILING. If reference textbook
    context is supplied in a prompt below, it is NOT optional flavor and a mismatch is NOT
    something you may simply ignore — it defines the maximum depth, vocabulary, notation, and
    solution technique allowed for this lesson. A technique can be entirely "on-topic" for the
    SLO and still be forbidden because it goes deeper than what the textbook itself shows for
    this exact concept. Concretely: if the textbook explains a concept using only diagrams,
    counting, and plain words, you may NOT introduce a formula, a named theorem, coordinate
    notation, or an algebraic method for that same concept — even if that method is
    mathematically correct and even if it is "the standard way" a more advanced student would
    solve it. When NO textbook context is supplied for a given section, use the SLO text alone
    and default to the SIMPLEST correct method — never reach for a more advanced approach on
    your own initiative "to be thorough."

(c) IF A "CHAPTER PROGRESS" BLOCK IS SUPPLIED, IT IS THE SEQUENCING BOUNDARY. It tells you which
    of THIS chapter's other lessons have already been taught (safe to build on) and which come
    LATER (not yet taught). Never use a term, technique, or named concept that belongs ONLY to a
    later lesson, even if a supplied textbook chunk happens to mention it in passing while
    covering this lesson's own topic — that chunk existing in your context does not mean the
    student has seen it yet. If unsure whether something belongs to an earlier or later lesson,
    treat it as not-yet-taught and avoid relying on it.

If you are ever unsure whether something belongs, leave it out. An incomplete-feeling but
strictly-scoped lesson is correct; a richer-feeling lesson that quietly exceeds the SLO, the
textbook's depth, or this chapter's own teaching order is a failure, regardless of how
well-written it is.
═══════════════════════════════════════════════════════════════════════

This content is read directly by a school student, often studying with a teacher or independently
at home. Never use a definition or register borrowed from an older/higher discipline (e.g.
university-level formalism, set-theoretic notation) unless that is the literal wording of the
SLO itself or is explicitly shown in the supplied textbook context.

REAL-LIFE CONTEXT VARIETY (read carefully — this governs OPTIONAL grounding, not every sentence):
Where you do ground an idea in real life, use genuine Pakistani daily life, and ROTATE across
DIFFERENT scenario categories within the same lesson rather than defaulting to the same 1-2
every time. Draw from this pool:
  - Money & shopping: rupees, a dukaan, buying/selling, pocket money, saving for something
  - Food & home: sharing food between siblings, cooking measurements, dividing a roti/cake
  - Sports: cricket, but also hockey (Pakistan's national sport), kabaddi, football
  - Weather & seasons: temperature, rainfall, Karachi humidity vs. Murree cold
  - Transport: rickshaw, bus, qingqi, train, distances between cities (Lahore, Karachi,
    Islamabad, Peshawar, Multan, Gilgit, Quetta)
  - School & family life: classroom counts, siblings, school supplies, a family trip
  - Festivals & events: Eid, a wedding/mehndi, a school function
  - Building & making things: construction, farming/crops, sewing/textiles, kite-making
  - Architecture & craft (Grade 5+): mosque tiles, truck art, railway tracks, tractor wheels
Naming a person in an example is OPTIONAL and should be occasional, not a default habit — many
good explanations and questions need no named character at all ("a shopkeeper," "a family,"
or better yet, a direct address to the reader: "imagine you..."). When a section's own
instructions cap how often a named character may open an explanation, that cap is a hard rule,
not a suggestion.
Do not force a scenario that doesn't naturally fit the math involved — clarity of the concept
always outranks variety for its own sake.

You always respond with well-structured, complete text — never truncate or summarise.
You never say "I will now write..." — just write the content directly.
Never reference a different grade level by number in student-facing text (e.g. do not write
"In Grade 5 you learned..."). If you need to bridge to prior knowledge, phrase it without a
grade number: "You already know that..." — never anchor it to a specific earlier grade.`;
};

// Kept only for any legacy code that imports SYSTEM_BASE directly without a
// grade. Every prompt function below calls SYSTEM_BASE_TEMPLATE(grade)
// directly and should NOT use this ungraded fallback — it exists purely so
// an old import doesn't crash.
const SYSTEM_BASE = SYSTEM_BASE_TEMPLATE(4);


// ─────────────────────────────────────────────────────────────────
// Cross-section variety tracking
// ─────────────────────────────────────────────────────────────────
const NAME_POOL = [
  'Ali', 'Sara', 'Amina', 'Bilal', 'Ayesha', 'Farhan', 'Sami', 'Usman', 'Hassan', 'Zara',
  'Fatima', 'Omar', 'Hamza', 'Maria', 'Noor', 'Zainab', 'Bilqees', 'Kamran', 'Rabia',
  'Imran', 'Saima', 'Tariq', 'Nadia', 'Asad', 'Mahnoor', 'Faizan', 'Sadia', 'Waqas',
  'Hira', 'Danish',
];

const CONTEXT_CATEGORIES = {
  money:     ['rupee', 'rupees', 'rs.', 'dukaan', 'pocket money', 'shopkeeper', 'saving', 'price', 'bought', 'sold'],
  food:      ['roti', 'cake', 'biryani', 'chocolate bar', 'sharing food', 'cooking', 'recipe', 'mango', 'mangoes', 'sweets'],
  sports:    ['cricket', 'hockey', 'kabaddi', 'football', 'runs', 'overs', 'wicket', 'match'],
  weather:   ['temperature', 'rainfall', 'humidity', 'weather', 'monsoon', '°c', 'degree'],
  transport: ['rickshaw', 'qingqi', 'train', 'lahore', 'karachi', 'islamabad', 'peshawar',
              'multan', 'gilgit', 'quetta', 'rawalpindi', 'muzaffarabad', 'distance', 'km'],
  school:    ['classroom', 'notebook', 'homework', 'family trip', 'siblings'],
  festival:  ['eid', 'wedding', 'mehndi', 'school function', 'celebration'],
  building:  ['construction', 'farming', 'crops', 'textile', 'sewing', 'kite', 'farmer', 'field'],
  craft:     ['mosque', 'jaali', 'truck art', 'railway', 'tractor wheel', 'calligraphy'],
};

function extractUsedContext(text) {
  if (!text) return { categories: [], names: [] };
  const lower = text.toLowerCase();

  const categories = Object.entries(CONTEXT_CATEGORIES)
    .filter(([, keywords]) => keywords.some(kw => lower.includes(kw)))
    .map(([cat]) => cat);

  const names = NAME_POOL.filter(name => new RegExp(`\\b${name}\\b`, 'i').test(text));

  return { categories, names };
}

function mergeUsedContext(a = {}, b = {}) {
  return {
    categories: [...new Set([...(a.categories || []), ...(b.categories || [])])],
    names: [...new Set([...(a.names || []), ...(b.names || [])])],
  };
}

function formatUsedContext(usedContext) {
  const categories = usedContext?.categories || [];
  const names = usedContext?.names || [];
  if (!categories.length && !names.length) return '';

  const lines = [];
  if (categories.length) lines.push(`Categories already used earlier in this lesson: ${categories.join(', ')}.`);
  if (names.length) lines.push(`Character names already used earlier in this lesson: ${names.join(', ')}.`);

  return `\nVARIETY CHECK — avoid repeating what's already been used in THIS lesson so far:
${lines.join('\n')}
Pick a DIFFERENT category for your new examples where the math allows it. If you name a
character, use a different one than what's already listed above — but naming someone at all
remains optional, not required (see the note on this in the system instructions above).\n`;
}


// ─────────────────────────────────────────────────────────────────
// [NEW v8] chapterProgressBlock() — cross-lesson prerequisite awareness.
//
// Built from `chapter.lessons`, which server.js now sets once (to the full
// `structure.lessons` array) before the generation loop starts, so any
// prompt function that already receives `chapter` — every section prompt
// does — can build this block without a signature change. Returns '' for
// a single-lesson chapter (nothing useful to say) or if `chapter.lessons`
// wasn't populated (keeps this backward-compatible with any caller that
// hasn't been updated to set it).
// ─────────────────────────────────────────────────────────────────
function chapterProgressBlock(chapter, currentLessonNumber) {
  const allLessons = chapter && chapter.lessons;
  if (!allLessons || allLessons.length < 2) return '';

  const before = allLessons
    .filter(l => l.number < currentLessonNumber)
    .sort((a, b) => a.number - b.number);
  const after = allLessons
    .filter(l => l.number > currentLessonNumber)
    .sort((a, b) => a.number - b.number);

  if (!before.length && !after.length) return '';

  const describe = (l) => `  - Lesson ${l.number}: ${l.title} — ${(l.slo_descriptions || []).join('; ')}`;

  let out = `\nCHAPTER PROGRESS — this chapter's OTHER lessons, for prerequisite awareness only
(see SCOPE DISCIPLINE rule (c) above). This does NOT change what THIS lesson's own SLOs require
you to teach — it only tells you what the student does or doesn't already know from elsewhere
in this same chapter.\n`;

  if (before.length) {
    out += `\nAlready taught earlier in this chapter (safe to assume the student knows these — you
may reference them briefly without re-teaching, e.g. "you already know how to group data into
classes"):\n${before.map(describe).join('\n')}\n`;
  }

  if (after.length) {
    out += `\nNOT yet taught — these come LATER in the chapter, so the student does NOT know this
yet. Do not use a term, technique, formula, or named concept that belongs ONLY to one of these
later lessons, even if it would make an explanation more elegant, and even if supplied textbook
context happens to mention it in passing:\n${after.map(describe).join('\n')}\n`;
  }

  return out;
}


// ─────────────────────────────────────────────────────────────────
// stripInternalMarkers() — removes internal-only diagnostic blocks before
// the docx renderer ever sees the text. Box markers ([WARMUP_START] etc.)
// are NOT stripped here — DocBuilder.js consumes those directly to build
// coloured boxes. Only SLO_CHECK / QUALITY_CHECK style HTML-comment blocks
// are stripped by this function.
// ─────────────────────────────────────────────────────────────────
function stripInternalMarkers(text) {
  if (!text) return text;

  let cleaned = text.replace(
    /<!--\s*(\w+)_START\s*-->[\s\S]*?<!--\s*\1_END\s*-->/gi,
    ''
  );

  cleaned = cleaned.replace(
    /^(#+\s*)?(\*{1,2})?[A-Z]-\d{2}-[A-Z]-\d{2}[:\s].*(\*{1,2})?$/gm,
    ''
  );

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}


// ─────────────────────────────────────────────────────────────────
// formatContext() — RAG context, split into current-grade material and an
// optional prior-knowledge "bridge". Current-grade chunks now render with
// EXPLICIT ceiling language instead of the previous "ignore it completely
// if it doesn't match" framing.
// ─────────────────────────────────────────────────────────────────
function formatContext(contextChunks) {
  if (!contextChunks || !contextChunks.length) return '';

  const current = contextChunks.filter(c => !c.isPriorGrade);
  const prior = contextChunks.filter(c => c.isPriorGrade);

  let out = '';

  if (current.length) {
    out += `\nREFERENCE TEXTBOOK CONTEXT (AUTHORITATIVE DEPTH CEILING — see SCOPE DISCIPLINE above):\n` +
      current.map((c, i) => `[Chunk ${i+1} from ${c.source} page ${c.page}]:\n${c.text}`).join('\n\n') +
      `\n\nHOW TO USE THIS: The SLO tells you the topic; this textbook context tells you HOW DEEP to
go and WHICH METHOD to use. Match the technique, vocabulary, and level of formality actually
shown here — do not introduce a more advanced method, a formula the textbook doesn't use, or
notation the textbook doesn't use, even if it would be mathematically valid. If this chunk
covers a narrower slice than the full SLO, that's fine — use it for what it covers and fall back
to the simplest correct method (per the SCOPE DISCIPLINE rule above) for whatever it doesn't
cover. Use local Pakistani naming contexts regardless of what naming the textbook chunk uses.\n`;
  }

  if (prior.length) {
    out += `\nPRIOR-KNOWLEDGE BRIDGE (from an earlier stage of the curriculum — reference ONLY):\n` +
      prior.map((c, i) => `[Prior chunk ${i+1} from ${c.source} page ${c.page}]:\n${c.text}`).join('\n\n') +
      `\n\nHOW TO USE THIS: This shows what students already learned earlier on a related topic. Use
it ONLY to write ONE short bridge sentence connecting that prior knowledge to today's new
concept — phrased WITHOUT naming a specific grade number (e.g. "You already know how to compare
whole numbers — today we use that same idea for decimals," never "In Grade 5 you learned..."). Do
NOT re-teach this prior content, do NOT test it, and do NOT let its scope leak into this lesson.
If it doesn't genuinely connect to what you're teaching, ignore it completely rather than forcing
a bridge that doesn't fit.\n`;
  }

  return out;
}

function scopeFence(lesson) {
  return `\nSCOPE RULE: Only teach or test content strictly covered by THIS lesson's SLOs below,
and never deeper than what any supplied textbook context shows (see SCOPE DISCIPLINE above).
Do not include a skill, term, or numeric range from a different lesson or grade, even if it
feels like a natural next step. If an SLO states a numeric bound, never exceed it.
SLOs for this lesson:
${lesson.slo_descriptions.join('; ')}\n`;
}

function buildSloChecklist(lesson) {
  const items = lesson.slos.map((code, i) =>
    `${i + 1}. [${code}] ${lesson.slo_descriptions[i]}`
  ).join('\n');

  return `
SLO COVERAGE CHECKLIST — treat each numbered line as a required target:
${items}

HEADING RULE (critical): Do NOT use SLO codes (e.g. "M-06-A-05") as headings or sub-headings
in your content. SLO codes are internal labels only — a child should never see them.
Use plain descriptive headings instead (e.g. "Parallel Lines", "Finding Unknown Angles").

If any single SLO names more than one target, cover each sub-target with its own Part.

MANDATORY SELF-CHECK: After the main content, add a coverage verification block formatted
EXACTLY like this — including the HTML comment tags, which are required:

<!-- SLO_CHECK_START -->
SLO Coverage Check
${lesson.slos.map((code, i) => `[${code}] — covered in [Part name]`).join('\n')}
<!-- SLO_CHECK_END -->

Re-read your draft before writing the coverage check. Only mark a target covered if it
genuinely appears in your content. Do not submit a line that isn't true.`;
}

function buildQualityCheck() {
  return `
MANDATORY SELF-CHECK: Before finalizing your answer, re-read your own draft above and honestly
answer each line below, then add a self-check block formatted EXACTLY like this — including the
HTML comment tags, which are required:

<!-- QUALITY_CHECK_START -->
Quality Self-Check
- Every Part has exactly one [YOURTURN_START]...[YOURTURN_END] block with an Answer Key inside
  it, placed immediately after that Part's worked example(s): [yes/no]
- Every Part has exactly one [WARMUP_START]...[WARMUP_END] block placed immediately after that
  Part's Your Turn block: [yes/no]
- Every worked example's numbers and method match the depth shown in any supplied textbook
  context — nothing more advanced was introduced: [yes/no]
- Sub-concepts opening with a named character: [count — must be 0 or 1, never more]
- Sub-concepts opening with the literal words "Imagine" or "Think about/of": [count — must be
  0 or 1 total across the WHOLE section, never more]
- Every sub-concept has at least one Worked Example with a shown Answer: [yes/no]
- Number of worked examples per sub-concept reflects genuinely distinct cases, not a fixed
  count applied everywhere: [yes/no]
- Every bold definition is self-contained (makes sense with no dependence on its opener's
  specific imagery): [yes/no]
- No term, technique, or named concept from a "NOT yet taught" lesson (if a CHAPTER PROGRESS
  block was supplied above) was assumed as known: [yes/no — write "n/a" if no such block was
  supplied]
<!-- QUALITY_CHECK_END -->

If any answer reveals a problem — a missing Your Turn or Warm-Up box on any Part, a technique
exceeding the textbook's shown depth, 2 or more character-led openings, 2 or more "Imagine"/
"Think about/of" openings, a sub-concept missing a worked example, a definition that only makes
sense alongside its opener's imagery, or reliance on a not-yet-taught concept — REWRITE the
affected Part(s) BEFORE giving your final answer. Do not submit a draft you already know fails
its own check.`;
}

function sliceLessonBySlos(lesson, sloCodes) {
  const idxs = lesson.slos.map((c, i) => sloCodes.includes(c) ? i : -1).filter(i => i !== -1);
  return {
    ...lesson,
    slos: idxs.map(i => lesson.slos[i]),
    slo_descriptions: idxs.map(i => lesson.slo_descriptions[i]),
  };
}

function extractVisualDescription(text) {
  if (!text) return null;
  const match = text.match(/\[VISUAL:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function extractConceptHighlights(allSections) {
  const cb = allSections?.conceptBuilding;
  if (!cb) return '(No Concept Building content available — summarize from the SLOs directly.)';

  const lines = cb.split('\n');
  const highlights = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      highlights.push(`- ${headingMatch[1].trim()}`);
      continue;
    }
    const boldMatch = line.match(/\*\*(.+?)\*\*/);
    const last = highlights[highlights.length - 1];
    if (boldMatch && last && !last.includes(':')) {
      highlights[highlights.length - 1] = `${last}: ${boldMatch[1].trim()}`;
    }
  }

  return highlights.length
    ? highlights.join('\n')
    : '(No Part headings detected — summarize from the SLOs directly.)';
}


// ─── Introduction ──────────────────────────────────────────────────

const INTRODUCTION_STYLE_EXEMPLAR = `
STYLE REFERENCE (drawn from the approved manual lesson format — shown to demonstrate the
register expected, not a template to copy. Do NOT reuse this topic or wording):

Look at the railway tracks running from Lahore to Karachi — the two rails never meet, no matter
how far they go. Look at the corner of your classroom wall — two walls meet at a perfectly
straight angle. Look at a road crossing a railway track — one line cuts across two others. All
of these are everyday examples of the lines we will study in this lesson.
In this lesson, you will learn the difference between parallel, perpendicular and intersecting
lines. You will also learn about the transversal — a line that cuts across two other lines — and
the special angles it creates: corresponding, alternate and vertically opposite angles.

Notice: no dialogue in this example, continuous prose, ends with a plain sentence (not a bullet
list) previewing what will be learned, opens with concrete real-world objects the reader has
actually seen, and never references a grade number. A dialogue-driven opener (two short lines of
speech between named characters) is equally valid for a different lesson if it suits the topic
better — vary your choice across different lessons rather than defaulting to the same one every
time. Whichever you choose, keep it to 2-3 short paragraphs and never teach the concept formally
here — this section builds curiosity only.
`;

function introductionPrompt(lesson, chapter, grade, contextChunks = [], usedContext = {}) {
  const system = `${SYSTEM_BASE_TEMPLATE(grade)}

You are writing the Introduction — a short hook that builds curiosity before the lesson
formally begins, for a Pakistani Grade ${grade} student.
${INTRODUCTION_STYLE_EXEMPLAR}
Decide, for THIS lesson, whether to:
- Open with continuous narrative prose and no dialogue at all, the way the STYLE REFERENCE does
  (this is the default — prefer it unless dialogue genuinely suits the topic better).
- OR open with a short spoken exchange between two people (2-4 lines total, alternating
  speakers, formatted "**Name:** ..." on its own line) — if you do, pick names from the
  REAL-LIFE CONTEXT VARIETY name pool in the system instructions; these are NOT fixed characters
  that repeat every lesson.

Close with a single flowing sentence (or two) previewing what will be learned — NOT a bullet
list, matching the STYLE REFERENCE exactly. NEVER show SLO codes or their formal curriculum
wording directly. NEVER reference a specific grade number.

Do not teach the concept formally yet — this section exists to build curiosity, not to deliver
the lesson itself. Only reference ideas that belong to THIS lesson's SLOs. Target length: 2-3
short paragraphs (roughly 80-150 words total).`;

  const user = `Lesson: "${lesson.title}"
Chapter: "${chapter.title}"
Grade: ${grade}
Learning outcomes (SNC 2022 — authoritative for what this lesson covers; paraphrase these
into plain student-friendly language, never show the codes or formal wording directly):
${lesson.slo_descriptions.join('; ')}
${formatContext(contextChunks)}
${chapterProgressBlock(chapter, lesson.number)}
${formatUsedContext(usedContext)}
Write the Introduction now, choosing whichever approach genuinely suits this lesson's topic.`;

  return { system, user };
}


// ─── Structure generation ────────────────────────────────

function structurePrompt(slosText, grade) {
  const system = `You are an expert curriculum planner for Pakistani school mathematics,
following SNC 2022 SLOs. Respond ONLY with a valid JSON object — no markdown code fences, no
explanation before or after, just the raw JSON.

When splitting SLOs into lessons:
- Copy each SLO's CODE exactly as given below into "slos" — never paraphrase or invent a code.
- Keep SLOs that test genuinely different skill types in SEPARATE lessons where the chapter
  contains more than one such category.
- SLOs that cannot be taught without each other (e.g. one defines a concept, the next asks you
  to find unknown values using it) belong in the SAME lesson.
- A lesson should only ever be assigned the SLOs it will actually teach.
- Do NOT retype each SLO's full description text — only its code.
- Order lessons so that a lesson never depends on a concept only a LATER lesson introduces —
  e.g. a lesson about interpreting/selecting data displays should come AFTER the lesson that
  defines the data-type vocabulary (discrete/continuous, grouped/ungrouped) it relies on, not
  before it, even if the SLOs were listed in a different order in the source material. Sequence
  by genuine conceptual dependency, not by the order SLOs happen to appear in the input.

CRITICAL — SLO COVERAGE: every single SLO code given to you below MUST appear in the "slos"
array of exactly one lesson in your response. Before you respond, go back through the FULL list
of SLO codes you were given and confirm each one appears somewhere in your output. An SLO that
doesn't obviously fit an existing lesson's theme is NOT grounds for dropping it — either fold it
into the most topically-adjacent lesson, or give it its own lesson. A chapter with a missing SLO
is an incomplete chapter, which is a hard failure of this task regardless of how coherent the
rest of the plan looks.`;

  const user = `Grade: ${grade}

Here are the Student Learning Outcomes (SLOs) for a chapter, from SNC 2022:

${slosText}

Plan the chapter. Decide:
1. A chapter title (the chapter NUMBER is assigned separately by the caller — do not worry
   about picking a meaningful number, any placeholder integer is fine there)
2. How many lessons (as many as genuinely needed — do not force unrelated SLOs together just
   to keep the lesson count low)
3. Which SLOs each lesson covers (by CODE only — do not retype their text) — see the CRITICAL
   SLO COVERAGE instruction above; every code listed above must appear exactly once across
   your lessons
4. A title for each lesson
5. A one-sentence description of each lesson
6. The teaching ORDER of the lessons, so no lesson depends on a concept only a later lesson
   defines (see the ordering instruction above)

Before responding, re-read the full SLO list above one more time and mentally check off each
code against your planned lessons. If any code isn't checked off, fix your plan before writing
the final JSON.

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
      "sections": ["Warm-Up", "Concept Building", "Mental Maths", "Your Turn", "Practice Questions", "Key Takeaways"]
    }
  ]
}`;

  return { system, user };
}

function parseSlosText(slosText) {
  const map = {};
  const lines = slosText.split('\n');

  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let m = trimmed.match(/^\[SLO:\s*([A-Za-z0-9-]+)\]\s*(.*)$/i);
    if (m) { map[m[1].trim()] = m[2].trim(); return; }

    m = trimmed.match(/^([A-Za-z]-\d{2}-[A-Za-z]-\d{2})\b[:-\s]*(.*)$/i);
    if (m) { map[m[1].trim()] = m[2].trim(); return; }

    m = trimmed.match(/^([A-Za-z0-9-]+)[:-\s]+(.*)$/);
    if (m && m[1].includes('-')) { map[m[1].trim()] = m[2].trim(); }
  });

  return map;
}

function hydrateStructure(structureJson, slosText) {
  const slosMap = parseSlosText(slosText);

  if (structureJson.chapter && structureJson.lessons.length > 0) {
    const firstCode = structureJson.lessons[0].slos[0] || '';
    const codeGradeMatch = firstCode.match(/^[A-Z]-(\d{2})-/);
    if (codeGradeMatch) {
      const codeGrade = parseInt(codeGradeMatch[1], 10);
      const chapterGrade = parseInt(structureJson.chapter.grade, 10);
      if (codeGrade !== chapterGrade) {
        console.warn(
          `[hydrateStructure] Grade mismatch: SLO codes suggest grade ${codeGrade} ` +
          `but chapter.grade is ${chapterGrade}. ` +
          `Check that the correct grade was passed to structurePrompt() — ` +
          `every downstream prompt calibrates tone to chapter.grade, so this ` +
          `mismatch will silently produce wrong-register content for the ` +
          `actual grade the SLOs belong to.`
        );
      }
    }
  }

  for (const lesson of structureJson.lessons) {
    lesson.slo_descriptions = lesson.slos.map(code => {
      const desc = slosMap[code];
      if (desc && desc.trim()) return desc.trim();
      return lesson.title;
    });
  }
  return structureJson;
}


// ─── Auditor ────────────────────────────────────────────────

function auditPrompt(sectionName, sectionContent, lesson, chapter, grade = 3, contextChunks = []) {
  const system = `You are a pedagogical auditor for Pakistani school mathematics content,
reviewing content written for Grade ${grade}. You check drafted lesson sections against the
official SNC 2022 SLOs for that lesson, using this framework:

1. CURRICULUM GAP — Is every SLO's target actually taught (not just mentioned in passing)?
2. MISSION CREEP / SCOPE — Does the content add a term, technique, or numeric range that is NOT
   in the SLO text AND NOT shown in the supplied textbook context (when context was supplied)?
   A technique being "a natural way to solve this" or "mathematically valid" is NOT a defense —
   if it isn't in the SLO wording or the textbook context, it is out of scope. This includes:
   introducing a named formula, theorem, or algebraic/coordinate method the textbook context
   never uses for this concept, even while the content stays nominally "on-topic" for the SLO.
   When NO textbook context was supplied, judge scope by the SLO text alone.
3. STRUCTURAL COMPLETENESS (Concept Building only) — Does EVERY Part have exactly one
   [YOURTURN_START]...[YOURTURN_END] block with an Answer Key, AND exactly one
   [WARMUP_START]...[WARMUP_END] block, in that order, immediately after that Part's worked
   example(s)? A Part missing either box is a FAIL on this check.
4. TONE & COMPLEXITY — Is vocabulary, sentence length, and abstraction right for a Grade ${grade}
   child? Specifically flag: adventure/fantasy framing in the introduction, dictionary-style
   definitions that come before any concrete example (for grades where a concrete anchor is
   still required — see the grade's own tone calibration for whether this applies), SLO codes
   appearing as student-facing headings, a specific grade number referenced in student-facing
   text, and REPEATED use of the same real-life scenario category across more than 2 Parts in
   the same lesson.
5. DEFINITIONAL ACCURACY — Are definitions correct and pitched at the SLO's wording and the
   textbook context's level of formality? ALSO: is each bold definition SELF-CONTAINED — would
   it still make complete sense to a reader who skipped the sentence before it?
6. WORKED EXAMPLE QUALITY — Does EVERY Part have at least one "Worked Example" with a fully
   shown Answer? Are the numbers and METHOD within any numeric SLO bound and within the depth
   shown by the textbook context? Where multiple examples exist for one Part, are they
   genuinely different cases (not the same reasoning with swapped numbers)?
7. CHARACTER-NARRATIVE OVERUSE (Concept Building only) — count how many Parts open with a named
   character doing something. More than ONE Part opening with a named character in the same
   section is a FAIL.
8. OPENER VARIETY (Concept Building only) — count how many Parts open with the literal words
   "Imagine" or "Think about"/"Think of". More than ONE such opening in the same section is a
   FAIL.
9. PREREQUISITE LEAKAGE — if a "CHAPTER PROGRESS" block was supplied to the writer (visible in
   the section content only indirectly, via any term/technique that matches a lesson listed as
   "NOT yet taught"), does the content rely on a concept that, per this chapter's own planned
   order, hasn't been introduced yet? Flag this the same way you'd flag scope creep.

TEXTBOOK CONTEXT RULE: when textbook context WAS supplied, it is authoritative for depth and
technique — content that goes beyond it, even while staying "on topic" for the SLO, should be
flagged under check 2. Only when NO textbook context was supplied at all should scope be judged
by the SLO text alone, and an absence of context is never itself grounds for failure.

Respond with ONLY a valid JSON object, no markdown fences:
{
  "pass": true or false,
  "feedback": "If false: numbered list of gaps, each with what's wrong and how to fix. If true: one-line confirmation.",
  "failedChecks": [array of check numbers (1-9) that failed — empty array if pass is true]
}`;

  const contextText = contextChunks && contextChunks.length
    ? `\nReference textbook context (AUTHORITATIVE FOR DEPTH — see check 2):\n` +
      contextChunks.map((c, i) => `[Chunk ${i+1} from ${c.source} page ${c.page}]:\n${c.text}`).join('\n\n') + '\n'
    : '\n(No textbook context was supplied for this section — judge scope by the SLO text alone.)\n';

  const user = `Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
Section being audited: ${sectionName}

SLOs for this lesson (SNC 2022 — authoritative):
${lesson.slo_descriptions.map((d, i) => `${i + 1}. [${lesson.slos[i]}] ${d}`).join('\n')}
${contextText}
${chapterProgressBlock(chapter, lesson.number)}
Section content to audit:
"""
${sectionContent}
"""

Audit this section now and return the JSON verdict.`;

  return { system, user };
}

function imageSearchQueryPrompt(visualDescription, topic, grade) {
  const system = `You turn a lesson's visual description into a short Google Images search query.
Output ONLY the query text — no quotes, no explanation, nothing else.
Rules:
- 3 to 6 words, concrete and specific to the actual subject matter.
- Never include meta-words about image TYPE: no "diagram", "illustration", "infographic","Grade 4",
  "graphic", "chart", "picture of", "image of", "visual", "clipart",'diagram','worksheet'.
- No need to pick and choose exact words. Remember, this is a google search query.
  - Describe the real-world subject or the concrete math object directly.`;

  const user = `Grade: ${grade}
Topic: ${topic}
Visual description from the lesson: "${visualDescription}"
Write the search query now.`;

  return { system, user };
}


// ─── Warm-Up (opening) ──────────────────────────────────────

const WARMUP_STYLE_EXEMPLAR = `
STYLE REFERENCE (drawn from the approved manual lesson format — shown to demonstrate the level
expected, not a template to copy. Do NOT reuse this topic or wording):

Think and answer before we start:
1. Look at the two rails of a railway track. Do they ever meet? What do you call lines like these?
2. Look at the corner of your desk or classroom wall. What type of angle is formed where two
   edges meet?
3. Imagine a road crossing a railway track. How many lines are involved? What does the crossing
   road do to the railway lines?

Notice: 3 short numbered questions, each one a genuine think-first prompt using something the
reader can picture or has seen, no physical materials required, no answer key needed (these are
meant to be answered by observation/recall, not calculated) — though a brief answer key is fine
to include if the question isn't self-evidently checkable by the reader alone.
`;

function warmUpPrompt(lesson, chapter, grade, context = [], usedContext = {}) {
  const system = SYSTEM_BASE_TEMPLATE(grade);
  const user = `Write the OPENING Warm-Up section for this lesson — this is the one that appears
before Concept Building begins, not one of the per-Part warm-ups inside it.
${formatContext(context)}
${scopeFence(lesson)}
${chapterProgressBlock(chapter, lesson.number)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
${WARMUP_STYLE_EXEMPLAR}
Rules:
- Wrap the ENTIRE section in box markers, exactly like this, with nothing outside them:
  [WARMUP_START]
  Think and answer before we start:
  1. ...
  2. ...
  3. ...
  [WARMUP_END]
- Exactly 3 numbered questions.
- Use ONLY prior knowledge — nothing from this lesson's new content. Never reference a specific
  grade number when bridging to prior knowledge.
- Be appropriate for Grade ${grade} students per the tone calibration above.
- Use a real-life Pakistani context — pick ONE category from the REAL-LIFE CONTEXT VARIETY
  pool in the system instructions; do not default to money/shopkeeper if another category fits
  better. A named character is optional here, not required.
- Do NOT include any SLO codes in the text — plain student-friendly language only.
${formatUsedContext(usedContext)}
Write ONLY the box-marked content described above. No preamble, nothing outside the markers.`;

  return { system, user };
}


// ─── Concept Building ────────────────────────────────────

const CONCEPT_BUILDING_STYLE_EXEMPLAR = `
STYLE REFERENCE (drawn from the approved manual lesson format on an unrelated topic — shown to
demonstrate the exact structure and depth expected, not a template to copy. Do NOT reuse this
topic, numbers, or wording):

## Part A: Parallel Lines, Intersecting Lines and Perpendicular Lines

Before we study the transversal and angles, we must understand the three basic types of lines.

### i. Parallel Lines
The railway track and the zebra crossing on a road are examples of parallel lines. Two or more
lines that extend in the same direction and remain the same distance apart are called
**parallel lines.**
- Parallel lines never meet, no matter how far they are extended.
- The symbol || is used to show parallel lines.

Real-life examples: railway tracks, the two sides of a ruler, opposite sides of a rectangle.

### ii. Perpendicular Lines
Two lines that meet or intersect each other at a right angle (90°) are called
**perpendicular lines.** The symbol is used to show perpendicular lines.
[VISUAL: three real-life photos side by side — a tall tree on flat ground, a flagpole on a
pavement, the corner of two adjacent walls — each labelled as an example of perpendicular lines]

Worked Example — Identifying Line Types
Look at the following and write whether they are parallel, perpendicular, or intersecting: (i)
the two rails of a railway track (ii) the corner of a textbook (iii) the hands of a clock at 3
o'clock.
Step 1: The rails run in the same direction and never meet — parallel.
Step 2: The textbook corner forms a right angle — perpendicular.
Step 3: The clock hands cross at the centre at an angle that is not 90° — intersecting.
Answer: (i) Parallel (ii) Perpendicular (iii) Intersecting

[YOURTURN_START]
1. Write one real-life example of each: (a) parallel lines (b) perpendicular lines.
2. Can two lines be both parallel and intersecting at the same time? Explain.
Answer Key:
1. Answers will vary — e.g. (a) railway tracks (b) corner of a wall.
2. No — if two lines are parallel they never meet, so they cannot intersect.
[YOURTURN_END]

[WARMUP_START]
Quick check — answer without looking at your notes!
1. What is the angle between two perpendicular lines?
2. Do parallel lines ever meet?
3. What is the point called where two lines cross each other?
[WARMUP_END]

Notice what this reference demonstrates:
- Sub-headings inside a Part use "### " for sub-types of the same idea (i, ii, iii) — the Part
  itself always uses "## Part X: Title".
- The worked example is directly followed by the mandatory Your Turn box, which is directly
  followed by the mandatory Warm-Up box — always in that order, always both present.
- The Your Turn box's Answer Key is INSIDE the same box, after a literal "Answer Key:" line.
- The Warm-Up box's questions are short oral/think-first checks, not written computation.
- No formula was invented for "type of line" because there isn't one — only genuinely numeric
  ideas get a "Formula:" line, and only when a genuine formula exists.
`;

function conceptBuildingPrompt(lesson, chapter, grade, warmUpText, context = [], usedContext = {}) {
  const system = SYSTEM_BASE_TEMPLATE(grade);
  const user = `Write the Concept Building section for this lesson. This section includes its own
worked examples woven directly into each Part, plus a mandatory Your Turn box and a mandatory
Warm-Up box at the end of EVERY Part — there is no separate "Worked Examples", "Pop-Up Quiz", or
"Think Time" section elsewhere, so give this section the full depth and structure it needs to
stand alone.
${formatContext(context)}
${scopeFence(lesson)}
${chapterProgressBlock(chapter, lesson.number)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

Opening Warm-Up that was just shown to the student (do not repeat its questions):
${warmUpText}
${CONCEPT_BUILDING_STYLE_EXEMPLAR}
Organise this section as a sequence of PARTS — "Part A", "Part B", "Part C" and so on (roughly
one Part per SLO or major idea; closely related sub-types, like different kinds of the same
object, MAY share one Part if splitting them would feel repetitive — use "### " sub-headings
inside a Part for that case, exactly like the STYLE REFERENCE's "i. Parallel Lines" /
"ii. Perpendicular Lines").

For EACH Part, in this exact order:

1. Heading: "## Part [Letter]: [Plain descriptive title]" — never an SLO code.

2. Explanation, written the way a real textbook author would for THIS specific idea:
   - Sometimes a concrete real-life opener earns its place; sometimes a plain, direct
     definition is the better opener — vary this across Parts, don't default to one style.
   - If the idea has a genuine underlying formula, state it as its own clear line
     ("Formula: ..."). If it doesn't have a real formula (many geometry/classification ideas
     don't), do NOT invent one just to have one.
   - A definition, wherever it appears, must be GENUINELY SELF-CONTAINED.

3. At least one Worked Example, labelled "Worked Example — [short descriptive name]", in the
   format: Question → Step 1 → Step 2 (→ Step 3 if genuinely needed) → "Answer:" on its own
   line. Include more than one when the Part has genuinely distinct cases worth showing — not
   as padding.

4. A MANDATORY [YOURTURN_START]...[YOURTURN_END] box, immediately after the worked example(s):
   - 2-4 questions directly testing THIS Part's content (not a future Part's).
   - A literal "Answer Key:" line inside the same box, followed by the answer to every question
     in order.
   - This is REQUIRED for every single Part — not optional, not occasional.

5. A MANDATORY [WARMUP_START]...[WARMUP_END] box, immediately after the Your Turn box:
   - Exactly 3 short questions — quick oral/recall checks, not written computation.
   - These can consolidate the Part just taught OR bridge toward the next Part — whichever
     fits better.
   - This is REQUIRED for every single Part — not optional, not occasional.

6. An analogy/metaphor and a Fun Fact are BOTH genuinely optional — include either only where
   it adds real value to THIS specific Part.

RHETORICAL VARIETY (applies across the WHOLE section, not per Part):
- Do not let any single opening technique become the default used in most Parts.
- HARD CAP: the exact words "Imagine" and "Think about"/"Think of" combined may be used as an
  OPENER at most ONCE TOTAL across the entire section — not once per Part.
- A named-character mini-story as an opener is allowed ONLY as a rare exception — at most ONE
  Part total across the whole section may open with a named character.

Other rules:
- Include at least one visual moment somewhere in this section, tagged EXACTLY like this on its
  own line: [VISUAL: a plain description of what to draw]. Use this bracketed tag format
  specifically so it can be extracted cleanly — do not just describe a visual in regular prose.
- Follow the REAL-LIFE CONTEXT VARIETY rule in the system instructions for any optional real-
  world grounding — use a DIFFERENT scenario category where the math allows it.
- If a "PRIOR-KNOWLEDGE BRIDGE" block appears above, open the FIRST Part it genuinely connects
  to with one short bridge sentence linking that prior knowledge to the new idea — phrased
  WITHOUT a specific grade number. If no such block appears, skip this entirely.
- If a "CHAPTER PROGRESS" block appears above, never rely on a concept listed under its "NOT yet
  taught" heading — treat those exactly as if they don't exist yet for this lesson's student.
- Be comprehensive on the assigned SLOs — and ONLY those SLOs, and ONLY as deep as any supplied
  textbook context shows (see SCOPE DISCIPLINE in the system instructions).
- Use Grade ${grade} appropriate numbers throughout.
- No fixed target length — let each Part's actual content decide how long it runs, but every
  Part MUST contain its Your Turn and Warm-Up boxes regardless of length.
${buildSloChecklist(lesson)}
${buildQualityCheck()}
${formatUsedContext(usedContext)}
Write the concept building content now, Part by Part, each ending in its mandatory Your Turn
box and Warm-Up box. End with the QUALITY_CHECK block, and after that, the mandatory SLO
Coverage Check block, as the very last thing.`;

  return { system, user };
}


// ─── Mental Maths ─────────────────────────────────────────

function mentalMathsPrompt(lesson, chapter, grade, context = [], usedContext = {}, conceptBuildingText = '') {
  const system = SYSTEM_BASE_TEMPLATE(grade);

  const difficultyFloorBlock = conceptBuildingText
    ? `\nDIFFICULTY FLOOR — for reference only, these Your Turn questions were already answered
during Concept Building (excerpt below, may be truncated):
${conceptBuildingText.slice(0, 1200)}${conceptBuildingText.length > 1200 ? '...' : ''}
Your Mental Maths questions should generally sit AT OR ABOVE this difficulty, not noticeably
below it — this is reinforcement, not easier filler.\n`
    : '';

  const user = `Write the Mental Maths section for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
${chapterProgressBlock(chapter, lesson.number)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
${difficultyFloorBlock}
Rules:
- Wrap the ENTIRE section in box markers, exactly like this, with nothing outside them:
  [WARMUP_START]
  Answer in your head — no writing!
  1. ...
  2. ...
  ...
  Answer Key:
  1. ... 2. ... (etc, all on one or two lines)
  [WARMUP_END]
  (Yes, Mental Maths uses the same box style as Warm-Up — both are quick-recall boxes.)
- Include 5-6 quick questions numbered 1-6.
- Solvable without writing (mental calculation only).
- Progress from simple to slightly challenging.
- Relate directly to the lesson content, staying within this lesson's SLOs and textbook depth.
- Follow the GRADE ${grade} TONE CALIBRATION above — very short, plain questions.
- Do NOT include SLO codes in the questions.
- The "Answer Key:" line and the answers themselves are MANDATORY inside the box.
- Every stated answer MUST be arithmetically correct — double check each one yourself before
  writing it down; an incorrect Answer Key is a failure of this task regardless of how good the
  questions are.
${formatUsedContext(usedContext)}
Write ONLY the box-marked content described above.`;

  return { system, user };
}


// ─── Full "Your Turn" section (two columns) ────────────────

function yourTurnFullPrompt(lesson, chapter, grade, context = [], usedContext = {}) {
  const system = SYSTEM_BASE_TEMPLATE(grade);
  const user = `Write the full "Your Turn" section for this lesson — this is the consolidated
review section that comes AFTER Mental Maths and BEFORE Practice Questions, distinct from the
per-Part Your Turn boxes already inside Concept Building. It reviews the WHOLE lesson so far,
not just one Part.
${formatContext(context)}
${scopeFence(lesson)}
${chapterProgressBlock(chapter, lesson.number)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

Structure this as exactly two labelled sub-parts, A and B, each covering a different aspect of
the lesson (e.g. one on concepts/identification, one on calculation/application — choose
groupings that fit this lesson's actual content). For EACH sub-part:

- A short heading line: "A.  [short label]" or "B.  [short label]" (plain text, not a markdown
  heading).
- Then wrap ONLY that sub-part's questions and answer key in its own box markers:
  [YOURTURN_START]
  1. ...
  2. ...
  3. ...
  Answer Key:
  1. ... 2. ... 3. ...
  [YOURTURN_END]

Rules:
- Each sub-part: 3-4 questions.
- Cover material spanning MULTIPLE Parts of Concept Building, not just one — this is a
  consolidation checkpoint.
- Follow the GRADE ${grade} TONE CALIBRATION above.
- Do NOT include SLO codes anywhere in the text.
- The Answer Key inside each box is MANDATORY.
- Every stated answer MUST be arithmetically correct — solve each question yourself before
  writing its answer down, rather than writing a plausible-looking answer.
${formatUsedContext(usedContext)}
Write "A. [label]" then its box, then "B. [label]" then its box. Nothing else.`;

  return { system, user };
}


// ─── Practice Questions ───────────────────────────────────

function practiceQuestionsPrompt(lesson, chapter, grade, context = [], usedContext = {}, conceptBuildingText = '') {
  const system = SYSTEM_BASE_TEMPLATE(grade);

  const difficultyFloorBlock = conceptBuildingText
    ? `\nDIFFICULTY FLOOR — for reference only, these Your Turn questions were already answered
during Concept Building (excerpt below, may be truncated):
${conceptBuildingText.slice(0, 1200)}${conceptBuildingText.length > 1200 ? '...' : ''}
Parts A/B should be comparable to or slightly above this difficulty; Parts C/D should be
clearly above it — re-testing something easier than what was already covered reads as filler.\n`
    : '';

  const user = `Write the Practice Questions section for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
${chapterProgressBlock(chapter, lesson.number)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
${difficultyFloorBlock}
Structure, in this exact order:

Part A — Identify / Short Answer (3-5 questions, direct recall or identification, no real-life
  wrapper needed).
Part B — Calculate / Apply (3-4 questions requiring calculation or applying a rule taught in
  this lesson).
Part C — True or False (4-5 statements testing precise understanding of definitions/rules).
Part D — Short Reasoning (2-3 questions asking the student to explain or justify, not just
  compute — "why", "what does this tell you", etc.).

Then a MANDATORY [WORDPROBLEM_START]...[WORDPROBLEM_END] box:
  E.  Word Problem
  [ONE multi-step real-life word problem using a genuine Pakistani context, combining 2+ ideas
  from this lesson where possible]
  (i) ...
  (ii) ...
  Answer Key:
  (i) ... — with brief working, not just the final value
  (ii) ...

Then an OPTIONAL [CHALLENGE_START]...[CHALLENGE_END] box — include this ONLY if you can write a
genuine extension question that stays STRICTLY within this lesson's SLO and textbook depth
ceiling (e.g. combining two ideas already taught, or a slightly less obvious case of the same
rule) — never a technique or vocabulary beyond what the rest of the lesson used. If you cannot
do this honestly within the depth ceiling, OMIT the Challenge box entirely rather than stretch
for one.

Then a MANDATORY [ANSWERKEY_START]...[ANSWERKEY_END] box containing the full answer key for
Parts A, B, and C (Part D's reasoning answers can be brief model answers; the Word Problem and
Challenge boxes already carry their own answer keys inside themselves, so do not repeat them
here):
  Answer Key — Practice
  A: ...
  B: ...
  C: ...
  D: [brief model reasoning for each]

Rules:
- Cover all SLOs taught in this lesson across Parts A-D combined.
- Follow the GRADE ${grade} TONE CALIBRATION above throughout.
- Difficulty must genuinely progress WITHIN each part.
- Word problems use varied Pakistani contexts — rotate, don't repeat what's already used.
- Do NOT label any group with an SLO code — Part A/B/C/D labels only.
- Never exceed the depth shown in any supplied textbook context, in ANY part including the
  optional Challenge box.
- Before writing any answer key (Parts A-C's, the Word Problem's, or the optional Challenge
  box's), solve the question yourself from scratch first — every stated answer, including all
  arithmetic in the Word Problem's working, MUST be correct. Double-check any total, sum, or
  multi-step calculation specifically, since that is where errors are most likely to hide.
${buildSloChecklist(lesson)}
${formatUsedContext(usedContext)}
Write Parts A-D, then the Word Problem box, then the Challenge box (only if it genuinely earns
its place), then the Answer Key box, then finally the mandatory SLO Coverage Check block.`;

  return { system, user };
}


// ─── Key Takeaways ────────────────────────────────────────

function keyTakeawaysPrompt(lesson, chapter, grade, allSections, context = []) {
  const system = SYSTEM_BASE_TEMPLATE(grade);

  const highlights = extractConceptHighlights(allSections);

  const user = `Write the Key Takeaways section for this lesson.
${formatContext(context)}
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}

What this lesson's Concept Building section actually covered (Part: definition):
${highlights}

Rules:
- 6-9 bullet points, one per line, each a complete plain sentence.
- Do NOT type a dash, hyphen, or bullet character at the start of any line yourself — the
  bullet marker is applied structurally by the document builder. Just write the sentence.
- Summarise the most important ideas from THIS lesson only, based on what's actually listed
  above — do not re-derive generic takeaways purely from the SLO wording if it drifts from
  what was actually taught.
- Each bullet: one short, clear, memorable sentence following the GRADE ${grade} TONE
  CALIBRATION above.
- Cover every Part listed above.
- Do NOT include SLO codes in the bullet text — plain student language only.
- Do NOT wrap this section in any box markers — Key Takeaways is plain bulleted text, not a
  coloured box.

Write ONLY the key takeaway lines, one per line, no heading (the heading is added
structurally), no preamble.`;

  return { system, user };
}


// ─── Stage 4: Supporting Artifacts ───────────────────────────────

function videoScriptPrompt(lesson, chapter, grade, allSections = {}) {
  const system = SYSTEM_BASE_TEMPLATE(grade);

  const highlights = extractConceptHighlights(allSections);
  const highlightsBlock = allSections?.conceptBuilding
    ? `\nWhat this lesson's Concept Building actually covered (Part: definition) —
reference these so Amina and Zahid's dialogue reflects the real lesson, not a generic version:
${highlights}\n`
    : '';

  const user = `Write a 10-scene educational Video Script based on this lesson.
${scopeFence(lesson)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
${highlightsBlock}
The script must have two recurring characters:
1. **Amina**: The teacher/guide who explains concepts.
2. **Zahid**: A curious Grade ${grade} student who asks practical questions.

Structure as a 10-scene sequence. For each scene, include:
- Scene Number and Description
- Visual: what is visible on screen
- Dialogue: spoken words for Amina and Zahid — keep each line short, this is spoken dialogue,
  following the GRADE ${grade} TONE CALIBRATION above
- Narration: any voiceover or sound effects

Keep tone engaging, conversational, and age-appropriate. Stay within this lesson's SLOs and
textbook depth. Never reference a specific grade number in the dialogue itself.`;

  return { system, user };
}

function unitAssessmentPrompt(chapter, grade, lessons) {
  const system = SYSTEM_BASE_TEMPLATE(grade);

  const lessonsSummaries = lessons.map(l =>
    `Lesson ${l.number}: ${l.title} (SLOs: ${l.slo_descriptions.join(', ')})`
  ).join('\n');

  const user = `Write a comprehensive Unit Assessment covering the entire chapter.

Chapter: ${chapter.title} (Grade ${grade})
Strand: ${chapter.strand || 'Mathematics'}

Lessons and SLOs covered (SNC 2022):
${lessonsSummaries}

The Unit Assessment must contain:
1. Section A: Multiple Choice Questions (6 questions, 4 options each, clear correct answer)
2. Section B: Short-Answer Questions (6 questions across all lessons)
3. Section C: Word Problems (4 multi-step word problems, varied Pakistani contexts)
4. Detailed Answer Key with correct answers and brief workings for all sections

Every question must map to one of the SLOs listed above, and stay within the depth each
lesson's own content established — this assessment is a review of what was taught, not a
chance to introduce new depth.
Do NOT include SLO codes in the question text itself — plain student language only.
Before writing the Answer Key, solve every question yourself from scratch — every stated
answer and every shown working must be arithmetically correct.

Write the assessment directly. Start with: Unit Assessment: ${chapter.title}`;

  return { system, user };
}

// ─── Answer Verification ──────────────────────────────────

function answerVerificationPrompt(sectionName, sectionText, lesson, chapter, grade = 6) {
  const system = `You are an independent, extremely careful math verifier for Pakistani school
content (SNC 2022). You will be given a lesson section containing questions and their STATED
answers (inside an "Answer Key:" line/block, or similar).

Your job, for EACH question you can clearly identify with a clearly stated answer:
1. Solve the question completely from scratch, using your own independent reasoning, BEFORE
   looking at whether your answer matches the stated one. Do not assume the stated answer is
   correct — that is exactly the failure mode you exist to catch. Many stated answers in this
   pipeline are auto-generated by the same process that wrote the question, with no independent
   check, and DO occasionally contain real arithmetic errors.
2. Only after computing your own answer, compare it to the stated answer. Treat equivalent forms
   as a MATCH, not a mismatch (e.g. 3/8 = 0.375 = 37.5%; "yes" and "true" for the same fact;
   an unsimplified fraction that reduces to the same value as a simplified one; 90° stated as
   "right angle").
3. If you are genuinely unsure whether a mismatch is a real error or just a different valid
   interpretation of an ambiguous question, mark it "ambiguous" rather than "mismatch" and
   explain the ambiguity — do not force a verdict you're not confident in.

Grade context: this is Grade ${grade} content — solve using methods appropriate to that grade,
but the ARITHMETIC itself must be exactly correct regardless of method.

Respond with ONLY a valid JSON array, no markdown fences, no explanation outside the array:
[
  {
    "question": "the question text, verbatim or close to it",
    "statedAnswer": "the answer as written in the section",
    "computedAnswer": "your own independently computed answer",
    "verdict": "match" | "mismatch" | "ambiguous",
    "explanation": "brief reasoning — REQUIRED if verdict is mismatch or ambiguous, omit or leave empty if match"
  }
]
If the section has no questions with clearly stated answers (e.g. it's pure narrative content),
return an empty array: []`;

  const user = `Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
Section: ${sectionName}

Section content to verify (contains questions and their stated answers):
"""
${sectionText}
"""

Solve every question independently first, then verify each stated answer. Return the JSON array now.`;

  return { system, user };
}


module.exports = {
  introductionPrompt,
  structurePrompt,
  warmUpPrompt,
  conceptBuildingPrompt,
  yourTurnFullPrompt,           // NEW (v7) — replaces popUpQuizPrompt; full two-column Your Turn section
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
  stripInternalMarkers,
  extractUsedContext,
  mergeUsedContext,
  extractVisualDescription,
  extractConceptHighlights,
  answerVerificationPrompt,
  chapterProgressBlock,         // NEW (v8)
};