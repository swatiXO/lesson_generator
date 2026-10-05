// env.js — loads .env from the project root into process.env.
// Require this first (server.js does) so every module sees the values,
// regardless of require order. Variables already set in the real
// environment win over .env, matching dotenv's behaviour.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!match) return;
    const key = match[1];
    let val = (match[2] || '').trim();
    if (val.length > 1 && val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') {
      val = val.substring(1, val.length - 1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  });
}

loadEnv();

module.exports = { loadEnv };
