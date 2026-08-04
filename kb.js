// kb.js — interface to the Python ChromaDB knowledge base
const { spawn } = require('child_process');
const path = require('path');

const PYTHON_PATH = 'C:\\Users\\hashi\\anaconda3\\envs\\ai_env\\python.exe';
const QUERY_SCRIPT_PATH = path.join(__dirname, 'query_kb.py');

/**
 * Queries the textbook vector database.
 * Falls back to empty array if query fails or knowledge base doesn't exist.
 */
async function queryKnowledgeBase(query, grade, subject = 'Mathematics', limit = 3) {
  return new Promise((resolve) => {
    console.log(`[kb] Querying knowledge base: "${query}" (Grade ${grade}, ${subject})...`);
    
    const args = [
      QUERY_SCRIPT_PATH,
      '--query', query,
      '--grade', grade,
      '--subject', subject,
      '--limit', limit
    ];
    
    const py = spawn(PYTHON_PATH, args);
    let stdout = '';
    let stderr = '';
    
    py.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    py.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    py.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[kb] Python query exited with code ${code}. Stderr: ${stderr.trim()}`);
        return resolve([]);
      }
      
      try {
        const json = JSON.parse(stdout.trim());
        if (json.error) {
          console.warn(`[kb] Error returned from query script: ${json.error}`);
          return resolve([]);
        }
        console.log(`[kb] Retrieved ${json.length} relevant chunks.`);
        resolve(json);
      } catch (err) {
        console.warn(`[kb] Failed to parse JSON output. Raw output was:\n${stdout.trim()}`);
        resolve([]);
      }
    });
  });
}

module.exports = { queryKnowledgeBase };
