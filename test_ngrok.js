const https = require('https');

const host = process.env.OLLAMA_HOST || 'professor-nacho-renewed.ngrok-free.dev';

console.log(`Testing Ollama Host overriding Host header to localhost with servername SNI`);

const req = https.request({
  hostname: host,
  port: 443,
  path: '/api/tags',
  method: 'GET',
  servername: host, // Force SNI to use the ngrok host so TLS handshake passes
  rejectUnauthorized: false, // bypass verification
  headers: {
    'Host': 'localhost',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'ngrok-skip-browser-warning': 'true'
  }
}, (res) => {
  console.log(`[Response] Status Code: ${res.statusCode}`);
  console.log('[Response] Headers:', JSON.stringify(res.headers, null, 2));
  
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('[Response] Body (first 2000 chars):');
    console.log(data.slice(0, 2000));
  });
});

req.on('error', err => console.error('[Error] Request failed:', err.message));
req.end();