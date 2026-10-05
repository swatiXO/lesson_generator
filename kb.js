// kb.js — interface to the Python ChromaDB knowledge base
const { spawn } = require('child_process');
const path = require('path');

require('./env');

// Set PYTHON_PATH in .env to an interpreter with chromadb installed.
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';
const QUERY_SCRIPT_PATH = path.join(__dirname, 'query_kb.py');

/**
 * Queries the textbook vector database.
 * Falls back to empty array if query fails or knowledge base doesn't exist.
 */
async function queryKnowledgeBase(query, grade, subject = 'Mathematics', limit = 3) {
  return new Promise((resolve) => {
    console.log(`[kb] Querying knowledge base: "${query}" (Grade ${grade}, ${subject}, limit ${limit})...`);

    // [FIX] child_process.spawn expects every element of `args` to be a
    // string. `grade` and `limit` were previously passed through as raw
    // numbers (e.g. from currentJob.grade, which is parseInt'd in server.js).
    // Coerce explicitly with String() so this never depends on Node-version-
    // specific implicit coercion behavior.
    const args = [
      QUERY_SCRIPT_PATH,
      '--query', query,
      '--grade', String(grade),
      '--subject', subject,
      '--limit', String(limit)
    ];

    console.log(`[kb] Spawning: ${PYTHON_PATH} ${args.join(' ')}`);

    const py = spawn(PYTHON_PATH, args);
    let stdout = '';
    let stderr = '';

    py.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    py.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    py.on('error', (err) => {
      // Fires if the python executable itself can't be spawned at all
      // (wrong PYTHON_PATH, permissions, etc.) — distinct from the process
      // starting and exiting with a non-zero code, which is handled below.
      console.warn(`[kb] Failed to spawn Python process: ${err.message}`);
      resolve([]);
    });

    py.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[kb] Python query exited with code ${code}. Stderr: ${stderr.trim()}`);
        return resolve([]);
      }

      // [FIX] Surface stderr even on a successful (code 0) exit — some
      // Python warnings (e.g. deprecation notices from chromadb) print to
      // stderr without causing a non-zero exit code, and silently dropping
      // them makes it harder to notice when something is subtly wrong.
      if (stderr.trim()) {
        console.warn(`[kb] Python process exited 0 but wrote to stderr: ${stderr.trim()}`);
      }

      try {
        const json = JSON.parse(stdout.trim());
        if (json.error) {
          console.warn(`[kb] Error returned from query script: ${json.error}`);
          return resolve([]);
        }

        // [FIX] Log which grade(s) actually came back in the results, not
        // just the count. If you query grade 4 and this shows chunks tagged
        // grade 6 (or a mix), that's a direct, visible sign the --grade
        // filter inside query_kb.py isn't actually being applied — much
        // easier to catch than silently trusting the requested grade was
        // honored just because a result array came back.
        const returnedGrades = Array.isArray(json)
          ? [...new Set(json.map(c => c.grade).filter(g => g !== undefined))]
          : [];
        console.log(`[kb] Retrieved ${Array.isArray(json) ? json.length : 0} relevant chunk(s). ` +
          `Requested grade: ${grade}. Grade(s) actually present in results: ${returnedGrades.length ? returnedGrades.join(', ') : '(none tagged)'}`);

        resolve(json);
      } catch (err) {
        console.warn(`[kb] Failed to parse JSON output. Raw output was:\n${stdout.trim()}`);
        resolve([]);
      }
    });
  });
}

module.exports = { queryKnowledgeBase };