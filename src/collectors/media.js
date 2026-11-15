const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PHOTO_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.jxl',
  '.raw', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.rwl',
  '.srw', '.pef', '.kdc', '.mrw', '.3fr', '.erf', '.sr2', '.tiff', '.tif', '.bmp',
  '.svg', '.ico', '.psd', '.xcf'
]);

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg',
  '.ts', '.mts', '.m2ts', '.m2t', '.3gp', '.3g2', '.vob', '.ifo', '.bup', '.ogv',
  '.divx', '.rm', '.rmvb', '.asf', '.f4v', '.mxf'
]);

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.wav', '.aac', '.ogg', '.oga', '.m4a', '.m4b', '.m4p', '.opus',
  '.wma', '.alac', '.aiff', '.aif', '.ape', '.wv', '.dsf', '.dff', '.ac3', '.dts',
  '.mid', '.midi'
]);

const BACKUP_DOC_EXT = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.rtf', '.txt', '.md', '.markdown', '.csv', '.epub', '.mobi', '.azw3',
  '.json', '.xml', '.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg', '.log',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.tbz', '.tbz2', '.xz', '.txz',
  '.zst', '.tzst', '.lz4', '.lzo', '.7z', '.rar', '.cab',
  '.bak', '.old', '.sql', '.sqlite', '.sqlite3', '.db', '.dump',
  '.iso', '.img', '.dmg', '.vmdk', '.qcow2', '.qcow', '.vdi', '.vhd', '.vhdx',
  '.ova', '.ovf', '.bin', '.cue', '.nrg', '.mdf', '.mds',
  '.deb', '.rpm', '.apk', '.appimage', '.exe', '.msi', '.pkg'
]);

const IGNORED_NAMES = new Set([
  '@eaDir',
  '#recycle',
  'lost+found',
  '.homeserver-trash',
  '$RECYCLE.BIN',
  'System Volume Information',
  'node_modules'
]);

const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_DURATION_MS = 120_000; // 2 minutes background scan
const DEFAULT_MAX_FILES = 1_000_000;
const DEFAULT_MAX_DEPTH = 24;
const STAT_CONCURRENCY = 24;

let mediaCache = {
  key: '',
  timestamp: 0,
  scanning: false,
  data: null
};

let mediaScanPromise = null;

function classifyExtension(ext) {
  if (PHOTO_EXT.has(ext)) return 'photos';
  if (VIDEO_EXT.has(ext)) return 'videos';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (BACKUP_DOC_EXT.has(ext)) return 'backups';
  return 'other';
}

function getEffectiveFileBytes(stat) {
  if (!stat || !Number.isFinite(stat.size) || stat.size < 0) return 0;
  // Guard against multi-hundred-GB sparse VM/image files inflating size beyond physical allocation
  if (Number.isFinite(stat.blocks) && stat.blocks > 0 && stat.size > 1024 * 1024) {
    const allocated = stat.blocks * 512;
    if (allocated < stat.size * 0.5) {
      return allocated;
    }
  }
  return stat.size;
}

function resolveMediaPaths(configMediaPaths = []) {
  const envPaths = (process.env.MEDIA_PATHS || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const combined = [...new Set([...envPaths, ...configMediaPaths])];
  let candidates = combined.filter((p) => fs.existsSync(p));

  if (candidates.length === 0) {
    // Auto-discover common mount roots if present and non-empty
    const autoCandidates = ['/disks', '/mnt', '/media'];
    const discovered = [];
    for (const root of autoCandidates) {
      try {
        if (!fs.existsSync(root)) continue;
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED_NAMES.has(entry.name)) {
            discovered.push(path.join(root, entry.name));
          }
        }
      } catch {
        // ignore unreadable root
      }
    }
    candidates = discovered;
  }

  // Deduplicate symlink aliases / duplicate mount paths via realpath while keeping display path order
  const seenReal = new Set();
  const deduped = [];
  for (const p of candidates) {
    try {
      const real = fs.realpathSync(p);
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      deduped.push({ inputPath: p, realPath: real });
    } catch {
      // skip vanished path
    }
  }

  // Filter out child directories if their ancestor directory is already part of the scan set
  const realList = deduped.map((d) => d.realPath);
  return deduped
    .filter((item) => !realList.some((other) => other !== item.realPath && item.realPath.startsWith(other + path.sep)))
    .map((item) => item.inputPath);
}

function buildResultFromState(paths, state, scanning = false) {
  const total = state.totalBytes || 1;
  const categoryDefs = [
    { id: 'photos', label: 'Fotos & RAW' },
    { id: 'videos', label: 'Videos & Filme' },
    { id: 'audio', label: 'Musik & Audio' },
    { id: 'backups', label: 'Dokumente & Backups' },
    { id: 'other', label: 'Sonstiges' }
  ];

  const topOtherExtensions = [...state.otherExtStats.entries()]
    .map(([ext, info]) => ({ ext, bytes: info.bytes, count: info.count }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 4);

  const categories = categoryDefs.map((def) => {
    const c = state.categories[def.id];
    const base = {
      id: def.id,
      label: def.label,
      bytes: c.bytes,
      count: c.count,
      percent: state.totalBytes > 0 ? Math.round((c.bytes / total) * 1000) / 10 : 0
    };
    if (def.id === 'other' && topOtherExtensions.length > 0) {
      base.topExtensions = topOtherExtensions;
    }
    return base;
  });

  const sortedRecent = [...state.recentFiles]
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1))
    .slice(0, 8);

  const folders = [...state.folderStats.values()].sort((a, b) => b.bytes - a.bytes);

  return {
    configured: true,
    scanning,
    scannedPaths: paths,
    totalBytes: state.totalBytes,
    totalFiles: state.totalFiles,
    truncated: state.truncated,
    scannedAt: new Date().toISOString(),
    categories,
    topOtherExtensions,
    folders,
    recentFiles: sortedRecent
  };
}

function isScanLimitReached(state) {
  return state.filesScanned >= state.maxFiles || Date.now() - state.startedAt > state.maxDurationMs;
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!items || items.length === 0) return;
  let index = 0;
  const count = Math.min(concurrency, items.length);
  const runners = Array.from({ length: count }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

async function scanRootDirectory(rootPath, state, onProgress) {
  const folderRec = state.folderStats.get(rootPath);
  const queue = [{ dir: rootPath, depth: 0 }];

  while (queue.length > 0) {
    if (isScanLimitReached(state)) {
      state.truncated = true;
      break;
    }

    const { dir, depth } = queue.pop();
    if (depth > state.maxDepth) {
      state.truncated = true;
      continue;
    }

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const fileNames = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.Trash-') || IGNORED_NAMES.has(entry.name)) {
        continue;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }
      // Never follow symlinks to avoid cyclic loops or double-counting mounted shares
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      } else if (entry.isFile()) {
        fileNames.push(entry.name);
      }
    }

    if (fileNames.length === 0) continue;

    await mapWithConcurrency(fileNames, STAT_CONCURRENCY, async (fileName) => {
      if (isScanLimitReached(state)) {
        state.truncated = true;
        return;
      }
      const fullPath = path.join(dir, fileName);
      try {
        const stat = await fsp.stat(fullPath);
        if (stat.ino && stat.nlink > 1) {
          const inodeKey = `${stat.dev}:${stat.ino}`;
          if (state.seenInodes.has(inodeKey)) return;
          state.seenInodes.add(inodeKey);
        }

        const sizeBytes = getEffectiveFileBytes(stat);
        const ext = path.extname(fileName).toLowerCase();
        const cat = classifyExtension(ext);

        state.categories[cat].bytes += sizeBytes;
        state.categories[cat].count += 1;
        state.totalBytes += sizeBytes;
        state.totalFiles += 1;
        state.filesScanned += 1;

        folderRec.bytes += sizeBytes;
        folderRec.files += 1;
        if (cat === 'photos') folderRec.photosCount += 1;
        if (cat === 'videos') folderRec.videosCount += 1;

        if (cat === 'other') {
          const extKey = ext || '(ohne Endung)';
          const prev = state.otherExtStats.get(extKey) || { bytes: 0, count: 0 };
          prev.bytes += sizeBytes;
          prev.count += 1;
          state.otherExtStats.set(extKey, prev);
        }

        if (stat.mtimeMs > state.recentCutoff && state.recentFiles.length < 24) {
          state.recentFiles.push({
            name: fileName,
            path: fullPath,
            category: cat,
            sizeBytes,
            modifiedAt: new Date(stat.mtimeMs).toISOString()
          });
        }

        if (typeof onProgress === 'function' && Date.now() - state.lastProgressPush >= 1500) {
          state.lastProgressPush = Date.now();
          onProgress();
        }
      } catch {
        // ignore unreadable/vanished files
      }
    });
  }
}

function buildEmptyMediaPlaceholder(configured, scannedPaths = [], scanning = false) {
  return {
    configured,
    scanning,
    scannedPaths,
    totalBytes: 0,
    totalFiles: 0,
    truncated: false,
    scannedAt: new Date().toISOString(),
    categories: [
      { id: 'photos', label: 'Fotos & RAW', bytes: 0, count: 0, percent: 0 },
      { id: 'videos', label: 'Videos & Filme', bytes: 0, count: 0, percent: 0 },
      { id: 'audio', label: 'Musik & Audio', bytes: 0, count: 0, percent: 0 },
      { id: 'backups', label: 'Dokumente & Backups', bytes: 0, count: 0, percent: 0 },
      { id: 'other', label: 'Sonstiges', bytes: 0, count: 0, percent: 0 }
    ],
    topOtherExtensions: [],
    folders: [],
    recentFiles: []
  };
}

async function runMediaScan(paths, cacheKey) {
  mediaCache.scanning = true;
  const folderStats = new Map();
  paths.forEach((mediaPath) => {
    folderStats.set(mediaPath, {
      path: mediaPath,
      name: path.basename(mediaPath) || mediaPath,
      bytes: 0,
      files: 0,
      photosCount: 0,
      videosCount: 0
    });
  });

  const state = {
    startedAt: Date.now(),
    lastProgressPush: Date.now(),
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
    maxFiles: DEFAULT_MAX_FILES,
    maxDepth: DEFAULT_MAX_DEPTH,
    filesScanned: 0,
    truncated: false,
    totalBytes: 0,
    totalFiles: 0,
    seenInodes: new Set(),
    otherExtStats: new Map(),
    folderStats,
    recentCutoff: Date.now() - 14 * 24 * 60 * 60 * 1000,
    recentFiles: [],
    categories: {
      photos: { bytes: 0, count: 0 },
      videos: { bytes: 0, count: 0 },
      audio: { bytes: 0, count: 0 },
      backups: { bytes: 0, count: 0 },
      other: { bytes: 0, count: 0 }
    }
  };

  const pushInterim = () => {
    // Only overwrite interim progress for the active cacheKey
    mediaCache = {
      key: cacheKey,
      timestamp: Date.now(),
      scanning: true,
      data: buildResultFromState(paths, state, true)
    };
  };

  // Scan up to 4 roots concurrently so earlier large folders never starve later drives
  await mapWithConcurrency(paths, 4, async (mediaPath) => {
    await scanRootDirectory(mediaPath, state, pushInterim);
  });

  const result = buildResultFromState(paths, state, false);
  mediaCache = { key: cacheKey, timestamp: Date.now(), scanning: false, data: result };
  return result;
}

async function collectMediaStats(configMediaPaths = [], forceRefresh = false) {
  const paths = resolveMediaPaths(configMediaPaths);
  const cacheKey = paths.join('|');
  const now = Date.now();

  if (paths.length === 0) {
    const emptyResult = buildEmptyMediaPlaceholder(false, [], false);
    mediaCache = { key: cacheKey, timestamp: now, scanning: false, data: emptyResult };
    return emptyResult;
  }

  const hasValidCache = Boolean(mediaCache.data && mediaCache.key === cacheKey);
  const isFresh = hasValidCache && now - mediaCache.timestamp < CACHE_TTL_MS && !mediaCache.scanning;

  if (!forceRefresh && isFresh) {
    return mediaCache.data;
  }

  if (forceRefresh) {
    if (!mediaScanPromise || mediaCache.key !== cacheKey) {
      mediaScanPromise = runMediaScan(paths, cacheKey)
        .catch(() => mediaCache.data || buildEmptyMediaPlaceholder(true, paths, false))
        .finally(() => {
          mediaScanPromise = null;
        });
    }
    // Wait up to 1.5s so quick scans complete inline while huge NAS arrays don't stall HTTP requests
    const outcome = await Promise.race([
      mediaScanPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 1500))
    ]);
    if (outcome) return outcome;
    if (mediaCache.data && mediaCache.key === cacheKey) {
      return { ...mediaCache.data, scanning: true };
    }
    return buildEmptyMediaPlaceholder(true, paths, true);
  }

  // Non-blocking background refresh so /api/snapshot & /api/stream stay <50ms
  if (!mediaScanPromise) {
    mediaScanPromise = runMediaScan(paths, cacheKey)
      .catch(() => {})
      .finally(() => {
        mediaScanPromise = null;
      });
  }

  if (hasValidCache) {
    return { ...mediaCache.data, scanning: Boolean(mediaScanPromise) };
  }
  return buildEmptyMediaPlaceholder(true, paths, true);
}

module.exports = {
  collectMediaStats
};
