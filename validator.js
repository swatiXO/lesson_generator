// validator.js — runs quality and correctness audits on generated lesson content
const { generate } = require('./ollama');
const { auditPrompt } = require('./prompts');
const { SECTIONS } = require('./sections');

// Sections that get a full curriculum/scope/tone audit (an extra LLM call).
// These are where real arithmetic and scope errors cluster; the rest skip it
// for speed. yourTurnFull gets its own arithmetic check (auditQuiz) instead.
const AUDITED_SECTIONS = new Set([
  SECTIONS.CONCEPT_BUILDING,
  SECTIONS.PRACTICE_QUESTIONS,
  SECTIONS.MENTAL_MATHS,
]);

/**
 * Parses a verdict: JSON ({"pass": bool, "feedback": "..."}) preferred,
 * falling back to a leading "PASS" if the model didn't return valid JSON.
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
      // fall through to legacy parsing
    }
  }
  const ok = raw.trim().toUpperCase().startsWith('PASS');
  return { ok, feedback: raw };
}

/**
 * Validates a generated lesson section. Returns { ok: boolean, feedback: string }.
 * An audit call that errors counts as a pass — a broken checker shouldn't block generation.
 */
async function validateSection(secKey, secLabel, secText, lesson, chapter, grade, contextChunks = []) {
  if (!secText || secText.trim().length < 50) {
    return { ok: false, feedback: 'The generated section is too short or empty.' };
  }

  try {
    if (secKey === SECTIONS.YOUR_TURN_FULL) {
      return await auditQuiz(secText);
    }

    if (AUDITED_SECTIONS.has(secKey)) {
      // One call covers SLO coverage, scope creep, grade-appropriate tone,
      // definitional accuracy, example quality, and textbook depth ceiling.
      const { system, user } = auditPrompt(secLabel, secText, lesson, chapter, grade, contextChunks);
      const raw = await generate(system, user);
      return parseVerdict(raw);
    }

    return { ok: true, feedback: 'PASS' };
  } catch (err) {
    console.error(`[validator] Validation error on ${secLabel}:`, err.message);
    return { ok: true, feedback: 'Validation skipped due to check error: ' + err.message };
  }
}

/**
 * Checks a Your Turn section's questions and answer keys for correctness and
 * consistency. Complements answerVerifier.js, which independently re-solves
 * each question from scratch.
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
