import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function runtimeIdentities(repoRoot = REPO_ROOT) {
  const genericFolders = new Set(['desktop', 'documents', 'downloads', 'projects', 'repos', 'workspace']);
  const profileFolders = path.relative(os.homedir(), repoRoot).split(path.sep)
    .filter(value => value.includes(' ') && !genericFolders.has(value.toLowerCase()));
  let packageName = '';
  try { packageName = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).name; } catch { /* standalone fixture */ }
  return [...new Set([os.userInfo().username, os.hostname(), path.basename(os.homedir()),
    ...profileFolders].filter(value => value && value !== packageName))];
}

function redactDocPlaceholders(source, filename) {
  if (!/\.(md|rst|txt)$/i.test(filename)) return source;
  // Only these neutral prefixes are permitted, including JSON-escaped backslashes.
  return source
    .replace(/c:[\\/]+users[\\/]+(?:example user|private owner)(?=[\\/\s"'`<>]|$)/gi, '<placeholder>')
    .replace(/c:[\\/]+path[\\/]+to[\\/]+/gi, '<placeholder>/')
    .replace(/x:[\\/]+path[\\/]+to[\\/]+/gi, '<placeholder>/');
}

/** Return counts only: matched values must never reach diagnostics. */
export function scanPrivacyText(source, { filename = '', identities = runtimeIdentities() } = {}) {
  source = redactDocPlaceholders(source, filename);
  const patterns = {
    windowsAbsolute: /(?<![a-z0-9_-])[a-z]:[\\/]/gi,
    userProfile: /[\\/]users[\\/]/gi,
    email: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi,
    apiKey: /\b(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{16,}|gsk_[a-z0-9]{16,}|AIza[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|(?:AKIA|ASIA)[a-z0-9]{16}|hf_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{20,})\b/gi,
    credentialLiteral: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization)["']?\s*[:=]\s*["'](?:bearer\s+)?[a-z0-9_+./=-]{20,}["']/gi,
  };
  if (identities.length) patterns.machineIdentity = new RegExp(identities.map(escapeRegex).join('|'), 'gi');
  return Object.fromEntries(Object.entries(patterns)
    .map(([name, pattern]) => [name, [...source.matchAll(pattern)].length])
    .filter(([, count]) => count > 0));
}

export function committableFiles(repoRoot = REPO_ROOT) {
  const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return [...new Set([...git(['ls-files', '-z']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean))].sort();
}

export function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const copy = Buffer.from(buffer.subarray(2));
    return copy.length % 2 === 0 ? copy.swap16().toString('utf16le') : null;
  }
  if (buffer.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return null; }
}

export function checkPrivacy({ repoRoot = REPO_ROOT } = {}) {
  const files = committableFiles(repoRoot);
  const identities = runtimeIdentities(repoRoot);
  const findings = [];
  let textFiles = 0;
  let binaryFiles = 0;
  for (const file of files) {
    const filename = path.join(repoRoot, file);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) continue;
    const source = decodeText(fs.readFileSync(filename));
    if (source === null) { binaryFiles++; continue; }
    textFiles++;
    const counts = scanPrivacyText(source, { filename: file, identities });
    if (Object.keys(counts).length) findings.push({ file, counts });
  }
  return { files: files.length, textFiles, binaryFiles, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkPrivacy();
    for (const finding of result.findings) console.log(JSON.stringify(finding));
    console.log(JSON.stringify({ files: result.files, textFiles: result.textFiles,
      binaryFiles: result.binaryFiles, failingFiles: result.findings.length }));
    process.exitCode = result.findings.length ? 1 : 0;
  } catch {
    console.error('Privacy scan failed to enumerate or read committable files.');
    process.exitCode = 1;
  }
}
