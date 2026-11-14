const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STACKS_DIR = path.join(DATA_DIR, 'stacks');
const TEMPLATES_FILE = path.join(process.cwd(), 'config', 'compose-templates.json');

function ensureStacksDir() {
  if (!fs.existsSync(STACKS_DIR)) {
    fs.mkdirSync(STACKS_DIR, { recursive: true });
  }
}

function sanitizeStackName(name) {
  const clean = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
  if (!clean) throw new Error('Ungültiger Stack-Name');
  return clean;
}

function getComposeTemplates() {
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function listStacks(isDemo = false) {
  ensureStacksDir();
  const dirs = await fsp.readdir(STACKS_DIR, { withFileTypes: true });
  const stacks = [];

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const ymlPath = path.join(STACKS_DIR, d.name, 'docker-compose.yml');
    if (fs.existsSync(ymlPath)) {
      const yaml = await fsp.readFile(ymlPath, 'utf8');
      const st = await fsp.stat(ymlPath);
      stacks.push({
        name: d.name,
        path: ymlPath,
        yaml,
        updatedAt: st.mtime.toISOString(),
        mode: isDemo ? 'demo' : 'live'
      });
    }
  }

  return stacks.sort((a, b) => a.name.localeCompare(b.name));
}

async function deployStack(stackName, yamlContent, isDemo = false) {
  const ALLOW_CONTROL = String(process.env.ALLOW_DOCKER_CONTROL || 'false').toLowerCase() === 'true';
  if (!isDemo && !ALLOW_CONTROL) {
    throw new Error('Container-Steuerung ist deaktiviert (ALLOW_DOCKER_CONTROL=true setzen).');
  }

  const clean = sanitizeStackName(stackName);
  if (!yamlContent || !yamlContent.includes('services:')) {
    throw new Error('Ungültige docker-compose.yml (Abschnitt "services:" fehlt).');
  }

  ensureStacksDir();
  const stackDir = path.join(STACKS_DIR, clean);
  await fsp.mkdir(stackDir, { recursive: true });
  const ymlPath = path.join(stackDir, 'docker-compose.yml');
  await fsp.writeFile(ymlPath, yamlContent, 'utf8');

  if (isDemo) {
    return {
      ok: true,
      name: clean,
      output: `[Demo] Stack "${clean}" gespeichert und simuliert gestartet.`
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['compose', '-p', clean, '-f', ymlPath, 'up', '-d', '--remove-orphans'],
      { timeout: 300_000 }
    );
    return {
      ok: true,
      name: clean,
      output: `${stdout}\n${stderr}`.trim() || 'Stack gestartet.'
    };
  } catch (err) {
    throw new Error(`Docker Compose Fehler: ${err.stderr || err.message}`);
  }
}

async function stopOrRemoveStack(stackName, action = 'down', isDemo = false) {
  const ALLOW_CONTROL = String(process.env.ALLOW_DOCKER_CONTROL || 'false').toLowerCase() === 'true';
  if (!isDemo && !ALLOW_CONTROL) {
    throw new Error('Container-Steuerung ist deaktiviert.');
  }

  const clean = sanitizeStackName(stackName);
  const stackDir = path.join(STACKS_DIR, clean);
  const ymlPath = path.join(stackDir, 'docker-compose.yml');

  if (!isDemo && fs.existsSync(ymlPath)) {
    const cmdArgs =
      action === 'pull'
        ? ['compose', '-p', clean, '-f', ymlPath, 'pull']
        : action === 'up'
        ? ['compose', '-p', clean, '-f', ymlPath, 'up', '-d']
        : ['compose', '-p', clean, '-f', ymlPath, 'down'];

    const { stdout, stderr } = await execFileAsync('docker', cmdArgs, { timeout: 300_000 });
    if (action === 'pull') {
      await execFileAsync('docker', ['compose', '-p', clean, '-f', ymlPath, 'up', '-d'], { timeout: 120_000 });
    }
    if (action === 'delete') {
      await fsp.rm(stackDir, { recursive: true, force: true });
    }
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  }

  if (action === 'delete' && fs.existsSync(stackDir)) {
    await fsp.rm(stackDir, { recursive: true, force: true });
  }
  return { ok: true, output: `[Demo] Aktion "${action}" für Stack "${clean}" ausgeführt.` };
}

module.exports = {
  getComposeTemplates,
  listStacks,
  deployStack,
  stopOrRemoveStack
};
