---
id: contributing
title: Contributing
sidebar_position: 13
---

# Contributing

Full team guide: [Git Branch and Commit Naming Convention](https://doc.clickup.com/90182858897/d/2kzn2e4h-818/git-branchand-commit-naming-convention) (ClickUp).

## Enable the git hooks (once per clone)

```bash
npm install   # at the repo root — installs Husky + Commitlint and activates the hooks
```

| Hook | Checks | Runs on | Config |
|---|---|---|---|
| `commit-msg` | Commit message format | `git commit` | `commitlint.config.mjs` |
| `pre-push` | Branch name format | `git push` | `scripts/lint-branch-name.mjs` |

`.github/workflows/naming-lint.yml` runs the same checks on pull requests when GitHub Actions are available. Check a branch manually with `npm run lint:branch`.

## Branch naming

```text
<type>/<short-kebab-case-description>
<type>/<ticket-id>-<short-description>      # when a task/ticket ID exists
```

Allowed types: `feat`, `fix`, `hotfix`, `refactor`, `docs`, `test`, `perf`, `ci`, `chore`

```text
feat/user-authentication
fix/login-token-expiry
refactor/vector-retrieval
feat/AI-142-rag-evaluation
fix/CU-12345-login-token-expiry
```

`main`, `dev` and `gh-pages` are exempt. Rename a branch with `git branch -m <new-name>`.

## Commit messages

```text
<type>(<scope>): <description>
```

Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `perf`, `ci`, `chore`, `build`, `style`

- Scope is **required** and kebab-case — e.g. `auth`, `underwriting`, `agent`, `api`, `deps`, `docs`
- Description is short, clear, imperative, starts **lowercase**, no trailing period
- Header (first line) is at most **72 characters** — put detail in the body: `git commit -m "<header>" -m "<body>"`

```text
feat(auth): add JWT authentication
fix(rag): prevent duplicate documents
refactor(agent): simplify state management
docs(readme): add setup instructions
chore(deps): update dependencies
```

Rejected: `updated code`, `fix`, `changes`, `final changes`, `feat: missing scope`, `feat(auth): Add capitalized`.

## Branch flow

`dev` carries the latest platform work; `main` is the release branch. Docs deploy to GitHub Pages from `main` when `docs/**` changes (`.github/workflows/deploy-docs.yml`).

## After changing code

| Changed | Do |
|---|---|
| A Python service | Uvicorn `--reload` picks it up (polling enabled for Docker Desktop); rebuild with `docker compose up --build -d <service>` if dependencies changed |
| `shared/models/core.py` | Add an additive migration to `MIGRATIONS` in `services/tenant-service/migrate.py`, then restart `tenant-service` |
| `shared/events/kafka_events.py` | Restart every producer and consumer of the changed event |
| `docker-compose.yml` or `.env` | `docker compose down && docker compose up --build -d` |
| Docs | `cd docs && npm start` → http://localhost:4991/insurance-ai/ |
