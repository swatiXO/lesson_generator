// test_openverse.js — test script to verify Openverse Creative Commons API search (zero-key)
const https = require('https');

function searchOpenverse(query) {
  // Query Openverse API
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}`;
  
  console.log(`[*] Querying Openverse API for: "${query}"`);
  console.log(`[*] Request URL: ${url}\n`);
  
  const options = {
    headers: {
      'User-Agent': 'LessonPlanGeneratorBot/1.0 (contact: support@mediatiz.com) Node.js/https'
    }
  };

  https.get(url, options, (res) => {
    console.log(`[+] Response Status Code: ${res.statusCode}`);
    
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        
        if (!json.results || !json.results.length) {
          console.log('[-] No results found.');
          console.log('Raw JSON Response:', JSON.stringify(json, null, 2));
          return;
        }
        
        console.log(`[+] Found ${json.results.length} search results:\n`);
        
        // Show top 5 results
        json.results.slice(0, 5).forEach((result, idx) => {
          console.log(`[Result ${idx + 1}]`);
          console.log(`- Title:      ${result.title}`);
          console.log(`- Image URL:  ${result.url}`);
          console.log(`- License:    ${result.license}`);
          console.log(`- Creator:    ${result.creator || 'unknown'}`);
          console.log('---');
        });
        
      } catch (err) {
        console.error('[!] Failed to parse JSON response:', err.message);
        console.log('[!] Raw response was:', data.slice(0, 1000));
      }
    });
  }).on('error', (err) => {
    console.error('[!] HTTP request failed:', err.message);
  });
}

const query = process.argv.slice(2).join(' ') || 'place value chart';
searchOpenverse(query);
