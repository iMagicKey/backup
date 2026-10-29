# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Unit tests, database round-trip integration tests (host and Docker mode), GitHub Actions CI.
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
- A missing `SHEDULER_INTERVAL` produced a 1 ms timer loop; `app/config/live/sheduler.json` was ignored.
- Telegram messages containing `<` or `&` (stack traces) were rejected by Telegram because of HTML parse mode.
- `pg_dump -v` output could exceed `exec`'s 1 MB buffer and abort large PostgreSQL backups.
- Restarting the service skipped the backup of the current period.
- Missing `app/config/<env>` or `app/logs` directories crashed the service.
- `BACKUP_PREFIX` was ignored for the bundle name.
- A backup of the project directory included the service's own storage, data and log directories.

### Removed

- Unused dependencies `imagic-utils` and `imagic-web-server`, and the TLS certificate script `system/certs.js`.
