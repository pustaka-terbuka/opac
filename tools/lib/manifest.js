import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

export function loadManifest(filePath) {
  let content = null;
  if (filePath.endsWith('.gz') && fs.existsSync(filePath)) {
    try { content = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8'); } catch {}
  } else if (fs.existsSync(filePath)) {
    try { content = fs.readFileSync(filePath, 'utf8'); } catch {}
  } else if (fs.existsSync(filePath + '.gz')) {
    try { content = zlib.gunzipSync(fs.readFileSync(filePath + '.gz')).toString('utf8'); } catch {}
  }

  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error loading manifest ${filePath}:`, err.message);
    return {};
  }
}

export function saveManifest(filePath, manifest) {
  // Sort keys
  const sortedKeys = Object.keys(manifest).sort();
  const sortedManifest = {};
  for (const key of sortedKeys) {
    sortedManifest[key] = manifest[key];
  }
  
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const content = JSON.stringify(sortedManifest) + '\n';
  const byteLen = Buffer.byteLength(content, 'utf8');
  const useGz = filePath.endsWith('.gz') || byteLen > 50 * 1024 * 1024;
  const targetPath = useGz ? (filePath.endsWith('.gz') ? filePath : filePath + '.gz') : filePath;
  const dataToWrite = useGz ? zlib.gzipSync(Buffer.from(content, 'utf8')) : content;

  let saved = false;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(targetPath, dataToWrite);
      if (useGz && !filePath.endsWith('.gz') && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
      saved = true;
      break;
    } catch (err) {
      lastErr = err;
      const start = Date.now();
      while (Date.now() - start < 150) {}
    }
  }
  if (!saved && lastErr) {
    throw lastErr;
  }
}

export function hasChanged(manifest, recordId, hash) {
  return manifest[recordId] !== hash;
}
