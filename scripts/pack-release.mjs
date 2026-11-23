import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.tmp', 'release');
const stage = join(output, 'package');
const names = ['cli', 'engine', 'core', 'contract', 'surfnet', 'sandbox', 'review'];
const manifests = new Map(
  names.map((name) => [name, JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'))]),
);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const dependencies = {};
const compiledFiles = [];
for (const manifest of manifests.values()) {
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith('@oms/')) continue;
    if (dependencies[name] && dependencies[name] !== version) throw new Error(`Conflicting dependency: ${name}`);
    dependencies[name] = version;
  }
}

function copySource(path) {
  const source = join(root, path);
  const target = join(stage, path);
  mkdirSync(dirname(target), { recursive: true });
  if (!path.endsWith('.ts')) {
    cpSync(source, target);
    return;
  }
  const input = readFileSync(source, 'utf8')
    .replace(/(new URL\(['"]\.{1,2}\/[^'"]+)\.ts(['"],\s*import\.meta\.url\))/g, '$1.js$2')
    .replace(/(['"])@oms\/([^/'"]+)([^'"]*)\1/g, (_match, quote, name, subpath) => {
      const exported = manifests.get(name)?.exports[subpath ? `.${subpath}` : '.'];
      if (typeof exported !== 'string') throw new Error(`Unknown workspace export: ${name}${subpath}`);
      let specifier = relative(dirname(path), join('packages', name, exported)).replaceAll('\\', '/');
      if (!specifier.startsWith('.')) specifier = `./${specifier}`;
      return `${quote}${specifier}${quote}`;
    });
  const result = ts.transpileModule(input, {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      rewriteRelativeImportExtensions: true,
      verbatimModuleSyntax: true,
    },
    reportDiagnostics: true,
  });
  if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error(`Cannot compile ${path}`);
  }
  const compiled = target.replace(/\.ts$/, '.js');
  writeFileSync(compiled, result.outputText);
  compiledFiles.push(compiled);
}
function copyTree(path) {
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) copyTree(child);
    else if (entry.isFile() && !entry.name.endsWith('.d.ts')) copySource(child);
  }
}
for (const name of names) copyTree(`packages/${name}/src`);
if (existsSync(join(root, 'packages/cli/art'))) copyTree('packages/cli/art');
copySource('scripts/start-local.ts');
copySource('packages/engine/runtime-manifest.json');
copySource('packages/engine/NOTES.md');
for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md']) copySource(file);
copyTree('licenses');
copyTree('docs');
for (const file of compiledFiles) {
  for (const match of readFileSync(file, 'utf8').matchAll(
    /new URL\(['"](\.{1,2}\/[^'"]+\.js)['"],\s*import\.meta\.url\)/g,
  )) {
    if (!existsSync(resolve(dirname(file), match[1])))
      throw new Error(`Missing compiled URL in ${relative(stage, file)}: ${match[1]}`);
  }
}
// The release version lives here, not in the root package.json, so the private workspaces stay at 0.0.1.
const version = '0.1.3';
const { overrides } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: '@barestate/oms',
      version,
      description:
        'Oh My Sol (OMS): an AI coding tool for Solana. Runs Claude, GPT and other models with current Solana references, a local Surfpool chain and an independent check before a task closes.',
      keywords: [
        'solana',
        'anchor',
        'solana-development',
        'ai-coding-agent',
        'coding-agent',
        'claude-code',
        'codex',
        'surfpool',
        'agave',
        'smart-contracts',
        'rust',
        'llm',
      ],
      homepage: 'https://barestate.xyz/oh-my-sol',
      bugs: { url: 'https://barestate.xyz/contact' },
      author: 'Barestate (https://barestate.xyz)',
      type: 'module',
      license: 'MIT',
      engines: { node: '>=22.19.0' },
      publishConfig: { access: 'public' },
      bin: { oms: './packages/cli/src/bin.js' },
      dependencies,
      overrides,
      bundleDependencies: Object.keys(dependencies),
    },
    null,
    2,
  ) + '\n',
);
// Bundle the resolved tree: consumer installs ignore this package's overrides.
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'pipe' });
// npm omits package-lock.json from archives; the verifier reads the lock from the install root.
cpSync(join(stage, 'package-lock.json'), join(stage, 'npm-shrinkwrap.json'));
pruneSourceMaps(join(stage, 'node_modules'));
stripBundledScripts(join(stage, 'node_modules'));
// npm runs a bundled dependency's install hooks when the package is installed, so none may carry a scripts section.
function stripBundledScripts(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      stripBundledScripts(path);
      continue;
    }
    const manifestPath = join(path, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      // A binding.gyp makes npm infer `node-gyp rebuild` as an install step unless gypfile is false.
      const changed = manifest.scripts !== undefined || manifest.gypfile !== undefined;
      delete manifest.scripts;
      if (existsSync(join(path, 'binding.gyp'))) manifest.gypfile = false;
      else delete manifest.gypfile;
      if (changed || existsSync(join(path, 'binding.gyp')))
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
    const nested = join(path, 'node_modules');
    if (existsSync(nested)) stripBundledScripts(nested);
  }
}
rmSync(join(stage, 'node_modules/@earendil-works/pi-coding-agent/docs/images'), { recursive: true, force: true });
function pruneSourceMaps(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) pruneSourceMaps(path);
    else if (entry.isFile() && entry.name.endsWith('.map')) rmSync(path);
  }
}
// npm only keeps the executable bit on the bin file when the staged copy already has it.
chmodSync(join(stage, 'packages/cli/src/bin.js'), 0o755);
const [packed] = JSON.parse(
  execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], {
    cwd: stage,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }),
);
if (packed.size > 25_000_000) throw new Error(`Archive exceeds 25 MB: ${packed.size} bytes`);
verifyArchiveImports(packed.files.map((file) => file.path));
// Every relative ESM import in the archive must name a file the archive ships, or `oms` fails to start once installed.
function verifyArchiveImports(paths) {
  const shipped = new Set(paths);
  const missing = new Set();
  for (const path of paths) {
    if (!/\.m?js$/.test(path)) continue;
    const text = readFileSync(join(stage, path), 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
    for (const match of text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\s]+\.(?:m?js|json))\1/g,
    )) {
      const target = join(dirname(path), match[2]).replaceAll('\\', '/');
      if (!shipped.has(target)) missing.add(`${path} imports ${match[2]}`);
    }
  }
  if (missing.size) throw new Error(`Archive is missing imported files:\n${[...missing].join('\n')}`);
}
console.log(`${join(output, packed.filename)}\n${packed.size} bytes compressed; ${packed.unpackedSize} bytes unpacked`);
