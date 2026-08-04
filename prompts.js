// prompts.js — all LLM prompts for the lesson generator
const SYSTEM_BASE = `You are an expert curriculum designer for Pakistani primary school mathematics (Grades 3–6).
You write clear, engaging, age-appropriate content that follows NCP 2022 and SNC 2020 guidelines.
You always respond with well-structured, complete text — never truncate or summarise.
You never say "I will now write..." — just write the content directly.`;

// ─── Step 1: Structure generation ────────────────────────────────
function structurePrompt(slosText, grade) {
  const system = SYSTEM_BASE + `
When asked to plan a chapter, respond ONLY with a valid JSON object.
No markdown code fences, no explanation before or after — just the raw JSON.`;

  const user = `Grade: ${grade}

Here are the Student Learning Outcomes (SLOs) for a chapter:

${slosText}

Plan the chapter. Decide:
1. A chapter title and number
2. How many lessons (3–5 is ideal)
3. Which SLOs each lesson covers
4. A title for each lesson
5. A one-sentence description of each lesson

Return ONLY this JSON structure (no markdown, no explanation):
{
  "chapter": {
    "number": 1,
    "title": "Chapter title here",
    "grade": ${grade},
    "strand": "strand name",
    "overview": "One paragraph overview of the chapter"
  },
  "lessons": [
    {
      "number": 1,
      "title": "Lesson title",
      "description": "One sentence description",
      "slos": ["SLO code 1", "SLO code 2"],
      "slo_descriptions": ["Full text of SLO 1", "Full text of SLO 2"],
      "sections": ["Warm-Up", "Concept Building", "Examples", "Pop-Up Quiz", "Mental Maths", "Practice Questions", "Key Takeaways"]
    }
  ]
}`;

  return { system, user };
}

// Helper to format retrieved context
function formatContext(contextChunks) {
  if (!contextChunks || !contextChunks.length) return '';
  return `\nGROUNDING TEXTBOOK CONTEXT:\n` + 
    contextChunks.map((c, i) => `[Chunk ${i+1} from ${c.source} page ${c.page}]:\n${c.text}`).join('\n\n') +
    `\n\nCRITICAL RULE: Ground your mathematical explanations, terms, and values in the context above. Do not invent contradictory definitions or names. Use local Pakistani naming contexts (names, currency Rs, etc.) matching the textbook.\n`;
}

// ─── Step 2: Section generators ──────────────────────────────────

function warmUpPrompt(lesson, chapter, grade, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Warm-Up section for this lesson.
${formatContext(context)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
SLOs covered: ${lesson.slo_descriptions.join('; ')}

The Warm-Up should:
- Have a short friendly heading: "🌟 Warm-Up"
- Include 3 numbered questions that activate prior knowledge
- Be appropriate for Grade ${grade} students
- Connect to what students already know before introducing new content
- Use real-life Pakistani contexts (food, cricket, money, daily life)
- Questions should be answerable without the new lesson content

Write ONLY the warm-up content. Start directly with the questions. No preamble.`;

  return { system, user };
}

function conceptBuildingPrompt(lesson, chapter, grade, warmUpText, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Concept Building section for this lesson.
${formatContext(context)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
SLOs covered: ${lesson.slo_descriptions.join('; ')}

Warm-Up that was just taught:
${warmUpText}

The Concept Building section should:
- Start with a clear definition or key concept in bold
- Explain the concept step by step using simple Grade ${grade} language
- Include at least one visual description (e.g. "Draw a number line showing...") which will be used to generate a graphic.
- Use concrete examples before abstract rules
- Cover ALL the SLOs listed above thoroughly
- Be comprehensive — this is the main teaching section
- Include sub-sections with h4 headings if multiple concepts are covered
- Use Pakistani real-life contexts where relevant

Write ONLY the concept building content. Start directly with the content.`;

  return { system, user };
}

function examplesPrompt(lesson, chapter, grade, conceptText, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write 3–4 worked Examples for this lesson.
${formatContext(context)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
SLOs: ${lesson.slo_descriptions.join('; ')}

Concept just taught:
${conceptText.slice(0, 800)}...

Each example should:
- Be labelled "Example 1", "Example 2", etc.
- Show a clear question
- Show step-by-step working (Step 1:, Step 2:, etc.)
- Show the final answer clearly labelled "Answer:"
- Progress from easier to harder
- Cover different aspects of the SLOs
- Use Grade ${grade} appropriate numbers and contexts

Write ONLY the worked examples. No introduction sentence needed.`;

  return { system, user };
}

function popUpQuizPrompt(lesson, chapter, grade, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Pop-Up Quiz section for this lesson.
${formatContext(context)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
SLOs: ${lesson.slo_descriptions.join('; ')}

The Pop-Up Quiz should:
- Start with heading "✏️ Pop-Up Quiz"
- Have Part A: Fill in the blanks (4 questions)
- Have Part B: Multiple Choice Questions (4 questions, each with options a, b, c, d)
- Test understanding of the concepts just taught
- Be appropriate for Grade ${grade}
- MCQ options should include one correct answer and three plausible distractors

Write ONLY the quiz content.`;

  return { system, user };
}

function mentalMathsPrompt(lesson, chapter, grade, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Mental Maths section for this lesson.
${formatContext(context)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
SLOs: ${lesson.slo_descriptions.join('; ')}

The Mental Maths section should:
- Start with heading "🧠 Mental Maths"
- Include 5–6 quick questions
- Be solvable without writing (mental calculation only)
- Progress from simple to slightly challenging
- Directly relate to the lesson content
- Be appropriate for Grade ${grade}

Write ONLY the mental maths questions. No introduction needed.`;

  return { system, user };
}

function practiceQuestionsPrompt(lesson, chapter, grade, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Practice Questions section for this lesson.
${formatContext(context)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
SLOs: ${lesson.slo_descriptions.join('; ')}

The Practice Questions should:
- Start with heading "📝 Practice Questions"
- Have Part A: Straightforward skill practice (4–5 questions)
- Have Part B: Applied/contextual questions (3–4 questions using Pakistani contexts)
- Have Part C: Real-Life Thinking — 2 word problems that require multi-step thinking
- Cover all SLOs taught in this lesson
- Include a mix of difficulty levels
- Word problems should use real Pakistani contexts (names, currency, food, cricket etc.)

Write ONLY the practice questions. No introduction needed.`;

  return { system, user };
}

function keyTakeawaysPrompt(lesson, chapter, grade, allSections, context = []) {
  const system = SYSTEM_BASE;
  const user = `Write the Key Takeaways section for this lesson.
${formatContext(context)}
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
SLOs covered: ${lesson.slo_descriptions.join('; ')}

The Key Takeaways should:
- Start with heading "⭐ Key Takeaways"
- Have 5–7 bullet points
- Summarise the most important concepts from this lesson
- Be written as clear, memorable statements
- Cover every SLO that was taught
- Use simple Grade ${grade} language

Write ONLY the key takeaways bullet points.`;

  return { system, user };
}

// ─── Stage 4: Supporting Artifacts ───────────────────────────────

function videoScriptPrompt(lesson, chapter, grade) {
  const system = SYSTEM_BASE;
  const user = `Write a 10-scene educational Video Script based on this lesson.
  
Chapter: ${chapter.title} (Grade ${grade})
Lesson ${lesson.number}: ${lesson.title}
SLOs: ${lesson.slo_descriptions.join('; ')}

The script must have two recurring characters:
1. **Amina**: The teacher/guide who explains concepts.
2. **Zahid**: A curious Grade ${grade} student who asks practical questions.

Structure the script precisely as a 10-scene sequence. For each scene, include:
- **Scene Number and Description** (e.g. Scene 1: Amina stands at a whiteboard...)
- **Visual**: A description of what is visible on the screen.
- **Dialogue**: The spoken words for Amina and Zahid.
- **Narration**: Any voiceover or sound effects.

Keep the tone highly engaging, conversational, and age-appropriate. Explain the core math concepts from the lesson.`;

  return { system, user };
}

function unitAssessmentPrompt(chapter, grade, lessons) {
  const system = SYSTEM_BASE;
  
  const lessonsSummaries = lessons.map(l => 
    `Lesson ${l.number}: ${l.title} (SLOs: ${l.slo_descriptions.join(', ')})`
  ).join('\n');

  const user = `Write a comprehensive Unit Assessment covering the entire chapter.

Chapter: ${chapter.title} (Grade ${grade})
Strand: ${chapter.strand || 'Mathematics'}

Here are the lessons and SLOs covered in this unit:
${lessonsSummaries}

The Unit Assessment must contain:
1. **Section A: Multiple Choice Questions** (6 questions, each with 4 options and a clear correct answer)
2. **Section B: Short-Answer Questions** (6 questions testing conceptual understanding across all lessons)
3. **Section C: Word Problems / Applied Math** (4 word problems involving multi-step thinking using Pakistani contexts)
4. **Detailed Answer Key**: Include correct answers and brief explanations/workings for every question in Sections A, B, and C.

Write the assessment content directly. Start with the title "📝 Unit Assessment: ${chapter.title}".`;

  return { system, user };
}

module.exports = {
  structurePrompt,
  warmUpPrompt,
  conceptBuildingPrompt,
  examplesPrompt,
  popUpQuizPrompt,
  mentalMathsPrompt,
  practiceQuestionsPrompt,
  keyTakeawaysPrompt,
  videoScriptPrompt,
  unitAssessmentPrompt,
};