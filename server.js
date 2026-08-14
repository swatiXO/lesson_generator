// server.js — Express backend for the lesson generator
const express = require('express');
const path = require('path');
const fs = require('fs');
const { generate, ping, MODEL } = require('./ollama');
const { 
  buildDocx, 
  buildPopQuizDocx, 
  buildVideoScriptDocx, 
  buildUnitAssessmentDocx 
} = require('./DocBuilder');
const {
  structurePrompt,
  introductionPrompt,
  warmUpPrompt,
  conceptBuildingPrompt,
  examplesPrompt,
  popUpQuizPrompt,
  mentalMathsPrompt,
  practiceQuestionsPrompt,
  keyTakeawaysPrompt,
  videoScriptPrompt,
  unitAssessmentPrompt,
  hydrateStructure, // NEW — reconstructs lesson.slo_descriptions from SLO codes
} = require('./prompts');
const { queryKnowledgeBase } = require('./kb');
const { generateImageForSection } = require('./imageGenerator');
const { buildSlides } = require('./slidesGenerator');
const { buildLessonPdf, renderHtmlToPdf } = require('./pdfRenderer');
const { validateSection } = require('./validator');
const AdmZip = require('adm-zip');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for generated content (single-user local app)
let currentJob = null;

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
  const { slos, grade, subject } = req.body;
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

    // NEW — structurePrompt now returns SLO codes only (not full description
    // text, to keep generation fast — see prompts.js). Reconstruct
    // lesson.slo_descriptions from the raw SLO text the caller supplied,
    // before storing/using the structure anywhere. Every downstream section
    // prompt reads lesson.slo_descriptions directly, so skipping this makes
    // them silently undefined.
    structure = hydrateStructure(structure, slos);

    // Store for later use (supporting full SDDD flow)
    currentJob = { 
      structure, 
      generatedSections: {}, 
      videoScripts: {},
      unitAssessment: '',
      images: {},
      validationReport: {},
      citations: [],
      grade: parseInt(grade),
      subject: subject || 'Mathematics',
      disableVerification: req.body.disableVerification || false
    };

    console.log(`[structure] Done — ${structure.lessons.length} lessons planned`);
    res.json({ structure });

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

  // sectionDefs with correct fn signatures matching new prompts.js
  // "introduction" runs first — a short, grade-friendly hook (e.g. "sharing a pizza"
  // for fractions) that sets up the topic before Warm-Up.
  const sectionDefs = [
    { key: 'introduction',      label: 'Introduction',        fn: (l, ctx) => introductionPrompt(l, chapter, chapter.grade, ctx) },
    { key: 'warmUp',            label: 'Warm-Up',             fn: (l, ctx) => warmUpPrompt(l, chapter, chapter.grade, ctx) },
    { key: 'conceptBuilding',   label: 'Concept Building',    fn: (l, ctx, wup) => conceptBuildingPrompt(l, chapter, chapter.grade, wup, ctx) },
    { key: 'examples',          label: 'Worked Examples',     fn: (l, ctx, cb) => examplesPrompt(l, chapter, chapter.grade, cb, ctx) },
    { key: 'popUpQuiz',         label: 'Pop-Up Quiz',         fn: (l, ctx) => popUpQuizPrompt(l, chapter, chapter.grade, ctx) },
    { key: 'mentalMaths',       label: 'Mental Maths',        fn: (l, ctx) => mentalMathsPrompt(l, chapter, chapter.grade, ctx) },
    { key: 'practiceQuestions', label: 'Practice Questions',  fn: (l, ctx) => practiceQuestionsPrompt(l, chapter, chapter.grade, ctx) },
    { key: 'keyTakeaways',      label: 'Key Takeaways',       fn: (l, ctx, prev) => keyTakeawaysPrompt(l, chapter, chapter.grade, prev, ctx) },
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

      send('lesson_start', { lessonNum: lesson.number, lessonTitle: lesson.title });

      // RAG Knowledge Layer query for the lesson
      console.log(`[gen] Running RAG retrieval for Lesson ${lesson.number}...`);
      const queryText = `${lesson.title} ${lesson.slo_descriptions.join(' ')}`;
      const context = await queryKnowledgeBase(queryText, currentJob.grade, currentJob.subject, 3);
      
      // Store citations in currentJob
      if (context && context.length > 0) {
        context.forEach(c => {
          if (!currentJob.citations.some(cit => cit.id === c.id)) {
            currentJob.citations.push(c);
          }
        });
      }
      const contextChunks = context || [];

      for (const sec of sectionDefs) {
        step++;
        const pct = Math.round((step / totalSteps) * 100);

        send('section_start', {
          lessonNum: lesson.number,
          section: sec.label,
          progress: pct,
          step,
          totalSteps,
        });

        console.log(`[gen] Lesson ${lesson.number} / ${sec.label} ...`);

        let attempt = 0;
        let success = false;
        let text = '';
        let validationReport = { ok: true, attempts: 0, errors: [] };

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
            const params = [lesson, contextChunks];
            if (sec.key === 'conceptBuilding') params.push(lessonSections['warmUp'] || '');
            if (sec.key === 'examples') params.push(lessonSections['conceptBuilding'] || '');
            if (sec.key === 'keyTakeaways') params.push(lessonSections); // Pass all previous sections
            
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

            // Run validation
            const validation = await validateSection(sec.key, sec.label, text, lesson, chapter, currentJob.grade, contextChunks);

            if (validation.ok) {
              success = true;
              validationReport.ok = true;
            } else {
              validationReport.ok = false;
              validationReport.errors.push(validation.feedback);
              send('validation_warning', { 
                lessonNum: lesson.number, 
                section: sec.key, 
                attempt, 
                feedback: validation.feedback 
              });
            }
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

        send('section_done', {
          lessonNum: lesson.number,
          section: sec.key,
          sectionLabel: sec.label,
          progress: pct,
        });

        // Trigger image generation for every section (one image per heading)
        {
          try {
            send('image_start', { lessonNum: lesson.number, section: sec.key });
            const imgPath = await generateImageForSection(
              `L${lesson.number}_${sec.key}`, 
              text, 
              currentJob.grade, 
              currentJob.subject, 
              currentJob.disableVerification
            );
            if (imgPath) {
              if (!currentJob.images[lesson.number - 1]) {
                currentJob.images[lesson.number - 1] = {};
              }
              currentJob.images[lesson.number - 1][sec.key] = imgPath;
              send('image_done', { lessonNum: lesson.number, section: sec.key, imagePath: imgPath });
            }
          } catch (imgErr) {
            console.error('[gen] Image generation error:', imgErr.message);
          }
        }
      }

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
        const { system: vSys, user: vUsr } = videoScriptPrompt(lesson, chapter, currentJob.grade);
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

  const { structure, generatedSections, videoScripts, images, validationReport } = currentJob;
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
    const docxBuffer = await buildDocx(singleStructure, singleSections);
    zip.addFile(`Lesson_${lessonNum}_Plan.docx`, docxBuffer);

    // 2. Lesson PDF
    console.log(`[download] Building lesson ${lessonNum} pdf...`);
    const pdfPath = path.join(tempDir, `Lesson_${lessonNum}_Plan.pdf`);
    const singleImages = { 0: images[lessonIndex] || {} };
    await buildLessonPdf(singleStructure, singleSections, singleImages, pdfPath);
    zip.addLocalFile(pdfPath);

    // 3. Slides
    console.log(`[download] Building lesson ${lessonNum} slides...`);
    const lessonImages = images[lessonIndex] || {};
    const slidesBuffer = await buildSlides(lesson, sections, lessonImages);
    zip.addFile(`Lesson_${lessonNum}_Slides.pptx`, slidesBuffer);

    // 4. Pop quiz (Word)
    if (sections.popUpQuiz) {
      console.log(`[download] Building lesson ${lessonNum} pop quiz docx...`);
      const quizBuffer = await buildPopQuizDocx([lesson], { 0: sections });
      zip.addFile(`Lesson_${lessonNum}_Quiz.docx`, quizBuffer);
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
      validation: { [lessonIndex]: validationReport[lessonIndex] || {} }
    };
    zip.addFile(`Lesson_${lessonNum}_manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)));

    // Send ZIP file
    const zipBuffer = zip.toBuffer();
    const filename = `Lesson_${lessonNum}_${lesson.title.replace(/\s+/g, '_')}_Bundle.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
    console.log(`[download] Sent lesson ${lessonNum} ZIP:`, filename);

  } catch (err) {
    console.error(`[download] Error building lesson ${lessonNum} ZIP:`, err.message);
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
    const { structure, generatedSections, videoScripts, unitAssessment, images, validationReport, citations } = currentJob;
    console.log('[download] Starting bundle generation...');

    const zip = new AdmZip();

    // 1. Core lesson document (Word)
    console.log('[download] Building lesson docx...');
    const docxBuffer = await buildDocx(structure, generatedSections);
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
      const lessonImages = images[li] || {};
      const slidesBuffer = await buildSlides(lesson, generatedSections[li] || {}, lessonImages);
      zip.addFile(`slides_lesson_${lesson.number}.pptx`, slidesBuffer);
    }

    // 4. Pop quiz document (Word)
    console.log('[download] Building pop quiz docx...');
    const quizBuffer = await buildPopQuizDocx(structure.lessons, generatedSections);
    zip.addFile('pop_quiz.docx', quizBuffer);

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
      citations: citations.map(c => ({
        source: c.source,
        page: c.page,
        subject: c.subject,
        grade: c.grade,
        slos: c.slos
      }))
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

    // Send ZIP file
    const zipBuffer = zip.toBuffer();
    const filename = `Chapter${structure.chapter.number}_Courseware_Bundle.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
    console.log('[download] Sent bundle ZIP:', filename);

  } catch (err) {
    console.error('[download] Zip packaging error:', err.message);
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
    validationReport: currentJob.validationReport
  });
});

// ─── Reset job ────────────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  currentJob = null;
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