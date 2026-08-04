// ollama.js — thin wrapper around Ollama's REST API
const http = require('http');

const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;
const MODEL = 'qwen2.5:14b';

/**
 * Call Ollama with a prompt. Returns the full response text.
 * onToken(chunk) is called for each streamed token if provided.
 */
async function generate(systemPrompt, userPrompt, onToken = null) {
  const body = JSON.stringify({
    model: MODEL,
    stream: true,
    options: {
      temperature: 0.4,      // low temp = more consistent, structured output
      top_p: 0.9,
      num_ctx: 8192,         // 8k context per call — enough for one section
      repeat_penalty: 1.1,
    },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let full = '';
        res.on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const json = JSON.parse(line);
              if (json.message?.content) {
                full += json.message.content;
                if (onToken) onToken(json.message.content);
              }
            } catch (_) {}
          }
        });
        res.on('end', () => resolve(full.trim()));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Quick health check — confirms Ollama is running and model is available.
 */
async function ping() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags', method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const models = json.models?.map(m => m.name) || [];
            const found = models.some(m => m.startsWith('qwen2.5:14b'));
            resolve({ ok: true, found, models });
          } catch {
            resolve({ ok: false });
          }
        });
      }
    );
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
}

module.exports = { generate, ping, MODEL };