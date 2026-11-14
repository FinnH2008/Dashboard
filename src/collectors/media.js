const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PHOTO_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif',
  '.raw', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.tiff', '.tif', '.bmp'
]);

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts', '.3gp'
]);

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.opus', '.wma', '.alac', '.aiff'
]);

const BACKUP_DOC_EXT = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.zst', '.7z', '.rar', '.bak', '.iso', '.img', '.dmg', '.vmdk'
]);

const CACHE_TTL_MS = 5 * 60 * 1000;
let mediaCache = {
  key: '',
  timestamp: 0,
  scanning: false,
  data: null
};

function classifyExtension(ext) {
  if (PHOTO_EXT.has(ext)) return 'photos';
  if (VIDEO_EXT.has(ext)) return 'videos';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (BACKUP_DOC_EXT.has(ext)) return 'backups';
  return 'other';
}

function resolveMediaPaths(configMediaPaths = []) {
  const envPaths = (process.env.MEDIA_PATHS || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const combined = [...new Set([...envPaths, ...configMediaPaths])];
  if (combined.length > 0) {
    return combined.filter((p) => fs.existsSync(p));
  }

  // Auto-discover common mount roots if present and non-empty
  const autoCandidates = ['/disks', '/mnt', '/media'];
  const discovered = [];
  for (const root of autoCandidates) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          discovered.push(path.join(root, entry.name));
        }
      }
    } catch {
      // ignore
    }
  }
  return discovered;
}

async function scanDirectory(rootDir, state, depth = 0) {
  if (depth > 8 || state.filesScanned >= state.maxFiles || Date.now() - state.startedAt > state.maxDurationMs) {
    state.truncated = true;
    return;
  }

  let entries;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '@eaDir' || entry.name === '#recycle' || entry.name === 'lost+found') {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(fullPath, state, depth + 1);
    } else if (entry.isFile()) {
      try {
        const stat = await fsp.stat(fullPath);
        const ext = path.extname(entry.name).toLowerCase();
        const cat = classifyExtension(ext);
        state.categories[cat].bytes += stat.size;
        state.categories[cat].count += 1;
        state.totalBytes += stat.size;
        state.totalFiles += 1;
        state.filesScanned += 1;

        if (stat.mtimeMs > state.recentCutoff && state.recentFiles.length < 12) {
          state.recentFiles.push({
            name: entry.name,
            path: fullPath,
            category: cat,
            sizeBytes: stat.size,
            modifiedAt: new Date(stat.mtimeMs).toISOString()
          });
        }
      } catch {
        // ignore unreadable files
      }
    }

    if (state.filesScanned >= state.maxFiles || Date.now() - state.startedAt > state.maxDurationMs) {
      state.truncated = true;
      break;
    }
  }
}

let mediaScanPromise = null;

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
    folders: [],
    recentFiles: []
  };
}

async function runMediaScan(paths, cacheKey) {
  mediaCache.scanning = true;
  const state = {
    startedAt: Date.now(),
    maxDurationMs: 6000,
    maxFiles: 150000,
    filesScanned: 0,
    truncated: false,
    totalBytes: 0,
    totalFiles: 0,
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

  const folders = [];

  for (const mediaPath of paths) {
    const beforeBytes = state.totalBytes;
    const beforeFiles = state.totalFiles;
    const beforePhotos = state.categories.photos.count;
    const beforeVideos = state.categories.videos.count;

    await scanDirectory(mediaPath, state, 0);

    folders.push({
      path: mediaPath,
      name: path.basename(mediaPath) || mediaPath,
      bytes: state.totalBytes - beforeBytes,
      files: state.totalFiles - beforeFiles,
      photosCount: state.categories.photos.count - beforePhotos,
      videosCount: state.categories.videos.count - beforeVideos
    });
  }

  const total = state.totalBytes || 1;
  const categoryDefs = [
    { id: 'photos', label: 'Fotos & RAW' },
    { id: 'videos', label: 'Videos & Filme' },
    { id: 'audio', label: 'Musik & Audio' },
    { id: 'backups', label: 'Dokumente & Backups' },
    { id: 'other', label: 'Sonstiges' }
  ];

  const categories = categoryDefs.map((def) => {
    const c = state.categories[def.id];
    return {
      id: def.id,
      label: def.label,
      bytes: c.bytes,
      count: c.count,
      percent: state.totalBytes > 0 ? Math.round((c.bytes / total) * 1000) / 10 : 0
    };
  });

  state.recentFiles.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));

  const result = {
    configured: true,
    scanning: false,
    scannedPaths: paths,
    totalBytes: state.totalBytes,
    totalFiles: state.totalFiles,
    truncated: state.truncated,
    scannedAt: new Date().toISOString(),
    categories,
    folders: folders.sort((a, b) => b.bytes - a.bytes),
    recentFiles: state.recentFiles.slice(0, 8)
  };

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
  const isFresh = hasValidCache && now - mediaCache.timestamp < CACHE_TTL_MS;

  if (!forceRefresh && isFresh) {
    return mediaCache.data;
  }

  if (forceRefresh) {
    if (mediaScanPromise) {
      await mediaScanPromise.catch(() => {});
    }
    mediaScanPromise = runMediaScan(paths, cacheKey).finally(() => {
      mediaScanPromise = null;
    });
    return mediaScanPromise;
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
    return { ...mediaCache.data, scanning: true };
  }
  return buildEmptyMediaPlaceholder(true, paths, true);
}

module.exports = {
  collectMediaStats
};
