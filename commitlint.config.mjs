// Commit convention: <type>(<scope>): <description>
// e.g. feat(auth): add JWT authentication
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'docs', 'test', 'perf', 'ci', 'chore', 'build', 'style'],
    ],
    'type-case': [2, 'always', 'lower-case'],
    'scope-empty': [2, 'never'],
    'scope-case': [2, 'always', 'kebab-case'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 72],
  },
  helpUrl:
    'https://doc.clickup.com/90182858897/d/2kzn2e4h-818/git-branchand-commit-naming-convention',
};
