// sections.js — single source of truth for section keys and labels.
//
// Compare, key and switch on SECTIONS.* everywhere instead of retyping the
// string: a renamed key that some file still compares as a raw literal fails
// silently (the branch just stops matching), which has happened before.
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

// Display labels, in lesson order (DocBuilder.js and pdfRenderer.js iterate this).
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
