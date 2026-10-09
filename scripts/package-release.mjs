import { cp, mkdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version ?? '')) throw new Error('Usage: node scripts/package-release.mjs VERSION');
const manifest = JSON.parse(await readFile('release.json', 'utf8'));
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.version !== `v${manifest.node}`) throw new Error('Build on Linux using the pinned release Node runtime');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} failed`);
};
run('npm', ['run', 'build']);
const staging = await mkdtemp(`${tmpdir()}/sitegrid-release-`);
try {
  for (const path of ['dist', 'migrations', 'ops', 'package.json', 'package-lock.json']) await cp(path, `${staging}/${path}`, { recursive: true, filter: source => !source.includes('__pycache__') });
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging });
  await rm(`${staging}/node_modules/.bin`, { recursive: true, force: true });
  await mkdir(`${staging}/runtime/bin`, { recursive: true });
  await cp(process.execPath, `${staging}/runtime/bin/node`);
  await writeFile(`${staging}/release.json`, JSON.stringify({ ...manifest, version, arch: process.arch }, null, 2) + '\n');
  await mkdir('artifacts', { recursive: true });
  const output = resolve(`artifacts/sitegrid-${version}-linux-${process.arch}.tar.gz`);
  run('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', output, '-C', staging, '.']);
  const sha = createHash('sha256').update(await readFile(output)).digest('hex');
  await writeFile(`${output}.sha256`, `${sha}  ${output.split('/').at(-1)}\n`);
  console.log(`Release: ${output}\nSHA256: ${sha}`);
} finally { await rm(staging, { recursive: true, force: true }); }
