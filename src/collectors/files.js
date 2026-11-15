const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const ALLOW_WRITE = String(process.env.ALLOW_FILE_WRITE || 'true').toLowerCase() !== 'false';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

let cachedFfmpegAvailable = null;
function hasFfmpeg() {
  if (cachedFfmpegAvailable !== null) return cachedFfmpegAvailable;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 2000 });
    cachedFfmpegAvailable = true;
  } catch {
    cachedFfmpegAvailable = false;
  }
  return cachedFfmpegAvailable;
}

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
  '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.env': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.cjs': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.service': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip'
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.avif', '.bmp', '.heic', '.raw', '.dng', '.cr2', '.cr3', '.nef', '.arw']);
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.wmv', '.ts', '.mts']);
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.opus', '.aac']);
const ARCHIVE_EXTS = new Set(['.zip', '.tar', '.gz', '.tgz', '.zst', '.7z', '.rar', '.bak', '.iso', '.img']);
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yml', '.yaml', '.toml', '.env', '.conf',
  '.cfg', '.ini', '.log', '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs',
  '.jsx', '.tsx', '.css', '.scss', '.html', '.htm', '.xml', '.csv', '.sql',
  '.service', '.timer', '.rules', '.list', '.properties'
]);
const EXTENSIONLESS_TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'caddyfile', 'procfile', 'vagrantfile',
  'gemfile', 'license', 'readme', '.gitignore', '.dockerignore', '.editorconfig', '.env'
]);

function classifyFileKind(ext, name = '') {
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  const lowerName = String(name || '').toLowerCase();
  if (
    TEXT_EXTS.has(ext) ||
    lowerName.startsWith('.env') ||
    EXTENSIONLESS_TEXT_NAMES.has(lowerName) ||
    lowerName.startsWith('dockerfile.')
  ) {
    return 'text';
  }
  if (['.doc', '.docx', '.odt', '.rtf'].includes(ext)) return 'document';
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
  let targetReal;
  try {
    targetReal = fs.existsSync(abs)
      ? fs.realpathSync(abs)
      : path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
  } catch {
    const err = new Error('Pfad oder übergeordneter Ordner existiert nicht.');
    err.statusCode = 404;
    throw err;
  }

  const isInside = roots.some((root) => targetReal === root || targetReal.startsWith(root + path.sep));
  if (!isInside) {
    const err = new Error('Zugriff verweigert: Pfad liegt außerhalb der freigegebenen Speicher-Ordner.');
    err.statusCode = 403;
    throw err;
  }
  return targetReal;
}

async function statExisting(targetPath) {
  try {
    return await fsp.stat(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      const notFound = new Error('Datei oder Ordner existiert nicht.');
      notFound.statusCode = 404;
      throw notFound;
    }
    throw err;
  }
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
  const stat = await statExisting(realDir);
  if (!stat.isDirectory()) {
    const err = new Error('Pfad ist kein Verzeichnis');
    err.statusCode = 400;
    throw err;
  }

  const entries = await fsp.readdir(realDir, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    if (
      entry.name.startsWith('.') &&
      !entry.name.startsWith('.env') &&
      entry.name !== '.gitignore' &&
      entry.name !== '.dockerignore' &&
      entry.name !== '.editorconfig'
    ) {
      continue;
    }
    if (entry.name === 'lost+found' || entry.name === '@eaDir') continue;
    const fullPath = path.join(realDir, entry.name);
    try {
      const st = await fsp.stat(fullPath);
      const isDir = st.isDirectory();
      const ext = isDir ? '' : path.extname(entry.name).toLowerCase();
      let kind = isDir ? 'folder' : classifyFileKind(ext, entry.name);
      if (!isDir && kind === 'other' && !ext && st.size > 0 && st.size <= 2 * 1024 * 1024) {
        try {
          const fh = await fsp.open(fullPath, 'r');
          const probe = Buffer.alloc(Math.min(512, st.size));
          await fh.read(probe, 0, probe.length, 0);
          await fh.close();
          if (!probe.includes(0)) kind = 'text';
        } catch {
          // ignore probe errors
        }
      }
      items.push({
        name: entry.name,
        path: fullPath,
        isDirectory: isDir,
        kind,
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

function pipeReadStream(fileStream, res) {
  const cleanup = () => {
    if (!fileStream.destroyed) fileStream.destroy();
  };
  res.once('close', cleanup);
  fileStream.on('error', () => {
    cleanup();
    if (!res.headersSent) {
      res.writeHead(500);
    }
    if (!res.writableEnded) res.end();
  });
  fileStream.pipe(res);
}

function isSafeInlineMime(mime) {
  if (!mime) return false;
  if (mime === 'application/pdf') return true;
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return true;
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return true;
  return false;
}

async function streamLiveFile(req, res, requestedPath, configMediaPaths = [], options = false) {
  const opts = typeof options === 'object' && options !== null
    ? options
    : { forceDownload: Boolean(options), inline: false };
  const forceDownload = Boolean(opts.forceDownload);
  const inline = Boolean(opts.inline);

  const roots = getAllowedRoots(configMediaPaths);
  const realFile = assertAllowedPath(requestedPath, roots);
  const stat = await statExisting(realFile);
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
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  };

  if (forceDownload) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
  } else if (inline) {
    const disposition = isSafeInlineMime(mime) ? 'inline' : 'attachment';
    headers['Content-Disposition'] = `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  const range = req.headers.range;
  if (range && stat.size > 0) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(stat.size - 1, parseInt(match[2], 10)) : stat.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < stat.size) {
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1
        });
        pipeReadStream(fs.createReadStream(realFile, { start, end }), res);
        return;
      }
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
  }

  res.writeHead(200, {
    ...headers,
    'Content-Length': stat.size
  });
  pipeReadStream(fs.createReadStream(realFile), res);
}

async function createLiveFolder(parentDir, folderName, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const cleanName = path.basename(String(folderName || '').trim());
  if (!cleanName || cleanName === '.' || cleanName === '..') throw new Error('Ungültiger Ordnername');
  const roots = getAllowedRoots(configMediaPaths);
  const realParent = assertAllowedPath(parentDir, roots);
  const target = path.join(realParent, cleanName);
  try {
    await fsp.mkdir(target, { recursive: false });
  } catch (err) {
    if (err.code === 'EEXIST') {
      const dupErr = new Error(`Ordner "${cleanName}" existiert bereits.`);
      dupErr.statusCode = 409;
      throw dupErr;
    }
    throw err;
  }
  return { ok: true, path: target };
}

async function renameLiveItem(targetPath, newName, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const cleanName = path.basename(String(newName || '').trim());
  if (!cleanName || cleanName === '.' || cleanName === '..') throw new Error('Ungültiger Name');
  const roots = getAllowedRoots(configMediaPaths);
  const realTarget = assertAllowedPath(targetPath, roots);
  await statExisting(realTarget);
  if (roots.includes(realTarget)) throw new Error('Stammordner kann nicht umbenannt werden.');
  const nextPath = path.join(path.dirname(realTarget), cleanName);
  if (fs.existsSync(nextPath) && nextPath !== realTarget) {
    const dupErr = new Error(`"${cleanName}" existiert im Zielordner bereits.`);
    dupErr.statusCode = 409;
    throw dupErr;
  }
  await fsp.rename(realTarget, nextPath);
  return { ok: true, path: nextPath };
}

async function copyOrMoveLiveItems(sources, destDir, move = false, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('Keine Dateien ausgewählt.');
  const roots = getAllowedRoots(configMediaPaths);
  const realDest = assertAllowedPath(destDir, roots);
  const destStat = await statExisting(realDest);
  if (!destStat.isDirectory()) throw new Error('Ziel ist kein Verzeichnis.');

  for (const src of sources) {
    const realSrc = assertAllowedPath(src, roots);
    await statExisting(realSrc);
    if (roots.includes(realSrc) && move) throw new Error('Stammordner kann nicht verschoben werden.');
    const target = path.join(realDest, path.basename(realSrc));
    if (realSrc === target) continue;
    if (target === realSrc || target.startsWith(realSrc + path.sep)) {
      const err = new Error('Ein Ordner kann nicht in sich selbst kopiert oder verschoben werden.');
      err.statusCode = 400;
      throw err;
    }

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

const TRASH_DIR_NAME = '.homeserver-trash';
const TRASH_MANIFEST = 'manifest.json';

function findOwningRoot(realPath, roots) {
  let best = null;
  for (const r of roots) {
    if (realPath === r || realPath.startsWith(r + path.sep)) {
      if (!best || r.length > best.length) best = r;
    }
  }
  return best;
}

function getTrashDirForRoot(rootPath) {
  return path.join(rootPath, TRASH_DIR_NAME);
}

async function readTrashManifest(rootPath) {
  const manifestPath = path.join(getTrashDirForRoot(rootPath), TRASH_MANIFEST);
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeTrashManifest(rootPath, entries) {
  const trashDir = getTrashDirForRoot(rootPath);
  await fsp.mkdir(trashDir, { recursive: true });
  const manifestPath = path.join(trashDir, TRASH_MANIFEST);
  await fsp.writeFile(manifestPath, JSON.stringify(entries, null, 2), 'utf8');
}

async function listDirectoriesOnly(requestedPath = '/', configMediaPaths = []) {
  const roots = getAllowedRoots(configMediaPaths);
  if (!requestedPath || requestedPath === '/') {
    return {
      currentPath: '/',
      parentPath: null,
      dirs: roots.map((r) => ({ name: path.basename(r) || r, path: r }))
    };
  }
  const realDir = assertAllowedPath(requestedPath, roots);
  const st = await statExisting(realDir);
  if (!st.isDirectory()) {
    const err = new Error('Pfad ist kein Verzeichnis.');
    err.statusCode = 400;
    throw err;
  }
  const entries = await fsp.readdir(realDir, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'lost+found' || entry.name === '@eaDir') continue;
    dirs.push({
      name: entry.name,
      path: path.join(realDir, entry.name)
    });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
  const isRoot = roots.includes(realDir);
  return {
    currentPath: realDir,
    parentPath: isRoot ? '/' : path.dirname(realDir),
    dirs
  };
}

async function safeRename(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.cp(src, dest, { recursive: true });
      await fsp.rm(src, { recursive: true, force: false });
    } else {
      throw err;
    }
  }
}

async function moveItemsToTrash(paths, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const list = Array.isArray(paths) ? paths : [paths];
  const roots = getAllowedRoots(configMediaPaths);
  const grouped = new Map();
  let movedCount = 0;

  for (const targetPath of list) {
    const realTarget = assertAllowedPath(targetPath, roots);
    const st = await statExisting(realTarget);
    if (roots.includes(realTarget)) throw new Error('Stammordner kann nicht gelöscht werden.');
    const owningRoot = findOwningRoot(realTarget, roots);
    if (!owningRoot) throw new Error('Kein passendes Laufwerk gefunden.');
    const trashDir = getTrashDirForRoot(owningRoot);
    if (realTarget === trashDir || realTarget.startsWith(trashDir + path.sep)) {
      throw new Error('Eintrag liegt bereits im Papierkorb.');
    }

    await fsp.mkdir(trashDir, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(realTarget)}`;
    const dest = path.join(trashDir, id);
    await safeRename(realTarget, dest);

    if (!grouped.has(owningRoot)) {
      grouped.set(owningRoot, await readTrashManifest(owningRoot));
    }
    grouped.get(owningRoot).push({
      id,
      name: path.basename(realTarget),
      originalPath: realTarget,
      rootPath: owningRoot,
      isDirectory: st.isDirectory(),
      sizeBytes: st.isDirectory() ? 0 : st.size,
      deletedAt: new Date().toISOString()
    });
    movedCount += 1;
  }

  for (const [rootPath, entries] of grouped.entries()) {
    await writeTrashManifest(rootPath, entries);
  }
  return { ok: true, trashed: movedCount };
}

async function listTrash(configMediaPaths = []) {
  const roots = getAllowedRoots(configMediaPaths);
  const all = [];
  for (const rootPath of roots) {
    const trashDir = getTrashDirForRoot(rootPath);
    const manifest = await readTrashManifest(rootPath);
    const valid = [];
    for (const item of manifest) {
      const storedPath = path.join(trashDir, item.id);
      if (fs.existsSync(storedPath)) {
        valid.push(item);
        all.push({
          ...item,
          trashKey: `${rootPath}::${item.id}`
        });
      }
    }
    if (valid.length !== manifest.length) {
      await writeTrashManifest(rootPath, valid);
    }
  }
  all.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  return { allowWrite: ALLOW_WRITE, items: all };
}

async function restoreFromTrash(items, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const list = Array.isArray(items) ? items : [items];
  const roots = getAllowedRoots(configMediaPaths);
  let restored = 0;

  for (const entry of list) {
    const rawKey = typeof entry === 'string' ? entry : entry?.trashKey || '';
    const [rootHint, id] = rawKey.includes('::') ? rawKey.split('::') : [null, rawKey];
    if (!id) continue;

    for (const rootPath of roots) {
      if (rootHint && rootPath !== rootHint) continue;
      const manifest = await readTrashManifest(rootPath);
      const idx = manifest.findIndex((m) => m.id === id);
      if (idx === -1) continue;

      const meta = manifest[idx];
      const storedPath = path.join(getTrashDirForRoot(rootPath), meta.id);
      if (!fs.existsSync(storedPath)) {
        manifest.splice(idx, 1);
        await writeTrashManifest(rootPath, manifest);
        continue;
      }

      const targetDir = path.dirname(meta.originalPath);
      await fsp.mkdir(targetDir, { recursive: true });
      let destPath = meta.originalPath;
      if (fs.existsSync(destPath)) {
        const ext = meta.isDirectory ? '' : path.extname(meta.name);
        const base = meta.isDirectory ? meta.name : path.basename(meta.name, ext);
        destPath = path.join(targetDir, `${base} (wiederhergestellt ${Date.now()})${ext}`);
      }
      await safeRename(storedPath, destPath);
      manifest.splice(idx, 1);
      await writeTrashManifest(rootPath, manifest);
      restored += 1;
      break;
    }
  }
  return { ok: true, restored };
}

async function deleteTrashItems(items, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const list = Array.isArray(items) ? items : [items];
  const roots = getAllowedRoots(configMediaPaths);
  let removed = 0;

  for (const entry of list) {
    const rawKey = typeof entry === 'string' ? entry : entry?.trashKey || '';
    const [rootHint, id] = rawKey.includes('::') ? rawKey.split('::') : [null, rawKey];
    if (!id) continue;

    for (const rootPath of roots) {
      if (rootHint && rootPath !== rootHint) continue;
      const manifest = await readTrashManifest(rootPath);
      const idx = manifest.findIndex((m) => m.id === id);
      if (idx === -1) continue;

      const storedPath = path.join(getTrashDirForRoot(rootPath), id);
      if (fs.existsSync(storedPath)) {
        await fsp.rm(storedPath, { recursive: true, force: true });
      }
      manifest.splice(idx, 1);
      await writeTrashManifest(rootPath, manifest);
      removed += 1;
      break;
    }
  }
  return { ok: true, removed };
}

async function emptyTrash(configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const roots = getAllowedRoots(configMediaPaths);
  let removed = 0;
  for (const rootPath of roots) {
    const trashDir = getTrashDirForRoot(rootPath);
    if (!fs.existsSync(trashDir)) continue;
    const manifest = await readTrashManifest(rootPath);
    removed += manifest.length;
    await fsp.rm(trashDir, { recursive: true, force: true });
  }
  return { ok: true, removed };
}

async function deleteLiveItems(paths, configMediaPaths = [], permanent = false) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  if (!permanent) {
    return await moveItemsToTrash(paths, configMediaPaths);
  }
  const list = Array.isArray(paths) ? paths : [paths];
  const roots = getAllowedRoots(configMediaPaths);
  for (const targetPath of list) {
    const realTarget = assertAllowedPath(targetPath, roots);
    await statExisting(realTarget);
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
  await statExisting(realDir);
  const destPath = path.join(realDir, cleanName);
  await fsp.writeFile(destPath, buffer);
  return { ok: true, path: destPath, sizeBytes: buffer.length };
}

async function readLiveTextFile(targetPath, configMediaPaths = []) {
  const roots = getAllowedRoots(configMediaPaths);
  const realFile = assertAllowedPath(targetPath, roots);
  const st = await statExisting(realFile);
  if (!st.isFile()) throw new Error('Keine Datei');
  if (st.size > 2 * 1024 * 1024) throw new Error('Datei zu groß für den Browser-Editor (Max 2 MB).');
  const buf = await fsp.readFile(realFile);
  const sampleLen = Math.min(buf.length, 8192);
  for (let i = 0; i < sampleLen; i += 1) {
    if (buf[i] === 0) {
      const err = new Error('Binärdatei kann nicht im Text-Editor geöffnet werden.');
      err.statusCode = 400;
      throw err;
    }
  }
  const content = buf.toString('utf8');
  return { path: realFile, name: path.basename(realFile), ext: path.extname(realFile).toLowerCase(), content };
}

async function writeLiveTextFile(targetPath, content, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const roots = getAllowedRoots(configMediaPaths);
  const realFile = assertAllowedPath(targetPath, roots);
  await fsp.writeFile(realFile, String(content ?? ''), 'utf8');
  return { ok: true };
}

function getCommonAncestorDir(absPaths) {
  const dirs = absPaths.map((p) => path.dirname(p).split(path.sep));
  let prefix = dirs[0];
  for (let i = 1; i < dirs.length; i += 1) {
    const cur = dirs[i];
    let j = 0;
    while (j < prefix.length && j < cur.length && prefix[j] === cur[j]) j += 1;
    prefix = prefix.slice(0, j);
  }
  const joined = prefix.join(path.sep);
  return joined || path.sep;
}

async function streamZipDownload(paths, res, configMediaPaths = []) {
  const list = Array.isArray(paths) ? paths : [paths];
  if (list.length === 0) {
    const err = new Error('Keine Dateien ausgewählt');
    err.statusCode = 400;
    throw err;
  }
  const roots = getAllowedRoots(configMediaPaths);
  const realItems = [];
  for (const p of list) {
    const resolved = assertAllowedPath(p, roots);
    await statExisting(resolved);
    realItems.push(resolved);
  }

  const baseDir = getCommonAncestorDir(realItems);
  const relNames = realItems.map((p) => path.relative(baseDir, p) || path.basename(p));
  const rawDownloadName = realItems.length === 1
    ? `${path.basename(realItems[0]).replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`
    : 'homeserver-archiv.zip';

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${rawDownloadName}"`,
    'X-Content-Type-Options': 'nosniff'
  });

  const zipProc = spawn('zip', ['-r', '-', ...relNames], {
    cwd: baseDir,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  zipProc.stdout.pipe(res);
  res.once('close', () => {
    if (!zipProc.killed) zipProc.kill('SIGTERM');
  });
  zipProc.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end();
  });
}

async function extractLiveArchive(archivePath, configMediaPaths = []) {
  if (!ALLOW_WRITE) throw new Error('Schreibzugriff ist deaktiviert.');
  const roots = getAllowedRoots(configMediaPaths);
  const realArchive = assertAllowedPath(archivePath, roots);
  await statExisting(realArchive);
  const destDir = path.dirname(realArchive);
  const lower = realArchive.toLowerCase();

  if (lower.endsWith('.zip')) {
    await execFileAsync('unzip', ['-o', realArchive, '-d', destDir], { timeout: 120_000 });
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
    await execFileAsync('tar', ['--no-same-owner', '-xf', realArchive, '-C', destDir], { timeout: 120_000 });
  } else {
    throw new Error('Unterstützte Formate zum Entpacken: .zip, .tar, .tar.gz, .tgz');
  }
  return { ok: true };
}

async function streamVideoTranscode(req, res, requestedPath, startSeconds = 0, configMediaPaths = []) {
  const roots = getAllowedRoots(configMediaPaths);
  const realFile = assertAllowedPath(requestedPath, roots);
  const st = await statExisting(realFile);
  if (!st.isFile()) {
    const err = new Error('Videodatei nicht gefunden');
    err.statusCode = 404;
    throw err;
  }

  if (!hasFfmpeg()) {
    const err = new Error('Live-Transkodierung erfordert ffmpeg (im Docker-Image vorinstalliert). Bitte „Herunterladen“ oder natives MP4/WebM nutzen.');
    err.statusCode = 501;
    throw err;
  }

  const start = Math.max(0, Math.min(86400, Number(startSeconds) || 0));
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    ...(start > 0 ? ['-ss', String(start)] : []),
    '-i', realFile,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  ];

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  ff.stdout.pipe(res);
  res.once('close', () => {
    if (!ff.killed) ff.kill('SIGKILL');
  });
  ff.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end();
  });
}

function sendFallbackSvgThumb(res, label = 'VIDEO') {
  const safeLabel = String(label || 'VIDEO').replace(/[^A-Z0-9._-]/gi, '').slice(0, 8).toUpperCase() || 'VIDEO';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">` +
    `<rect width="320" height="200" rx="14" fill="#181c24"/>` +
    `<circle cx="160" cy="88" r="30" fill="#2c3342"/>` +
    `<polygon points="151,74 151,102 176,88" fill="#e5e9f0"/>` +
    `<text x="160" y="148" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" font-weight="600" fill="#9aa5b5">${safeLabel}</text>` +
    `</svg>`;
  const buf = Buffer.from(svg, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(buf);
}

async function streamThumbnail(req, res, requestedPath, configMediaPaths = []) {
  const roots = getAllowedRoots(configMediaPaths);
  const realFile = assertAllowedPath(requestedPath, roots);
  const st = await statExisting(realFile);
  if (!st.isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }

  const ext = path.extname(realFile).toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);
  const isImage = IMAGE_EXTS.has(ext);

  if (!hasFfmpeg() || ext === '.svg') {
    if (isImage) {
      return await streamLiveFile(req, res, realFile, configMediaPaths, { inline: true });
    }
    if (isVideo) {
      return sendFallbackSvgThumb(res, ext.slice(1) || 'VIDEO');
    }
    res.writeHead(404);
    res.end();
    return;
  }

  const thumbDir = path.join(DATA_DIR, 'thumbs');
  await fsp.mkdir(thumbDir, { recursive: true });
  const hash = crypto.createHash('sha256').update(`${realFile}:${st.size}:${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 32);
  const thumbPath = path.join(thumbDir, `${hash}.jpg`);

  if (!fs.existsSync(thumbPath)) {
    const args = isVideo
      ? ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '2', '-i', realFile, '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '5', thumbPath]
      : ['-y', '-hide_banner', '-loglevel', 'error', '-i', realFile, '-vf', 'scale=320:-2', '-frames:v', '1', '-q:v', '5', thumbPath];
    try {
      await execFileAsync('ffmpeg', args, { timeout: 12000 });
    } catch {
      if (isImage) {
        return await streamLiveFile(req, res, realFile, configMediaPaths, { inline: true });
      }
      if (isVideo) {
        return sendFallbackSvgThumb(res, ext.slice(1) || 'VIDEO');
      }
      res.writeHead(404);
      res.end();
      return;
    }
  }

  if (fs.existsSync(thumbPath)) {
    const tStat = await fsp.stat(thumbPath);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': tStat.size,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    });
    pipeReadStream(fs.createReadStream(thumbPath), res);
    return;
  }

  if (isImage) {
    return await streamLiveFile(req, res, realFile, configMediaPaths, { inline: true });
  }
  if (isVideo) {
    return sendFallbackSvgThumb(res, ext.slice(1) || 'VIDEO');
  }
  res.writeHead(404);
  res.end();
}

async function searchLiveFiles(query, configMediaPaths = [], limit = 80) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { query: '', items: [], truncated: false };

  const roots = getAllowedRoots(configMediaPaths);
  const results = [];
  const maxResults = Math.max(10, Math.min(200, Number(limit) || 80));
  const MAX_VISITED = 15000;
  const MAX_DEPTH = 8;
  let visited = 0;
  let truncated = false;

  const stack = roots.map((r) => ({ dir: r, depth: 0 }));

  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === TRASH_DIR_NAME || entry.name === 'lost+found' || entry.name === '@eaDir' || entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      if (entry.name.startsWith('.') && !entry.name.startsWith('.env') && entry.name !== '.gitignore' && entry.name !== '.dockerignore') {
        continue;
      }
      visited += 1;
      if (visited > MAX_VISITED) {
        truncated = true;
        break;
      }

      const fullPath = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      const lowerName = entry.name.toLowerCase();
      if (lowerName.includes(q)) {
        try {
          const st = await fsp.stat(fullPath);
          const ext = isDir ? '' : path.extname(entry.name).toLowerCase();
          results.push({
            name: entry.name,
            path: fullPath,
            parentDir: dir,
            isDirectory: isDir,
            kind: isDir ? 'folder' : classifyFileKind(ext, entry.name),
            sizeBytes: isDir ? 0 : st.size,
            modifiedAt: st.mtime.toISOString(),
            ext
          });
          if (results.length >= maxResults) {
            truncated = true;
            break;
          }
        } catch {
          // ignore
        }
      }

      if (isDir && depth < MAX_DEPTH) {
        stack.push({ dir: fullPath, depth: depth + 1 });
      }
    }
    if (truncated) break;
  }

  return {
    query: String(query).trim(),
    allowWrite: ALLOW_WRITE,
    truncated,
    items: results
  };
}

async function cleanupExpiredTrash(maxAgeDays = 30, configMediaPaths = []) {
  const days = Math.max(1, Number(maxAgeDays) || 30);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const roots = getAllowedRoots(configMediaPaths);
  let removedCount = 0;

  for (const rootPath of roots) {
    const trashDir = getTrashDirForRoot(rootPath);
    if (!fs.existsSync(trashDir)) continue;
    const manifest = await readTrashManifest(rootPath);
    const keep = [];
    let changed = false;

    for (const item of manifest) {
      const deletedTs = item.deletedAt ? new Date(item.deletedAt).getTime() : 0;
      if (deletedTs > 0 && deletedTs < cutoffMs) {
        const storedPath = path.join(trashDir, item.id);
        if (fs.existsSync(storedPath)) {
          await fsp.rm(storedPath, { recursive: true, force: true });
        }
        removedCount += 1;
        changed = true;
      } else {
        keep.push(item);
      }
    }
    if (changed) {
      await writeTrashManifest(rootPath, keep);
    }
  }
  return { ok: true, removedCount };
}

module.exports = {
  getAllowedRoots,
  assertAllowedPath,
  classifyFileKind,
  hasFfmpeg,
  listLiveDirectory,
  listDirectoriesOnly,
  streamLiveFile,
  streamVideoTranscode,
  streamThumbnail,
  searchLiveFiles,
  cleanupExpiredTrash,
  createLiveFolder,
  renameLiveItem,
  copyOrMoveLiveItems,
  deleteLiveItems,
  listTrash,
  restoreFromTrash,
  deleteTrashItems,
  emptyTrash,
  saveLiveUpload,
  readLiveTextFile,
  writeLiveTextFile,
  streamZipDownload,
  extractLiveArchive
};
