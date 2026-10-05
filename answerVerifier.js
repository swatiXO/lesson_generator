// answerVerifier.js — independent answer-correctness verification.
//
// A separate LLM call solves every question in a section from scratch BEFORE
// comparing with the stated answer — showing the stated answer first would let
// the model anchor on it and rationalize agreement. The value is independence
// (a fresh reasoning pass), not determinism. One call per section, batched
// across its questions.
//
// server.js runs this inside the generation retry loop: a flagged answer is fed
// back into the next attempt like a validation failure, and only answers still
// flagged after every attempt ship with a review note.
const { generate } = require('./ollama');
const { answerVerificationPrompt } = require('./prompts');
const { SECTIONS } = require('./sections');

// Sections that carry an answer key. warmUp's key is optional; a section with
// nothing to check just returns an empty, unflagged result.
const ANSWER_BEARING_SECTIONS = new Set([
  SECTIONS.WARM_UP,
  SECTIONS.CONCEPT_BUILDING,   // each Part's Your Turn + Warm-Up box
  SECTIONS.MENTAL_MATHS,
  SECTIONS.YOUR_TURN_FULL,
  SECTIONS.PRACTICE_QUESTIONS, // Parts A-D, Word Problem, Challenge, Answer Key
]);

/**
 * Runs the independent verification pass against one section's text.
 * Never throws: a verifier failure (model error, bad JSON) returns an
 * unflagged result with `verifierError` set — a broken check is not the same
 * as a confirmed wrong answer and must not block the lesson.
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

    const cleaned = raw
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
