// google_drive.js
// Fetches Mitra memory files from Google Drive using Service Account JWT auth.
// Uses ONLY Node.js built-in modules (https, crypto) — zero new npm packages.
// Graceful fallback: returns empty string if GOOGLE_SERVICE_ACCOUNT_JSON is not set.

const https = require('https');
const crypto = require('crypto');

const DRIVE_FILE_IDS = {
  'MEMORY.md':      '1U1UAoKxTMu6IIN9dp8WNKth1tc4J4Nmh',
  'IN_PROGRESS.md': '1sakp2bRmmWW-WnKBU5nZDV3PvyEkWnMO',
  'DECISIONS.md':   '1o-2OdmjWm8j3sg_RFQI-Ohc8kbowdYXU'
};

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error('HTTP ' + res.statusCode + ': ' + data.substring(0, 200)));
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Drive fetch timeout')); });
  });
}

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers || {})
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error('HTTP ' + res.statusCode + ': ' + data.substring(0, 200)));
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Token request timeout')); });
    req.write(body);
    req.end();
  });
}

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now
  }));
  const sigInput = header + '.' + payload;
  const signer = crypto.createSign('SHA256');
  signer.update(sigInput);
  const sig = signer.sign(sa.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const jwt = sigInput + '.' + sig;
  const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
  const resp = await httpsPost(
    'https://oauth2.googleapis.com/token',
    body,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  return JSON.parse(resp).access_token;
}

async function fetchDriveFile(fileId, token) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media';
  return httpsGet(url, { Authorization: 'Bearer ' + token });
}

async function fetchDriveMemory() {
  try {
    const jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!jsonStr) return '';

    const sa = JSON.parse(jsonStr);
    const token = await getAccessToken(sa);

    const parts = await Promise.all(
      Object.entries(DRIVE_FILE_IDS).map(async ([name, id]) => {
        try {
          const content = await fetchDriveFile(id, token);
          return '\n\n=== ' + name + ' (live from Google Drive) ===\n' + content;
        } catch (e) {
          console.error('[DriveMemory] Failed to fetch ' + name + ': ' + e.message);
          return '';
        }
      })
    );

    const result = parts.join('');
    if (result) console.log('[DriveMemory] Loaded ' + result.length + ' chars from Google Drive');
    return result;
  } catch (e) {
    console.error('[DriveMemory] Auth error: ' + e.message);
    return '';
  }
}

module.exports = { fetchDriveMemory };
