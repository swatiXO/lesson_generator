// test_pipeline.js — developer utility to test each stage of the lesson plan generator
const path = require('path');
const fs = require('fs');
const { queryKnowledgeBase } = require('./kb');
const { generateImageForSection } = require('./imageGenerator');
const { buildSlides } = require('./slidesGenerator');
const { buildLessonPdf } = require('./pdfRenderer');

async function testQuery() {
  console.log('\n--- Testing RAG Query ---');
  try {
    const results = await queryKnowledgeBase('fractions', 4, 'Mathematics', 2);
    console.log('Query results:', JSON.stringify(results, null, 2));
  } catch (err) {
    console.error('Query test failed:', err);
  }
}

async function testImageGen() {
  console.log('\n--- Testing Image/Diagram Generator ---');
  try {
    const sectionName = 'Concept Building';
    const sectionContent = 'In this lesson, we will learn about number lines. Draw a horizontal straight line with numbers marked at equal intervals, starting from 0, 1, 2, 3, 4, 5. Each section represents one unit.';
    const imgUrl = await generateImageForSection(sectionName, sectionContent, 4, 'Mathematics', true);
    console.log('Generated image path:', imgUrl);
  } catch (err) {
    console.error('Image generation test failed:', err);
  }
}

async function testSlides() {
  console.log('\n--- Testing Slides Generator ---');
  const lesson = {
    number: 1,
    title: 'Understanding Fractions',
    description: 'Learn the definition of fractions, numerator, and denominator.',
    grade: 4,
    slos: ['M-04-A-19'],
    slo_descriptions: ['Differentiate among proper fractions, improper fractions and mixed numbers.']
  };
  
  const sections = {
    warmUp: '🌟 Warm-Up\n1. What is half of an apple?\n2. Share 4 rotis between 2 children.\n3. Show half using a shape.',
    conceptBuilding: '📖 Concept Building\nA fraction represents a part of a whole.\n- Numerator: top number\n- Denominator: bottom number',
    keyTakeaways: '⭐ Key Takeaways\n- A fraction is a part of a whole.\n- The denominator cannot be zero.'
  };
  
  try {
    const buffer = await buildSlides(lesson, sections, {});
    const dest = path.join(__dirname, 'test_output.pptx');
    fs.writeFileSync(dest, buffer);
    console.log('Slides saved to:', dest);
  } catch (err) {
    console.error('Slides test failed:', err);
  }
}

async function testPdf() {
  console.log('\n--- Testing PDF Renderer ---');
  const structure = {
    chapter: { number: 1, title: 'Fractions', grade: 4, strand: 'Numbers', overview: 'This chapter teaches fractions.' },
    lessons: [{
      number: 1,
      title: 'Understanding Fractions',
      description: 'Introduction to numerator and denominator.',
      slos: ['M-04-A-19'],
      slo_descriptions: ['Proper and improper fractions.']
    }]
  };
  
  const generatedSections = {
    0: {
      warmUp: '🌟 Warm-Up\n1. Share 2 biscuits.',
      conceptBuilding: '📖 Concept Building\nA fraction is part of a whole.',
      keyTakeaways: '⭐ Key Takeaways\n• Learn numerator.'
    }
  };
  
  try {
    const dest = path.join(__dirname, 'test_output.pdf');
    await buildLessonPdf(structure, generatedSections, {}, dest);
    console.log('PDF saved to:', dest);
  } catch (err) {
    console.error('PDF test failed:', err);
  }
}

async function runAll() {
  const args = process.argv.slice(2);
  const stage = args[0] ? args[0].replace('--stage=', '') : 'all';
  
  console.log(`[*] Starting tests for stage: ${stage}...`);
  
  if (stage === 'query' || stage === 'all') await testQuery();
  if (stage === 'images' || stage === 'all') await testImageGen();
  if (stage === 'slides' || stage === 'all') await testSlides();
  if (stage === 'render' || stage === 'all') await testPdf();
  
  console.log('\n[*] Tests finished.');
}

runAll();
