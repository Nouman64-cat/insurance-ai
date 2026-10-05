#!/usr/bin/env node
// Branch convention: <type>/<short-kebab-case-description>
// or, with a ticket ID: <type>/<TICKET-ID>-<short-description>
// Usage: node scripts/lint-branch-name.mjs [branch]  (defaults to current branch)
import { execSync } from 'node:child_process';

const TYPES = ['feat', 'fix', 'hotfix', 'refactor', 'docs', 'test', 'perf', 'ci', 'chore'];
const PROTECTED = ['main', 'dev', 'gh-pages'];
const PATTERN = new RegExp(`^(${TYPES.join('|')})/([A-Z][A-Z0-9]*-\\d+-)?[a-z0-9]+(-[a-z0-9]+)*$`);

const branch =
  process.argv[2] || execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();

if (branch === 'HEAD' || PROTECTED.includes(branch) || PATTERN.test(branch)) {
  process.exit(0);
}

console.error(`\n✖ Invalid branch name: "${branch}"\n`);
console.error('  Expected: <type>/<short-kebab-case-description>');
console.error('        or: <type>/<TICKET-ID>-<short-description>\n');
console.error(`  Allowed types: ${TYPES.join(', ')}\n`);
console.error('  Examples: feat/user-authentication, fix/CU-12345-login-token-expiry\n');
console.error('  Rename with: git branch -m <new-name>\n');
process.exit(1);
