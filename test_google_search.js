// test_google_search.js — test script for Google Custom Search JSON API
const https = require('https');
const fs = require('fs');
const path = require('path');


require('./env');

function searchGoogleImages(query, apiKey, cx) {
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&searchType=image&key=${apiKey}&cx=${cx}&num=5`;
  
  console.log(`[*] Querying Google Custom Search API for: "${query}"`);
  console.log(`[*] Request URL: https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&searchType=image&key=...&cx=...\n`);

  https.get(url, (res) => {
    console.log(`[+] Response Status Code: ${res.statusCode}`);
    
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        
        if (json.error) {
          console.error('[!] Google API Error:', json.error.message);
          if (json.error.errors) {
            console.error('Details:', JSON.stringify(json.error.errors, null, 2));
          }
          return;
        }
        
        if (!json.items || !json.items.length) {
          console.log('[-] No image items found in search results.');
          return;
        }
        
        console.log(`[+] Found ${json.items.length} Google Custom Search results:\n`);
        
        json.items.forEach((item, idx) => {
          console.log(`[Result ${idx + 1}]`);
          console.log(`- Title:      ${item.title}`);
          console.log(`- Image URL:  ${item.link}`);
          console.log(`- Source:     ${item.image.contextLink}`);
          console.log(`- Dimensions: ${item.image.width}x${item.image.height}`);
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

// Check args or env
const args = process.argv.slice(2);
const query = args[0] || 'five digit place value diagram';

const apiKey = process.env.GOOGLE_API_KEY || '';
const cx = process.env.GOOGLE_CX || '';

if (!apiKey || !cx) {
  console.log('[-] Missing Google API configuration.');
  console.log('Please set GOOGLE_API_KEY and GOOGLE_CX in your .env file.');
  console.log('\nAlternative command line usage:');
  console.log('node test_google_search.js "query" <apiKey> <cx>');
  
  const argKey = args[1];
  const argCx = args[2];
  
  if (argKey && argCx) {
    searchGoogleImages(query, argKey, argCx);
  }
} else {
  searchGoogleImages(query, apiKey, cx);
}
