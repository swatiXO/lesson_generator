// sections.js — single source of truth for section keys used across the
// pipeline (server.js's sectionDefs, DocBuilder.js's box/title rendering,
// answerVerifier.js's ANSWER_BEARING_SECTIONS, validator.js's
// AUDITED_SECTIONS and its quiz-audit routing).
//
// WHY THIS EXISTS: before this file, every one of the four files above
// retyped these as raw string literals independently. That's exactly how
// validator.js's arithmetic-audit routing went silently dead during the v7
// rename — 'popUpQuiz' was renamed to 'yourTurnFull' in server.js and
// prompts.js, but validator.js's `if (secKey === 'popUpQuiz')` branch was
// never touched, and nothing (no lint rule, no runtime error, no test)
// could catch that, because a string comparison that stops matching just
// looks like "this section always passes validation now" — not an error.
//
// Import SECTIONS everywhere a section key is compared, keyed, or switched
// on, instead of typing the string again. A future rename becomes "change
// it here" instead of "grep every file and hope you found every callsite."
'use strict';

const SECTIONS = Object.freeze({
  INTRODUCTION: 'introduction',
  WARM_UP: 'warmUp',
  CONCEPT_BUILDING: 'conceptBuilding',
  MENTAL_MATHS: 'mentalMaths',
  YOUR_TURN_FULL: 'yourTurnFull',
  PRACTICE_QUESTIONS: 'practiceQuestions',
  KEY_TAKEAWAYS: 'keyTakeaways',
});

// Human-facing labels, also centralized — server.js's sectionDefs and
// DocBuilder.js's sectionOrder each used to maintain their own copy of
// these strings too, with no guarantee they'd stay in sync with each other.
const SECTION_LABELS = Object.freeze({
  [SECTIONS.INTRODUCTION]: 'Introduction',
  [SECTIONS.WARM_UP]: 'Warm-Up Activity',
  [SECTIONS.CONCEPT_BUILDING]: 'Concept Building',
  [SECTIONS.MENTAL_MATHS]: 'Mental Maths',
  [SECTIONS.YOUR_TURN_FULL]: 'Your Turn',
  [SECTIONS.PRACTICE_QUESTIONS]: 'Practice Questions',
  [SECTIONS.KEY_TAKEAWAYS]: 'Key Takeaways',
});

module.exports = { SECTIONS, SECTION_LABELS };