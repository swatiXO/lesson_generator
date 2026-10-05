// answerVerifier.js — Tier-1 fix: independent answer-correctness verification.
//
// A separate LLM call is told to solve every question in a section from
// scratch, BEFORE comparing its own answer to what's already written —
// that ordering matters, since showing the stated answer first would let
// the model anchor on it and rationalize agreement instead of actually
// re-deriving it.
//
// This is deliberately an LLM-based cross-check, not a symbolic math
// engine. A general symbolic parser for natural-language word problems
// (as opposed to clean arithmetic expressions) is a much larger, separate
// project, and would still need something to actually parse "40% of 600
// people take a rickshaw" into a computable form — which is itself most
// reliably done by an LLM at this problem's scale. The value here is
// INDEPENDENCE (a fresh reasoning pass with no access to how the original
// answer was derived), not determinism.
//
// One call per section, batched across all its questions — matching the
// existing per-section audit-call cost pattern (auditPrompt) rather than
// paying for one call per individual question.
//
// [FIX v8] IMPORTANT — the flagged output this module produces is only
// half the fix. Previously, server.js ran this AFTER a section was already
// accepted and stored, and only ever used the result to print a warning
// and render an inline "FLAGGED FOR REVIEW" note in the finished document
// — the actual wrong answer shipped unchanged right next to that note.
// server.js's generation loop now runs this INSIDE the same retry loop
// used for validateSection, and feeds `computedAnswer` back into the next
// attempt's prompt exactly like a validation failure, so a caught error
// gets a chance to actually be corrected before the section is accepted.
// See server.js's per-section attempt loop for where that's wired in.
// This file's own logic (the independent solve-then-compare check itself)
// is unchanged — only how its output gets used changed.

const { generate } = require('./ollama');
const { answerVerificationPrompt } = require('./prompts');
const { SECTIONS } = require('./sections');

// Sections that actually carry an answer key worth verifying, keyed via
// the shared SECTIONS constant (see sections.js) instead of a locally
// retyped string literal — this Set going stale after a section rename is
// exactly what happened to validator.js's quiz-audit routing, and this
// file's own list was ALSO one rename behind at one point (its old
// hardcoded 'popUpQuiz'/'thinkTime' handling had already been manually
// patched here, but only here — see server.js's now-simplified union,
// which existed purely as a defensive workaround for this file being
// out of sync).
//
//   - 'warmUp' — the opening Warm-Up's Answer Key is optional per its own
//     prompt, so presence is inconsistent rather than absent. Included
//     because verifySectionAnswers already returns an empty, non-flagged
//     result when a section has nothing to check — the cost of including
//     it is an occasional wasted call, not an incorrect one, and missing a
//     genuine error because this section was skipped would be worse.
//   - 'conceptBuilding' — per-Part mandatory Your Turn box (Answer Key) +
//     Warm-Up box.
//   - 'mentalMaths' — mandatory Answer Key inside its Warm-Up-style box.
//   - 'yourTurnFull' — mandatory Answer Key in each of its two sub-parts
//     (A/B). Also independently audited by validator.js's auditQuiz path
//     now that its routing is fixed — the two checks are complementary,
//     not redundant (see validator.js's auditQuiz doc comment).
//   - 'practiceQuestions' — Parts A-D + Word Problem box + optional
//     Challenge box + Answer Key box; operates on the section's full raw
//     text, so it naturally covers all of these without per-box
//     special-casing.
const ANSWER_BEARING_SECTIONS = new Set([
  SECTIONS.WARM_UP,
  SECTIONS.CONCEPT_BUILDING,
  SECTIONS.MENTAL_MATHS,
  SECTIONS.YOUR_TURN_FULL,
  SECTIONS.PRACTICE_QUESTIONS,
]);

/**
 * Runs the independent verification pass against one section's finished
 * text. Returns a result object — NEVER throws; a verifier failure (model
 * error, bad JSON, etc.) is logged and returned as a non-flagged result
 * with `verifierError` set, so a broken verifier call can't accidentally
 * block a lesson from completing. A verifier error is not the same thing
 * as a confirmed wrong answer, and the two must not be conflated.
 *
 * @returns {{ flagged: boolean, issues: Array, allVerdicts: Array, verifierError?: string }}
 */
async function verifySectionAnswers(sectionKey, sectionLabel, text, lesson, chapter, grade) {
  if (!text || !text.trim()) {
    return { flagged: false, issues: [], allVerdicts: [] };
  }

  try {
    const { system, user } = answerVerificationPrompt(sectionLabel, text, lesson, chapter, grade);
    const raw = await generate(system, user);

    let cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn(`[answerVerifier] ${sectionKey}: model did not return a JSON array. Raw output (truncated):\n${cleaned.slice(0, 300)}`);
      return { flagged: false, issues: [], allVerdicts: [], verifierError: 'Model did not return valid JSON' };
    }

    let verdicts;
    try {
      verdicts = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.warn(`[answerVerifier] ${sectionKey}: JSON parse failed: ${parseErr.message}`);
      return { flagged: false, issues: [], allVerdicts: [], verifierError: `JSON parse failed: ${parseErr.message}` };
    }

    if (!Array.isArray(verdicts)) {
      console.warn(`[answerVerifier] ${sectionKey}: expected a JSON array, got ${typeof verdicts}`);
      return { flagged: false, issues: [], allVerdicts: [], verifierError: 'Response was not an array' };
    }

    const issues = verdicts.filter(v => v && v.verdict && v.verdict.toLowerCase() !== 'match');

    if (issues.length > 0) {
      console.warn(`[answerVerifier] ⚠️  ${sectionKey}: ${issues.length} answer(s) flagged for review — ` +
        issues.map(i => `"${(i.question || '').slice(0, 60)}..." (stated: ${i.statedAnswer}, computed: ${i.computedAnswer})`).join('; '));
    }

    return {
      flagged: issues.length > 0,
      issues,
      allVerdicts: verdicts,
    };
  } catch (err) {
    console.error(`[answerVerifier] Verification call failed for ${sectionKey}:`, err.message);
    return { flagged: false, issues: [], allVerdicts: [], verifierError: err.message };
  }
}

module.exports = { verifySectionAnswers, ANSWER_BEARING_SECTIONS };