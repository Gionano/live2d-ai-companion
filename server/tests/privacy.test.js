import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkPrivacy, committableFiles, decodeText, runtimeIdentities, scanPrivacyText } from '../../scripts/checkPrivacy.js';

const windowsPath = (...parts) => path.win32.join('X:', '/', ...parts);

test('committable text files contain no private paths, identities, emails or keys', () => {
  assert.deepEqual(checkPrivacy().findings, [], 'Privacy findings are reported as file/count pairs only.');
});

test('privacy patterns detect paths, profiles, credentials and identities case-insensitively', () => {
  const identities = [os.userInfo().username, os.hostname()];
  for (const value of identities) {
    assert.ok(scanPrivacyText(value.toUpperCase(), { identities }).machineIdentity > 0);
  }
  assert.ok(runtimeIdentities().includes(identities[0]));
  for (const value of [windowsPath('private', 'model.gguf'), windowsPath('private', 'model.gguf').replaceAll('\\', '/')]) {
    assert.equal(scanPrivacyText(value, { identities: [] }).windowsAbsolute, 1);
  }
  for (const separator of ['/', '\\']) {
    const value = [separator, 'uSeRs', separator, 'Synthetic Owner', separator].join('');
    assert.equal(scanPrivacyText(value, { identities: [] }).userProfile, 1);
  }
  const email = ['synthetic', 'example.invalid'].join('@');
  assert.equal(scanPrivacyText(email, { identities: [] }).email, 1);
  for (const prefix of ['sk-', 'gsk_', 'ghp_', 'hf_', 'AIza', 'AKIA']) {
    const key = prefix + 'a'.repeat(prefix === 'AKIA' ? 16 : 32);
    assert.equal(scanPrivacyText(key, { identities: [] }).apiKey, 1);
  }
  const credential = `API_KEY = "${'z'.repeat(24)}"`;
  assert.equal(scanPrivacyText(credential, { identities: [] }).credentialLiteral, 1);
});

test('privacy exceptions allow only neutral documentation prefixes', () => {
  const examples = [path.win32.join('C:', '/', 'Users', 'Example User', 'model'),
    path.win32.join('C:', '/', 'Users', 'Private Owner', 'model'),
    path.win32.join('C:', '/', 'Path', 'To', 'model'), windowsPath('path', 'to', 'model'),
    '<repo>/local', '<comfyui-install-dir>'];
  for (const example of examples) {
    assert.deepEqual(scanPrivacyText(example, { filename: 'docs/example.md', identities: [] }), {});
    assert.deepEqual(scanPrivacyText(example.toUpperCase(), { filename: 'README.md', identities: [] }), {});
    assert.deepEqual(scanPrivacyText(JSON.stringify(example), { filename: 'docs/example.md', identities: [] }), {});
  }
  assert.equal(scanPrivacyText(examples[0], { filename: 'server/example.js', identities: [] }).windowsAbsolute, 1);
  assert.equal(scanPrivacyText(windowsPath('Neutral', 'secret'), { filename: 'docs/example.md', identities: [] }).windowsAbsolute, 1);
  const mixed = examples[0] + '\n' + windowsPath('Users', 'Other Owner', 'secret');
  assert.equal(scanPrivacyText(mixed, { filename: 'docs/example.md', identities: [] }).userProfile, 1);
  assert.deepEqual(scanPrivacyText('https://example.invalid overflow-x:\\s*auto /api/settings', { identities: [] }), {});
});

test('privacy enumeration includes tracked and untracked files while ignoring machine files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy fixture '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'selfie.config.local.json\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), windowsPath('private', 'tracked'));
  git(['add', '.gitignore', 'tracked.txt']);
  fs.writeFileSync(path.join(root, 'untracked.txt'), windowsPath('private', 'untracked'));
  fs.writeFileSync(path.join(root, 'selfie.config.local.json'), windowsPath('private', 'ignored'));
  fs.writeFileSync(path.join(root, 'tiny.bin'), Buffer.from([0, 1, 2]));
  const result = checkPrivacy({ repoRoot: root });
  assert.deepEqual(result.findings.map(finding => finding.file), ['tracked.txt', 'untracked.txt']);
  assert.equal(result.binaryFiles, 1);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('fixture', 'utf16le')]);
  assert.equal(decodeText(utf16), 'fixture');
});

test('archive privacy enumeration honors nested ignore rules without creating a repository', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, content) => {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  };
  write('.gitignore', '.env*\n!.env.example\n*.local.json\nnode_modules/\nlocal/\nreferences/*\n!references/README.md\n');
  write('.env.example', 'PROVIDER_API_KEY=\n');
  write('public.txt', windowsPath('private', 'detected'));
  for (const name of ['.env', 'selfie.config.local.json', 'providers.config.local.json',
    'node_modules/dependency/index.js', 'local/runtime/model.bin', 'references/personal.png']) {
    write(name, windowsPath('private', 'excluded'));
  }
  write('references/README.md', 'Public reference instructions.');
  write('nested/.gitignore', '*.txt\n!keep.txt\n');
  write('nested/keep.txt', 'Public fixture.');
  write('nested/ignored.txt', windowsPath('private', 'excluded'));
  assert.deepEqual(committableFiles(root), ['.env.example', '.gitignore', 'nested/.gitignore',
    'nested/keep.txt', 'public.txt', 'references/README.md']);
  assert.deepEqual(checkPrivacy({ repoRoot: root }).findings.map(finding => finding.file), ['public.txt']);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});

test('an archive inside another checkout never inherits its index or ignore rules', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-parent-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', '--template=', parent], { stdio: 'pipe', windowsHide: true });
  fs.writeFileSync(path.join(parent, '.gitignore'), 'archive/\n');
  const root = path.join(parent, 'archive');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'public.txt'), 'Public fixture.');
  assert.deepEqual(committableFiles(root), ['public.txt']);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});

test('a broken checkout does not silently fall back to archive enumeration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-broken-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.git'), 'invalid metadata\n');
  fs.writeFileSync(path.join(root, 'public.txt'), 'Public fixture.');
  assert.throws(() => committableFiles(root));
});
