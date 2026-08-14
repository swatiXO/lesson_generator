const { generateFast } = require('./ollama');

async function test() {
  console.log('Testing generateFast...');
  try {
    const query = await generateFast('You are a query assistant.', 'Write a query for place value chart.');
    console.log('[+] Success! Generated Query:', query);
  } catch (err) {
    console.error('[!] Error during generateFast:', err.message);
    if (err.stack) console.error(err.stack);
  }
}
test();
