import https from 'https';

// Search for MITRA_BRIEFING.md by name — always picks most recently modified version
const DRIVE_FOLDER_ID = '1QxmSqP7TUpIi0O1RqbEZIQ1TcvI8pmt4';
const DRIVE_FILE_NAMES = ['MITRA_BRIEFING.md'];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        text: () => data
      }));
    }).on('error', reject);
  });
}

export async function fetchDriveMemory(apiKey) {
  const parts = [];
  for (const filename of DRIVE_FILE_NAMES) {
    try {
      const q = encodeURIComponent("name='" + filename + "' and '" + DRIVE_FOLDER_ID + "' in parents");
      const searchUrl = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&orderBy=modifiedTime+desc&pageSize=1&key=' + apiKey;
      const searchRes = await httpsGet(searchUrl);
      if (!searchRes.ok) { console.warn('Drive search failed for ' + filename); continue; }
      const searchData = JSON.parse(searchRes.text());
      const fileId = searchData.files && searchData.files[0] && searchData.files[0].id;
      if (!fileId) { console.warn('No Drive file found for: ' + filename); continue; }
      const fileUrl = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&key=' + apiKey;
      const res = await httpsGet(fileUrl);
      if (res.ok) { parts.push(res.text()); }
      else { console.warn('Drive fetch failed for ' + filename + ': ' + res.status); }
    } catch (err) {
      console.error('Error fetching ' + filename + ' from Drive:', err.message);
    }
  }
  return parts.join('\n\n');
}
