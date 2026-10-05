// validator.js — runs quality and correctness audits on generated lesson content
const { generate } = require('./ollama');
const { auditPrompt } = require('./prompts');
const { SECTIONS } = require('./sections');

// [FIX v8] Sections where a full curriculum/scope/tone audit is worth the
// extra LLM call. Previously this was JUST conceptBuilding, by explicit
// design ("speed was the explicit complaint"). Widened to also include
// practiceQuestions and mentalMaths: these are exactly the two sections
// where real arithmetic/scope errors were found clustering in actual
// generated output (word problems, mental-maths answer keys), and neither
// was getting ANY structural/scope audit before this change — they simply
// fell through to the default PASS at the bottom of validateSection. This
// is still a deliberate latency/coverage tradeoff, not "audit everything";
// warmUp, yourTurnFull, and keyTakeaways remain unaudited here on purpose
// (yourTurnFull's arithmetic is covered by auditQuiz below instead — see
// the routing fix in validateSection).
const AUDITED_SECTIONS = new Set([
  SECTIONS.CONCEPT_BUILDING,
  SECTIONS.PRACTICE_QUESTIONS,
  SECTIONS.MENTAL_MATHS,
]);

/**
 * Parses a verdict response. Prefers the new JSON format
 * ({"pass": bool, "feedback": "..."}) that auditPrompt/auditQuiz now request;
 * falls back to the legacy "PASS"-prefix string convention if the model
 * didn't return valid JSON, so this stays robust either way.
 */
function parseVerdict(raw) {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.pass === 'boolean') {
        return { ok: parsed.pass, feedback: parsed.feedback || (parsed.pass ? 'PASS' : 'FAIL (no feedback given)') };
      }
    } catch (_) {
      // fall through to legacy parsing below
    }
  }
  const ok = raw.trim().toUpperCase().startsWith('PASS');
  return { ok, feedback: raw };
}

/**
 * Validates a generated lesson section.
 * Returns { ok: boolean, feedback: string }
 *
 * NOTE signature: takes (chapter, grade, contextChunks) instead of a single
 * pre-joined contextText string, since auditPrompt needs the chapter title,
 * grade, and structured chunk metadata (source/page).
 */
async function validateSection(secKey, secLabel, secText, lesson, chapter, grade, contextChunks = []) {
  // 1. Basic length check
  if (!secText || secText.trim().length < 50) {
    return { ok: false, feedback: 'The generated section is too short or empty.' };
  }

  try {
    // [FIX v8] This was `secKey === 'popUpQuiz'` — a section key that has
    // not existed since the v7 rename (server.js's sectionDefs and
    // prompts.js both moved to 'yourTurnFull' months ago; see prompts.js's
    // file-level design note). With the old string, this branch could
    // never match anything, so 'yourTurnFull' — one of the sections that
    // actually carries an answer key — silently fell through to the
    // unconditional `{ ok: true }` at the bottom of this function with NO
    // arithmetic or structural check of any kind, every single time. This
    // is the fix: route on the current key via the shared SECTIONS
    // constant instead of a stale literal, so a future rename can't
    // silently break this again the same way.
    if (secKey === SECTIONS.YOUR_TURN_FULL) {
      return await auditQuiz(secText);
    }

    if (AUDITED_SECTIONS.has(secKey)) {
      // Single call covers: SLO coverage (all sub-targets), scope/mission
      // creep, tone & complexity for the grade, definitional accuracy,
      // example quality, and mini-exercise presence where applicable.
      //
      // [FIX v8] Old comment here claimed "Textbook context (if any) is
      // treated as advisory, not authoritative — a topic mismatch there is
      // never grounds for failure on its own." That described PRE-v7
      // behavior and now directly contradicts auditPrompt's own system
      // message (prompts.js), which explicitly states textbook context is
      // AUTHORITATIVE for depth/technique once supplied, and instructs the
      // auditor to fail content that exceeds it (see auditPrompt's check
      // #2 and its "TEXTBOOK CONTEXT RULE"). This validator doesn't override
      // that verdict — it just forwards it — so the actual runtime
      // behavior was already correct; only this comment was stale and
      // actively misleading about what check #2 does.
      const { system, user } = auditPrompt(secLabel, secText, lesson, chapter, grade, contextChunks);
      const raw = await generate(system, user);
      return parseVerdict(raw);
    }

    // Default to PASS for other sections if basic checks pass
    return { ok: true, feedback: 'PASS' };

  } catch (err) {
    console.error(`[validator] Validation error on ${secLabel}:`, err.message);
    return { ok: true, feedback: 'Validation skipped due to check error: ' + err.message };
  }
}

/**
 * Audit quiz answers and keys — a genuinely different check (arithmetic
 * correctness of the quiz itself) from curriculum/SLO coverage, so this
 * stays separate from auditPrompt rather than folded into it.
 *
 * NOTE: this checks structural/plausibility correctness (are the MCQ
 * distractors sane, is there exactly one correct answer, does the answer
 * key exist and look internally consistent). It is intentionally NOT a
 * replacement for answerVerifier.js's independent from-scratch solve —
 * that one actually re-derives each answer before comparing. The two are
 * complementary, not redundant: this one runs as part of the normal
 * validate-then-retry loop for every attempt; answerVerifier.js's deeper
 * check is reserved for ANSWER_BEARING_SECTIONS specifically (see
 * server.js's generation loop for how the two are now combined).
 */
async function auditQuiz(quizText) {
  const system = `You are an independent mathematics quality auditor checking a quiz for correctness.
Respond with ONLY a valid JSON object, no markdown fences, no explanation outside the JSON:
{"pass": true or false, "feedback": "If pass is false, explain the specific error(s) clearly so the author can regenerate the section. If pass is true, a brief one-line confirmation."}`;

  const user = `Review the following "Your Turn" section (two labelled sub-parts, A and B, each
containing questions with a boxed Answer Key).
Ensure:
1. All questions have mathematically correct answers.
2. The Answer Key inside each box is present and correct — every question must have a
   corresponding, correct answer.
3. Questions make sense and are unambiguous given the stated Answer Key.

Quiz Content:
${quizText}

Return the JSON verdict now.`;

  const raw = await generate(system, user);
  return parseVerdict(raw);
}

module.exports = { validateSection, AUDITED_SECTIONS };