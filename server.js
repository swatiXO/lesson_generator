// server.js — Express backend for the lesson generator
require('./env'); // load .env before any module reads process.env
const express = require('express');
const path = require('path');
const fs = require('fs');
const { generate, ping, MODEL } = require('./ollama');
const {
  buildDocx,
  buildYourTurnDocx,   // v7 — replaces buildPopQuizDocx (kept below as a deprecated alias for compatibility)
  buildPopQuizDocx,
  buildVideoScriptDocx,
  buildUnitAssessmentDocx
} = require('./DocBuilder');
const {
  structurePrompt,
  introductionPrompt,
  warmUpPrompt,
  conceptBuildingPrompt, // now includes inline worked examples AND, per Part, a mandatory
                          // Your Turn box + Warm-Up box (v7) — see prompts.js's design note
  yourTurnFullPrompt,     // v7 — replaces popUpQuizPrompt; full two-column "Your Turn" section
  mentalMathsPrompt,
  practiceQuestionsPrompt,
  // thinkTimePrompt REMOVED (v7) — its misconception-catching purpose now lives as the
  // OPTIONAL Challenge box inside practiceQuestionsPrompt, bounded by the same textbook
  // depth ceiling as the rest of the lesson instead of being a separate, unbounded section.
  keyTakeawaysPrompt,
  videoScriptPrompt,
  unitAssessmentPrompt,
  hydrateStructure, // reconstructs lesson.slo_descriptions from SLO codes
  extractUsedContext, // scans a section's text for scenario/name usage
  mergeUsedContext,   // accumulates usedContext across a lesson's sections
  extractVisualDescription, // pulls the [VISUAL: ...] tag for clean image generation
  parseSlosText,      // [FIX v8] also used here now for the SLO-coverage check, not just hydrateStructure
} = require('./prompts');
const { queryKnowledgeBase } = require('./kb');
const { generateImageForSection } = require('./imageGenerator');
const { buildSlides } = require('./slidesGenerator');
const { buildLessonPdf, renderHtmlToPdf, markdownToHtml } = require('./pdfRenderer');
const { validateSection } = require('./validator');
const { verifySectionAnswers, ANSWER_BEARING_SECTIONS } = require('./answerVerifier');
// [FIX v8] Single source of truth for section keys. Previously each of
// server.js / answerVerifier.js / DocBuilder.js / validator.js retyped
// section-key strings independently — see sections.js's file comment for
// why that's exactly how validator.js's quiz-audit routing went silently
// dead during the v7 rename. Everything below keys off SECTIONS.* now.
const { SECTIONS } = require('./sections');
const AdmZip = require('adm-zip');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB — a chapter's full zip with images can be several MB

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for generated content (single-user local app)
let currentJob = null;

// ─── Job persistence (tier-1 crash resilience) ─────────────────────
// This is a deliberately lightweight fix, not the "real" solution for
// multi-instance/production scale (that's Redis/Postgres — see prior
// discussion). For a single local server, snapshotting currentJob to disk
// after every completed section means a crash or restart mid-lesson loses
// at most the section that was in flight, not the entire run. Without
// this, currentJob lives ONLY in memory, and a crash at Lesson 3 of 3
// meant re-paying the full cost of Lessons 1 and 2 as well.
const JOB_STATE_PATH = path.join(__dirname, 'job_state.json');

function persistJobState() {
  if (!currentJob) return;
  try {
    fs.writeFileSync(JOB_STATE_PATH, JSON.stringify(currentJob, null, 2));
  } catch (err) {
    // Non-fatal — persistence failing shouldn't crash generation, but it
    // does mean crash-resilience is degraded for this run, so log loudly.
    console.error('[persist] Failed to write job_state.json:', err.message);
  }
}

function tryLoadPersistedJobState() {
  if (!fs.existsSync(JOB_STATE_PATH)) return;
  try {
    const raw = fs.readFileSync(JOB_STATE_PATH, 'utf8');
    currentJob = JSON.parse(raw);
    const doneLessons = Object.keys(currentJob.generatedSections || {}).length;
    console.log(`\n[startup] Found a previous job in job_state.json — Chapter ${currentJob.structure?.chapter?.number}: ` +
      `"${currentJob.structure?.chapter?.title}", ${doneLessons} lesson(s) with some content already generated.`);
    console.log(`[startup] Call GET /api/generate again to resume (already-completed sections are skipped), ` +
      `or POST /api/reset to discard this and start fresh.\n`);
  } catch (err) {
    console.warn('[startup] Found job_state.json but failed to load it (starting fresh):', err.message);
    currentJob = null;
  }
}

tryLoadPersistedJobState();

// ─── Split section text into subheading chunks ────────────────────
// The model is instructed (see conceptBuildingPrompt in prompts.js) to
// emit plain descriptive markdown headings for each sub-concept, e.g.:
//   ## What are Integers?
//   ...
//   ## Ordering Numbers on a Number Line
//   ...
// This splits on those headings so we can generate one image per
// subheading instead of a single image for the whole section blob.
// If the model didn't emit any headings, the whole text is returned
// as a single "Overview" chunk so we never end up with zero images.
function splitBySubheading(text) {
  const lines = text.split('\n');
  const chunks = [];
  let title = null;
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) chunks.push({ title: title || 'Overview', body });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    // Match ATX headings (## Heading) OR a standalone bold-only line (**Heading**)
    const atxMatch = trimmed.match(/^#{1,4}\s+(.*)/);
    const boldMatch = !atxMatch && trimmed.match(/^\*\*(.+?)\*\*:?\s*$/);

    if (atxMatch || boldMatch) {
      flush();
      title = (atxMatch ? atxMatch[1] : boldMatch[1]).replace(/\*\*/g, '').trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();

  if (chunks.length === 0 && text.trim()) {
    chunks.push({ title: 'Overview', body: text.trim() });
  }
  return chunks;
}

// Sections where subheading-level images make sense. Short/list-style
// sections (Warm-Up, Quiz, Mental Maths, Key Takeaways) stay one-image —
// splitting those would just generate near-duplicate images per bullet.
const MULTI_IMAGE_SECTIONS = new Set([SECTIONS.CONCEPT_BUILDING]); // 'examples' removed — merged into conceptBuilding

// ─── Health check ─────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const status = await ping();
  res.json({
    ollama: status.ok,
    model: MODEL,
    modelFound: status.found,
    availableModels: status.models || [],
  });
});

// ─── Step 1: Generate structure ───────────────────────────────────
app.post('/api/structure', async (req, res) => {
  const { slos, grade, subject, chapterNumber } = req.body;
  if (!slos || !grade) return res.status(400).json({ error: 'slos and grade are required' });

  try {
    const { system, user } = structurePrompt(slos, grade);
    console.log(`[structure] Calling ${MODEL}...`);

    let raw = await generate(system, user);

    // Strip markdown code fences if model adds them
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Try to parse JSON — handle model adding text before/after
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Model did not return valid JSON.\n\nRaw output:\n' + raw.slice(0, 500));

    let structure = JSON.parse(jsonMatch[0]);

    // Validate structure
    if (!structure.chapter || !structure.lessons?.length) {
      throw new Error('Invalid structure returned by model');
    }

    // [FIX v8] Chapter number was never actually supplied to the model —
    // structurePrompt's user message had no chapterNumber field at all, so
    // the model had nothing real to echo except the "number": 1 baked into
    // the JSON *schema example* it was shown. That's exactly why every
    // generated chapter came out numbered "1" regardless of what chapter
    // it actually was. Set it directly from the caller-supplied value
    // instead of asking the model to invent a meaningful one — the caller
    // (whoever is running this pipeline for a specific chapter) always
    // knows this number; the model never could.
    if (chapterNumber !== undefined && chapterNumber !== null && chapterNumber !== '') {
      const n = Number(chapterNumber);
      structure.chapter.number = Number.isFinite(n) ? n : chapterNumber;
    }

    // NEW — structurePrompt now returns SLO codes only (not full description
    // text, to keep generation fast — see prompts.js). Reconstruct
    // lesson.slo_descriptions from the raw SLO text the caller supplied,
    // before storing/using the structure anywhere. Every downstream section
    // prompt reads lesson.slo_descriptions directly, so skipping this makes
    // them silently undefined.
    structure = hydrateStructure(structure, slos);

    // [FIX v8] SLO coverage check — previously NOTHING verified that every
    // SLO code submitted by the caller actually got assigned to some
    // lesson by the model; the structure was accepted as long as it merely
    // *parsed*. In practice this meant the model could silently drop an
    // entire SLO — or a whole cluster of related ones (e.g. an entire
    // "Measures of Central Tendency" outcome dropped wholesale from a
    // multi-SLO chapter) — with no error, no warning, nothing: the
    // resulting chapter just quietly never generated that content, and the
    // only way to notice was a human reading the finished lessons and
    // realizing a topic was missing. This diffs the submitted SLO codes
    // against what the model actually assigned, and retries once with the
    // specific missing codes called out if any are found.
    const submittedCodes = new Set(Object.keys(parseSlosText(slos)));
    const getAssignedCodes = (struct) => new Set((struct.lessons || []).flatMap(l => l.slos || []));

    let missingCodes = [...submittedCodes].filter(c => !getAssignedCodes(structure).has(c));

    if (missingCodes.length > 0) {
      console.warn(`[structure] Model's structure is missing ${missingCodes.length} submitted SLO(s): ` +
        `${missingCodes.join(', ')}. Retrying structure generation once with these called out explicitly...`);

      const retryUser = `${user}

IMPORTANT — your previous attempt at this exact task did not assign the following SLO code(s)
to ANY lesson: ${missingCodes.join(', ')}. Every SLO code listed in the original SLO list above
MUST appear in some lesson's "slos" array — fold each missing code into the most topically
adjacent existing lesson, or give it its own lesson if none fits. Produce a corrected, complete
structure now that accounts for every SLO code, including the ones listed above.`;

      try {
        let retryRaw = await generate(system, retryUser);
        retryRaw = retryRaw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
        const retryMatch = retryRaw.match(/\{[\s\S]*\}/);

        if (retryMatch) {
          let retryStructure = JSON.parse(retryMatch[0]);
          if (retryStructure.chapter && retryStructure.lessons?.length) {
            if (chapterNumber !== undefined && chapterNumber !== null && chapterNumber !== '') {
              const n = Number(chapterNumber);
              retryStructure.chapter.number = Number.isFinite(n) ? n : chapterNumber;
            }
            retryStructure = hydrateStructure(retryStructure, slos);
            const retryMissing = [...submittedCodes].filter(c => !getAssignedCodes(retryStructure).has(c));

            if (retryMissing.length < missingCodes.length) {
              structure = retryStructure;
              missingCodes = retryMissing;
              console.log(retryMissing.length === 0
                ? '[structure] Retry achieved full SLO coverage.'
                : `[structure] Retry improved coverage but still missing: ${retryMissing.join(', ')}.`);
            } else {
              console.warn(`[structure] Retry did not improve coverage (still missing ` +
                `${(retryMissing.length ? retryMissing : missingCodes).join(', ')}). Proceeding with the original structure.`);
            }
          }
        } else {
          console.warn('[structure] Retry response was not valid JSON — proceeding with the original structure.');
        }
      } catch (retryErr) {
        console.warn('[structure] Retry call failed, proceeding with original structure:', retryErr.message);
      }

      // Final check, loud regardless of whether the retry helped — this
      // must never be silent even if nobody is watching server logs.
      missingCodes = [...submittedCodes].filter(c => !getAssignedCodes(structure).has(c));
      if (missingCodes.length > 0) {
        console.error(`[structure] ⚠️  SLO COVERAGE GAP — the following submitted SLO(s) are not ` +
          `assigned to ANY lesson and will NOT be generated: ${missingCodes.join(', ')}. This chapter ` +
          `is INCOMPLETE as planned. Consider re-running /api/structure, or manually editing the ` +
          `returned structure to add a lesson for these before calling /api/generate.`);
      }
    }

    // Store for later use (supporting full SDDD flow)
    currentJob = { 
      structure, 
      generatedSections: {}, 
      videoScripts: {},
      unitAssessment: '',
      images: {},
      // NEW — per-subheading image map: images[lessonIndex][sectionKey] = { subheadingTitle: path }
      // Kept SEPARATE from `images` (which stays single-path-per-section for
      // backward compatibility with pdfRenderer.js). Used by slidesGenerator.js
      // to place one image per subheading slide instead of only the first slide.
      imagesBySubheading: {},
      // NEW (v4) — accumulated { categories: [], names: [] } per lesson index,
      // used to stop different sections of the same lesson from independently
      // reaching for the same scenario/character. Reset at the start of each
      // lesson's generation loop below.
      usedContext: {},
      // NEW (tier-1) — { [lessonIndex]: { [sectionKey]: {flagged, issues, allVerdicts} } }
      // Populated by the answer verification pass, now run INSIDE the
      // generation retry loop (see /api/generate below) so a flagged answer
      // gets a chance to be corrected before the section is accepted, not
      // just annotated after the fact. Surfaced in manifest.json and, for
      // docx output, as a visible warning inline in the document ONLY when
      // still flagged after exhausting retries (see DocBuilder.js's
      // buildReviewFlagParagraphs).
      answerVerification: {},
      validationReport: {},
      citations: [],
      grade: parseInt(grade),
      subject: subject || 'Mathematics',
      // [FIX v8] Surfaced in manifest.json (see /api/download and
      // /api/download/lesson/:num below) so an incomplete chapter is
      // visible in the shipped bundle too, not just in server logs.
      sloCoverageGap: missingCodes,
      disableVerification: req.body.disableVerification || false,
      // Skips the LLM-generated-SVG-diagram path in imageGenerator.js (a
      // full LLM call + Puppeteer render, the most expensive step in image
      // generation) for the whole run when true. Diagram-classified content
      // falls through to the normal web-search/placeholder flow instead.
      // Off by default.
      disableSvgDiagrams: req.body.disableSvgDiagrams || false
    };

    console.log(`[structure] Done — ${structure.lessons.length} lessons planned` +
      (missingCodes.length ? ` (⚠️ ${missingCodes.length} SLO code(s) uncovered — see sloCoverageGap)` : ''));
    persistJobState();
    res.json({ structure, sloCoverageGap: missingCodes });

  } catch (err) {
    console.error('[structure] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Step 2: Generate all lesson content (SSE stream) ─────────────
app.get('/api/generate', async (req, res) => {
  if (!currentJob) {
    return res.status(400).json({ error: 'No structure found. Generate structure first.' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const { structure } = currentJob;
  const { chapter, lessons } = structure;

  // [FIX v8] Expose the full lesson list on `chapter` so any prompt
  // function that already receives `chapter` (every section prompt does)
  // can build a "what's already been taught vs not yet, elsewhere in this
  // chapter" block without a signature change to every prompt function.
  // See prompts.js's chapterProgressBlock() — this is what fixes the class
  // of bug where an early lesson (e.g. "Selecting Appropriate Graphs")
  // freely used a term (e.g. "continuous data") that a LATER lesson in the
  // same chapter is the one actually responsible for teaching.
  chapter.lessons = lessons;

  // sectionDefs with correct fn signatures matching new prompts.js
  //
  // [FIX v4] Every fn now has a uniform 4-parameter shape:
  //   (lesson, contextChunks, sectionSpecificExtra, usedContext)
  // `sectionSpecificExtra` is whatever a given section needs beyond the
  // basics (warmUpText for conceptBuilding, conceptText for examples, all
  // prior sections for keyTakeaways) — null for sections that don't need
  // one. usedContext is always last, threaded through from the main loop
  // below so every section knows what scenario/names earlier sections in
  // THIS lesson already used.
  //
  // "introduction" runs first — a short, grade-friendly hook (e.g. "sharing a pizza"
  // for fractions) that sets up the topic before Warm-Up.
  // v7 SECTION FLOW — matches the approved manual lesson format exactly:
  //   Introduction -> Warm-Up (opening) -> Concept Building (Parts, each
  //   with its own mandatory Your Turn + Warm-Up box) -> Mental Maths ->
  //   Your Turn (full, two columns) -> Practice Questions -> Key Takeaways
  // 'popUpQuiz' and 'thinkTime' are gone — see prompts.js's design note for
  // where their responsibilities now live (yourTurnFull, and the optional
  // Challenge box inside practiceQuestions, respectively).
  const sectionDefs = [
    { key: SECTIONS.INTRODUCTION,       label: 'Introduction',        fn: (l, ctx, _extra, used) => introductionPrompt(l, chapter, chapter.grade, ctx, used) },
    { key: SECTIONS.WARM_UP,            label: 'Warm-Up',             fn: (l, ctx, _extra, used) => warmUpPrompt(l, chapter, chapter.grade, ctx, used) },
    // 'examples' stays merged into Concept Building, matching the reference
    // document's actual structure (no standalone Worked Examples section;
    // examples live directly inside the Part they belong to, followed by
    // that Part's mandatory Your Turn and Warm-Up boxes).
    { key: SECTIONS.CONCEPT_BUILDING,   label: 'Concept Building',    fn: (l, ctx, wup, used) => conceptBuildingPrompt(l, chapter, chapter.grade, wup, ctx, used) },
    // mentalMaths/practiceQuestions receive Concept Building's text via the
    // "extra" slot so prompts.js's difficulty-floor reference can compare
    // against what was already taught, instead of guessing blind.
    { key: SECTIONS.MENTAL_MATHS,       label: 'Mental Maths',        fn: (l, ctx, extra, used) => mentalMathsPrompt(l, chapter, chapter.grade, ctx, used, extra || '') },
    { key: SECTIONS.YOUR_TURN_FULL,     label: 'Your Turn',           fn: (l, ctx, _extra, used) => yourTurnFullPrompt(l, chapter, chapter.grade, ctx, used) },
    { key: SECTIONS.PRACTICE_QUESTIONS, label: 'Practice Questions',  fn: (l, ctx, extra, used) => practiceQuestionsPrompt(l, chapter, chapter.grade, ctx, used, extra || '') },
    { key: SECTIONS.KEY_TAKEAWAYS,      label: 'Key Takeaways',       fn: (l, ctx, prev, used) => keyTakeawaysPrompt(l, chapter, chapter.grade, prev, ctx) }, // no usedContext — summary only, nothing new to vary
  ];

  // We have lessons * sectionDefs steps + lessons scripts + 1 unit assessment
  const totalSteps = (lessons.length * sectionDefs.length) + lessons.length + 1;
  let step = 0;

  try {
    for (const lesson of lessons) {
      if (!currentJob.generatedSections[lesson.number - 1]) {
        currentJob.generatedSections[lesson.number - 1] = {};
      }
      const lessonSections = currentJob.generatedSections[lesson.number - 1];

      // [FIX v4] Reset variety tracking at the start of each lesson — reusing
      // a name/category ACROSS different lessons is fine (e.g. Ali can show
      // up again in Lesson 2), the goal is only to stop different sections
      // WITHIN the same lesson from independently converging on the same
      // scenario.
      let lessonUsedContext = { categories: [], names: [] };

      send('lesson_start', { lessonNum: lesson.number, lessonTitle: lesson.title });

      // Per-SLO RAG retrieval — one targeted query per SLO instead of a
      // single blended query for the whole lesson. A lesson's SLOs often
      // map to genuinely different sub-concepts (this is exactly why
      // buildSloChecklist tells the model "if a single SLO names more than
      // one target, cover each with its own content") — a single query
      // built from the whole lesson's title plus every SLO description
      // concatenated tends to retrieve chunks skewed toward whichever
      // SLO's vocabulary dominates that blended string, rather than giving
      // each sub-concept a fair shot at relevant material. True per-
      // sub-heading retrieval isn't possible here — Concept Building's
      // actual "## " headings don't exist until the model writes them
      // mid-generation — but SLOs are the pre-generation stand-in for
      // sub-topics, so querying once per SLO gets close to that same effect.
      console.log(`[gen] Running per-SLO RAG retrieval for Lesson ${lesson.number} (${lesson.slo_descriptions.length} SLO(s))...`);
      let context = [];
      const seenChunkKeys = new Set();
      for (let si = 0; si < lesson.slo_descriptions.length; si++) {
        const sloQuery = `${lesson.title} — ${lesson.slo_descriptions[si]}`;
        try {
          const sloResults = await queryKnowledgeBase(sloQuery, currentJob.grade, currentJob.subject, 2);
          (sloResults || []).forEach(c => {
            // Dedup key built from source+page+text-prefix rather than an
            // `id` field — query_kb.py never returns one (see the fix to
            // the citations block just below, which had the same issue).
            const chunkKey = `${c.source}::${c.page}::${(c.text || '').slice(0, 50)}`;
            if (!seenChunkKeys.has(chunkKey)) {
              seenChunkKeys.add(chunkKey);
              context.push(c);
            }
          });
        } catch (err) {
          console.warn(`[gen] RAG query failed for SLO "${lesson.slos[si]}" (non-fatal, continuing):`, err.message);
        }
      }

      // Cap total combined chunks — this pipeline has no end-to-end token
      // budget yet (see prompts.js's file-level design note on this), so a
      // lesson with several SLOs shouldn't silently balloon the context
      // injected into every section's prompt just because retrieval is now
      // finer-grained.
      const MAX_TOTAL_CONTEXT_CHUNKS = 6;
      if (context.length > MAX_TOTAL_CONTEXT_CHUNKS) {
        console.log(`[gen] Retrieved ${context.length} unique chunk(s) across ${lesson.slo_descriptions.length} SLO-targeted queries — capping to ${MAX_TOTAL_CONTEXT_CHUNKS} for context budget.`);
        context = context.slice(0, MAX_TOTAL_CONTEXT_CHUNKS);
      } else {
        console.log(`[gen] Retrieved ${context.length} unique chunk(s) across ${lesson.slo_descriptions.length} SLO-targeted queries.`);
      }

      // Store citations in currentJob
      if (context && context.length > 0) {
        context.forEach(c => {
          // [FIX] Previously compared `cit.id === c.id` — query_kb.py never
          // returns an `id` field on chunk objects, so this was always
          // `undefined === undefined`, which is true for ANY two chunks
          // once at least one citation exists. In practice this meant
          // dedup treated almost every new chunk as a duplicate of the
          // first citation ever recorded, rather than detecting genuine
          // duplicates. Fixed using the same composite key as the RAG
          // dedup above.
          const chunkKey = `${c.source}::${c.page}::${(c.text || '').slice(0, 50)}`;
          const alreadyCited = currentJob.citations.some(cit =>
            `${cit.source}::${cit.page}::${(cit.text || '').slice(0, 50)}` === chunkKey
          );
          if (!alreadyCited) {
            currentJob.citations.push(c);
          }
        });
      }

      // [FIX v5] Prior-grade knowledge bridge — also query the knowledge base
      // for the PREVIOUS grade's content on this same topic, so conceptBuildingPrompt
      // can open with a short "you already know X, now we build on it" bridge
      // sentence. Tagged isPriorGrade:true so formatContext() (prompts.js) renders
      // it in a separate, more restrictive block instead of mixing it into the
      // current lesson's authoritative reference context. Intentionally NOT added
      // to currentJob.citations — citations track sources for THIS lesson's SLOs,
      // not supplementary bridge material from a different grade. Non-fatal if it
      // fails or grade is 1 (no prior grade exists) — the lesson still generates
      // fine without a bridge, conceptBuildingPrompt is written to skip it gracefully.
      let priorGradeContext = [];
      if (currentJob.grade > 1) {
        try {
          // The prior-grade bridge is a small, supplementary lookup (capped
          // at 2 chunks) — a single blended query is fine here, unlike the
          // main retrieval above where per-SLO precision actually matters.
          const bridgeQueryText = `${lesson.title} ${lesson.slo_descriptions.join(' ')}`;
          const priorRaw = await queryKnowledgeBase(bridgeQueryText, currentJob.grade - 1, currentJob.subject, 2);
          priorGradeContext = (priorRaw || []).map(c => ({ ...c, isPriorGrade: true }));
          if (priorGradeContext.length) {
            console.log(`[gen] Found ${priorGradeContext.length} prior-grade (Grade ${currentJob.grade - 1}) bridge chunk(s) for Lesson ${lesson.number}`);
          }
        } catch (err) {
          console.warn(`[gen] Prior-grade RAG lookup failed (non-fatal, continuing without a bridge):`, err.message);
        }
      }

      const contextChunks = [...(context || []), ...priorGradeContext];

      for (const sec of sectionDefs) {
        step++;
        const pct = Math.round((step / totalSteps) * 100);

        // [FIX] This is the skip-check the startup log has been promising
        // since persistJobState/tryLoadPersistedJobState were added
        // ("already-completed sections are skipped") — it was never
        // actually implemented until now. Without it, resuming from
        // job_state.json after a crash still reprocessed every section
        // from scratch, defeating the entire point of persisting state.
        const alreadyDone = !!(
          lessonSections[sec.key] &&
          currentJob.validationReport?.[lesson.number - 1]?.[sec.key]?.ok
        );
        if (alreadyDone) {
          console.log(`[gen] Lesson ${lesson.number} / ${sec.label} — already completed in a prior run, skipping regeneration.`);
          send('section_start', { lessonNum: lesson.number, section: sec.label, progress: pct, step, totalSteps, resumed: true });

          // A resumed run's lessonUsedContext starts empty even though
          // earlier sections (now being skipped) already used real
          // scenarios/names — fold this section's actual text into the
          // tracker so later, non-skipped sections still see accurate
          // "already used" state instead of starting blind.
          const resumedText = lessonSections[sec.key];
          const sectionUsage = extractUsedContext(resumedText);
          lessonUsedContext = mergeUsedContext(lessonUsedContext, sectionUsage);
          currentJob.usedContext[lesson.number - 1] = lessonUsedContext;

          send('section_done', {
            lessonNum: lesson.number,
            section: sec.key,
            sectionLabel: sec.label,
            progress: pct,
            resumed: true,
            answerFlagged: currentJob.answerVerification?.[lesson.number - 1]?.[sec.key]?.flagged || false,
          });
          continue; // images for this section were already generated and persisted too — nothing left to do
        }

        send('section_start', {
          lessonNum: lesson.number,
          section: sec.label,
          progress: pct,
          step,
          totalSteps,
        });

        console.log(`[gen] Lesson ${lesson.number} / ${sec.label} ...`);

        // Per-heading RAG retrieval (previously here for the now-removed
        // 'examples' section) no longer applies — worked examples are
        // generated inline as part of the single conceptBuilding call, so
        // there's no longer a "Concept Building already ran, Examples
        // hasn't yet" moment to exploit real headings for a second,
        // more targeted retrieval pass. The per-SLO lesson-level context
        // (contextChunks) is used directly for every section, unchanged.
        const sectionContextChunks = contextChunks;

        let attempt = 0;
        let success = false;
        let text = '';
        let validationReport = { ok: true, attempts: 0, errors: [] };
        // [FIX v8] Tracks the latest answer-verification result for this
        // section regardless of which attempt produced it, so it can be
        // stored/surfaced even if the loop exhausts its attempts still
        // flagged (see the end of this section's handling below).
        let latestVerification = { flagged: false, issues: [], allVerdicts: [] };

        // NEW — keep the ORIGINAL system/user prompt from attempt 1 around.
        // The old retry logic discarded it entirely on attempt 2+ and replaced
        // it with a bare "fix the errors" prompt that carried none of the
        // scope fence / SLO checklist / self-study rules — so a retry could
        // "fix" the reported issue while drifting on everything else the
        // original prompt was constraining. Retries now reuse the exact same
        // system prompt and append the feedback to the exact same user
        // prompt, so every constraint stays in force across attempts.
        let originalSystemPrompt = null;
        let originalUserPrompt = null;

        while (attempt < 3 && !success) {
          attempt++;
          validationReport.attempts = attempt;

          let systemPrompt, userPrompt;
          if (attempt === 1) {
            // [FIX v4] params now always ends with lessonUsedContext, in
            // addition to whatever section-specific extra data this section
            // needs (or null if it doesn't need one).
            const params = [lesson, sectionContextChunks];
            if (sec.key === SECTIONS.CONCEPT_BUILDING) params.push(lessonSections[SECTIONS.WARM_UP] || '');
            else if (sec.key === SECTIONS.KEY_TAKEAWAYS) params.push(lessonSections); // Pass all previous sections
            else if (sec.key === SECTIONS.MENTAL_MATHS || sec.key === SECTIONS.PRACTICE_QUESTIONS) {
              // [WIRED v6] Difficulty-floor reference — see prompts.js's
              // mentalMathsPrompt/practiceQuestionsPrompt for how this is used.
              params.push(lessonSections[SECTIONS.CONCEPT_BUILDING] || '');
            }
            else params.push(null);
            params.push(lessonUsedContext);

            const promptsObj = sec.fn(...params);
            systemPrompt = promptsObj.system;
            userPrompt = promptsObj.user;
            originalSystemPrompt = systemPrompt;
            originalUserPrompt = userPrompt;
          } else {
            const lastFeedback = validationReport.errors[validationReport.errors.length - 1];
            systemPrompt = originalSystemPrompt;
            userPrompt = `${originalUserPrompt}

IMPORTANT — A previous attempt at this exact task had the following problems. Fix them in this
attempt while still following every instruction above (SLO coverage checklist, scope rules,
tone/format constraints, etc. all still apply):
${lastFeedback}

Write the corrected, complete section now, following all the original instructions. No preamble.`;
          }

          try {
            let tokens = '';
            text = await generate(systemPrompt, userPrompt, (chunk) => {
              tokens += chunk;
              send('token', { lessonNum: lesson.number, section: sec.key, chunk });
            });

            // Run structural/scope/tone validation
            const validation = await validateSection(sec.key, sec.label, text, lesson, chapter, currentJob.grade, contextChunks);

            if (!validation.ok) {
              validationReport.ok = false;
              validationReport.errors.push(validation.feedback);
              send('validation_warning', {
                lessonNum: lesson.number,
                section: sec.key,
                attempt,
                feedback: validation.feedback
              });
              continue; // don't bother verifying answers on content we already know needs a rewrite
            }

            // [FIX v8] Structural validation passed — now, for sections that
            // carry an answer key, run the INDEPENDENT answer-correctness
            // check (answerVerifier.js) BEFORE accepting this attempt.
            //
            // Previously this ran only AFTER a section was already accepted
            // and stored in lessonSections, and its only effect was writing
            // a visible "FLAGGED FOR REVIEW" note into the final document
            // right next to the answer it had just proven was wrong — the
            // actual content never changed. That defeated most of the
            // purpose of doing an independent solve in the first place. This
            // treats a flagged answer exactly like a validation failure and
            // feeds `computedAnswer` back into the SAME retry mechanism
            // already used for scope/tone failures above, reusing the exact
            // same original-prompt-plus-feedback pattern so a caught error
            // actually gets a chance to be corrected.
            if (ANSWER_BEARING_SECTIONS.has(sec.key)) {
              console.log(`[gen] Running independent answer verification for Lesson ${lesson.number} / ${sec.label} (attempt ${attempt})...`);
              const verification = await verifySectionAnswers(sec.key, sec.label, text, lesson, chapter, currentJob.grade);
              latestVerification = verification;

              if (verification.flagged) {
                const issueLines = verification.issues.map((iss, i) =>
                  `${i + 1}. Question: "${(iss.question || '').slice(0, 150)}" — you stated the answer as ` +
                  `"${iss.statedAnswer}", but the independently verified correct answer is "${iss.computedAnswer}"` +
                  `${iss.explanation ? ` (${iss.explanation})` : ''}.`
                ).join('\n');

                validationReport.ok = false;
                validationReport.errors.push(
                  `Independent answer verification found ${verification.issues.length} incorrect stated ` +
                  `answer(s) that MUST be corrected (do not just change the wording — recompute the actual ` +
                  `answer and make sure the question, working, and stated answer are all mutually consistent):\n${issueLines}`
                );
                send('answer_flagged', {
                  lessonNum: lesson.number,
                  section: sec.key,
                  sectionLabel: sec.label,
                  attempt,
                  issues: verification.issues,
                });
                continue; // let the loop retry with this feedback appended, same as a validation failure
              } else if (verification.verifierError) {
                // A verifier failure (bad JSON, model error) is logged but
                // NOT treated as a confirmed answer error, and does NOT
                // block acceptance of this attempt — those are two
                // different things and must not be conflated.
                console.warn(`[gen] Answer verification for Lesson ${lesson.number} / ${sec.label} did not ` +
                  `complete cleanly (non-fatal, attempt accepted anyway): ${verification.verifierError}`);
              }
            }

            success = true;
            validationReport.ok = true;
          } catch (secErr) {
            console.error(`[gen] Attempt ${attempt} failed:`, secErr.message);
            validationReport.ok = false;
            validationReport.errors.push(secErr.message);
          }
        }

        lessonSections[sec.key] = text;
        if (!currentJob.validationReport[lesson.number - 1]) {
          currentJob.validationReport[lesson.number - 1] = {};
        }
        currentJob.validationReport[lesson.number - 1][sec.key] = validationReport;

        // [FIX v8] Store whatever the LAST answer-verification result was —
        // whether that's a clean pass from the attempt that finally
        // succeeded, or a still-flagged result if all 3 attempts were
        // exhausted without a clean answer (in which case the section still
        // ships, per the existing precedent for structural validation
        // failures below, but the flag now genuinely means "this survived
        // automatic correction and needs a human," not "nobody tried."
        if (!currentJob.answerVerification[lesson.number - 1]) {
          currentJob.answerVerification[lesson.number - 1] = {};
        }
        if (ANSWER_BEARING_SECTIONS.has(sec.key)) {
          currentJob.answerVerification[lesson.number - 1][sec.key] = latestVerification;
          if (latestVerification.flagged) {
            console.warn(`[gen] ⚠️  Lesson ${lesson.number} / ${sec.label}: ${latestVerification.issues.length} ` +
              `answer(s) STILL flagged after exhausting retry attempts — shipping with a visible review flag.`);
          }
        }

        // [FIX v4] After this section's final text is settled, scan it for
        // which scenario categories/names it actually used and fold that
        // into this lesson's running usedContext, so every LATER section in
        // this same lesson (loop continues below) sees it via the params
        // array construction above ("lessonUsedContext" is the same object
        // re-read each iteration, so mutating it here is picked up next pass).
        const sectionUsage = extractUsedContext(text);
        lessonUsedContext = mergeUsedContext(lessonUsedContext, sectionUsage);
        currentJob.usedContext[lesson.number - 1] = lessonUsedContext;

        send('section_done', {
          lessonNum: lesson.number,
          section: sec.key,
          sectionLabel: sec.label,
          progress: pct,
          answerFlagged: currentJob.answerVerification[lesson.number - 1][sec.key]?.flagged || false,
        });

        // ── Image generation — one image per subheading ──────────
        // For sections with subheadings (Concept Building, Examples), split
        // the generated text and produce one image per subheading. For all
        // other sections, behave exactly as before (one image for the whole
        // section text).
        //
        // TWO STORAGE SHAPES ARE MAINTAINED ON PURPOSE:
        //   currentJob.images[lessonIndex][sec.key]              -> single path (string)
        //     Kept exactly as before so pdfRenderer.js (unchanged) keeps working.
        //     Stores the FIRST subheading's image as the representative image.
        //   currentJob.imagesBySubheading[lessonIndex][sec.key]  -> { subheadingTitle: {path, query, isPlaceholder} }
        //     New — consumed by slidesGenerator.js and DocBuilder.js to place
        //     one image per subheading, plus a query caption when a real
        //     image couldn't be found (see imageGenerator.js's new return shape).
        {
          if (!currentJob.images[lesson.number - 1]) {
            currentJob.images[lesson.number - 1] = {};
          }
          if (!currentJob.imagesBySubheading[lesson.number - 1]) {
            currentJob.imagesBySubheading[lesson.number - 1] = {};
          }
          currentJob.imagesBySubheading[lesson.number - 1][sec.key] = {};

          const useSubheadings = MULTI_IMAGE_SECTIONS.has(sec.key);
          const chunks = useSubheadings
            ? splitBySubheading(text)
            : [{ title: sec.key, body: text }];
          console.log(`[gen] ${sec.key} split into ${chunks.length} chunk(s):`, chunks.map(c => c.title));
          let firstImagePath = null;

          for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci];

            // [FIX] Only conceptBuilding/examples chunks are structured
            // enough (heading + definition + metaphor + mini-exercise) to
            // safely fall back to raw chunk text when no [VISUAL:] tag is
            // present. Freeform sections (Introduction, Warm-Up, Pop-Up
            // Quiz, Mental Maths, Key Takeaways) were previously ALWAYS
            // generating one image from their full raw text regardless —
            // which is how Introduction's Zara/Bilal dialogue ended up
            // rendered as a single chaotic SVG mixing character icons and
            // an unrelated pie chart. Those sections now only get an image
            // when the text explicitly tagged one; otherwise they're
            // skipped entirely rather than guessing from freeform prose.
            const visualTag = extractVisualDescription(chunk.body);
            if (!useSubheadings && !visualTag) {
              console.log(`[gen] Skipping image for ${sec.key} — no [VISUAL:] tag present and this section isn't structured content.`);
              continue;
            }

            try {
              send('image_start', {
                lessonNum: lesson.number,
                section: sec.key,
                subheading: chunk.title,
              });
              const imgResult = await generateImageForSection(
                `L${lesson.number}_${sec.key}_${ci}`,
                // Prefer the model's own [VISUAL: ...] tag when present — a
                // clean, deliberate description — over a slice of raw prose,
                // which is noisier for both the search-query model and the
                // diagram-content classifier. For conceptBuilding/examples
                // chunks specifically, still falls back to the chunk's own
                // (structured) text if no tag was found in that particular
                // sub-concept.
                visualTag || chunk.body,
                currentJob.grade,
                currentJob.subject,
                currentJob.disableVerification,
                currentJob.disableSvgDiagrams
              );
              if (imgResult && imgResult.path) {
                // imagesBySubheading now stores the full result object
                // (path + query + isPlaceholder), not a bare string —
                // DocBuilder.js and slidesGenerator.js read .path from it and
                // use .query/.isPlaceholder to show a caption when a real
                // image couldn't be found/verified.
                currentJob.imagesBySubheading[lesson.number - 1][sec.key][chunk.title] = {
                  path: imgResult.path,
                  query: imgResult.query,
                  isPlaceholder: imgResult.isPlaceholder,
                };
                // currentJob.images stays a plain string map — pdfRenderer.js
                // depends on this shape and is intentionally left untouched.
                if (firstImagePath === null) firstImagePath = imgResult.path;
                send('image_done', {
                  lessonNum: lesson.number,
                  section: sec.key,
                  subheading: chunk.title,
                  imagePath: imgResult.path,
                  query: imgResult.query,
                  isPlaceholder: imgResult.isPlaceholder,
                });
              }
            } catch (imgErr) {
              console.error(
                `[gen] Image generation error (${sec.key} / "${chunk.title}"):`,
                imgErr.message
              );
            }
          }

          // Backward-compatible single path for pdfRenderer.js / anything
          // else that still expects images[lessonIndex][sectionKey] to be a
          // plain string.
          if (firstImagePath) {
            currentJob.images[lesson.number - 1][sec.key] = firstImagePath;
          }
        }

        // [FIX] persistJobState() was defined but never actually called
        // anywhere — job_state.json never got written during generation,
        // so the crash-resilience mechanism was completely inert despite
        // existing in the codebase. This is the actual checkpoint: once a
        // section's text, validation, usedContext, and images are all
        // finalized, snapshot the whole job so a crash loses at most the
        // section currently in flight, not everything before it.
        persistJobState();
      }

      persistJobState(); // coarser checkpoint at lesson boundaries too

      // Generate Video Script
      step++;
      const scriptPct = Math.round((step / totalSteps) * 100);
      send('section_start', {
        lessonNum: lesson.number,
        section: 'Video Script',
        progress: scriptPct,
        step,
        totalSteps,
      });
      try {
        console.log(`[gen] Generating Video Script for Lesson ${lesson.number}...`);
        // [WIRED v6] lessonSections passed so Amina/Zahid's dialogue can
        // reference the actual sub-concepts taught in this lesson instead
        // of generating from the bare SLO wording alone.
        const { system: vSys, user: vUsr } = videoScriptPrompt(lesson, chapter, currentJob.grade, lessonSections);
        const scriptText = await generate(vSys, vUsr);
        currentJob.videoScripts[lesson.number - 1] = scriptText;
        send('section_done', {
          lessonNum: lesson.number,
          section: 'videoScript',
          sectionLabel: 'Video Script',
          progress: scriptPct
        });
      } catch (scriptErr) {
        console.error('[gen] Script gen error:', scriptErr.message);
        currentJob.videoScripts[lesson.number - 1] = `[Error generating script: ${scriptErr.message}]`;
        send('section_error', { lessonNum: lesson.number, section: 'videoScript', error: scriptErr.message });
      }

      send('lesson_done', { lessonNum: lesson.number });
    }

    // Generate Unit Assessment
    step++;
    const assessPct = 100;
    send('section_start', {
      lessonNum: 0,
      section: 'Unit Assessment',
      progress: assessPct,
      step,
      totalSteps,
    });
    try {
      console.log(`[gen] Generating Unit Assessment...`);
      const { system: aSys, user: aUsr } = unitAssessmentPrompt(chapter, currentJob.grade, lessons);
      const assessmentText = await generate(aSys, aUsr);
      currentJob.unitAssessment = assessmentText;
      send('section_done', {
        lessonNum: 0,
        section: 'unitAssessment',
        sectionLabel: 'Unit Assessment',
        progress: assessPct
      });
    } catch (assessErr) {
      console.error('[gen] Unit assessment error:', assessErr.message);
      currentJob.unitAssessment = `[Error generating assessment: ${assessErr.message}]`;
      send('section_error', { lessonNum: 0, section: 'unitAssessment', error: assessErr.message });
    }

    send('all_done', { message: 'All lessons, scripts, and assessments generated! Click Download to get your ZIP bundle.' });

  } catch (err) {
    console.error('[gen] Fatal error:', err.message);
    send('error', { error: err.message });
  } finally {
    res.end();
  }
});

// ─── Step 3b: Build and download individual lesson bundle ─────────
app.get('/api/download/lesson/:num', async (req, res) => {
  const lessonNum = parseInt(req.params.num);
  if (!currentJob) return res.status(400).json({ error: 'No active job.' });

  const { structure, generatedSections, videoScripts, images, imagesBySubheading, validationReport, answerVerification } = currentJob;
  const lessonIndex = lessonNum - 1;

  const lesson = structure.lessons.find(l => l.number === lessonNum);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });

  const sections = generatedSections[lessonIndex];
  if (!sections || !Object.keys(sections).length) {
    return res.status(400).json({ error: 'Lesson content not yet generated.' });
  }

  const tempDir = path.join(__dirname, 'public', `bundle_temp_lesson_${lessonNum}_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const zip = new AdmZip();

    // Construct a sub-structure with only this lesson
    const singleStructure = { chapter: structure.chapter, lessons: [lesson] };
    const singleSections = { 0: sections };

    // 1. Lesson Docx
    console.log(`[download] Building lesson ${lessonNum} docx...`);
    const singleImagesBySubheading = { 0: imagesBySubheading[lessonIndex] || {} };
    const singleAnswerVerification = { 0: (answerVerification || {})[lessonIndex] || {} };
    const docxBuffer = await buildDocx(singleStructure, singleSections, singleImagesBySubheading, singleAnswerVerification);
    zip.addFile(`Lesson_${lessonNum}_Plan.docx`, docxBuffer);

    // 2. Lesson PDF
    console.log(`[download] Building lesson ${lessonNum} pdf...`);
    const pdfPath = path.join(tempDir, `Lesson_${lessonNum}_Plan.pdf`);
    const singleImages = { 0: images[lessonIndex] || {} };
    await buildLessonPdf(singleStructure, singleSections, singleImages, pdfPath);
    zip.addLocalFile(pdfPath);

    // 3. Slides
    console.log(`[download] Building lesson ${lessonNum} slides...`);
    const lessonImagesBySubheading = imagesBySubheading[lessonIndex] || {};
    const slidesBuffer = await buildSlides(lesson, sections, lessonImagesBySubheading);
    zip.addFile(`Lesson_${lessonNum}_Slides.pptx`, slidesBuffer);

    // 4. Your Turn compilation (Word) — v7: was "Pop quiz", now reads the
    // yourTurnFull section key and uses buildYourTurnDocx.
    if (sections[SECTIONS.YOUR_TURN_FULL]) {
      console.log(`[download] Building lesson ${lessonNum} Your Turn docx...`);
      const yourTurnBuffer = await buildYourTurnDocx([lesson], { 0: sections });
      zip.addFile(`Lesson_${lessonNum}_YourTurn.docx`, yourTurnBuffer);
    }

    // 5. Video script (Word)
    const scriptText = videoScripts[lessonIndex];
    if (scriptText) {
      console.log(`[download] Building lesson ${lessonNum} video script docx...`);
      const scriptBuffer = await buildVideoScriptDocx([lesson], { 0: scriptText });
      zip.addFile(`Lesson_${lessonNum}_Video_Script.docx`, scriptBuffer);
    }

    // 6. Manifest file
    console.log(`[download] Creating lesson ${lessonNum} manifest...`);
    const lessonAnswerVerification = (answerVerification || {})[lessonIndex] || {};
    const flaggedForReview = Object.entries(lessonAnswerVerification)
      .filter(([, v]) => v?.flagged)
      .map(([secKey, v]) => ({ section: secKey, issues: v.issues }));
    const manifest = {
      meta: {
        chapterNumber: structure.chapter.number,
        chapterTitle: structure.chapter.title,
        lessonNumber: lessonNum,
        lessonTitle: lesson.title,
        grade: currentJob.grade,
        subject: currentJob.subject,
        timestamp: new Date().toISOString()
      },
      validation: { [lessonIndex]: validationReport[lessonIndex] || {} },
      flaggedForReview,
      // [FIX v8] Chapter-wide, not per-lesson (an SLO can only be "missing"
      // at the whole-chapter planning stage) — included here too so anyone
      // downloading just one lesson's bundle can still see the chapter had
      // a coverage gap elsewhere, since that context wouldn't otherwise be
      // visible from a single-lesson download.
      chapterSloCoverageGap: currentJob.sloCoverageGap || [],
    };
    zip.addFile(`Lesson_${lessonNum}_manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)));

    // 7. lesson_data.json — machine-readable snapshot for later rehydration.
    // See /api/rehydrate below: uploading this file (or this whole ZIP)
    // restores currentJob exactly, so slides/video-script/etc. can be
    // rebuilt from already-generated text without re-running any LLM
    // calls, even in a brand new server session or on a different machine.
    // Deliberately includes the FULL chapter (all lessons), not just this
    // one, so the rehydrate path is identical regardless of which zip type
    // gets re-uploaded later.
    const lessonDataSnapshot = {
      version: 'v8',
      savedAt: new Date().toISOString(),
      structure,
      generatedSections,
      videoScripts,
      unitAssessment: currentJob.unitAssessment || null,
      images: currentJob.images || {},
      imagesBySubheading,
      answerVerification: currentJob.answerVerification || {},
      validationReport: currentJob.validationReport || {},
      citations: currentJob.citations || [],
      grade: currentJob.grade,
      subject: currentJob.subject,
      sloCoverageGap: currentJob.sloCoverageGap || [],
    };
    zip.addFile('lesson_data.json', Buffer.from(JSON.stringify(lessonDataSnapshot, null, 2)));

    // Send ZIP file
    const zipBuffer = zip.toBuffer();
    const filename = `Lesson_${lessonNum}_${lesson.title.replace(/\s+/g, '_')}_Bundle.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
    console.log(`[download] Sent lesson ${lessonNum} ZIP:`, filename);

  } catch (err) {
    // Logging the full stack, not just the message — for an error thrown
    // INSIDE a third-party library (like docx's own minified code), the
    // message alone gives no way to find which of our own lines called
    // into it with bad data. err.stack includes the full call chain.
    console.error(`[download] Error building lesson ${lessonNum} ZIP:`, err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

// ─── Step 3: Build and download ZIP bundle ────────────────────────
app.get('/api/download', async (req, res) => {
  if (!currentJob || !Object.keys(currentJob.generatedSections).length) {
    return res.status(400).json({ error: 'No generated content found.' });
  }

  const tempDir = path.join(__dirname, 'public', `bundle_temp_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const { structure, generatedSections, videoScripts, unitAssessment, images, imagesBySubheading, validationReport, citations, answerVerification } = currentJob;
    console.log('[download] Starting bundle generation...');

    const zip = new AdmZip();

    // 1. Core lesson document (Word)
    console.log('[download] Building lesson docx...');
    const docxBuffer = await buildDocx(structure, generatedSections, imagesBySubheading, answerVerification || {});
    zip.addFile('lesson.docx', docxBuffer);

    // 2. Core lesson document (PDF)
    console.log('[download] Building lesson pdf...');
    const pdfPath = path.join(tempDir, 'lesson.pdf');
    await buildLessonPdf(structure, generatedSections, images, pdfPath);
    zip.addLocalFile(pdfPath);

    // 3. Slides (one deck per lesson)
    console.log('[download] Building slides pptx...');
    for (let li = 0; li < structure.lessons.length; li++) {
      const lesson = structure.lessons[li];
      const lessonImagesBySubheading = imagesBySubheading[li] || {};
      const slidesBuffer = await buildSlides(lesson, generatedSections[li] || {}, lessonImagesBySubheading);
      zip.addFile(`slides_lesson_${lesson.number}.pptx`, slidesBuffer);
    }

    // 4. Your Turn compilation document (Word) — v7: was "Pop quiz"
    console.log('[download] Building Your Turn compilation docx...');
    const yourTurnBuffer = await buildYourTurnDocx(structure.lessons, generatedSections);
    zip.addFile('your_turn_compilation.docx', yourTurnBuffer);

    // 5. Video script document (Word)
    console.log('[download] Building video script docx...');
    const scriptBuffer = await buildVideoScriptDocx(structure.lessons, videoScripts);
    zip.addFile('video_script.docx', scriptBuffer);

    // 6. Unit assessment
    if (unitAssessment) {
      console.log('[download] Building unit assessment docx...');
      const assessmentDocxBuffer = await buildUnitAssessmentDocx(structure.chapter, unitAssessment);
      zip.addFile('unit_assessment.docx', assessmentDocxBuffer);

      console.log('[download] Building unit assessment pdf...');
      const cleanAssessmentHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
            body { font-family: 'Inter', sans-serif; padding: 20mm; color: #212529; line-height: 1.6; }
            h1 { font-size: 24pt; color: #1A7A4A; margin-bottom: 24px; border-bottom: 2px solid #1A7A4A; padding-bottom: 8px; }
            h2 { font-size: 18pt; color: #1F5C99; margin-top: 24px; margin-bottom: 12px; }
            h3 { font-size: 14pt; color: #2E75B6; margin-top: 18px; }
            p { margin-bottom: 12px; }
            ul, ol { margin-bottom: 16px; padding-left: 20px; }
            li { margin-bottom: 6px; }
            strong { font-weight: 600; }
          </style>
        </head>
        <body>
          ${markdownToHtml(unitAssessment)}
        </body>
        </html>
      `;
      const assessmentPdfPath = path.join(tempDir, 'unit_assessment.pdf');
      await renderHtmlToPdf(cleanAssessmentHtml, assessmentPdfPath);
      zip.addLocalFile(assessmentPdfPath);
    }

    // 7. Manifest file
    console.log('[download] Creating manifest...');
    const flaggedForReview = [];
    Object.entries(answerVerification || {}).forEach(([lessonIdx, sections]) => {
      Object.entries(sections || {}).forEach(([secKey, v]) => {
        if (v?.flagged) {
          flaggedForReview.push({ lessonIndex: Number(lessonIdx), section: secKey, issues: v.issues });
        }
      });
    });
    if (flaggedForReview.length) {
      console.warn(`[download] ⚠️  ${flaggedForReview.length} section(s) across this bundle have answers flagged for review — see manifest.json's flaggedForReview field.`);
    }
    if ((currentJob.sloCoverageGap || []).length) {
      console.warn(`[download] ⚠️  This chapter has ${currentJob.sloCoverageGap.length} uncovered SLO(s): ` +
        `${currentJob.sloCoverageGap.join(', ')} — see manifest.json's sloCoverageGap field.`);
    }
    const manifest = {
      meta: {
        chapterNumber: structure.chapter.number,
        chapterTitle: structure.chapter.title,
        grade: currentJob.grade,
        subject: currentJob.subject,
        overview: structure.chapter.overview,
        lessonsCount: structure.lessons.length,
        timestamp: new Date().toISOString()
      },
      validation: validationReport,
      flaggedForReview,
      // [FIX v8] SLO codes submitted at /api/structure time that never got
      // assigned to any lesson, even after the automatic retry (see
      // /api/structure's SLO coverage check). An empty array means full
      // coverage. This is the single most important field in this file for
      // catching an incomplete chapter — see server.js's /api/structure
      // handler for where this is actually detected.
      sloCoverageGap: currentJob.sloCoverageGap || [],
      citations: citations.map(c => ({
        source: c.source,
        page: c.page,
        subject: c.subject,
        grade: c.grade,
        slos: c.slos
      }))
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    // 8. lesson_data.json — see the single-lesson download's identical
    // block above for why this exists and what it's for.
    const lessonDataSnapshot = {
      version: 'v8',
      savedAt: new Date().toISOString(),
      structure,
      generatedSections,
      videoScripts,
      unitAssessment: unitAssessment || null,
      images: images || {},
      imagesBySubheading,
      answerVerification: answerVerification || {},
      validationReport: validationReport || {},
      citations: citations || [],
      grade: currentJob.grade,
      subject: currentJob.subject,
      sloCoverageGap: currentJob.sloCoverageGap || [],
    };
    zip.addFile('lesson_data.json', Buffer.from(JSON.stringify(lessonDataSnapshot, null, 2)));

    // Send ZIP file
    const zipBuffer = zip.toBuffer();
    const filename = `Chapter${structure.chapter.number}_Courseware_Bundle.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
    console.log('[download] Sent bundle ZIP:', filename);

  } catch (err) {
    console.error('[download] Zip packaging error:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
});

// ─── Preview: return generated text as JSON ───────────────────────
app.get('/api/preview', (req, res) => {
  if (!currentJob) return res.status(400).json({ error: 'Nothing generated yet.' });
  res.json({
    structure: currentJob.structure,
    sections: currentJob.generatedSections,
    videoScripts: currentJob.videoScripts,
    unitAssessment: currentJob.unitAssessment,
    images: currentJob.images,
    imagesBySubheading: currentJob.imagesBySubheading,
    validationReport: currentJob.validationReport,
    answerVerification: currentJob.answerVerification,
    sloCoverageGap: currentJob.sloCoverageGap || [],
  });
});

// ─── Rebuild-only endpoints ────────────────────────────────────────
//
// Motivating case: a fix/improvement lands in slidesGenerator.js (or any
// other renderer), but the underlying lesson TEXT was already generated
// under an older version of that renderer. Restarting the server is still
// required to pick up new require()'d code — but thanks to job_state.json,
// that restart no longer means losing the already-generated content. These
// endpoints just re-run the RENDERING step against data that's already
// there, with zero new LLM calls.

app.get('/api/rebuild/slides/:num', async (req, res) => {
  const lessonNum = parseInt(req.params.num);
  if (!currentJob) {
    return res.status(400).json({
      error: 'No active job. If you already generated a lesson before restarting the server, ' +
             'it should have reloaded automatically from job_state.json — check the startup logs. ' +
             'Otherwise, generate a lesson first.'
    });
  }

  const { structure, generatedSections, imagesBySubheading } = currentJob;
  const lessonIndex = lessonNum - 1;
  const lesson = structure?.lessons?.find(l => l.number === lessonNum);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });

  const sections = generatedSections[lessonIndex];
  if (!sections || !Object.keys(sections).length) {
    return res.status(400).json({ error: 'This lesson has no generated content yet — nothing to rebuild.' });
  }

  try {
    console.log(`[rebuild] Rebuilding slides for Lesson ${lessonNum} from already-generated content (no LLM calls)...`);
    const lessonImagesBySubheading = imagesBySubheading[lessonIndex] || {};
    const slidesBuffer = await buildSlides(lesson, sections, lessonImagesBySubheading);

    const filename = `Lesson_${lessonNum}_${lesson.title.replace(/\s+/g, '_')}_Slides.pptx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(slidesBuffer);
    console.log(`[rebuild] Sent rebuilt slides for Lesson ${lessonNum}.`);
  } catch (err) {
    console.error(`[rebuild] Failed to rebuild slides for Lesson ${lessonNum}:`, err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Same idea, whole chapter at once, zipped.
app.get('/api/rebuild/slides', async (req, res) => {
  if (!currentJob) {
    return res.status(400).json({ error: 'No active job. Generate a lesson first, or restart the server if job_state.json should have reloaded one.' });
  }

  const { structure, generatedSections, imagesBySubheading } = currentJob;
  if (!structure || !Object.keys(generatedSections).length) {
    return res.status(400).json({ error: 'No generated content found — nothing to rebuild.' });
  }

  try {
    console.log('[rebuild] Rebuilding slides for all lessons from already-generated content (no LLM calls)...');
    const zip = new AdmZip();
    for (let li = 0; li < structure.lessons.length; li++) {
      const lesson = structure.lessons[li];
      const sections = generatedSections[li];
      if (!sections || !Object.keys(sections).length) continue;
      const lessonImagesBySubheading = imagesBySubheading[li] || {};
      const slidesBuffer = await buildSlides(lesson, sections, lessonImagesBySubheading);
      zip.addFile(`slides_lesson_${lesson.number}.pptx`, slidesBuffer);
    }
    const filename = `Chapter${structure.chapter.number}_Slides_Rebuilt.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zip.toBuffer());
    console.log('[rebuild] Sent rebuilt slides for all lessons.');
  } catch (err) {
    console.error('[rebuild] Failed to rebuild all slides:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── Rehydrate: restore a job from a previously-downloaded ZIP ────
//
// Motivating case: you don't have currentJob anymore — a long time passed,
// job_state.json got cleared, or this is a different machine entirely —
// but you still have a ZIP bundle from a past generation run. Upload it
// (or just the lesson_data.json extracted from it) here, and currentJob
// gets restored EXACTLY — no LLM calls, no lossy re-parsing of the .docx
// text. Every ZIP built by this app from now on includes lesson_data.json
// specifically to make this possible; a ZIP downloaded BEFORE this
// feature existed won't have it (see the error message below for that case).
//
// After this succeeds, /api/rebuild/slides/:num (and the regular download
// endpoints) work immediately against the restored data.
//
// NOTE: image files referenced by imagesBySubheading live on disk at
// public/images_temp/... — if those files no longer exist (cleaned up,
// or genuinely a different machine), rebuilt slides/docx will simply
// render without that image rather than failing — both DocBuilder.js and
// slidesGenerator.js already check fs.existsSync before using an image
// path, so this degrades gracefully rather than crashing. Text content is
// always fully restored either way.
app.post('/api/rehydrate', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: 'No file uploaded. Send the .zip bundle (or just lesson_data.json extracted from it) ' +
             'as multipart/form-data under the field name "file".'
    });
  }

  const name = (req.file.originalname || '').toLowerCase();
  let jobData;

  try {
    if (name.endsWith('.json')) {
      jobData = JSON.parse(req.file.buffer.toString('utf8'));
    } else if (name.endsWith('.zip')) {
      const zip = new AdmZip(req.file.buffer);
      const entry = zip.getEntry('lesson_data.json');
      if (!entry) {
        return res.status(400).json({
          error: 'This ZIP has no lesson_data.json inside it — it was very likely generated before this ' +
                 'feature existed. Only ZIPs downloaded from now on will contain it. There is no lossless ' +
                 'way to recover the structured data from an older ZIP\'s .docx/.pptx files alone.'
        });
      }
      jobData = JSON.parse(zip.readAsText(entry));
    } else {
      return res.status(400).json({ error: 'Upload a .zip bundle or a lesson_data.json file.' });
    }
  } catch (err) {
    console.error('[rehydrate] Failed to parse uploaded file:', err.message);
    return res.status(400).json({ error: `Could not parse uploaded file: ${err.message}` });
  }

  if (!jobData.structure || !jobData.structure.lessons) {
    return res.status(400).json({ error: 'Uploaded data is missing the lesson structure — this may not be a valid lesson_data.json.' });
  }

  currentJob = {
    structure: jobData.structure,
    generatedSections: jobData.generatedSections || {},
    videoScripts: jobData.videoScripts || {},
    unitAssessment: jobData.unitAssessment || null,
    images: jobData.images || {},
    imagesBySubheading: jobData.imagesBySubheading || {},
    answerVerification: jobData.answerVerification || {},
    validationReport: jobData.validationReport || {},
    citations: jobData.citations || [],
    grade: jobData.grade,
    subject: jobData.subject,
    sloCoverageGap: jobData.sloCoverageGap || [],
    disableVerification: false,
    disableSvgDiagrams: false,
  };
  persistJobState();

  const lessonCount = currentJob.structure.lessons.length;
  console.log(`[rehydrate] Restored job from upload — Chapter ${currentJob.structure.chapter?.number}: "${currentJob.structure.chapter?.title}", ${lessonCount} lesson(s).`);

  res.json({
    success: true,
    structure: currentJob.structure,
    sloCoverageGap: currentJob.sloCoverageGap,
    message: `Restored ${lessonCount} lesson(s). You can now call /api/rebuild/slides/:num, /api/rebuild/slides, ` +
             `/api/download, or /api/download/lesson/:num without re-running generation.`,
  });
});

// ─── Reset job ────────────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  currentJob = null;
  try {
    if (fs.existsSync(JOB_STATE_PATH)) fs.unlinkSync(JOB_STATE_PATH);
  } catch (err) {
    console.warn('[reset] Failed to delete job_state.json:', err.message);
  }
  res.json({ ok: true });
});

// ─── Start server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Lesson Generator running at http://localhost:${PORT}`);
  console.log(`📦 Model: ${MODEL}`);
  console.log(`\nMake sure Ollama is running: ollama serve`);
  console.log(`Pull the model if needed:    ollama pull ${MODEL}\n`);
});