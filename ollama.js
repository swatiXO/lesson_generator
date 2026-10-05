// ollama.js — thin wrapper around Ollama's REST API (Colab/ngrok version)
require('./env');
const https = require('https');

// Host printed by the Colab notebook, e.g. "abcd1234.ngrok-free.app" — no https://, no trailing slash.
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'professor-nacho-renewed.ngrok-free.dev';
const OLLAMA_PORT = 443;
const MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b';

// Optional smaller model for cheap extraction tasks (image search queries etc.),
// e.g. `ollama pull qwen2.5:3b`. Falls back to MODEL.
const FAST_MODEL = process.env.OLLAMA_FAST_MODEL || MODEL;

// Ollama's default 5m unloads the model between text calls while images render.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';

const DEFAULT_NUM_CTX = 8192;

// Abort a call if the stream goes silent this long (dead tunnel, hung Colab).
const IDLE_TIMEOUT_MS = Number(process.env.OLLAMA_IDLE_TIMEOUT_MS) || 5 * 60 * 1000;

// Reuse TLS connections across calls — each new one pays the ngrok handshake.
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

const BASE_HEADERS = {
  // Skips ngrok's free-tier browser interstitial.
  'ngrok-skip-browser-warning': 'true',
};

/**
 * Call Ollama with a prompt. Returns the full response text.
 * onToken(chunk) is called for each streamed token if provided.
 *
 * opts (all optional): model, num_ctx, keep_alive, temperature, top_p, repeat_penalty
 */
async function generate(systemPrompt, userPrompt, onToken = null, opts = {}) {
  const model = opts.model || MODEL;
  const body = JSON.stringify({
    model,
    stream: true,
    keep_alive: opts.keep_alive || KEEP_ALIVE,
    options: {
      temperature: opts.temperature ?? 0.4,
      top_p: opts.top_p ?? 0.9,
      num_ctx: opts.num_ctx ?? DEFAULT_NUM_CTX,
      repeat_penalty: opts.repeat_penalty ?? 1.1,
    },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  });

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const req = https.request(
      {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        agent,
        headers: {
          ...BASE_HEADERS,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          // An offline tunnel returns an HTML error page; without this check it
          // would parse as zero tokens and resolve to an empty "section".
          let errBody = '';
          res.on('data', c => { errBody += c; });
          res.on('end', () => reject(new Error(
            `Ollama returned HTTP ${res.statusCode} from ${OLLAMA_HOST}: ${errBody.slice(0, 200).trim()}`)));
          return;
        }

        let full = '';
        let buffer = '';
        let streamError = null;

        const handleLine = (line) => {
          if (!line.trim()) return;
          let json;
          try {
            json = JSON.parse(line);
          } catch (err) {
            console.error('[ollama] Failed to parse line:', line, err.message);
            return;
          }
          if (json.error) streamError = json.error;
          if (json.message?.content) {
            full += json.message.content;
            if (onToken) onToken(json.message.content);
          }
        };

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // last element may be an incomplete line
          lines.forEach(handleLine);
        });
        res.on('end', () => {
          handleLine(buffer);
          if (streamError && !full) return reject(new Error(`Ollama error: ${streamError}`));
          console.log(`[ollama] ${model} responded in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
          resolve(full.trim());
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Ollama stream idle for ${IDLE_TIMEOUT_MS / 1000}s — aborting (is the Colab tunnel still up?)`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * For cheap/short tasks. Uses FAST_MODEL with a small context window — but only
 * when FAST_MODEL is a different model: changing num_ctx on the already-loaded
 * main model makes Ollama reload it, which costs far more than it saves.
 */
async function generateFast(systemPrompt, userPrompt, opts = {}) {
  const separateModel = FAST_MODEL !== MODEL;
  return generate(systemPrompt, userPrompt, null, {
    model: FAST_MODEL,
    ...(separateModel ? { num_ctx: 1024 } : {}),
    ...opts,
  });
}

/**
 * Health check — confirms Ollama is reachable and MODEL is available.
 */
async function ping() {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags', method: 'GET', agent, headers: BASE_HEADERS },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, host: OLLAMA_HOST });
          try {
            const models = JSON.parse(data).models?.map(m => m.name) || [];
            const found = models.some(m => m.startsWith(MODEL));
            const fastFound = models.some(m => m.startsWith(FAST_MODEL));
            resolve({ ok: true, found, fastFound, models, model: MODEL, fastModel: FAST_MODEL, host: OLLAMA_HOST });
          } catch {
            resolve({ ok: false, host: OLLAMA_HOST });
          }
        });
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, host: OLLAMA_HOST }));
    req.end();
  });
}

module.exports = { generate, generateFast, ping, MODEL, FAST_MODEL, OLLAMA_HOST };
