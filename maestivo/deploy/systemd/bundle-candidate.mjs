// Staging artifact builder only. Never starts services, transfers files, or reads credentials.
import { build, version as esbuildVersion } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entries = Object.freeze({
  server: 'apps/api/src/server.ts',
  'omr-worker': 'apps/api/src/omr-worker-main.ts',
  'identity-erasure-worker': 'apps/api/src/identity-erasure-worker-main.ts',
});

// Never let a shared node_modules symlink choose another checkout's workspace
// sources. Resolve only declared exports of these two pinned workspace packages.
export function workspaceResolverFor(sourceRoot, exportsByPackage) {
  return { name: 'pinned-workspace-packages', setup(builder) {
    builder.onResolve({ filter: /^@maestivo\// }, ({ path }) => {
      const match = /^@maestivo\/([a-z-]+)(\/.*)?$/.exec(path);
      const name = match?.[1], subpath = match?.[2] ? `.${match[2]}` : '.';
      const target = name && exportsByPackage[name]?.[subpath];
      if (typeof target !== 'string' || !target.startsWith('./src/') || target.includes('..'))
        return { errors: [{ text: `Unreviewed workspace import: ${path}` }] };
      return { path: resolve(sourceRoot, 'packages', name, target) };
    });
  } };
}

export async function buildCandidate(output) {
  if (typeof output !== 'string' || !isAbsolute(output)) throw Error('Provide an absolute path to a new staging directory.');
  const absolute = resolve(output);
  const parent = await realpath(dirname(absolute));
  const directory = join(parent, basename(absolute));
  const rel = relative(await realpath(root), directory);
  if (!rel || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel)))
    throw Error('The staging directory must be outside the repository.');
  const sourceRoot = await realpath(root);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Unable to identify the source revision.');
  // Excludes untracked files and says nothing about installed dependency integrity.
  const trackedChangesAtStart = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).length > 0;
  // mkdir without recursive: do not overwrite or clean an existing directory.
  const exportsByPackage = {};
  for (const name of ['contracts', 'score-core']) {
    const file = join(sourceRoot, 'packages', name, 'package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    if (pkg.name !== `@maestivo/${name}` || !pkg.exports || typeof pkg.exports !== 'object')
      throw Error('Workspace package metadata is invalid.');
    exportsByPackage[name] = pkg.exports;
  }
  await mkdir(directory, { mode: 0o700 });
  const result = await build({ absWorkingDir: root, entryPoints: entries, outdir: directory,
    outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', metafile: true,
    plugins: [workspaceResolverFor(sourceRoot, exportsByPackage)], logLevel: 'silent' });
  const workspaceNames = [];
  for (const input of Object.keys(result.metafile.inputs)) {
    const file = await realpath(resolve(root, input));
    if (file.split(sep).includes('node_modules')) continue; // Third-party integrity remains unverified.
    const name = relative(sourceRoot, file);
    if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name))
      throw Error('A workspace input resolved outside this checkout.');
    workspaceNames.push(name);
  }
  const uniqueNames = [...new Set(workspaceNames)].sort();
  const tracked = new Set(execFileSync('git', ['ls-files', '-z', '--', ...uniqueNames], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
  if (uniqueNames.length !== workspaceNames.length || uniqueNames.some(name => !tracked.has(name)))
    throw Error('A workspace input is not tracked or has ambiguous aliases.');
  const workspaceInputs = {};
  for (const name of uniqueNames) {
    const bytes = await readFile(join(sourceRoot, name));
    workspaceInputs[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
  const buildInputs = {};
  for (const name of ['packages/contracts/package.json', 'packages/score-core/package.json', 'deploy/systemd/bundle-candidate.mjs', 'deploy/systemd/check-omr-scratch.mjs', 'deploy/systemd/omr-ssh-bridge.mjs']) {
    const physical = await realpath(join(sourceRoot, name));
    if (physical !== join(sourceRoot, name)) throw Error('A build input is not a regular checkout path.');
    const recorded = execFileSync('git', ['ls-files', '--error-unmatch', '--', name], { cwd: root, encoding: 'utf8' }).trim();
    if (recorded !== name) throw Error('A build input is not tracked.');
    const bytes = await readFile(physical);
    buildInputs[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
  const files = {};
  for (const name of Object.keys(entries)) {
    const file = `${name}.cjs`;
    const bytes = await readFile(join(directory, file));
    files[file] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
  // A separately reviewed host unit may use this guard. Copy it as source,
  // include its digest, and never install or execute it in this staging step.
  const scratchGuard = await readFile(join(root, 'deploy/systemd/check-omr-scratch.mjs'));
  await writeFile(join(directory, 'check-omr-scratch.mjs'), scratchGuard, { flag: 'wx', mode: 0o600 });
  files['check-omr-scratch.mjs'] = { sha256: createHash('sha256').update(scratchGuard).digest('hex'), bytes: scratchGuard.length };
  const sshBridge = await readFile(join(root, 'deploy/systemd/omr-ssh-bridge.mjs'));
  await writeFile(join(directory, 'omr-ssh-bridge.mjs'), sshBridge, { flag: 'wx', mode: 0o600 });
  files['omr-ssh-bridge.mjs'] = { sha256: createHash('sha256').update(sshBridge).digest('hex'), bytes: sshBridge.length };
  const revisionAtEnd = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const trackedChangesAtEnd = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).length > 0;
  const manifest = { schemaVersion: 1, revision, revisionAtEnd, trackedChangesAtStart, trackedChangesAtEnd, sourceSnapshotVerified: false, untrackedInputsVerified: false,
    dependencyIntegrityVerified: false, esbuildVersion, nodeVersion: process.versions.node,
    files, bundledInputCount: Object.keys(result.metafile.inputs).length, workspaceInputs, buildInputs, workspaceInputsTrackedAndInCheckout: true, readyToDeploy: false };
  await writeFile(join(directory, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory, manifest };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--output-dir') throw Error('Usage: node deploy/systemd/bundle-candidate.mjs --output-dir /absolute/new-directory');
    const { manifest } = await buildCandidate(process.argv[3]);
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Candidate bundle failed.'); process.exitCode = 1; }
}
