# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Breaking:** the misspelled 1.x scheduler names were corrected: the environment variable is now `SCHEDULER_INTERVAL`, the config file `app/config/<APP_ENV>/scheduler.json` and the source directory `app/code/scheduler/`. Rename the variable in existing `.env` files (it is optional; the default is 15000 ms).
- Minimum Node.js version raised to 24.10: before that the `--env-file`/`--env-file-if-exists` flags used by the npm scripts were experimental and printed a warning. CI now tests the minimum version.
- `npm run backup:once` exits with code 1 when any component failed (previously only failed uploads did), so cron jobs and monitors notice partial backups.

### Added

- Unit tests for every module and entry point (backup components against stub dump tools, Docker failure modes, Drive client setup, logger redaction, Telegram reports, scheduler wiring, `bootstrap`, the service start/stop, `check`, `create-auth`, `init`, `clear-logs` and the systemd unit) and `npm run test:coverage`.

### Fixed

- Running `npm run backup:once` while the service was running could make the service repeat the same backup: the service now reloads `state.json` before every check.
- `npm run check` inserted `MARIADB_DUMP_COMMAND` into a shell command.
- The backup lock was not released if preparing the run directory failed.

## [2.0.0] - 2026-10-30

First public release. Internals were rewritten; existing `.env` files keep working (see "Upgrading from 1.x" in the README).

### Added

- Docker support for all databases: `MARIADB_DOCKER_CONTAINER`, `POSTGRES_DOCKER_CONTAINER`, `MONGODB_DOCKER_CONTAINER`, `DOCKER_COMMAND` (works with Podman). Containers are checked before dumping, with clear errors for a missing CLI, missing permissions, and missing or stopped containers.
- Automatic `mariadb-dump`/`mysqldump` detection (MariaDB ≥ 11 images ship only `mariadb-dump`); `MARIADB_DUMP_COMMAND` override.
- Multiple databases in `MARIADB_DATABASE` and `POSTGRES_DATABASE`; `*_EXTRA_ARGS` for every database.
- `BACKUP_RETENTION`, `BACKUP_SERVER_NAME`, `BACKUP_STORAGE_DIR`, `BACKUP_DATA_DIR`, `BACKUP_KEEP_LOCAL`, `BACKUP_TIMEOUT_MINUTES`, `BACKUP_RETRY_MINUTES`, `GOOGLE_DRIVE_FOLDER_ID`, `TELEGRAM_REPORT_SUCCESS`.
- `manifest.json` and `SHA256SUMS` in every bundle; MD5 verification of uploads and copies; timeouts for all Google Drive requests.
- Per-database failure handling for PostgreSQL: one failing database no longer discards the others.
- Persistent state (`app/data/state.json`) and retries of failed periods.
- `npm run backup:once` (with `--no-upload` and period arguments) and `npm run check` (diagnostics).
- Interactive `npm run create-auth` that accepts the code or the full redirect URL.
- Unit tests, database round-trip integration tests (host and Docker mode), GitHub Actions CI (`mariadb:11`, `postgres:18`, `mongo:9`).
- `.env.example`, `AGENTS.md`, `SECURITY.md`, `LICENSE`.

### Changed

- **Breaking:** Node.js ≥ 24 is required.
- **Breaking:** bundle format. Each run produces one uncompressed `.tar` with individually compressed members (`files.tar.zst`, `mariadb.sql.zst`, `postgres-<db>.dump`, `postgres-all.sql.zst`, `mongodb.archive.zst`). Previously the already-compressed files archive was compressed a second time. Timestamps changed from `YYYY.MM.DD-HH:mm` to `YYYY-MM-DD_HH-mm` (no colons).
- **Breaking:** `npm test` runs unit tests; `create-auth` reads `.env`; `create-certs` was removed.
- Database dumps are streamed through the compressor instead of being written uncompressed.
- The bundle is uploaded once; other periods receive a server-side copy.
- MariaDB dumps use `--single-transaction --quick --routines --triggers` (and `--events` with `MARIADB_ALL`) and `--databases`.
- PostgreSQL: `pg_dump` writes to stdout (works through `docker exec`), `--no-password`, no verbose output. `POSTGRES_USER` defaults to `postgres`.
- Google Drive: folders are looked up by name **and parent**, listings are paginated, deletions are awaited, `@googleapis/drive` replaces the full `googleapis` package (~2.5 MB instead of ~250 MB), and only the `drive.file` scope is requested.
- Migrated to `imagic-scheduler`, `imagic-logger` and `imagic-config`; `imagic-telegram` updated to 1.1.
- ESLint 10 flat config with `eslint-plugin-n` replaces the legacy airbnb configuration; explicit `.js` import extensions replace `specifier-resolution-node`.
- systemd unit: copied instead of hard-linked, `daemon-reload`, runs `node` directly, `UMask=0077`, `NoNewPrivileges`, `PrivateTmp`.
- The process exits after an uncaught exception (systemd restarts it) and shuts down cleanly on `SIGTERM`/`SIGINT`.

### Fixed

- A tar warning ("file changed as we read it", exit code 1) made the whole files backup count as failed; if a database also failed, no backup was produced at all.
- Passwords were visible in the process list (`mysqldump -p…`, `PGPASSWORD=… pg_dump` via a shell, `mongodump --uri=…`).
- MongoDB connection strings including the password were written to the error log.
- Paths or passwords containing quotes broke the shell commands (and allowed command injection).
- Uploads ran in an un-awaited `forEach`: errors became unhandled rejections and a new run could start while the previous upload was still in progress.
- The scheduler never set its in-progress flag, so runs could overlap.
- A missing scheduler interval variable produced a 1 ms timer loop; the scheduler config file in `app/config/live/` was ignored.
- Telegram messages containing `<` or `&` (stack traces) were rejected by Telegram because of HTML parse mode.
- `pg_dump -v` output could exceed `exec`'s 1 MB buffer and abort large PostgreSQL backups.
- Restarting the service skipped the backup of the current period.
- Missing `app/config/<env>` or `app/logs` directories crashed the service.
- `BACKUP_PREFIX` was ignored for the bundle name.
- A backup of the project directory included the service's own storage, data and log directories.

### Removed

- Unused dependencies `imagic-utils` and `imagic-web-server`, and the TLS certificate script `system/certs.js`.
