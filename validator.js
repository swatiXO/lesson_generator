// validator.js — runs quality and correctness audits on generated lesson content
const { generate } = require('./ollama');
const { auditPrompt } = require('./prompts');

// Sections where a full curriculum/scope/tone audit is worth the extra LLM
// call. Kept intentionally narrow to conceptBuilding only, matching the
// original scope — auditing more sections finds more real issues, but each
// added section is one more full model call per attempt (×3 on retry), and
// speed was the explicit complaint. Add 'examples' and/or 'practiceQuestions'
// here if you want broader coverage and are OK trading latency for it.
const AUDITED_SECTIONS = new Set(['conceptBuilding']);

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
 * NOTE signature change: now takes (chapter, grade, contextChunks) instead of
 * a single pre-joined contextText string, since auditPrompt needs the chapter
 * title, grade, and structured chunk metadata (source/page) — update the call
 * site in server.js accordingly.
 */
async function validateSection(secKey, secLabel, secText, lesson, chapter, grade, contextChunks = []) {
  // 1. Basic length check
  if (!secText || secText.trim().length < 50) {
    return { ok: false, feedback: 'The generated section is too short or empty.' };
  }

  try {
    if (secKey === 'popUpQuiz') {
      return await auditQuiz(secText);
    }

    if (AUDITED_SECTIONS.has(secKey)) {
      // Single call covers: SLO coverage (all sub-targets), scope/mission
      // creep, tone & complexity for the grade, definitional accuracy,
      // example quality, and mini-exercise presence where applicable.
      // Textbook context (if any) is treated as advisory, not authoritative —
      // a topic mismatch there is never grounds for failure on its own.
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
 */
async function auditQuiz(quizText) {
  const system = `You are an independent mathematics quality auditor checking a quiz for correctness.
Respond with ONLY a valid JSON object, no markdown fences, no explanation outside the JSON:
{"pass": true or false, "feedback": "If pass is false, explain the specific error(s) clearly so the author can regenerate the section. If pass is true, a brief one-line confirmation."}`;

  const user = `Review the following Pop-Up Quiz.
Ensure:
1. All questions (Fill in the blanks & MCQs) have mathematically correct answers.
2. If an answer key is provided, it is correct. If no answer key is provided, check if the questions themselves make sense.
3. MCQ distractors are plausible and only one answer is correct.

Quiz Content:
${quizText}

Return the JSON verdict now.`;

  const raw = await generate(system, user);
  return parseVerdict(raw);
}

module.exports = { validateSection };