// server.js — Express backend for the lesson generator
require('./env'); // load .env before any module reads process.env
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');
const multer = require('multer');
const { generate, ping, MODEL } = require('./ollama');
const {
  buildDocx,
  buildYourTurnDocx,
  buildVideoScriptDocx,
  buildUnitAssessmentDocx,
} = require('./DocBuilder');
const {
  structurePrompt,
  introductionPrompt,
  warmUpPrompt,
  conceptBuildingPrompt,
  yourTurnFullPrompt,
  mentalMathsPrompt,
  practiceQuestionsPrompt,
  keyTakeawaysPrompt,
  videoScriptPrompt,
  unitAssessmentPrompt,
  hydrateStructure,         // rebuilds lesson.slo_descriptions from SLO codes
  extractUsedContext,       // scenario/name usage in a section's text
  mergeUsedContext,
  extractVisualDescription, // the [VISUAL: ...] tag, for image generation
  parseSlosText,
} = require('./prompts');
const { queryKnowledgeBase, queryKnowledgeBaseBatch } = require('./kb');
const { generateImageForSection } = require('./imageGenerator');
const { buildSlides } = require('./slidesGenerator');
const { buildLessonPdf, renderHtmlToPdf, markdownToHtml } = require('./pdfRenderer');
const { validateSection } = require('./validator');
const { verifySectionAnswers, ANSWER_BEARING_SECTIONS } = require('./answerVerifier');
const { closeBrowser } = require('./puppeteerHelper');
const { SECTIONS } = require('./sections');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // a chapter zip with images can be several MB

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MAX_SECTION_ATTEMPTS = 3;
const MAX_TOTAL_CONTEXT_CHUNKS = 6; // per lesson, across all SLO queries — there's no end-to-end token budget yet
const IMAGE_DIR = path.join(__dirname, 'public', 'images_temp');
// Unreferenced images are kept this long so a rehydrated old bundle can still find them.
const IMAGE_RETENTION_DAYS = Number(process.env.IMAGE_RETENTION_DAYS) || 7;

// In-memory store for generated content (single-user local app)
let currentJob = null;

// ─── Job persistence ──────────────────────────────────────────────
// currentJob is snapshotted after every section, so a crash or restart loses at
// most the section in flight. (Fine for one local server; multi-instance would
// need a real store.)
const JOB_STATE_PATH = path.join(__dirname, 'job_state.json');

function persistJobState() {
  if (!currentJob) return;
  try {
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    const tmpPath = `${JOB_STATE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(currentJob, null, 2));
    fs.renameSync(tmpPath, JOB_STATE_PATH);
  } catch (err) {
    console.error('[persist] Failed to write job_state.json:', err.message);
  }
}

function tryLoadPersistedJobState() {
  if (!fs.existsSync(JOB_STATE_PATH)) return;
  try {
    currentJob = JSON.parse(fs.readFileSync(JOB_STATE_PATH, 'utf8'));
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

/**
 * Deletes generated images that the current job doesn't reference and that are
 * older than IMAGE_RETENTION_DAYS.
 */
function pruneOldImages() {
  if (!fs.existsSync(IMAGE_DIR)) return;
  const referenced = new Set(
    (JSON.stringify(currentJob || {}).match(/images_temp\/[^"\\]+/g) || []).map(p => path.basename(p))
  );
  const cutoff = Date.now() - IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of fs.readdirSync(IMAGE_DIR)) {
    if (referenced.has(file)) continue;
    const filePath = path.join(IMAGE_DIR, file);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch (_) {}
  }
  if (removed) console.log(`[cleanup] Removed ${removed} unreferenced image(s) older than ${IMAGE_RETENTION_DAYS} day(s).`);
}

tryLoadPersistedJobState();
pruneOldImages();

// ─── Helpers ──────────────────────────────────────────────────────

const chunkKey = (c) => `${c.source}::${c.page}::${(c.text || '').slice(0, 50)}`;

function ensure(obj, key) {
  if (!obj[key]) obj[key] = {};
  return obj[key];
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-bundle-'));
}

function sendFile(res, buffer, filename, contentType = 'application/zip') {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

/**
 * Parses the model's structure response. Returns { structure } or { error }.
 * The chapter number comes from the caller — the model can only echo the
 * example number in the prompt's JSON schema.
 */
function parseStructureResponse(raw, slos, chapterNumber) {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/); // tolerate text before/after the JSON
  if (!jsonMatch) return { error: 'Model did not return valid JSON.\n\nRaw output:\n' + cleaned.slice(0, 500) };

  const structure = JSON.parse(jsonMatch[0]);
  if (!structure.chapter || !structure.lessons?.length) return { error: 'Invalid structure returned by model' };

  if (chapterNumber !== undefined && chapterNumber !== null && chapterNumber !== '') {
    const n = Number(chapterNumber);
    structure.chapter.number = Number.isFinite(n) ? n : chapterNumber;
  }
  // structurePrompt returns SLO codes only; every section prompt needs the descriptions.
  return { structure: hydrateStructure(structure, slos) };
}

// Sections that get one image per sub-heading. List-style sections would just
// produce near-duplicate images per bullet.
const MULTI_IMAGE_SECTIONS = new Set([SECTIONS.CONCEPT_BUILDING]);

/**
 * Splits section text on its sub-headings (## Heading or a bold-only line) so
 * each sub-concept gets its own image. Text without headings becomes one
 * "Overview" chunk.
 */
function splitBySubheading(text) {
  const chunks = [];
  let title = null;
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) chunks.push({ title: title || 'Overview', body });
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
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

  if (chunks.length === 0 && text.trim()) chunks.push({ title: 'Overview', body: text.trim() });
  return chunks;
}

/**
 * Textbook context for a lesson: one query per SLO (a blended whole-lesson
 * query skews toward whichever SLO's vocabulary dominates), run in a single
 * Python process, deduplicated and capped. Plus up to 2 prior-grade chunks for
 * a "you already know…" bridge, tagged isPriorGrade so prompts render them
 * separately and kept out of citations.
 */
async function retrieveLessonContext(lesson, job) {
  console.log(`[gen] Running per-SLO RAG retrieval for Lesson ${lesson.number} (${lesson.slo_descriptions.length} SLO(s))...`);
  const queries = lesson.slo_descriptions.map(desc => `${lesson.title} — ${desc}`);
  const perSlo = await queryKnowledgeBaseBatch(queries, job.grade, job.subject, 2);

  let context = [];
  const seen = new Set();
  perSlo.flat().forEach(c => {
    const key = chunkKey(c);
    if (!seen.has(key)) {
      seen.add(key);
      context.push(c);
    }
  });

  if (context.length > MAX_TOTAL_CONTEXT_CHUNKS) {
    console.log(`[gen] Retrieved ${context.length} unique chunk(s) across ${queries.length} SLO-targeted queries — capping to ${MAX_TOTAL_CONTEXT_CHUNKS} for context budget.`);
    context = context.slice(0, MAX_TOTAL_CONTEXT_CHUNKS);
  } else {
    console.log(`[gen] Retrieved ${context.length} unique chunk(s) across ${queries.length} SLO-targeted queries.`);
  }

  const cited = new Set(job.citations.map(chunkKey));
  context.forEach(c => {
    if (!cited.has(chunkKey(c))) {
      cited.add(chunkKey(c));
      job.citations.push(c);
    }
  });

  let priorGradeContext = [];
  if (job.grade > 1) {
    const bridgeQueryText = `${lesson.title} ${lesson.slo_descriptions.join(' ')}`;
    const priorRaw = await queryKnowledgeBase(bridgeQueryText, job.grade - 1, job.subject, 2);
    priorGradeContext = (priorRaw || []).map(c => ({ ...c, isPriorGrade: true }));
    if (priorGradeContext.length) {
      console.log(`[gen] Found ${priorGradeContext.length} prior-grade (Grade ${job.grade - 1}) bridge chunk(s) for Lesson ${lesson.number}`);
    }
  }

  return [...context, ...priorGradeContext];
}

// Answer-verification issues formatted as retry feedback.
function answerIssuesFeedback(issues) {
  const issueLines = issues.map((iss, i) =>
    `${i + 1}. Question: "${(iss.question || '').slice(0, 150)}" — you stated the answer as ` +
    `"${iss.statedAnswer}", but the independently verified correct answer is "${iss.computedAnswer}"` +
    `${iss.explanation ? ` (${iss.explanation})` : ''}.`
  ).join('\n');
  return `Independent answer verification found ${issues.length} incorrect stated ` +
    `answer(s) that MUST be corrected (do not just change the wording — recompute the actual ` +
    `answer and make sure the question, working, and stated answer are all mutually consistent):\n${issueLines}`;
}

function flaggedSections(lessonVerification) {
  return Object.entries(lessonVerification || {})
    .filter(([, v]) => v?.flagged)
    .map(([section, v]) => ({ section, issues: v.issues }));
}

// Machine-readable snapshot added to every bundle; /api/rehydrate restores
// currentJob from it with no LLM calls. Always the full chapter, so any bundle
// rehydrates the same way.
function buildJobSnapshot(job) {
  return {
    version: 'v8',
    savedAt: new Date().toISOString(),
    structure: job.structure,
    generatedSections: job.generatedSections,
    videoScripts: job.videoScripts,
    unitAssessment: job.unitAssessment || null,
    images: job.images || {},
    imagesBySubheading: job.imagesBySubheading,
    answerVerification: job.answerVerification || {},
    validationReport: job.validationReport || {},
    citations: job.citations || [],
    grade: job.grade,
    subject: job.subject,
    sloCoverageGap: job.sloCoverageGap || [],
  };
}

const isErrorPlaceholder = (text) => typeof text === 'string' && text.startsWith('[Error generating');

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

    const parsed = parseStructureResponse(await generate(system, user), slos, chapterNumber);
    if (parsed.error) throw new Error(parsed.error);
    let { structure } = parsed;

    // The model can silently drop SLOs, so diff submitted codes against assigned
    // ones and retry once with the missing codes called out.
    const submittedCodes = new Set(Object.keys(parseSlosText(slos)));
    const missingFrom = (struct) => {
      const assigned = new Set((struct.lessons || []).flatMap(l => l.slos || []));
      return [...submittedCodes].filter(c => !assigned.has(c));
    };
    let missingCodes = missingFrom(structure);

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
        const retry = parseStructureResponse(await generate(system, retryUser), slos, chapterNumber);
        if (retry.error) {
          console.warn(`[structure] Retry response unusable (${retry.error.split('\n')[0]}) — proceeding with the original structure.`);
        } else {
          const retryMissing = missingFrom(retry.structure);
          if (retryMissing.length < missingCodes.length) {
            structure = retry.structure;
            missingCodes = retryMissing;
            console.log(retryMissing.length === 0
              ? '[structure] Retry achieved full SLO coverage.'
              : `[structure] Retry improved coverage but still missing: ${retryMissing.join(', ')}.`);
          } else {
            console.warn(`[structure] Retry did not improve coverage (still missing ` +
              `${(retryMissing.length ? retryMissing : missingCodes).join(', ')}). Proceeding with the original structure.`);
          }
        }
      } catch (retryErr) {
        console.warn('[structure] Retry call failed, proceeding with original structure:', retryErr.message);
      }

      if (missingCodes.length > 0) {
        console.error(`[structure] ⚠️  SLO COVERAGE GAP — the following submitted SLO(s) are not ` +
          `assigned to ANY lesson and will NOT be generated: ${missingCodes.join(', ')}. This chapter ` +
          `is INCOMPLETE as planned. Consider re-running /api/structure, or manually editing the ` +
          `returned structure to add a lesson for these before calling /api/generate.`);
      }
    }

    currentJob = {
      structure,
      generatedSections: {},
      videoScripts: {},
      unitAssessment: '',
      // images[lessonIndex][sectionKey] = path of the section's first image (pdfRenderer.js)
      images: {},
      // imagesBySubheading[lessonIndex][sectionKey][subheading] = { path, query, isPlaceholder }
      // (DocBuilder.js / slidesGenerator.js: one image per sub-heading)
      imagesBySubheading: {},
      // usedContext[lessonIndex] = { categories, names } already used by earlier sections
      usedContext: {},
      // answerVerification[lessonIndex][sectionKey] = { flagged, issues, allVerdicts }
      answerVerification: {},
      validationReport: {},
      citations: [],
      grade: parseInt(grade),
      subject: subject || 'Mathematics',
      sloCoverageGap: missingCodes, // surfaced in manifest.json too
      disableVerification: req.body.disableVerification || false,
      // Skips LLM-drawn SVG diagrams (the costliest image step) for the whole run.
      disableSvgDiagrams: req.body.disableSvgDiagrams || false,
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const job = currentJob;
  const { chapter, lessons } = job.structure;

  // Lets every prompt (which already receives `chapter`) see the whole lesson
  // plan — see chapterProgressBlock() in prompts.js.
  chapter.lessons = lessons;

  // Every section prompt is called as fn(lesson, contextChunks, extra, usedContext).
  // `extra` is whatever earlier output that section builds on.
  const sectionDefs = [
    { key: SECTIONS.INTRODUCTION,       label: 'Introduction',
      fn: (l, ctx, _extra, used) => introductionPrompt(l, chapter, chapter.grade, ctx, used) },
    { key: SECTIONS.WARM_UP,            label: 'Warm-Up',
      fn: (l, ctx, _extra, used) => warmUpPrompt(l, chapter, chapter.grade, ctx, used) },
    { key: SECTIONS.CONCEPT_BUILDING,   label: 'Concept Building',
      extra: (secs) => secs[SECTIONS.WARM_UP] || '',
      fn: (l, ctx, warmUp, used) => conceptBuildingPrompt(l, chapter, chapter.grade, warmUp, ctx, used) },
    // Mental Maths and Practice Questions see Concept Building as a difficulty floor.
    { key: SECTIONS.MENTAL_MATHS,       label: 'Mental Maths',
      extra: (secs) => secs[SECTIONS.CONCEPT_BUILDING] || '',
      fn: (l, ctx, concept, used) => mentalMathsPrompt(l, chapter, chapter.grade, ctx, used, concept || '') },
    { key: SECTIONS.YOUR_TURN_FULL,     label: 'Your Turn',
      fn: (l, ctx, _extra, used) => yourTurnFullPrompt(l, chapter, chapter.grade, ctx, used) },
    { key: SECTIONS.PRACTICE_QUESTIONS, label: 'Practice Questions',
      extra: (secs) => secs[SECTIONS.CONCEPT_BUILDING] || '',
      fn: (l, ctx, concept, used) => practiceQuestionsPrompt(l, chapter, chapter.grade, ctx, used, concept || '') },
    // A summary of everything before it; nothing new to vary, so no usedContext.
    { key: SECTIONS.KEY_TAKEAWAYS,      label: 'Key Takeaways',
      extra: (secs) => secs,
      fn: (l, ctx, prev) => keyTakeawaysPrompt(l, chapter, chapter.grade, prev, ctx) },
  ];

  // lessons × sections, plus one video script per lesson, plus the unit assessment
  const totalSteps = (lessons.length * sectionDefs.length) + lessons.length + 1;
  let step = 0;

  try {
    for (const lesson of lessons) {
      const lessonIdx = lesson.number - 1;
      const lessonSections = ensure(job.generatedSections, lessonIdx);
      const isDone = (sec) => !!(lessonSections[sec.key] && job.validationReport?.[lessonIdx]?.[sec.key]?.ok);

      // Variety is tracked per lesson: Ali can reappear in Lesson 2, but two
      // sections of the same lesson shouldn't converge on the same scenario.
      let lessonUsedContext = { categories: [], names: [] };
      const trackUsage = (text) => {
        lessonUsedContext = mergeUsedContext(lessonUsedContext, extractUsedContext(text));
        job.usedContext[lessonIdx] = lessonUsedContext;
      };

      send('lesson_start', { lessonNum: lesson.number, lessonTitle: lesson.title });

      // On resume, a fully finished lesson needs no retrieval at all.
      const lessonComplete = sectionDefs.every(isDone);
      const contextChunks = lessonComplete ? [] : await retrieveLessonContext(lesson, job);
      let lessonChanged = false;

      for (const sec of sectionDefs) {
        step++;
        const pct = Math.round((step / totalSteps) * 100);

        // Resume: sections that passed validation in an earlier run are kept,
        // including their images. Their text still feeds the variety tracker.
        if (isDone(sec)) {
          console.log(`[gen] Lesson ${lesson.number} / ${sec.label} — already completed in a prior run, skipping regeneration.`);
          send('section_start', { lessonNum: lesson.number, section: sec.label, progress: pct, step, totalSteps, resumed: true });
          trackUsage(lessonSections[sec.key]);
          send('section_done', {
            lessonNum: lesson.number,
            section: sec.key,
            sectionLabel: sec.label,
            progress: pct,
            resumed: true,
            answerFlagged: job.answerVerification?.[lessonIdx]?.[sec.key]?.flagged || false,
          });
          continue;
        }

        lessonChanged = true;
        send('section_start', { lessonNum: lesson.number, section: sec.label, progress: pct, step, totalSteps });
        console.log(`[gen] Lesson ${lesson.number} / ${sec.label} ...`);

        let text = '';
        let success = false;
        const validationReport = { ok: true, attempts: 0, errors: [] };
        // Latest verification result, kept even if every attempt stays flagged.
        let latestVerification = { flagged: false, issues: [], allVerdicts: [] };

        // Retries reuse the original prompts with feedback appended, so the scope
        // fence, SLO checklist and format rules stay in force on every attempt.
        const original = sec.fn(lesson, contextChunks, sec.extra ? sec.extra(lessonSections) : null, lessonUsedContext);

        for (let attempt = 1; attempt <= MAX_SECTION_ATTEMPTS && !success; attempt++) {
          validationReport.attempts = attempt;

          const userPrompt = attempt === 1 ? original.user : `${original.user}

IMPORTANT — A previous attempt at this exact task had the following problems. Fix them in this
attempt while still following every instruction above (SLO coverage checklist, scope rules,
tone/format constraints, etc. all still apply):
${validationReport.errors[validationReport.errors.length - 1]}

Write the corrected, complete section now, following all the original instructions. No preamble.`;

          try {
            text = await generate(original.system, userPrompt, (chunk) => {
              send('token', { lessonNum: lesson.number, section: sec.key, chunk });
            });

            const validation = await validateSection(sec.key, sec.label, text, lesson, chapter, job.grade, contextChunks);
            if (!validation.ok) {
              validationReport.ok = false;
              validationReport.errors.push(validation.feedback);
              send('validation_warning', { lessonNum: lesson.number, section: sec.key, attempt, feedback: validation.feedback });
              continue; // no point verifying answers in content that needs a rewrite anyway
            }

            // Independent answer check; a wrong answer is retried like a validation failure.
            if (ANSWER_BEARING_SECTIONS.has(sec.key)) {
              console.log(`[gen] Running independent answer verification for Lesson ${lesson.number} / ${sec.label} (attempt ${attempt})...`);
              const verification = await verifySectionAnswers(sec.key, sec.label, text, lesson, chapter, job.grade);
              latestVerification = verification;

              if (verification.flagged) {
                validationReport.ok = false;
                validationReport.errors.push(answerIssuesFeedback(verification.issues));
                send('answer_flagged', {
                  lessonNum: lesson.number,
                  section: sec.key,
                  sectionLabel: sec.label,
                  attempt,
                  issues: verification.issues,
                });
                continue;
              } else if (verification.verifierError) {
                // A broken verifier call is not a wrong answer; accept the attempt.
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

        // After exhausting attempts the last text still ships, with its report.
        lessonSections[sec.key] = text;
        ensure(job.validationReport, lessonIdx)[sec.key] = validationReport;

        const lessonVerification = ensure(job.answerVerification, lessonIdx);
        if (ANSWER_BEARING_SECTIONS.has(sec.key)) {
          lessonVerification[sec.key] = latestVerification;
          if (latestVerification.flagged) {
            console.warn(`[gen] ⚠️  Lesson ${lesson.number} / ${sec.label}: ${latestVerification.issues.length} ` +
              `answer(s) STILL flagged after exhausting retry attempts — shipping with a visible review flag.`);
          }
        }

        trackUsage(text);

        send('section_done', {
          lessonNum: lesson.number,
          section: sec.key,
          sectionLabel: sec.label,
          progress: pct,
          answerFlagged: lessonVerification[sec.key]?.flagged || false,
        });

        await generateSectionImages(job, lesson, sec, text, send);
        persistJobState(); // checkpoint: a crash now loses at most the next section
      }

      persistJobState();

      // Video script — reused on resume if this lesson's content didn't change.
      step++;
      const scriptPct = Math.round((step / totalSteps) * 100);
      send('section_start', { lessonNum: lesson.number, section: 'Video Script', progress: scriptPct, step, totalSteps });
      const existingScript = job.videoScripts[lessonIdx];
      if (!lessonChanged && existingScript && !isErrorPlaceholder(existingScript)) {
        console.log(`[gen] Lesson ${lesson.number} / Video Script — already completed in a prior run, skipping regeneration.`);
        send('section_done', { lessonNum: lesson.number, section: 'videoScript', sectionLabel: 'Video Script', progress: scriptPct, resumed: true });
      } else {
        try {
          console.log(`[gen] Generating Video Script for Lesson ${lesson.number}...`);
          // Gets the lesson's sections so the dialogue covers what was actually taught.
          const { system: vSys, user: vUsr } = videoScriptPrompt(lesson, chapter, job.grade, lessonSections);
          job.videoScripts[lessonIdx] = await generate(vSys, vUsr);
          send('section_done', { lessonNum: lesson.number, section: 'videoScript', sectionLabel: 'Video Script', progress: scriptPct });
        } catch (scriptErr) {
          console.error('[gen] Script gen error:', scriptErr.message);
          job.videoScripts[lessonIdx] = `[Error generating script: ${scriptErr.message}]`;
          send('section_error', { lessonNum: lesson.number, section: 'videoScript', error: scriptErr.message });
        }
        persistJobState();
      }

      send('lesson_done', { lessonNum: lesson.number });
    }

    // Unit assessment — built from the lesson plan only, so reusable on resume.
    step++;
    const assessPct = 100;
    send('section_start', { lessonNum: 0, section: 'Unit Assessment', progress: assessPct, step, totalSteps });
    if (job.unitAssessment && !isErrorPlaceholder(job.unitAssessment)) {
      console.log('[gen] Unit Assessment — already completed in a prior run, skipping regeneration.');
      send('section_done', { lessonNum: 0, section: 'unitAssessment', sectionLabel: 'Unit Assessment', progress: assessPct, resumed: true });
    } else {
      try {
        console.log(`[gen] Generating Unit Assessment...`);
        const { system: aSys, user: aUsr } = unitAssessmentPrompt(chapter, job.grade, lessons);
        job.unitAssessment = await generate(aSys, aUsr);
        send('section_done', { lessonNum: 0, section: 'unitAssessment', sectionLabel: 'Unit Assessment', progress: assessPct });
      } catch (assessErr) {
        console.error('[gen] Unit assessment error:', assessErr.message);
        job.unitAssessment = `[Error generating assessment: ${assessErr.message}]`;
        send('section_error', { lessonNum: 0, section: 'unitAssessment', error: assessErr.message });
      }
      persistJobState();
    }

    send('all_done', { message: 'All lessons, scripts, and assessments generated! Click Download to get your ZIP bundle.' });

  } catch (err) {
    console.error('[gen] Fatal error:', err.message);
    send('error', { error: err.message });
  } finally {
    res.end();
  }
});

/**
 * Images for one finished section. Concept Building gets one per sub-heading;
 * other sections get one only if the text has an explicit [VISUAL:] tag —
 * guessing from freeform prose (dialogue, lists) produced chaotic images.
 */
async function generateSectionImages(job, lesson, sec, text, send) {
  const lessonIdx = lesson.number - 1;
  const lessonImages = ensure(job.images, lessonIdx);
  const sectionImages = ensure(job.imagesBySubheading, lessonIdx)[sec.key] = {};

  const useSubheadings = MULTI_IMAGE_SECTIONS.has(sec.key);
  const chunks = useSubheadings ? splitBySubheading(text) : [{ title: sec.key, body: text }];
  console.log(`[gen] ${sec.key} split into ${chunks.length} chunk(s):`, chunks.map(c => c.title));
  let firstImagePath = null;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const visualTag = extractVisualDescription(chunk.body);
    if (!useSubheadings && !visualTag) {
      console.log(`[gen] Skipping image for ${sec.key} — no [VISUAL:] tag present and this section isn't structured content.`);
      continue;
    }

    try {
      send('image_start', { lessonNum: lesson.number, section: sec.key, subheading: chunk.title });
      const imgResult = await generateImageForSection(
        `L${lesson.number}_${sec.key}_${ci}`,
        visualTag || chunk.body, // a deliberate [VISUAL:] description beats raw prose
        job.grade,
        job.subject,
        job.disableVerification,
        job.disableSvgDiagrams
      );
      if (imgResult && imgResult.path) {
        sectionImages[chunk.title] = { path: imgResult.path, query: imgResult.query, isPlaceholder: imgResult.isPlaceholder };
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
      console.error(`[gen] Image generation error (${sec.key} / "${chunk.title}"):`, imgErr.message);
    }
  }

  if (firstImagePath) lessonImages[sec.key] = firstImagePath;
}

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

  const tempDir = makeTempDir();

  try {
    const zip = new AdmZip();
    // Renderers take whole-chapter shapes; give them a one-lesson chapter.
    const singleStructure = { chapter: structure.chapter, lessons: [lesson] };
    const singleSections = { 0: sections };
    const lessonImagesBySubheading = imagesBySubheading[lessonIndex] || {};
    const lessonAnswerVerification = (answerVerification || {})[lessonIndex] || {};

    console.log(`[download] Building lesson ${lessonNum} docx...`);
    const docxBuffer = await buildDocx(singleStructure, singleSections, { 0: lessonImagesBySubheading }, { 0: lessonAnswerVerification });
    zip.addFile(`Lesson_${lessonNum}_Plan.docx`, docxBuffer);

    console.log(`[download] Building lesson ${lessonNum} pdf...`);
    const pdfPath = path.join(tempDir, `Lesson_${lessonNum}_Plan.pdf`);
    await buildLessonPdf(singleStructure, singleSections, { 0: images[lessonIndex] || {} }, pdfPath);
    zip.addLocalFile(pdfPath);

    console.log(`[download] Building lesson ${lessonNum} slides...`);
    zip.addFile(`Lesson_${lessonNum}_Slides.pptx`, await buildSlides(lesson, sections, lessonImagesBySubheading));

    if (sections[SECTIONS.YOUR_TURN_FULL]) {
      console.log(`[download] Building lesson ${lessonNum} Your Turn docx...`);
      zip.addFile(`Lesson_${lessonNum}_YourTurn.docx`, await buildYourTurnDocx([lesson], singleSections));
    }

    const scriptText = videoScripts[lessonIndex];
    if (scriptText) {
      console.log(`[download] Building lesson ${lessonNum} video script docx...`);
      zip.addFile(`Lesson_${lessonNum}_Video_Script.docx`, await buildVideoScriptDocx([lesson], { 0: scriptText }));
    }

    console.log(`[download] Creating lesson ${lessonNum} manifest...`);
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
      flaggedForReview: flaggedSections(lessonAnswerVerification),
      // Chapter-wide — included so a single-lesson bundle still shows the gap.
      chapterSloCoverageGap: currentJob.sloCoverageGap || [],
    };
    zip.addFile(`Lesson_${lessonNum}_manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)));
    zip.addFile('lesson_data.json', Buffer.from(JSON.stringify(buildJobSnapshot(currentJob), null, 2)));

    const filename = `Lesson_${lessonNum}_${lesson.title.replace(/\s+/g, '_')}_Bundle.zip`;
    sendFile(res, zip.toBuffer(), filename);
    console.log(`[download] Sent lesson ${lessonNum} ZIP:`, filename);

  } catch (err) {
    // Full stack: an error inside a library (e.g. docx) is untraceable from the message alone.
    console.error(`[download] Error building lesson ${lessonNum} ZIP:`, err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const UNIT_ASSESSMENT_CSS = `
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
            body { font-family: 'Inter', sans-serif; padding: 20mm; color: #212529; line-height: 1.6; }
            h1 { font-size: 24pt; color: #1A7A4A; margin-bottom: 24px; border-bottom: 2px solid #1A7A4A; padding-bottom: 8px; }
            h2 { font-size: 18pt; color: #1F5C99; margin-top: 24px; margin-bottom: 12px; }
            h3 { font-size: 14pt; color: #2E75B6; margin-top: 18px; }
            p { margin-bottom: 12px; }
            ul, ol { margin-bottom: 16px; padding-left: 20px; }
            li { margin-bottom: 6px; }
            strong { font-weight: 600; }`;

// ─── Step 3: Build and download ZIP bundle ────────────────────────
app.get('/api/download', async (req, res) => {
  if (!currentJob || !Object.keys(currentJob.generatedSections).length) {
    return res.status(400).json({ error: 'No generated content found.' });
  }

  const tempDir = makeTempDir();

  try {
    const { structure, generatedSections, videoScripts, unitAssessment, images, imagesBySubheading, validationReport, citations, answerVerification } = currentJob;
    console.log('[download] Starting bundle generation...');
    const zip = new AdmZip();

    console.log('[download] Building lesson docx...');
    zip.addFile('lesson.docx', await buildDocx(structure, generatedSections, imagesBySubheading, answerVerification || {}));

    console.log('[download] Building lesson pdf...');
    const pdfPath = path.join(tempDir, 'lesson.pdf');
    await buildLessonPdf(structure, generatedSections, images, pdfPath);
    zip.addLocalFile(pdfPath);

    console.log('[download] Building slides pptx...');
    for (let li = 0; li < structure.lessons.length; li++) {
      const lesson = structure.lessons[li];
      const slidesBuffer = await buildSlides(lesson, generatedSections[li] || {}, imagesBySubheading[li] || {});
      zip.addFile(`slides_lesson_${lesson.number}.pptx`, slidesBuffer);
    }

    console.log('[download] Building Your Turn compilation docx...');
    zip.addFile('your_turn_compilation.docx', await buildYourTurnDocx(structure.lessons, generatedSections));

    console.log('[download] Building video script docx...');
    zip.addFile('video_script.docx', await buildVideoScriptDocx(structure.lessons, videoScripts));

    if (unitAssessment) {
      console.log('[download] Building unit assessment docx...');
      zip.addFile('unit_assessment.docx', await buildUnitAssessmentDocx(structure.chapter, unitAssessment));

      console.log('[download] Building unit assessment pdf...');
      const assessmentHtml = `<!DOCTYPE html>
<html>
<head><style>${UNIT_ASSESSMENT_CSS}</style></head>
<body>
${markdownToHtml(unitAssessment)}
</body>
</html>`;
      const assessmentPdfPath = path.join(tempDir, 'unit_assessment.pdf');
      await renderHtmlToPdf(assessmentHtml, assessmentPdfPath);
      zip.addLocalFile(assessmentPdfPath);
    }

    console.log('[download] Creating manifest...');
    const flaggedForReview = Object.entries(answerVerification || {}).flatMap(([lessonIdx, sections]) =>
      flaggedSections(sections).map(f => ({ lessonIndex: Number(lessonIdx), ...f })));
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
      // SLO codes no lesson covers, even after the retry — empty means full coverage.
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
    zip.addFile('lesson_data.json', Buffer.from(JSON.stringify(buildJobSnapshot(currentJob), null, 2)));

    const filename = `Chapter${structure.chapter.number}_Courseware_Bundle.zip`;
    sendFile(res, zip.toBuffer(), filename);
    console.log('[download] Sent bundle ZIP:', filename);

  } catch (err) {
    console.error('[download] Zip packaging error:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
// Re-run rendering (e.g. after a renderer fix + server restart) against
// already-generated content, with zero LLM calls.

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
    const slidesBuffer = await buildSlides(lesson, sections, imagesBySubheading[lessonIndex] || {});
    const filename = `Lesson_${lessonNum}_${lesson.title.replace(/\s+/g, '_')}_Slides.pptx`;
    sendFile(res, slidesBuffer, filename, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    console.log(`[rebuild] Sent rebuilt slides for Lesson ${lessonNum}.`);
  } catch (err) {
    console.error(`[rebuild] Failed to rebuild slides for Lesson ${lessonNum}:`, err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Same, whole chapter at once, zipped.
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
      zip.addFile(`slides_lesson_${lesson.number}.pptx`, await buildSlides(lesson, sections, imagesBySubheading[li] || {}));
    }
    sendFile(res, zip.toBuffer(), `Chapter${structure.chapter.number}_Slides_Rebuilt.zip`);
    console.log('[rebuild] Sent rebuilt slides for all lessons.');
  } catch (err) {
    console.error('[rebuild] Failed to rebuild all slides:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ─── Rehydrate: restore a job from a previously-downloaded ZIP ────
// Upload a bundle (or its lesson_data.json) to restore currentJob exactly — no
// LLM calls — then rebuild/download as usual. Images live in
// public/images_temp; if they've been cleaned up, renderers skip them.
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
    usedContext: {},
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
  pruneOldImages();
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

// Close the shared headless Chrome on Ctrl+C / kill.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await closeBrowser();
    process.exit(0);
  });
}
