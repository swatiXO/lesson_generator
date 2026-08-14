// test_ddg_api.js — test script for zero-key JSON-based DuckDuckGo Image Search
const https = require('https');

function getVqd(query, callback) {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };

  https.get(url, options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      // Look for the vqd token in the response text using regex
      // Usually looks like: vqd="3-123456789..." or vqd='3-123456789...'
      const match = data.match(/vqd=["']?([0-9a-zA-Z-]+)["']?/);
      if (match && match[1]) {
        callback(null, match[1]);
      } else {
        callback(new Error('Failed to find vqd token in response.'));
      }
    });
  }).on('error', (err) => {
    callback(err);
  });
}

function searchImages(query, vqd) {
  // Query DuckDuckGo's internal JSON API
  const url = `https://duckduckgo.com/d.js?q=${encodeURIComponent(query)}&vqd=${vqd}&s=0&o=json&api=d.js`;
  
  console.log(`[+] Found VQD token: ${vqd}`);
  console.log(`[*] Querying DDG JSON API: ${url}\n`);

  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://duckduckgo.com/'
    }
  };

  https.get(url, options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        
        if (!json.results || !json.results.length) {
          console.log('[-] No results found.');
          return;
        }
        
        console.log(`[+] Found ${json.results.length} images:\n`);
        
        // Show top 5 results
        json.results.slice(0, 5).forEach((result, idx) => {
          console.log(`[Result ${idx + 1}]`);
          console.log(`- Title:  ${result.title}`);
          console.log(`- URL:    ${result.image}`);
          console.log(`- Source: ${result.url}`);
          console.log('---');
        });
      } catch (err) {
        console.error('[!] Failed to parse JSON response:', err.message);
        console.log('[!] Raw data was:', data.slice(0, 1000));
      }
    });
  }).on('error', (err) => {
    console.error('[!] HTTP request failed:', err.message);
  });
}

const query = process.argv.slice(2).join(' ') || 'place value chart';
console.log(`[*] Initializing DuckDuckGo search for: "${query}"`);

getVqd(query, (err, vqd) => {
  if (err) {
    console.error('[!] Failed to retrieve VQD token:', err.message);
    return;
  }
  searchImages(query, vqd);
});
