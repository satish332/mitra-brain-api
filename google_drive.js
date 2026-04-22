const https = require('https');

const DRIVE_FILE_IDS = {
  'MEMORY.md':      '1U1UAoKxTMu6IIN9dp8WNKth1tc4J4Nmh',
  'IN_PROGRESS.md': '1sakp2bRmmWW-WnKBU5nZDV3PvyEkWnMO',
  'DECISIONS.md':   '1o-2OdmjWm8j3sg_RFQI-Ohc8kbowdYXU'
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode));
        } else {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function fetchDriveMemory() {
  try {
    const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
    if (!apiKey) return '';
    const parts = await Promise.all(
      Object.entries(DRIVE_FILE_IDS).map(async ([name, id]) => {
        const url = 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media&key=' + apiKey;
        const content = await httpsGet(url);
        return '\n\n=== ' + name + ' (live) ===\n' + content;
      })
    );
    const result = parts.join('');
    if (result) console.log('[DriveMemory] Loaded ' + result.length + ' chars');
    return result;
  } catch (e) {
    console.error('[DriveMemory] Error: ' + e.message);
    return '';
  }
}

module.exports = { fetchDriveMemory };
