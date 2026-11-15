const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAllowedRoots } = require('./files');

const MAX_FILES_SCAN = 150_000;
const MIN_DUPLICATE_SIZE = 1024; // ignore tiny empty/config stubs < 1 KB

const analyzerState = {
  running: false,
  phase: 'idle', // 'idle' | 'walking' | 'hashing' | 'done' | 'error'
  scannedFiles: 0,
  scannedDirs: 0,
  scannedBytes: 0,
  hashedFiles: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  roots: [],
  largestFiles: [],
  largestDirs: [],
  duplicateGroups: [],
  summary: {
    totalFiles: 0,
    totalBytes: 0,
    duplicateGroupCount: 0,
    duplicateExtraFiles: 0,
    wastedBytes: 0
  }
};

async function computePartialSignature(filePath, sizeBytes) {
  const chunkSize = Math.min(65536, sizeBytes);
  const fh = await fsp.open(filePath, 'r');
  try {
    const hash = crypto.createHash('sha256');
    hash.update(String(sizeBytes));
    const headBuf = Buffer.allocUnsafe(chunkSize);
    const { bytesRead: headRead } = await fh.read(headBuf, 0, chunkSize, 0);
    hash.update(headBuf.subarray(0, headRead));
    if (sizeBytes > chunkSize) {
      const tailPos = Math.max(0, sizeBytes - chunkSize);
      const tailBuf = Buffer.allocUnsafe(chunkSize);
      const { bytesRead: tailRead } = await fh.read(tailBuf, 0, chunkSize, tailPos);
      hash.update(tailBuf.subarray(0, tailRead));
    }
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

function computeFullSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

let loadedAnalyzerFile = '';

function getAnalyzerCacheFile() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, 'analyzer-cache.json');
}

function savePersistedAnalysis() {
  if (analyzerState.phase !== 'done') return;
  const file = getAnalyzerCacheFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          phase: analyzerState.phase,
          scannedFiles: analyzerState.scannedFiles,
          scannedDirs: analyzerState.scannedDirs,
          scannedBytes: analyzerState.scannedBytes,
          hashedFiles: analyzerState.hashedFiles,
          startedAt: analyzerState.startedAt,
          finishedAt: analyzerState.finishedAt,
          roots: analyzerState.roots,
          summary: analyzerState.summary,
          largestFiles: analyzerState.largestFiles,
          largestDirs: analyzerState.largestDirs,
          duplicateGroups: analyzerState.duplicateGroups
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    // non-fatal
  }
}

function loadPersistedAnalysisOnce() {
  if (analyzerState.running || analyzerState.phase !== 'idle') return;
  const file = getAnalyzerCacheFile();
  if (loadedAnalyzerFile === file) return;
  loadedAnalyzerFile = file;
  try {
    if (!fs.existsSync(file)) return;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.phase === 'done' && saved.finishedAt) {
      analyzerState.phase = 'done';
      analyzerState.scannedFiles = Number(saved.scannedFiles) || 0;
      analyzerState.scannedDirs = Number(saved.scannedDirs) || 0;
      analyzerState.scannedBytes = Number(saved.scannedBytes) || 0;
      analyzerState.hashedFiles = Number(saved.hashedFiles) || 0;
      analyzerState.startedAt = saved.startedAt || saved.finishedAt;
      analyzerState.finishedAt = saved.finishedAt;
      analyzerState.roots = Array.isArray(saved.roots) ? saved.roots : [];
      analyzerState.summary = saved.summary || analyzerState.summary;
      analyzerState.largestFiles = Array.isArray(saved.largestFiles) ? saved.largestFiles : [];
      analyzerState.largestDirs = Array.isArray(saved.largestDirs) ? saved.largestDirs : [];
      analyzerState.duplicateGroups = Array.isArray(saved.duplicateGroups) ? saved.duplicateGroups : [];
    }
  } catch {
    // ignore corrupt cache
  }
}

async function runAnalysisJob(roots) {
  const sizeBuckets = new Map();
  const topFiles = [];
  const dirStats = new Map();
  const seenInodes = new Set();

  function addDirBytes(dirPath, bytes, isDirectChildFile) {
    let cur = dirPath;
    for (let depth = 0; depth < 24; depth += 1) {
      if (!roots.some((r) => cur === r || cur.startsWith(r + path.sep))) break;
      let rec = dirStats.get(cur);
      if (!rec) {
        rec = { path: cur, name: path.basename(cur) || cur, totalBytes: 0, fileCount: 0 };
        dirStats.set(cur, rec);
      }
      rec.totalBytes += bytes;
      if (isDirectChildFile || depth >= 0) rec.fileCount += 1;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  async function walkDir(dirPath) {
    if (analyzerState.scannedFiles >= MAX_FILES_SCAN) return;
    analyzerState.scannedDirs += 1;

    let entries;
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (analyzerState.scannedFiles >= MAX_FILES_SCAN) break;
      if (entry.name === '.homeserver-trash' || entry.name === 'lost+found' || entry.name === '@eaDir' || entry.name === 'node_modules') {
        continue;
      }
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.isFile()) {
        let st;
        try {
          st = await fsp.stat(fullPath);
        } catch {
          continue;
        }
        const inodeKey = `${st.dev}:${st.ino}`;
        if (st.ino && seenInodes.has(inodeKey)) continue;
        if (st.ino) seenInodes.add(inodeKey);

        analyzerState.scannedFiles += 1;
        analyzerState.scannedBytes += st.size;

        addDirBytes(dirPath, st.size, true);

        const fileEntry = {
          path: fullPath,
          name: entry.name,
          sizeBytes: st.size,
          modifiedAt: st.mtime.toISOString()
        };

        if (topFiles.length < 30 || st.size > topFiles[topFiles.length - 1].sizeBytes) {
          topFiles.push(fileEntry);
          topFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
          if (topFiles.length > 30) topFiles.pop();
        }

        if (st.size >= MIN_DUPLICATE_SIZE) {
          let bucket = sizeBuckets.get(st.size);
          if (!bucket) {
            bucket = [];
            sizeBuckets.set(st.size, bucket);
          }
          bucket.push(fileEntry);
        }
      }
    }
  }

  try {
    for (const root of roots) {
      await walkDir(root);
    }

    analyzerState.phase = 'hashing';
    const duplicateGroups = [];

    for (const [sizeBytes, candidates] of sizeBuckets.entries()) {
      if (candidates.length < 2) continue;

      const partialBuckets = new Map();
      for (const file of candidates) {
        try {
          const sig = await computePartialSignature(file.path, sizeBytes);
          let arr = partialBuckets.get(sig);
          if (!arr) {
            arr = [];
            partialBuckets.set(sig, arr);
          }
          arr.push(file);
        } catch {
          // skip unreadable file
        }
      }

      for (const groupCandidates of partialBuckets.values()) {
        if (groupCandidates.length < 2) continue;
        const fullBuckets = new Map();
        for (const file of groupCandidates) {
          try {
            const sha = await computeFullSha256(file.path);
            analyzerState.hashedFiles += 1;
            let arr = fullBuckets.get(sha);
            if (!arr) {
              arr = [];
              fullBuckets.set(sha, arr);
            }
            arr.push(file);
          } catch {
            // skip unreadable file
          }
        }

        for (const [hash, files] of fullBuckets.entries()) {
          if (files.length < 2) continue;
          files.sort((a, b) => a.path.localeCompare(b.path, 'de'));
          duplicateGroups.push({
            hash: hash.slice(0, 16),
            fullHash: hash,
            sizeBytes,
            wastedBytes: sizeBytes * (files.length - 1),
            files
          });
        }
      }
    }

    duplicateGroups.sort((a, b) => b.wastedBytes - a.wastedBytes);
    const topDuplicates = duplicateGroups.slice(0, 80);

    const largestDirs = [...dirStats.values()]
      .filter((d) => !roots.includes(d.path))
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .slice(0, 25);

    const wastedBytes = duplicateGroups.reduce((sum, g) => sum + g.wastedBytes, 0);
    const duplicateExtraFiles = duplicateGroups.reduce((sum, g) => sum + (g.files.length - 1), 0);

    analyzerState.largestFiles = topFiles;
    analyzerState.largestDirs = largestDirs;
    analyzerState.duplicateGroups = topDuplicates;
    analyzerState.summary = {
      totalFiles: analyzerState.scannedFiles,
      totalBytes: analyzerState.scannedBytes,
      duplicateGroupCount: duplicateGroups.length,
      duplicateExtraFiles,
      wastedBytes
    };
    analyzerState.phase = 'done';
    analyzerState.finishedAt = new Date().toISOString();
    savePersistedAnalysis();
  } catch (err) {
    analyzerState.phase = 'error';
    analyzerState.error = err.message;
    analyzerState.finishedAt = new Date().toISOString();
  } finally {
    analyzerState.running = false;
  }
}

function startStorageAnalysis(requestedPaths = [], configMediaPaths = []) {
  if (analyzerState.running) {
    return getAnalysisStatus();
  }

  const allowed = getAllowedRoots(configMediaPaths);
  const selected = Array.isArray(requestedPaths) && requestedPaths.length > 0
    ? requestedPaths
        .map((p) => path.resolve(String(p || '')))
        .filter((p) => allowed.some((r) => p === r || p.startsWith(r + path.sep)))
    : allowed;

  const targetRoots = [...new Set(selected.length > 0 ? selected : allowed)];
  if (targetRoots.length === 0) {
    const err = new Error('Keine Speicher-Pfade zur Analyse gefunden.');
    err.statusCode = 400;
    throw err;
  }

  analyzerState.running = true;
  analyzerState.phase = 'walking';
  analyzerState.scannedFiles = 0;
  analyzerState.scannedDirs = 0;
  analyzerState.scannedBytes = 0;
  analyzerState.hashedFiles = 0;
  analyzerState.startedAt = new Date().toISOString();
  analyzerState.finishedAt = null;
  analyzerState.error = null;
  analyzerState.roots = targetRoots;

  setImmediate(() => runAnalysisJob(targetRoots));
  return getAnalysisStatus();
}

function getAnalysisStatus() {
  loadPersistedAnalysisOnce();
  return {
    running: analyzerState.running,
    phase: analyzerState.phase,
    scannedFiles: analyzerState.scannedFiles,
    scannedDirs: analyzerState.scannedDirs,
    scannedBytes: analyzerState.scannedBytes,
    hashedFiles: analyzerState.hashedFiles,
    startedAt: analyzerState.startedAt,
    finishedAt: analyzerState.finishedAt,
    error: analyzerState.error,
    roots: analyzerState.roots,
    summary: analyzerState.summary,
    largestFiles: analyzerState.largestFiles,
    largestDirs: analyzerState.largestDirs,
    duplicateGroups: analyzerState.duplicateGroups
  };
}

module.exports = {
  startStorageAnalysis,
  getAnalysisStatus
};
