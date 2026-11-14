const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const ALLOW_WRITE = String(process.env.ALLOW_FILE_WRITE || 'true').toLowerCase() !== 'false';

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.env': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip'
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.bmp', '.heic', '.raw', '.dng', '.cr2', '.cr3', '.nef', '.arw']);
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.wmv', '.ts', '.mts']);
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.opus', '.aac']);
const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.tgz', '.zst', '.7z', '.rar', '.bak', '.iso', '.img']);
const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.yml', '.yaml', '.env', '.conf', '.cfg', '.ini', '.log', '.sh', '.xml', '.csv']);

function classifyFileKind(ext, name = '') {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (TEXT_EXTS.has(ext) || name.startsWith('.env')) return 'text';
  if (['.pdf', '.doc', '.docx'].includes(ext)) return 'document';
  return 'other';
}

function getAllowedRoots(configMediaPaths = []) {
  const envRoots = [
    ...(process.env.FILE_ROOTS || '').split(','),
    ...(process.env.MEDIA_PATHS || '').split(','),
    ...(process.env.DISK_MOUNTS || '').split(','),
    ...configMediaPaths
  ]
    .map((p) => p.trim())
    .filter(Boolean);

  const candidates = new Set(envRoots);
  for (const base of ['/mnt', '/media', '/disks']) {
    if (fs.existsSync(base)) {
      try {
        const sub = fs.readdirSync(base, { withFileTypes: true });
        for (const d of sub) {
          if (d.isDirectory() && !d.name.startsWith('.')) {
            candidates.add(path.join(base, d.name));
          }
        }
      } catch {
        // ignore
      }
    }
  }

  const resolved = [];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        resolved.push(fs.realpathSync(p));
      }
    } catch {
      // ignore
    }
  }

  return [...new Set(resolved)];
}

function assertAllowedPath(targetPath, roots) {
  if (!targetPath || typeof targetPath !== 'string') {
    const err = new Error('Ungültiger Pfad');
    err.statusCode = 400;
    throw err;
  }
  const abs = path.resolve(targetPath);
  const targetReal = fs.existsSync(abs)
    ? fs.realpathSync(abs)
    : path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));

  const isInside = roots.some((root) => targetReal === root || targetReal.startsWith(root + path.sep));
  if (!isInside) {
    const err = new Error('Zugriff verweigert: Pfad liegt außerhalb der freigegebenen Speicher-Ordner.');
    err.statusCode = 403;
    throw err;
  }
  return targetReal;
}

async function listLiveDirectory(requestedPath, configMediaPaths = []) {
  const roots = getAllowedRoots(configMediaPaths);

  if (!requestedPath || requestedPath === '/') {
    const rootItems = await Promise.all(
      roots.map(async (rootPath) => {
        let modifiedAt = new Date().toISOString();
        try {
          const st = await fsp.stat(rootPath);
          modifiedAt = st.mtime.toISOString();
        } catch {
          // ignore
        }
        return {
          name: path.basename(rootPath) || rootPath,
          path: rootPath,
          isDirectory: true,
          kind: 'folder',
          sizeBytes: 0,
          modifiedAt,
          ext: ''
        };
      })
    );

    return {
      allowWrite: ALLOW_WRITE,
      currentPath: '/',
      parentPath: null,
      roots: roots.map((r) => ({ name: path.basename(r) || r, path: r })),
      items: rootItems
    };
  }

  const realDir = assertAllowedPath(requestedPath, roots);
  const stat = await fsp.stat(realDir);
  if (!stat.isDirectory()) throw new Error('Pfad ist kein Verzeichnis');

  const entries = await fsp.readdir(realDir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') && !entry.name.startsWith('.env')) continue;
    if (entry.name === 'lost+found' || entry.name === '@eaDir') continue;
    const fullPath = path.join(realDir, entry.name);
    try {
      const st = await fsp.stat(fullPath);
      const isDir = st.isDirectory();
      const ext = isDir ? '' : path.extname(entry.name).toLowerCase();
      items.push({
        name: entry.name,
        path: fullPath,
        isDirectory: isDir,
        kind: isDir ? 'folder' : classifyFileKind(ext, entry.name),
        sizeBytes: isDir ? 0 : st.size,
        modifiedAt: st.mtime.toISOString(),
        ext
      });
    } catch {
      // ignore
    }
  }

  items.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name, 'de', { numeric: true });
  });

  const isRoot = roots.includes(realDir);
  const parentPath = isRoot ? '/' : path.dirname(realDir);

  return {
    allowWrite: ALLOW_WRITE,
    currentPath: realDir,
    parentPath,
    roots: roots.map((r) => ({ name: path.basename(r) || r, path: r })),
    items
  };
}

async function streamLiveFile(req, res, requestedPath, configMediaPaths = [], forceDownload = false) {
  const roots = getAllowedRoots(configMediaPaths);
  const realFile = assertAllowedPath(requestedPath, roots);
  const stat = await fsp.stat(realFile);
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end('Datei nicht gefunden');
    return;
  }

  const ext = path.extname(realFile).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  const filename = path.basename(realFile);
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  };

  if (forceDownload) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  const range = req.headers.range;
  if (range && stat.size > 0) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(stat.size - 1, parseInt(match[2], 10)) : stat.size - 1;
      if (start <= end && start < stat.size) {
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1
        });
        fs.createReadStream(realFile, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    ...headers,
    'Content-Length': stat.size
  });
  fs.createReadStream(realFile).pipe(res);
}

async function createLiveFolder(parentDir, folderName, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const cleanName = path.basename(String(folderName || '').trim());
  if (!cleanName || cleanName === '.' || cleanName === '..') throw new Error('Ungültiger Ordnername');
  const roots = getAllowedRoots(configMediaPaths);
  const realParent = assertAllowedPath(parentDir, roots);
  const target = path.join(realParent, cleanName);
  await fsp.mkdir(target, { recursive: false });
  return { ok: true, path: target };
}

async function renameLiveItem(targetPath, newName, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const cleanName = path.basename(String(newName || '').trim());
  if (!cleanName || cleanName === '.' || cleanName === '..') throw new Error('Ungültiger Name');
  const roots = getAllowedRoots(configMediaPaths);
  const realTarget = assertAllowedPath(targetPath, roots);
  if (roots.includes(realTarget)) throw new Error('Stammordner kann nicht umbenannt werden.');
  const nextPath = path.join(path.dirname(realTarget), cleanName);
  await fsp.rename(realTarget, nextPath);
  return { ok: true, path: nextPath };
}

async function copyOrMoveLiveItems(sources, destDir, move = false, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('Keine Dateien ausgewählt.');
  const roots = getAllowedRoots(configMediaPaths);
  const realDest = assertAllowedPath(destDir, roots);
  const destStat = await fsp.stat(realDest);
  if (!destStat.isDirectory()) throw new Error('Ziel ist kein Verzeichnis.');

  for (const src of sources) {
    const realSrc = assertAllowedPath(src, roots);
    if (roots.includes(realSrc) && move) throw new Error('Stammordner kann nicht verschoben werden.');
    const target = path.join(realDest, path.basename(realSrc));
    if (realSrc === target) continue;

    if (move) {
      try {
        await fsp.rename(realSrc, target);
      } catch (err) {
        if (err.code === 'EXDEV') {
          // Cross-disk move: copy recursively then delete source
          await fsp.cp(realSrc, target, { recursive: true });
          await fsp.rm(realSrc, { recursive: true, force: false });
        } else {
          throw err;
        }
      }
    } else {
      await fsp.cp(realSrc, target, { recursive: true });
    }
  }
  return { ok: true, count: sources.length };
}

async function deleteLiveItems(paths, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const list = Array.isArray(paths) ? paths : [paths];
  const roots = getAllowedRoots(configMediaPaths);
  for (const targetPath of list) {
    const realTarget = assertAllowedPath(targetPath, roots);
    if (roots.includes(realTarget)) throw new Error('Stammordner kann nicht gelöscht werden.');
    await fsp.rm(realTarget, { recursive: true, force: false });
  }
  return { ok: true };
}

async function saveLiveUpload(targetDir, rawFilename, buffer, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const cleanName = path.basename(String(rawFilename || 'upload.bin').trim());
  if (!cleanName || cleanName === '.' || cleanName === '..') throw new Error('Ungültiger Dateiname');
  const roots = getAllowedRoots(configMediaPaths);
  const realDir = assertAllowedPath(targetDir, roots);
  const destPath = path.join(realDir, cleanName);
  await fsp.writeFile(destPath, buffer);
  return { ok: true, path: destPath, sizeBytes: buffer.length };
}

async function readLiveTextFile(targetPath, configMediaPaths = []) {
  const roots = getAllowedRoots(configMediaPaths);
  const realFile = assertAllowedPath(targetPath, roots);
  const st = await fsp.stat(realFile);
  if (!st.isFile()) throw new Error('Keine Datei');
  if (st.size > 2 * 1024 * 1024) throw new Error('Datei zu groß für den Browser-Editor (Max 2 MB).');
  const content = await fsp.readFile(realFile, 'utf8');
  return { path: realFile, name: path.basename(realFile), content };
}

async function writeLiveTextFile(targetPath, content, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const roots = getAllowedRoots(configMediaPaths);
  const realFile = assertAllowedPath(targetPath, roots);
  await fsp.writeFile(realFile, String(content ?? ''), 'utf8');
  return { ok: true };
}

async function streamZipDownload(paths, res, configMediaPaths = []) {
  const list = Array.isArray(paths) ? paths : [paths];
  if (list.length === 0) throw new Error('Keine Dateien ausgewählt');
  const roots = getAllowedRoots(configMediaPaths);
  const realItems = list.map((p) => assertAllowedPath(p, roots));

  const parentDir = path.dirname(realItems[0]);
  const relNames = realItems.map((p) => path.relative(parentDir, p) || path.basename(p));

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="homeserver-archiv.zip"'
  });

  const zipProc = spawn('zip', ['-r', '-', ...relNames], { cwd: parentDir });
  zipProc.stdout.pipe(res);
  zipProc.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}

async function extractLiveArchive(archivePath, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const roots = getAllowedRoots(configMediaPaths);
  const realArchive = assertAllowedPath(archivePath, roots);
  const destDir = path.dirname(realArchive);
  const lower = realArchive.toLowerCase();

  if (lower.endsWith('.zip')) {
    await execFileAsync('unzip', ['-o', realArchive, '-d', destDir], { timeout: 120_000 });
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
    await execFileAsync('tar', ['-xf', realArchive, '-C', destDir], { timeout: 120_000 });
  } else {
    throw new Error('Unterstützte Formate zum Entpacken: .zip, .tar, .tar.gz, .tgz');
  }
  return { ok: true };
}

module.exports = {
  listLiveDirectory,
  streamLiveFile,
  createLiveFolder,
  renameLiveItem,
  copyOrMoveLiveItems,
  deleteLiveItems,
  saveLiveUpload,
  readLiveTextFile,
  writeLiveTextFile,
  streamZipDownload,
  extractLiveArchive
};
