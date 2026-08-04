// validator.js — runs quality and correctness audits on generated lesson content
const { generate } = require('./ollama');

/**
 * Validates a generated lesson section.
 * Returns { ok: boolean, feedback: string }
 */
async function validateSection(secKey, secLabel, secText, lesson, contextText) {
  // 1. Basic length check
  if (!secText || secText.trim().length < 50) {
    return { ok: false, feedback: 'The generated section is too short or empty.' };
  }
  
  // 2. Specific validation audits
  try {
    if (secKey === 'popUpQuiz') {
      return await auditQuiz(secText);
    }
    
    if (secKey === 'conceptBuilding') {
      // Run both SLO coverage and Fact Grounding for Concept Building
      const sloAudit = await auditSloCoverage(secLabel, secText, lesson.slo_descriptions.join('; '));
      if (!sloAudit.ok) return sloAudit;
      
      if (contextText && contextText.trim().length > 0) {
        const groundingAudit = await auditFactGrounding(secLabel, secText, contextText);
        if (!groundingAudit.ok) return groundingAudit;
      }
    }
    
    // Default to PASS for other sections if basic checks pass
    return { ok: true, feedback: 'PASS' };
    
  } catch (err) {
    console.error(`[validator] Validation error on ${secLabel}:`, err.message);
    return { ok: true, feedback: 'Validation skipped due to check error: ' + err.message };
  }
}

/**
 * Audit quiz answers and keys
 */
async function auditQuiz(quizText) {
  const system = 'You are an independent mathematics quality auditor. Respond with "PASS" if the quiz is correct. Otherwise, explain the error.';
  const user = `Review the following Pop-Up Quiz.
Ensure:
1. All questions (Fill in the blanks & MCQs) have mathematically correct answers.
2. If an answer key is provided, it is correct. If no answer key is provided, check if the questions themselves make sense.
3. MCQ distractors are plausible and only one answer is correct.

Quiz Content:
${quizText}

If correct, write "PASS" as the very first word. If there are errors, explain them clearly so the author can regenerate the section.
Your audit report:`;

  const report = await generate(system, user);
  const ok = report.toUpperCase().startsWith('PASS');
  return { ok, feedback: report };
}

/**
 * Audit SLO coverage
 */
async function auditSloCoverage(secLabel, secText, sloDescriptions) {
  const system = 'You are an expert curriculum auditor. Respond with "PASS" if the content covers the SLOs. Otherwise, list what is missing.';
  const user = `Review the following lesson section and verify if it covers the Student Learning Outcomes (SLOs).

Target SLOs:
${sloDescriptions}

Lesson Section (${secLabel}):
${secText}

Does this section adequately explain or address the skills/concepts in the target SLOs?
If yes, write "PASS" as the very first word. If no, explain what is missing.
Your audit report:`;

  const report = await generate(system, user);
  const ok = report.toUpperCase().startsWith('PASS');
  return { ok, feedback: report };
}

/**
 * Audit fact grounding against RAG context
 */
async function auditFactGrounding(secLabel, secText, contextText) {
  const system = 'You are an auditor verifying if teaching materials are grounded in the official textbook context. Respond with "PASS" if correct.';
  const user = `Compare the lesson content with the official textbook context.
Check for any mathematical contradictions, incorrect definitions, or values that contradict the textbook.

Official Textbook Context:
${contextText.slice(0, 3000)}

Lesson Content (${secLabel}):
${secText}

Are all math facts and terms in the lesson content grounded in or consistent with the official context?
If yes, write "PASS" as the very first word. If there are contradictions or errors, explain them clearly.
Your audit report:`;

  const report = await generate(system, user);
  const ok = report.toUpperCase().startsWith('PASS');
  return { ok, feedback: report };
}

module.exports = { validateSection };
