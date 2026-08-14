// test_wikimedia.js — test script to verify Wikimedia Commons API search
const https = require('https');

function searchWikimedia(query) {
  // Query MediaWiki search generator in the File namespace (6)
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&prop=imageinfo&iiprop=url|size&format=json&origin=*`;
  
  console.log(`[*] Querying Wikimedia Commons for: "${query}"`);
  console.log(`[*] Request URL: ${url}\n`);
  
  // Wikimedia Commons API requires a descriptive User-Agent header, otherwise it blocks requests.
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
        
        if (!json.query || !json.query.pages) {
          console.log('[-] No pages found in query response.');
          console.log('Raw JSON Response:', JSON.stringify(json, null, 2));
          return;
        }
        
        const pages = Object.values(json.query.pages);
        console.log(`[+] Found ${pages.length} search results:\n`);
        
        pages.forEach((page, idx) => {
          if (page.imageinfo && page.imageinfo[0]) {
            const info = page.imageinfo[0];
            console.log(`[Result ${idx + 1}]`);
            console.log(`- Page Title: ${page.title}`);
            console.log(`- Image URL:  ${info.url}`);
            console.log(`- Dimensions: ${info.width || 'unknown'}x${info.height || 'unknown'} px`);
            console.log(`- File Size:  ${(info.size / 1024).toFixed(1)} KB`);
            console.log('---');
          } else {
            console.log(`[Result ${idx + 1}] No image info for page: ${page.title}`);
            console.log('---');
          }
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
searchWikimedia(query);
