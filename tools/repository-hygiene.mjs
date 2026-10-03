import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const maxBytes = 5 * 1024 * 1024;

export function inspectEntry(path, content) {
  const findings = [];
  const segments = path.split('/');
  const name = segments.at(-1);
  if (segments.some(segment => ['node_modules', 'target', 'dist', '.pnpm-store', 'coverage', 'relatorios'].includes(segment))) {
    findings.push('generated or local directory');
  }
  if ((/^\.env(?:\.|$)/.test(name) && !/^\.env\.(example|sample|template)$/.test(name)) ||
      /\.(log|dmp|stackdump|pid|tmp|bak|orig|pem|key|p12|pfx|keystore|sqlite3?|exe|msi|pdb)$/i.test(name) ||
      /^logs?\.txt$/i.test(name) || /^DEBUG_PERFORMANCE_/i.test(name)) {
    findings.push('private, diagnostic, or generated file');
  }
  if (content.length > maxBytes) findings.push('file exceeds 5 MiB; review and use an appropriate distribution channel');
  if (!content.subarray(0, 8000).includes(0)) {
    const text = content.toString('utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text) ||
        /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(text)) {
      findings.push('potential credential; revoke real credentials and review history');
    }
    if (/(?:\b[A-Za-z]:[\\/]Users[\\/][^\s\\/"']+|\/home\/[a-z0-9_-]+\/)/.test(text)) {
      findings.push('personal absolute home-directory path');
    }
  }
  return findings;
}

export function checkRepository(staged = false) {
  const git = args => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
  const paths = git(staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  let checked = 0;
  const findings = [];
  for (const path of paths) {
    if (!staged && !existsSync(path)) continue;
    const content = staged ? git(['show', `:${path}`]) : readFileSync(path);
    checked++;
    for (const reason of inspectEntry(path, content)) findings.push(`${path}: ${reason}`);
  }
  return { checked, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { checked, findings } = checkRepository(process.argv.includes('--staged'));
  for (const finding of findings) console.error(finding);
  console.log(`Repository hygiene: ${checked} files checked; ${findings.length} findings.`);
  if (findings.length) process.exitCode = 1;
}
