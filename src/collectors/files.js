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

// ==================== DEMO MODE VIRTUAL FILESYSTEM ====================
const demoTextContents = {
  '/mnt/backup/System_Snapshots/docker-compose-backup.yml':
    'services:\n  immich-server:\n    image: ghcr.io/immich-app/immich-server:release\n    ports:\n      - "2283:2283"\n    volumes:\n      - /mnt/fotos:/usr/src/app/upload\n',
  '/mnt/backup/System_Snapshots/immich.env':
    'TZ=Europe/Berlin\nUPLOAD_LOCATION=/mnt/fotos\nDB_DATA_LOCATION=/opt/stacks/immich/postgres\n'
};

const demoTree = {
  '/mnt/fotos': [
    { name: '2026_Norwegen', isDirectory: true, kind: 'folder', sizeBytes: 0, modifiedAt: '2026-11-12T18:20:00Z' },
    { name: '2025_Italien', isDirectory: true, kind: 'folder', sizeBytes: 0, modifiedAt: '2025-09-18T14:10:00Z' },
    { name: 'Handy_Backup', isDirectory: true, kind: 'folder', sizeBytes: 0, modifiedAt: '2026-11-14T09:15:00Z' },
    { name: 'Alpen_Panorama.svg', isDirectory: false, kind: 'image', ext: '.svg', sizeBytes: 4820000, modifiedAt: '2026-11-10T16:40:00Z' },
    { name: 'Familienfeier_2026.svg', isDirectory: false, kind: 'image', ext: '.svg', sizeBytes: 3450000, modifiedAt: '2026-10-22T20:12:00Z' }
  ],
  '/mnt/fotos/2026_Norwegen': [
    { name: 'Geirangerfjord_Sonnenuntergang.svg', isDirectory: false, kind: 'image', ext: '.svg', sizeBytes: 6420000, modifiedAt: '2026-11-12T18:20:00Z' },
    { name: 'DSC_8492.ARW', isDirectory: false, kind: 'image', ext: '.arw', sizeBytes: 54945382, modifiedAt: '2026-11-12T18:15:00Z' },
    { name: 'Drohnenflug_Fjord_4K.mp4', isDirectory: false, kind: 'video', ext: '.mp4', sizeBytes: 2840000000, modifiedAt: '2026-11-12T17:50:00Z' }
  ],
  '/mnt/fotos/2025_Italien': [
    { name: 'Toskana_Morgennebel.svg', isDirectory: false, kind: 'image', ext: '.svg', sizeBytes: 5120000, modifiedAt: '2025-09-18T08:30:00Z' },
    { name: 'Rom_Abendspaziergang.jpg', isDirectory: false, kind: 'image', ext: '.jpg', sizeBytes: 4210000, modifiedAt: '2025-09-16T21:10:00Z' }
  ],
  '/mnt/fotos/Handy_Backup': [
    { name: 'IMG_4921.HEIC', isDirectory: false, kind: 'image', ext: '.heic', sizeBytes: 4299161, modifiedAt: '2026-11-14T09:15:00Z' },
    { name: 'VID_20261113.mp4', isDirectory: false, kind: 'video', ext: '.mp4', sizeBytes: 184000000, modifiedAt: '2026-11-13T19:45:00Z' }
  ],
  '/mnt/filme': [
    { name: '4K_HDR_Sammlung', isDirectory: true, kind: 'folder', sizeBytes: 0, modifiedAt: '2026-11-08T20:00:00Z' },
    { name: 'Dokumentationen', isDirectory: true, kind: 'folder', sizeBytes: 0, modifiedAt: '2026-10-30T15:00:00Z' },
    { name: 'Heimkino_Demo_4K.mkv', isDirectory: false, kind: 'video', ext: '.mkv', sizeBytes: 18400000000, modifiedAt: '2026-11-05T21:00:00Z' }
  ],
  '/mnt/filme/4K_HDR_Sammlung': [
    { name: 'Interstellar_2160p_HDR.mkv', isDirectory: false, kind: 'video', ext: '.mkv', sizeBytes: 42600000000, modifiedAt: '2026-11-08T20:00:00Z' },
    { name: 'Dune_Part_Two_4K.mkv', isDirectory: false, kind: 'video', ext: '.mkv', sizeBytes: 38200000000, modifiedAt: '2026-10-19T18:22:00Z' }
  ],
  '/mnt/filme/Dokumentationen': [
    { name: 'Planet_Erde_III_01.mp4', isDirectory: false, kind: 'video', ext: '.mp4', sizeBytes: 4850000000, modifiedAt: '2026-10-30T15:00:00Z' }
  ],
  '/mnt/serien': [
    { name: 'Dark_Staffel_1-3', isDirectory: true, kind: 'folder', sizeBytes: 0, modifiedAt: '2026-10-12T11:00:00Z' },
    { name: 'FLAC_Musikbibliothek', isDirectory: true, kind: 'folder', sizeBytes: 0, modifiedAt: '2026-11-01T10:15:00Z' }
  ],
  '/mnt/serien/Dark_Staffel_1-3': [
    { name: 'Dark.S01E01.Geheimnisse.mkv', isDirectory: false, kind: 'video', ext: '.mkv', sizeBytes: 3420000000, modifiedAt: '2026-10-12T11:00:00Z' }
  ],
  '/mnt/serien/FLAC_Musikbibliothek': [
    { name: 'Album_01_Intro.flac', isDirectory: false, kind: 'audio', ext: '.flac', sizeBytes: 38400000, modifiedAt: '2026-11-01T10:15:00Z' }
  ],
  '/mnt/backup': [
    { name: 'System_Snapshots', isDirectory: true, kind: 'folder', sizeBytes: 0, modifiedAt: '2026-11-14T03:00:00Z' },
    { name: 'Steuer_2025_Archiv.pdf', isDirectory: false, kind: 'document', ext: '.pdf', sizeBytes: 2450000, modifiedAt: '2026-06-15T12:00:00Z' },
    { name: 'Heimserver_Backup_2026-11.tar.zst', isDirectory: false, kind: 'archive', ext: '.zst', sizeBytes: 19542100000, modifiedAt: '2026-11-14T03:00:00Z' }
  ],
  '/mnt/backup/System_Snapshots': [
    { name: 'docker-compose-backup.yml', isDirectory: false, kind: 'text', ext: '.yml', sizeBytes: 4280, modifiedAt: '2026-11-14T03:00:00Z' },
    { name: 'immich.env', isDirectory: false, kind: 'text', ext: '.env', sizeBytes: 120, modifiedAt: '2026-11-14T03:00:00Z' }
  ]
};

const demoRoots = [
  { name: 'fotos (8TB)', path: '/mnt/fotos' },
  { name: 'filme (12TB)', path: '/mnt/filme' },
  { name: 'serien (8TB)', path: '/mnt/serien' },
  { name: 'backup (4TB)', path: '/mnt/backup' }
];

function listDemoDirectory(requestedPath) {
  if (!requestedPath || requestedPath === '/') {
    return {
      allowWrite: true,
      currentPath: '/',
      parentPath: null,
      roots: demoRoots,
      items: demoRoots.map((r) => ({
        name: r.name,
        path: r.path,
        isDirectory: true,
        kind: 'folder',
        sizeBytes: 0,
        modifiedAt: '2026-11-14T09:00:00Z',
        ext: ''
      }))
    };
  }

  const entries = demoTree[requestedPath] || [];
  const isRoot = demoRoots.some((r) => r.path === requestedPath);
  const parentPath = isRoot ? '/' : path.posix.dirname(requestedPath);

  return {
    allowWrite: true,
    currentPath: requestedPath,
    parentPath,
    roots: demoRoots,
    items: entries.map((e) => ({
      ...e,
      path: `${requestedPath}/${e.name}`,
      ext: e.ext || ''
    }))
  };
}

function sendDemoPreview(res, requestedPath) {
  const name = path.basename(requestedPath || 'Foto');
  const hash = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = hash % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="hsl(${hue}, 32%, 18%)"/>
        <stop offset="65%" stop-color="hsl(${(hue + 25) % 360}, 28%, 35%)"/>
        <stop offset="100%" stop-color="#e59a3c"/>
      </linearGradient>
    </defs>
    <rect width="960" height="540" fill="url(#sky)"/>
    <path d="M0 390 L180 260 L340 340 L520 200 L720 330 L960 230 L960 540 L0 540 Z" fill="#151c24" opacity="0.88"/>
    <path d="M0 430 L260 320 L480 410 L760 290 L960 380 L960 540 L0 540 Z" fill="#0d1116"/>
    <text x="48" y="485" fill="#edf0f4" font-family="sans-serif" font-size="22" font-weight="600">${name.replace(/[<>&"]/g, '')}</text>
    <text x="48" y="512" fill="#98a1af" font-family="monospace" font-size="14">Demo-Vorschau · ${requestedPath.replace(/[<>&"]/g, '')}</text>
  </svg>`;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
  res.end(svg);
}

function demoCreateFolder(parentDir, folderName) {
  const cleanName = path.posix.basename(String(folderName || '').trim());
  if (!cleanName || !demoTree[parentDir]) throw new Error('Ordner kann in Demo nur in bestehenden Pfaden angelegt werden.');
  const newPath = `${parentDir}/${cleanName}`;
  if (!demoTree[newPath]) {
    demoTree[newPath] = [];
    demoTree[parentDir].unshift({
      name: cleanName,
      isDirectory: true,
      kind: 'folder',
      sizeBytes: 0,
      modifiedAt: new Date().toISOString()
    });
  }
  return { ok: true, path: newPath };
}

function demoRenameItem(targetPath, newName) {
  const cleanName = path.posix.basename(String(newName || '').trim());
  const dir = path.posix.dirname(targetPath);
  const oldBase = path.posix.basename(targetPath);
  if (demoTree[dir]) {
    const entry = demoTree[dir].find((i) => i.name === oldBase);
    if (entry) entry.name = cleanName;
  }
  if (demoTree[targetPath]) {
    demoTree[`${dir}/${cleanName}`] = demoTree[targetPath];
    delete demoTree[targetPath];
  }
  return { ok: true };
}

function demoCopyOrMove(sources, destDir, move = false) {
  if (!demoTree[destDir]) throw new Error('Zielordner in Demo nicht gefunden.');
  for (const src of sources) {
    const srcDir = path.posix.dirname(src);
    const base = path.posix.basename(src);
    const entry = (demoTree[srcDir] || []).find((i) => i.name === base);
    if (!entry) continue;
    if (!demoTree[destDir].some((i) => i.name === base)) {
      demoTree[destDir].push({ ...entry });
    }
    if (move && demoTree[srcDir]) {
      demoTree[srcDir] = demoTree[srcDir].filter((i) => i.name !== base);
    }
  }
  return { ok: true };
}

function demoDeleteItems(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  for (const targetPath of list) {
    const dir = path.posix.dirname(targetPath);
    const base = path.posix.basename(targetPath);
    if (demoTree[dir]) {
      demoTree[dir] = demoTree[dir].filter((item) => item.name !== base);
    }
    delete demoTree[targetPath];
  }
  return { ok: true };
}

function demoReadText(targetPath) {
  return {
    path: targetPath,
    name: path.posix.basename(targetPath),
    content: demoTextContents[targetPath] || `# Beispiel-Datei: ${path.posix.basename(targetPath)}\n`
  };
}

function demoWriteText(targetPath, content) {
  demoTextContents[targetPath] = String(content ?? '');
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
  extractLiveArchive,
  listDemoDirectory,
  sendDemoPreview,
  demoCreateFolder,
  demoRenameItem,
  demoCopyOrMove,
  demoDeleteItems,
  demoReadText,
  demoWriteText
};
