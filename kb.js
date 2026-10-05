// kb.js — interface to the Python ChromaDB knowledge base
const { spawn } = require('child_process');
const path = require('path');

require('./env');

// Set PYTHON_PATH in .env to an interpreter with chromadb installed.
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';
const QUERY_SCRIPT_PATH = path.join(__dirname, 'query_kb.py');

/**
 * Runs query_kb.py once for one or more queries. Starting Python and loading
 * chromadb + the embedding model dominates the cost of a query, so batching
 * several queries into one process is much cheaper than one process each.
 * Resolves to one result array per query; empty arrays on any failure.
 */
function runQueries(queries, grade, subject, limit) {
  const empty = () => queries.map(() => []);

  return new Promise((resolve) => {
    const args = [QUERY_SCRIPT_PATH];
    queries.forEach(q => args.push('--query', q));
    args.push('--grade', String(grade), '--subject', subject, '--limit', String(limit));

    console.log(`[kb] Querying knowledge base (${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}, ` +
      `Grade ${grade}, ${subject}, limit ${limit}):`, queries);

    const py = spawn(PYTHON_PATH, args, { cwd: __dirname });
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', (data) => { stdout += data.toString(); });
    py.stderr.on('data', (data) => { stderr += data.toString(); });

    py.on('error', (err) => {
      // The interpreter itself couldn't start (wrong PYTHON_PATH etc.)
      console.warn(`[kb] Failed to spawn Python process (${PYTHON_PATH}): ${err.message}`);
      resolve(empty());
    });

    py.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[kb] Python query exited with code ${code}. Stderr: ${stderr.trim()}`);
        return resolve(empty());
      }
      // chromadb prints deprecation warnings to stderr without failing
      if (stderr.trim()) console.warn(`[kb] Python process exited 0 but wrote to stderr: ${stderr.trim()}`);

      let json;
      try {
        json = JSON.parse(stdout.trim());
      } catch (err) {
        console.warn(`[kb] Failed to parse JSON output. Raw output was:\n${stdout.trim()}`);
        return resolve(empty());
      }
      if (json.error) {
        console.warn(`[kb] Error returned from query script: ${json.error}`);
        return resolve(empty());
      }

      const perQuery = queries.length === 1 ? [json] : json;
      const all = perQuery.flat();
      // Logging the grades actually returned makes a broken --grade filter visible.
      const returnedGrades = [...new Set(all.map(c => c.grade).filter(g => g !== undefined))];
      console.log(`[kb] Retrieved ${all.length} chunk(s). Requested grade: ${grade}. ` +
        `Grade(s) present in results: ${returnedGrades.length ? returnedGrades.join(', ') : '(none tagged)'}`);
      resolve(perQuery.map(r => (Array.isArray(r) ? r : [])));
    });
  });
}

/**
 * Queries the textbook vector database.
 * Falls back to an empty array if the query fails or the knowledge base doesn't exist.
 */
async function queryKnowledgeBase(query, grade, subject = 'Mathematics', limit = 3) {
  const [results] = await runQueries([query], grade, subject, limit);
  return results;
}

/**
 * Same as queryKnowledgeBase for several queries at once, in one Python process.
 * Returns one result array per query, in order.
 */
async function queryKnowledgeBaseBatch(queries, grade, subject = 'Mathematics', limit = 3) {
  if (!queries.length) return [];
  return runQueries(queries, grade, subject, limit);
}

module.exports = { queryKnowledgeBase, queryKnowledgeBaseBatch };
