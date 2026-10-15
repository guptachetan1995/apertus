'use strict';

// What `make run` ships, checked without Docker: the Dockerfile and Makefiles say what the
// documents say they do, the host-side preflight script behaves, and the exact set of files the
// Dockerfile copies is enough to boot the server, read-only, and pass the image's own healthcheck.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const DOCKERFILE = read('Dockerfile');
const MAKEFILE = read('Makefile');

function dockerfileLines() {
  return DOCKERFILE.replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
}

function preflight(mode, { env = {}, envFile = '' } = {}) {
  const clean = { PATH: process.env.PATH };
  const run = spawnSync('sh', [path.join(ROOT, 'scripts', 'preflight.sh'), mode, envFile], {
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

describe('Dockerfile', () => {
  const lines = dockerfileLines();
  const instruction = (name) => lines.filter((line) => line.toUpperCase().startsWith(`${name} `));

  test('is pinned to an exact Node.js release and an image digest', () => {
    expect(instruction('FROM')).toHaveLength(1);
    expect(instruction('FROM')[0]).toMatch(/^FROM node:24\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/);
  });

  test('runs as the unprivileged node user, with a healthcheck', () => {
    expect(instruction('USER')).toEqual(['USER node']);
    expect(lines.findIndex((line) => line.startsWith('USER '))).toBeGreaterThan(lines.findIndex((line) => line.startsWith('RUN ')));
    expect(instruction('HEALTHCHECK')).toHaveLength(1);
  });

  test('bakes in no secret: no LLM variable, no key-like ENV or ARG, no whole-directory copy', () => {
    for (const line of [...instruction('ENV'), ...instruction('ARG')]) {
      expect(line).not.toMatch(/LLM_|KEY|TOKEN|SECRET|PASSWORD/i);
    }
    for (const line of instruction('COPY')) {
      expect(line).not.toMatch(/\.env|COPY\s+(--\S+\s+)*\.\s/);
    }
    expect(DOCKERFILE).not.toMatch(/ADD\s/);
  });

  test('tells the server it runs in a container, so a loopback LLM_BASE_URL is pointed at the host', () => {
    expect(instruction('ENV').join(' ')).toMatch(/APERTUS_IN_CONTAINER=1/);
    expect(MAKEFILE).toMatch(/--add-host host\.docker\.internal:host-gateway/);
  });

  test('installs only production dependencies, from the lockfile, with no install scripts', () => {
    const install = instruction('RUN').find((line) => line.includes('npm ci'));
    expect(install).toMatch(/npm ci --omit=dev --ignore-scripts/);
  });
});

describe('.gitattributes', () => {
  test.each(['.gitattributes', '../.gitattributes'])('%s keeps shell scripts, Makefiles and the Dockerfile on LF line endings', (file) => {
    const lines = read(file).split('\n').map((line) => line.trim());
    for (const pattern of ['*.sh', 'Makefile', 'Dockerfile']) expect(lines).toContain(`${pattern} text eol=lf`);
  });
});

describe('.dockerignore', () => {
  const ignored = read('.dockerignore').split('\n').map((line) => line.trim());

  test('keeps env files, tests and documents out of the build context', () => {
    for (const entry of ['.env', '.env.*', '!.env.example', 'tests', 'node_modules', '.git']) {
      expect(ignored).toContain(entry);
    }
  });
});

describe('Makefile', () => {
  test('uses tabs for recipes and declares the targets the documents name', () => {
    expect(MAKEFILE).not.toMatch(/^ +[^ #]/m);
    expect(MAKEFILE).toMatch(/^\.PHONY:.*\brun\b.*\bbuild\b.*\btest\b.*\beval\b/m);
    for (const target of ['run', 'build', 'test', 'eval']) expect(MAKEFILE).toMatch(new RegExp(`^${target}:`, 'm'));
  });

  test('make run builds, then starts the container, passing the three settings by name', () => {
    const recipe = MAKEFILE.slice(MAKEFILE.indexOf('\nrun:'), MAKEFILE.indexOf('\nbuild:')).replace(/\\\n/g, ' ');
    expect(recipe.indexOf('$(DOCKER_BUILD)')).toBeGreaterThan(-1);
    expect(recipe.indexOf('docker run')).toBeGreaterThan(recipe.indexOf('$(DOCKER_BUILD)'));
    for (const name of ['LLM_NAME', 'LLM_BASE_URL', 'LLM_API_KEY']) expect(recipe).toMatch(new RegExp(`-e ${name}(\\s|$)`));
    expect(recipe).toMatch(/-p \$\(BIND\):\$\(PORT\):3000/);
    expect(MAKEFILE).toMatch(/^BIND \?= 127\.0\.0\.1$/m);
  });

  test('never expands a secret into a recipe line, where make would echo it', () => {
    expect(MAKEFILE).not.toMatch(/\$\((LLM_[A-Z_]+|OWNER_TOKEN|AGENT_TOKEN)\)/);
    expect(MAKEFILE).not.toMatch(/LLM_[A-Z_]+=/);
  });

  test('the root Makefile forwards the same targets to track_2b', () => {
    const rootMakefile = fs.readFileSync(path.join(ROOT, '..', 'Makefile'), 'utf8');
    expect(rootMakefile).toMatch(/^\.PHONY:.*\brun\b.*\bbuild\b.*\btest\b.*\beval\b/m);
    expect(rootMakefile).toMatch(/^run build test eval:/m);
    expect(rootMakefile).toMatch(/-C track_2b \$@/);
  });
});

describe('scripts/preflight.sh', () => {
  const KEY = 'preflight-fake-key-0123456789';

  test('with nothing set, says loudly that the fixture is about to answer', () => {
    expect(preflight('check')).toMatchObject({ status: 0 });
    const banner = preflight('banner');
    expect(banner.status).toBe(0);
    expect(banner.out).toMatch(/NO MODEL ENDPOINT IS CONFIGURED/);
    expect(banner.out).toMatch(/OFFLINE FIXTURE PROVIDER/);
    expect(banner.out).toMatch(/NOT Apertus output/);
  });

  test('a half-set configuration stops make run before the build, naming what is missing', () => {
    const half = preflight('check', { env: { LLM_API_KEY: KEY } });
    expect(half.status).toBe(2);
    expect(half.err).toContain('LLM_NAME LLM_BASE_URL');
    expect(half.err.split('missing:')[1]).not.toContain('LLM_API_KEY');
    expect(half.err + half.out).not.toContain(KEY);
  });

  test('with all three set it is quiet about the fixture and never prints a value', () => {
    const env = { LLM_NAME: 'swiss-ai/Apertus-v1.5-8B', LLM_BASE_URL: 'https://example.invalid/v1', LLM_API_KEY: KEY };
    expect(preflight('check', { env }).status).toBe(0);
    const banner = preflight('banner', { env });
    expect(banner.status).toBe(0);
    expect(banner.out).not.toMatch(/OFFLINE|fixture provider/i);
    expect(banner.out + banner.err).not.toContain(KEY);
    expect(banner.out + banner.err).not.toContain('example.invalid');
  });

  test('an ENV_FILE must exist, is never read, and leaves the provider decision to the server', () => {
    expect(preflight('check', { envFile: path.join(os.tmpdir(), 'no-such-env-file-for-test') }).status).toBe(2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-env-'));
    try {
      const file = path.join(dir, 'env');
      fs.writeFileSync(file, `LLM_API_KEY=${KEY}\n`);
      expect(preflight('check', { envFile: file }).status).toBe(0);
      const banner = preflight('banner', { envFile: file });
      expect(banner.out).toContain(file);
      expect(banner.out).not.toContain(KEY);
      expect(banner.out).not.toMatch(/NO MODEL ENDPOINT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown mode is a usage error', () => {
    expect(preflight('nonsense').status).toBe(64);
  });
});

describe('the files the Dockerfile copies are enough to run the server', () => {
  let work;

  function walk(dir, visit) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full, visit);
      visit(full, entry.isDirectory());
    }
  }

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'review-triage-image-'));
    const app = path.join(work, 'app');
    fs.mkdirSync(app, { recursive: true });
    for (const line of dockerfileLines().filter((l) => l.startsWith('COPY '))) {
      const parts = line.split(/\s+/).slice(1);
      const dest = parts.pop();
      for (const source of parts) {
        const target = dest.endsWith('/') ? path.join(app, dest, path.basename(source)) : path.join(app, dest);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(path.join(ROOT, source), target, { recursive: true });
      }
    }
    // The image runs `npm ci --omit=dev`; here the installed packages are linked in instead, so
    // the test needs no network. Only the copied files are under test.
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(app, 'node_modules'), 'dir');
    walk(app, (full, isDir) => fs.chmodSync(full, isDir ? 0o555 : 0o444));
    fs.chmodSync(app, 0o555);
  });

  afterAll(() => {
    const app = path.join(work, 'app');
    fs.chmodSync(app, 0o755);
    walk(app, (full, isDir) => fs.chmodSync(full, isDir ? 0o755 : 0o644));
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('copies src and exactly the two data files the server reads', () => {
    const app = path.join(work, 'app');
    expect(fs.readdirSync(path.join(app, 'data')).sort()).toEqual(['fake-provider-fixtures.json', 'seed-reviews.json']);
    expect(fs.existsSync(path.join(app, 'src', 'server.js'))).toBe(true);
    expect(fs.existsSync(path.join(app, 'tests'))).toBe(false);
    expect(fs.existsSync(path.join(app, 'data', 'eval-set.json'))).toBe(false);
  });

  test('boots read-only on the offline fixture, prints the banner, and passes the image healthcheck', async () => {
    const app = path.join(work, 'app');
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: app,
      env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'production' },
    });
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
      const port = await new Promise((resolve, reject) => {
        const settle = (fn, value) => {
          clearTimeout(timer);
          clearInterval(poll);
          fn(value);
        };
        const timer = setTimeout(() => settle(reject, new Error(`server did not start: ${stderr}${output}`)), 8000);
        const poll = setInterval(() => {
          // The bearer-token line is the last one start() prints.
          const match = /listening on http:\/\/127\.0\.0\.1:(\d+)[\s\S]*Agent bearer token/.exec(output);
          if (match) settle(resolve, Number(match[1]));
        }, 25);
        child.once('exit', (code) => settle(reject, new Error(`server exited with ${code}: ${stderr}${output}`)));
      });
      expect(output).toMatch(/OFFLINE FIXTURE PROVIDER/);

      const healthcheck = dockerfileLines().find((line) => line.startsWith('HEALTHCHECK '));
      const script = JSON.parse(healthcheck.slice(healthcheck.indexOf('CMD [') + 4))[2];
      const check = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, PORT: String(port) } });
      expect(check.status).toBe(0);

      const down = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH, PORT: '1' } });
      expect(down.status).toBe(1);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
  });
});
