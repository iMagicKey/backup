# AGENTS.md

Guidelines for AI coding agents (and humans) working on this repository. Read [README.md](README.md) for what the service does and how it is configured; this file covers how to change it safely.

## Project summary

A Node.js (≥ 24.10, ESM, no build step, no TypeScript) background service. No HTTP server, no frontend. It dumps files and databases (MariaDB/MySQL, PostgreSQL, MongoDB; on the host or via `docker exec`), bundles them, uploads to Google Drive with per-period retention and reports problems to Telegram.

Runtime dependencies are deliberately few: `@googleapis/drive`, `imagic-config`, `imagic-logger`, `imagic-scheduler`, `imagic-telegram`. All archiving and dumping is done by spawning system tools (`tar`, `zstd`/`gzip`, `mariadb-dump`, `pg_dump`, `mongodump`, `docker`).

## Commands

```bash
npm ci                     # install exactly what package-lock.json specifies
npm test                   # unit tests (node:test); must pass before every commit
npm run lint               # ESLint 10 flat config (eslint.config.js)
npm run format             # Prettier (4 spaces, no semicolons, single quotes, width 150)
npm run verify             # lint + format check + unit tests
npm run test:integration   # real database round trips; needs IT_* env vars (see README "Testing")
npm run backup:once -- --no-upload   # end-to-end local run without Google credentials
npm run check              # diagnostics against the configured environment
```

## Architecture

```
app/index.js → bootstrap.js → code/index.js → scheduler/index.js (imagic-scheduler, 1-minute task)
  scheduler/tasks/backup.js   due periods = labels changed since last success (store.js); retry; overlap guard
  backup/index.js runBackup  lock → createBackup (components in parallel → manifest + SHA256SUMS → tar bundle)
                             → uploadBackup (upload once, files.copy for other periods, MD5 check, retention) → report
```

- `app/code/config.js` is the **only** place that reads `process.env`. `buildConfig(env)` is pure, never throws and returns `errors`, `authErrors` and `warnings`. Everything else receives the config object as a parameter.
- Each backup component (`app/code/backup/{files,mariadb,postgres,mongodb}.js`) exports a pure `build…Command(config)` that returns a spawn spec `{ command, args, env, input, label }` plus a default async function `(config, { runDir, timeoutMs, warnings }) → [{ component, file }]`. Keep that shape when adding components and register new ones in `COMPONENTS` in `backup/index.js`.
- `app/code/utils/exec.js`: `run(spec)` and `runToFile(producer, outPath, { compressor })`. Never use `child_process.exec`, `execSync` with strings or `shell: true` in application code.
- `app/code/utils/docker.js`: `inContainerIfConfigured(spec, container, dockerCommand)` turns any spec into `docker exec [-i] -e NAME… <container> …`.
- Logging: `import Logger from '../../libs/logger.js'` (imagic-logger wrapper with redaction). Use prefixed methods (`Logger.plog('Drive', …)`). Do not use `console.*` outside CLI scripts (`check.js`, `create.js`, `system/`).
- Telegram: `report(...)` from `utils/report.js`. It never throws.

## Rules

### Security (non-negotiable)

1. **Never put secrets in argv.** Pass passwords via environment variables (`MYSQL_PWD`, `PGPASSWORD`), stdin or `0600` temp files; in Docker mode via `-e NAME` without a value. Unit tests assert this; keep them passing and add the same assertion for new components.
2. **Never use a shell to build commands from config values.** The only `sh -c` scripts are fixed strings that receive values as positional parameters (`"$@"`) or stdin.
3. **Register new secrets for redaction** in `secretsOf()` in `config.js`.
4. **Never commit** `.env*` (except `.env.example`), tokens, real hostnames, IPs, log files or backup files. `.env.example` must contain placeholders only.
5. Files created at runtime must stay private (`umask 077` is set in `bootstrap.js`; use `mode: 0o600`/`0o700` explicitly for anything security-relevant).
6. Only delete what the service created: `cleanStorage()` matches explicit name patterns because `BACKUP_STORAGE_DIR` may be a shared directory.
7. Keep the Google scope at `drive.file`.

### Behaviour and compatibility

- Existing environment variable names are a public interface. Add new ones with safe defaults and document them in `.env.example`, `README.md` (Configuration table) and `config.js`; never rename or remove one without a deprecation path and a CHANGELOG entry.
- A failing component must not prevent the others from being backed up. Throw from a component only for that component's failure; `createBackup` collects failures.
- GNU tar exit code 1 ("file changed as we read it") is a warning, not a failure.
- Period labels and file timestamps are UTC. File names must not contain `:`.
- Changes to the bundle layout or member names are breaking for restores: update the restore table in README, bump the manifest `format` and add a CHANGELOG entry.

### Code style

- ESM with explicit `.js` extensions in relative imports; `node:` prefix for built-ins.
- Prettier formatting (run `npm run format`); ESLint must report no errors or warnings.
- Small pure functions for anything that can be unit tested; side effects at the edges.
- Comments explain *why*, not *what*. Match the density of the surrounding code.
- Prefer Node built-ins over new dependencies. A new runtime dependency needs a clear justification (size, maintenance, license MIT/ISC/Apache-2.0/BSD).

### Tests

- Every exported function and every entry point has unit tests in `test/unit/`; keep it that way (`npm run test:coverage` shows gaps). Every behaviour change needs a test.
- Use the helpers instead of real services: `test/helpers/setup.js` (`configFrom`, `tempDir`, `stubCommand` for fake dump tools in `PATH`, `withEnv` for scoped environment variables), `fake-drive.js` and `fake-docker.js`. Entry points are tested as child processes with an isolated environment; never let a test read the repository's `.env`.
- Unit tests must not need network access, databases, Docker or credentials, and must finish in a few seconds.
- Changes to dump or restore commands must be checked with `npm run test:integration` (local servers or containers). CI runs the Docker variant.
- Tests write only to temporary directories (`tempDir`), never into the repository.

## Before you finish

1. `npm run verify` passes.
2. Docs updated: README (configuration, restore, troubleshooting), `.env.example`, CHANGELOG (`Unreleased` section).
3. `git status` shows no secrets, logs, backups, `.env` files or editor/agent files.
4. Commit messages: imperative mood, explain *why* for non-obvious changes.
