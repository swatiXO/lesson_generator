// ollama.js — thin wrapper around Ollama's REST API (Colab/ngrok version)
const https = require('https');

// Paste the ngrok URL printed by the Colab notebook, e.g. "abcd1234.ngrok-free.app"
// No "https://" prefix, no trailing slash.
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'professor-nacho-renewed.ngrok-free.dev';
const OLLAMA_PORT = 443;
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:27b';

// A much smaller/faster model for trivial extraction tasks (image search
// queries, short classification, etc.) that don't need the full 27B model's
// reasoning depth. Pull one in your Colab notebook, e.g.:
//   !ollama pull qwen2.5:3b
// or
//   !ollama pull llama3.2:3b
// and set OLLAMA_FAST_MODEL, or just pass { model: 'qwen2.5:3b' } per-call.
// Falls back to MODEL if unset, so nothing breaks if you haven't pulled one yet.
const FAST_MODEL = process.env.OLLAMA_FAST_MODEL || 'qwen2.5:3b';

// How long Ollama keeps a model loaded in VRAM after a request with no new
// requests coming in. Ollama's own default is 5 minutes ("5m") — too short
// for a multi-step pipeline where an image download/Puppeteer render/vision
// verification can easily take longer than that between two text calls,
// causing the 27B model to unload and pay a full reload on the next call.
// Bump this via env if 30m still isn't enough for your Colab session.
const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';

// Reuse TCP/TLS connections across calls instead of opening a fresh HTTPS
// connection (and paying the ngrok routing + TLS handshake cost) on every
// single request — you make 9+ of these per lesson.
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

/**
 * Call Ollama with a prompt. Returns the full response text.
 * onToken(chunk) is called for each streamed token if provided.
 *
 * opts (all optional):
 *   - model:       override MODEL for this call (use FAST_MODEL for cheap
 *                  extraction tasks like image queries — see imageGenerator.js)
 *   - num_ctx:     override the 8192 default. A short extraction task doesn't
 *                  need 8k of context; a smaller value prefills much faster.
 *   - keep_alive:  override KEEP_ALIVE for this call
 *   - temperature, top_p, repeat_penalty: override the defaults below
 */
async function generate(systemPrompt, userPrompt, onToken = null, opts = {}) {
  const body = JSON.stringify({
    model: opts.model || MODEL,
    stream: true,
    keep_alive: opts.keep_alive || KEEP_ALIVE,
    options: {
      temperature: opts.temperature ?? 0.4,      // low temp = more consistent, structured output
      top_p: opts.top_p ?? 0.9,
      num_ctx: opts.num_ctx ?? 8192,              // 8k context per call — enough for one section
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
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          // ngrok free tier shows an interstitial warning page to browsers;
          // this header tells it to skip that and pass the request straight through.
          'ngrok-skip-browser-warning': 'true',
        },
      },
      (res) => {
        let full = '';
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          // Last element may be an incomplete line — keep it in buffer for the next chunk.
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const json = JSON.parse(line);
              if (json.message?.content) {
                full += json.message.content;
                if (onToken) onToken(json.message.content);
              }
            } catch (err) {
              console.error('[ollama] Failed to parse line:', line, err.message);
            }
          }
        });
        res.on('end', () => {
          // Flush any trailing complete line left in the buffer.
          if (buffer.trim()) {
            try {
              const json = JSON.parse(buffer);
              if (json.message?.content) {
                full += json.message.content;
                if (onToken) onToken(json.message.content);
              }
            } catch (err) {
              console.error('[ollama] Failed to parse final line:', buffer, err.message);
            }
          }
          const ms = Date.now() - startedAt;
          console.log(`[ollama] ${opts.model || MODEL} responded in ${(ms / 1000).toFixed(1)}s`);
          resolve(full.trim());
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Convenience wrapper for cheap/short tasks (image search queries, short
 * classification, etc.) — uses FAST_MODEL and a much smaller context window
 * by default so it doesn't pay full 27B prefill/generation cost for a few
 * words of output. Falls back to MODEL automatically if you haven't set
 * OLLAMA_FAST_MODEL / pulled a smaller model yet.
 */
async function generateFast(systemPrompt, userPrompt, opts = {}) {
  return generate(systemPrompt, userPrompt, null, {
    model: FAST_MODEL,
    num_ctx: 1024,
    ...opts,
  });
}

/**
 * Quick health check — confirms the Colab-hosted Ollama is reachable and the active MODEL is available.
 */
async function ping() {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags', method: 'GET', agent,
        headers: { 'ngrok-skip-browser-warning': 'true' } },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const models = json.models?.map(m => m.name) || [];
            const found = models.some(m => m.startsWith(MODEL));
            const fastFound = models.some(m => m.startsWith(FAST_MODEL));
            resolve({ ok: true, found, fastFound, models, model: MODEL, fastModel: FAST_MODEL, host: OLLAMA_HOST });
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

module.exports = { generate, generateFast, ping, MODEL, FAST_MODEL, OLLAMA_HOST };