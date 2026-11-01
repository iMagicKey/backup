# backup

Self-hosted backup service for a single server. On a schedule it archives **files and directories**, dumps **MariaDB/MySQL**, **PostgreSQL** and **MongoDB** (installed on the host *or* running in **Docker containers**), packs everything into one bundle, uploads it to **Google Drive** and keeps a configurable number of backups per period (hourly, daily, weekly, …). Failures are reported to **Telegram**.

- Streams dumps straight into the compressor — no uncompressed temporary copies
- `gzip` or multi-threaded `zstd` compression
- One upload per run; additional periods are server-side copies inside Google Drive
- Upload integrity verified with MD5; every bundle contains a manifest and `SHA256SUMS`
- Credentials never appear in process arguments or logs
- Partial failures are tolerated: if one database is down, everything else is still backed up (and you are notified)
- State is persisted, so restarts neither skip nor repeat backups; failed uploads are retried

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Google Drive setup](#google-drive-setup)
- [Configuration](#configuration)
- [Databases in Docker containers](#databases-in-docker-containers)
- [Running](#running)
- [Backup format and restore](#backup-format-and-restore)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Upgrading from 1.x](#upgrading-from-1x)
- [Project structure](#project-structure)
- [License](#license)

---

## How it works

The scheduler checks once per minute whether a configured period has started since that period's last successful backup. Period labels are computed in **UTC**:

| Period   | New backup when…          | Kept by default |
| -------- | ------------------------- | --------------- |
| minutely | the minute changes        | 60              |
| hourly   | the hour changes          | 24              |
| daily    | the UTC date changes      | 3               |
| weekly   | the ISO week changes      | 5               |
| monthly  | the month changes         | 12              |
| yearly   | the year changes          | 15              |

When one or more periods are due, a single backup cycle runs:

1. **Dump** all enabled components in parallel into a private working directory (`app/storage/run-<timestamp>/`):
   - files → `files.tar.zst` (or `.tar.gz`)
   - MariaDB/MySQL → `mariadb.sql.zst`
   - PostgreSQL → `postgres-<db>.dump` (custom format) or `postgres-all.sql.zst` (`pg_dumpall`)
   - MongoDB → `mongodb.archive.zst`
2. **Bundle** the results with `manifest.json` and `SHA256SUMS` into one uncompressed `backup-<YYYY-MM-DD_HH-mm>.tar` (members are already compressed, so nothing is compressed twice).
3. **Upload** the bundle once to `My Drive/<SERVER NAME>/<period>/<period>-<timestamp>.tar`, verify size and MD5, then **copy** it server-side into the folders of the other due periods.
4. **Rotate**: delete the oldest backups in each period folder beyond the retention limit.
5. **Record** the successful periods in `app/data/state.json`. Periods whose upload failed are retried after `BACKUP_RETRY_MINUTES`.

**Partial backups.** If a component fails (for example a database is down) the remaining components are still bundled and uploaded, the failure is listed in `manifest.json` and reported to Telegram, and the period counts as done. This is deliberate: retrying would re-upload the whole bundle every `BACKUP_RETRY_MINUTES` for as long as the database stays down. Rotation treats a partial backup like any other, so fix failing components promptly (or run `npm run backup:once -- <period>` once they work again).

The service's own storage, data and log directories are always excluded from the files archive, even if they are inside `BACKUP_PATHS`.

On the very first start (no state file yet) every configured period is due, so the first backup runs about a minute after start-up.

---

## Requirements

- **Linux** with **Node.js ≥ 24**
- **GNU tar**, plus **zstd** (if `BACKUP_COMPRESSION=zstd`) or **gzip**
- Client tools for the databases you back up, **either on the host or inside the database containers**:

  | Database        | Tool                                              | Package (Debian/Ubuntu)                               |
  | --------------- | ------------------------------------------------- | ----------------------------------------------------- |
  | MariaDB / MySQL | `mariadb-dump` (falls back to `mysqldump`)        | `mariadb-client` or `mysql-client`                    |
  | PostgreSQL      | `pg_dump` / `pg_dumpall` (**≥ server version**)   | `postgresql-client-<version>` (PGDG repository)       |
  | MongoDB         | `mongodump` (MongoDB Database Tools ≥ 100.3)      | `mongodb-database-tools`                              |

  In Docker mode nothing needs to be installed on the host except the Docker CLI: the official `mariadb`, `mysql`, `postgres` and `mongo` images already contain these tools.
- A Google account and a Google Cloud OAuth client (see below)
- Free disk space in the storage directory for roughly **two times** the size of one compressed backup (components + bundle)

---

## Installation

```bash
git clone https://github.com/iMagicKey/backup.git
cd backup
npm run init            # installs dependencies, creates app/{logs,storage,data} and .env/.env.dev from .env.example
chmod 600 .env
$EDITOR .env            # see Configuration
npm run create-auth     # Google Drive authorization, see below
npm run check           # verify the configuration
npm run backup:once     # run one backup now
sudo npm run install-service   # run permanently as a systemd service
```

---

## Google Drive setup

1. In the [Google Cloud Console](https://console.cloud.google.com/) create (or select) a project and **enable the Google Drive API** (*APIs & Services → Library*).
2. Configure the **OAuth consent screen** (*External* is fine for a personal account) and add your Google account as a test user.
   - **Publish the app** ("In production") when you are done. While an app is in *Testing*, Google expires refresh tokens after **7 days** and backups start failing with `invalid_grant`. Unverified personal apps keep working; you only see a warning during consent.
3. *Credentials → Create credentials → OAuth client ID → Application type **Desktop app***.
4. Put the client into `.env`:

   ```dotenv
   GOOGLE_APP={"clientId":"…apps.googleusercontent.com","clientSecret":"GOCSPX-…","redirectURL":"http://localhost"}
   ```

5. Run `npm run create-auth`, open the printed URL, allow access. The browser is redirected to `http://localhost/?code=…`. The page will not load (nothing listens there), which is expected. Copy the whole address from the address bar and paste it into the terminal.
6. Add the printed `GOOGLE_AUTH={…}` line to `.env`.

The service requests only the **`drive.file`** scope: it can access only the files and folders it created itself, not the rest of your Drive.

To put backups somewhere other than the root of *My Drive*, set `GOOGLE_DRIVE_FOLDER_ID` to the ID of a folder **created by this service** (with the `drive.file` scope the service cannot see folders you created by hand). Shared drives are not supported.

---

## Configuration

All settings are environment variables, normally kept in `.env` (`npm run live`, `npm start`, the systemd service) or `.env.dev` (`npm run dev`). [`.env.example`](.env.example) contains every variable with comments. Lists accept comma-separated values or a JSON array (`["/path,with,commas"]`). Booleans accept `true/false`, `1/0`, `yes/no`.

### General

| Variable                 | Default                | Description                                                                                         |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `APP_ENV`                | `live`                 | Selects `app/config/<APP_ENV>/` (logger output, scheduler tick)                                     |
| `BACKUP_PATHS`           | –                      | Files/directories to archive. Missing paths are skipped with a warning                              |
| `BACKUP_EXCLUDES`        | –                      | `tar --exclude` patterns, e.g. `node_modules,*.log`                                                 |
| `BACKUP_PERIODS`         | `daily`                | Any of `minutely,hourly,daily,weekly,monthly,yearly`                                                |
| `BACKUP_RETENTION`       | see table above        | JSON object overriding the number of kept backups, e.g. `{"daily":7}`                               |
| `BACKUP_COMPRESSION`     | `gzip`                 | `gzip` or `zstd`                                                                                    |
| `BACKUP_ZSTD_LEVEL`      | `19`                   | 1–22. Lower is much faster (3–10 is a good trade-off for large data); >19 uses `--ultra`            |
| `BACKUP_PREFIX`          | `backup-`              | Prefix of the local bundle file name (letters, digits, `._-`)                                       |
| `BACKUP_SERVER_NAME`     | hostname, upper case   | Name of the per-server folder in Google Drive                                                       |
| `BACKUP_STORAGE_DIR`     | `app/storage`          | Working directory for archives. The service only deletes entries matching its own naming scheme there (`run-<timestamp>/`, `<prefix><timestamp>.tar`, 1.x archive names) |
| `BACKUP_DATA_DIR`        | `app/data`             | Location of `state.json`                                                                            |
| `BACKUP_KEEP_LOCAL`      | `true`                 | Keep the latest bundle on disk until the next run                                                   |
| `BACKUP_TIMEOUT_MINUTES` | `360`                  | Kill any single dump/archive command running longer than this                                       |
| `BACKUP_RETRY_MINUTES`   | `15`                   | Delay before retrying periods whose upload failed                                                   |
| `DOCKER_COMMAND`         | `docker`               | Docker CLI used for `*_DOCKER_CONTAINER` (e.g. `podman`)                                            |
| `SCHEDULER_INTERVAL`      | `app/config` (15000)   | Scheduler tick in ms. The backup check itself runs once per minute                                  |

### MariaDB / MySQL

| Variable                   | Description                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MARIADB_ENABLED`          | `true` to enable                                                                                             |
| `MARIADB_ALL`              | `true`: `--all-databases --events` (includes users and grants); otherwise only `MARIADB_DATABASE`            |
| `MARIADB_DATABASE`         | One or more databases (comma-separated); dumped with `--databases`, so the dump re-creates them              |
| `MARIADB_HOST`, `_PORT`    | Leave empty to use the default local socket (recommended in Docker mode)                                     |
| `MARIADB_USER`, `_PASSWORD`| Credentials. The password is passed via `MYSQL_PWD`, never on the command line. Alternatively leave it empty and put it in `~/.my.cnf` (`[client]` section) of the service user, or of the container user in Docker mode |
| `MARIADB_DOCKER_CONTAINER` | Run the dump inside this container                                                                           |
| `MARIADB_DUMP_COMMAND`     | Force a binary (default: `mariadb-dump`, falling back to `mysqldump`)                                        |
| `MARIADB_EXTRA_ARGS`       | Extra arguments, e.g. `--skip-routines --ignore-table=app.sessions`                                          |

Dumps always use `--single-transaction --quick --routines --triggers` (consistent InnoDB snapshot without locking tables).

### PostgreSQL

| Variable                    | Description                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_ENABLED`          | `true` to enable                                                                                                  |
| `POSTGRES_ALL`              | `true`: `pg_dumpall` (all databases, roles, tablespaces; plain SQL). Otherwise `pg_dump` of each database          |
| `POSTGRES_DATABASE`         | One or more databases; each becomes `postgres-<db>.dump` in custom format (compressed, restore with `pg_restore`)   |
| `POSTGRES_HOST`, `_PORT`    | Leave empty for the default local socket                                                                          |
| `POSTGRES_USER`             | Default `postgres`                                                                                                |
| `POSTGRES_PASSWORD`         | Passed via `PGPASSWORD`. A `~/.pgpass` file works as well                                                         |
| `POSTGRES_DOCKER_CONTAINER` | Run the dump inside this container                                                                                |
| `POSTGRES_EXTRA_ARGS`       | Extra arguments, e.g. `--exclude-table-data=audit_log`                                                            |

### MongoDB

| Variable                   | Description                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `MONGODB_ENABLED`          | `true` to enable                                                                                               |
| `MONGODB_URI`              | Connection string. Passed to `mongodump` via a private temporary config file, never on the command line. Optional in Docker mode |
| `MONGODB_DOCKER_CONTAINER` | Run the dump inside this container                                                                             |
| `MONGODB_EXTRA_ARGS`       | Extra arguments, e.g. `--db=app` or `--readPreference=secondary`                                               |

### Google Drive and Telegram

| Variable                  | Description                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `GOOGLE_APP`              | `{"clientId","clientSecret","redirectURL"}` of the OAuth client                     |
| `GOOGLE_AUTH`             | Tokens printed by `npm run create-auth` (must contain `refresh_token`)              |
| `GOOGLE_DRIVE_FOLDER_ID`  | Optional parent folder (default: root of My Drive)                                  |
| `TELEGRAM_REPORT_ENABLED` | `true` to send reports                                                              |
| `TELEGRAM_BOT_TOKEN`      | Bot token from [@BotFather](https://t.me/BotFather)                                 |
| `TELEGRAM_CHANNEL_ID`     | Chat or channel ID (the bot must be allowed to post there)                          |
| `TELEGRAM_REPORT_SUCCESS` | `true` to also report successful backups (default: only start-up, errors, warnings) |

### File-based settings

`app/config/<APP_ENV>/*.json` is loaded with [imagic-config](https://www.npmjs.com/package/imagic-config):

- `logger.json`: options for [imagic-logger](https://www.npmjs.com/package/imagic-logger), e.g. `{"output": ["console", "file"]}` (files go to `app/logs/<level>.log`)
- `scheduler.json`: `{"interval": 15000}`, the scheduler tick

If the directory does not exist (e.g. `app/config/dev/`, which is git-ignored), logging goes to the console only.

---

## Databases in Docker containers

Set `<DB>_DOCKER_CONTAINER` to the container name or ID and the dump runs **inside** the container via `docker exec`, streaming to the host:

```dotenv
MARIADB_ENABLED=true
MARIADB_ALL=true
MARIADB_DOCKER_CONTAINER=mariadb
MARIADB_USER=root
MARIADB_PASSWORD=…          # same as MARIADB_ROOT_PASSWORD of the container
MARIADB_HOST=               # empty: connect through the socket inside the container

POSTGRES_ENABLED=true
POSTGRES_ALL=true
POSTGRES_DOCKER_CONTAINER=postgres
POSTGRES_HOST=

MONGODB_ENABLED=true
MONGODB_DOCKER_CONTAINER=mongo
MONGODB_URI=mongodb://root:…@localhost:27017/?authSource=admin   # as seen from inside the container
```

Why this is the preferred way to back up containerized databases:

- No database ports have to be published to the host.
- The dump tool always matches the server version (`pg_dump` must not be older than the server).
- No database client tools are needed on the host.

Details and failure handling:

- Before dumping, the service checks the container with `docker inspect`. A missing Docker CLI, missing permissions, a non-existent or a stopped container produce a clear error for that component only; the other components are still backed up and the problem is reported to Telegram.
- Passwords are forwarded with `docker exec -e NAME` (without the value), so they are not visible in the host process list. MongoDB connection strings are piped over stdin into a temporary `0600` file inside the container that is deleted afterwards (requires `sh` and `mktemp` in the image, which the official images provide).
- For MariaDB ≥ 11 images, which ship only `mariadb-dump`, the binary is detected automatically; MySQL images use `mysqldump`.
- The user running the service needs access to the Docker daemon (root, or membership in the `docker` group, which is effectively root access).
- Use `DOCKER_COMMAND=podman` for Podman.
- Limitation: when a dump exceeds `BACKUP_TIMEOUT_MINUTES`, the `docker exec` client is killed, but Docker does not forward that to the process inside the container. A dump that is stuck (not writing) can keep running there until it finishes or the container restarts.

With Docker Compose, use the container name (`docker compose ps` shows it, e.g. `myapp-db-1`) or set `container_name:` in the compose file.

---

## Running

| Command                                   | Description                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `npm run live`                            | Run the service with `.env` (foreground)                                    |
| `npm run dev`                             | Run the service with `.env.dev`                                             |
| `npm start`                               | Run with `.env` if present, otherwise with the existing environment         |
| `npm run backup:once`                     | One backup cycle now for all `BACKUP_PERIODS`, then exit                    |
| `npm run backup:once -- daily weekly`     | One cycle for the given periods only                                        |
| `npm run backup:once -- --no-upload`      | Create the local bundle only (no Google credentials needed); prints its path |
| `npm run check`                           | Diagnose config, tools, containers, storage and Google Drive access         |
| `npm run check -- --telegram`             | Additionally send a Telegram test message                                   |
| `npm run create-auth`                     | Google OAuth setup                                                          |
| `sudo npm run install-service [-- dev]`   | Install and start a systemd unit named after the project directory          |
| `sudo npm run uninstall-service`          | Stop and remove the unit                                                    |
| `npm run clear-logs [-- error warn]`      | Truncate log files                                                          |

The systemd unit runs `node app/index.js` directly with `--env-file`, restarts on failure, uses `UMask=0077`, `NoNewPrivileges` and `PrivateTmp`, and appends output to `app/logs/service-*.log`. Check its status with `systemctl status <dir-name>` and `journalctl -u <dir-name>`.

The process stops cleanly on `SIGTERM`/`SIGINT` (running dump processes are terminated; the interrupted cycle is retried after restart).

---

## Backup format and restore

Download a bundle from Google Drive (or use the local copy in `app/storage/`) and unpack it:

```bash
mkdir restore && tar -xf daily-2026-10-30_00-00.tar -C restore && cd restore
sha256sum -c SHA256SUMS        # verify integrity
cat manifest.json              # server, time, components, warnings, failed components
```

| File                         | Restore                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `files.tar.zst`              | `tar -I zstd -xf files.tar.zst -C /` (or `-C /tmp/restore` to inspect first; paths are stored without the leading `/`) |
| `files.tar.gz`               | `tar -xzf files.tar.gz -C /`                                                                             |
| `mariadb.sql.zst`            | `zstd -dc mariadb.sql.zst \| mariadb -u root -p`                                                         |
| `postgres-<db>.dump`         | `createdb <db> && pg_restore --dbname=<db> postgres-<db>.dump` (add `--clean --if-exists` to overwrite)  |
| `postgres-all.sql.zst`       | `zstd -dc postgres-all.sql.zst \| psql -U postgres -d postgres`                                          |
| `mongodb.archive.zst`        | `zstd -dc mongodb.archive.zst \| mongorestore --uri="mongodb://…" --archive --drop`                      |

Use `gzip -dc` instead of `zstd -dc` for `.gz` files. Into containers, pipe the same way through `docker exec -i <container> …`:

```bash
zstd -dc mariadb.sql.zst      | docker exec -i -e MYSQL_PWD="$PW" mariadb mariadb -uroot
docker exec -i postgres pg_restore -U postgres --dbname=app < postgres-app.dump
zstd -dc postgres-all.sql.zst | docker exec -i postgres psql -U postgres -d postgres
zstd -dc mongodb.archive.zst  | docker exec -i mongo mongorestore --uri="mongodb://root:…@localhost:27017/?authSource=admin" --archive --drop
```

**Test your restores regularly.** A backup you have never restored is a hope, not a backup.

---

## Security

- **Keep `.env` private** (`chmod 600 .env`). It contains database passwords, the Google refresh token and the Telegram bot token. It is git-ignored; never commit it.
- **No secrets in argv**: passwords are passed through `MYSQL_PWD` / `PGPASSWORD`, MongoDB URIs through a private config file; in Docker mode via `docker exec -e NAME` and stdin. Commands are spawned without a shell, so paths and values cannot inject commands.
- **Redaction**: registered secrets and `user:password@` parts of URLs are removed from logs and Telegram messages, because dump tools echo connection strings in their error output.
- **Private files**: the process runs with `umask 077`; bundles, state and temporary files are only readable by the service user.
- **Least privilege on Google Drive**: only the `drive.file` scope is requested.
- **Least privilege in databases**: a dedicated read-only backup user is recommended, e.g. for MariaDB `GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES, PROCESS ON *.* TO 'backup'@'localhost'` (add `RELOAD` if you use `--master-data`/`--flush-logs` via extra args).
- **Encryption at rest**: bundles are stored in Google Drive **unencrypted**. If that is not acceptable for your data, encrypt the storage directory or add client-side encryption. Contributions are welcome.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

---

## Troubleshooting

Start with `npm run check`; it tests most of the points below. Logs are in `app/logs/` (when file output is enabled) or `journalctl -u <service>`.

| Symptom                                                                 | Cause / fix                                                                                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid configuration` at start                                        | The log lists each invalid variable. Compare with `.env.example`                                                                                                      |
| `invalid_grant` from Google                                             | Refresh token revoked or expired. Apps in *Testing* status expire tokens after 7 days: publish the app, then run `npm run create-auth` again                         |
| `Google did not return a refresh_token`                                 | Remove the app at <https://myaccount.google.com/permissions> and authorize again                                                                                      |
| `redirect_uri_mismatch`                                                 | Use a *Desktop app* OAuth client and `"redirectURL":"http://localhost"`                                                                                               |
| `files: some files changed while being archived`                        | Warning only: files were modified during the backup. The archive is still valid. Exclude volatile paths (caches, sockets, database data directories) with `BACKUP_EXCLUDES` |
| `command not found ("mariadb-dump")` / `exited with code 127`           | Install the client tools on the host, or use Docker mode. In Docker mode, the image lacks the tool                                                                    |
| `Docker container "x" does not exist / is not running`                  | Check `docker ps`; use the real container name (Compose adds prefixes/suffixes)                                                                                       |
| `No permission to talk to the Docker daemon`                            | Run the service as root or add its user to the `docker` group                                                                                                         |
| PostgreSQL `server version mismatch`                                    | Host `pg_dump` is older than the server. Install the matching `postgresql-client-<version>` or use Docker mode                                                        |
| PostgreSQL `Peer authentication failed`                                 | Set `POSTGRES_HOST=127.0.0.1` to use password authentication over TCP, or run as the `postgres` OS user                                                              |
| MariaDB `Access denied … (using password: NO)`                          | `MARIADB_PASSWORD` is empty or wrong. With MySQL versions that no longer read `MYSQL_PWD`, use `~/.my.cnf` instead                                                    |
| MariaDB `… to use LOCK TABLES` / routines errors                        | Grant the privileges listed under [Security](#security) or add `MARIADB_EXTRA_ARGS=--skip-routines`                                                                   |
| MongoDB `can't create session: failed to connect`                       | Server down or wrong host/port in `MONGODB_URI`. In Docker mode the URI is resolved **inside** the container (`localhost`)                                            |
| MongoDB container exits: `Linux kernel versions 6.19 and newer has a known incompatibility` | MongoDB 8.0 does not start on kernel ≥ 6.19 ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). Upgrade the database to MongoDB 9.0 (or a fixed 8.0 release); this is unrelated to the backup service |
| `Another backup is already running`                                     | A service instance and `backup:once` use the same storage directory at the same time; wait or stop one. Stale locks of dead processes are cleaned up automatically   |
| No backup after restart                                                 | Periods run only when their label changed since the last success (see `app/data/state.json`). Delete a period from that file, or run `npm run backup:once`, to force a run |
| Disk full                                                               | Point `BACKUP_STORAGE_DIR` to a larger disk, set `BACKUP_KEEP_LOCAL=false`, exclude large paths                                                                       |
| Telegram messages do not arrive                                         | `npm run check -- --telegram`. The bot must be a member/admin of the channel; channel IDs start with `-100`                                                           |

---

## Testing

```bash
npm test                 # unit tests (no network, no databases needed)
npm run lint             # ESLint
npm run format:check     # Prettier
npm run verify           # all of the above
```

**Integration tests** (`npm run test:integration`) dump real databases, unpack the bundle, verify checksums, restore into an empty database and compare the data. Each engine runs when its variables are set and is skipped otherwise:

```bash
# databases reachable from the host
IT_MARIADB_HOST=127.0.0.1 IT_MARIADB_PORT=3306 IT_MARIADB_USER=root IT_MARIADB_PASSWORD=… \
IT_POSTGRES_HOST=127.0.0.1 IT_POSTGRES_PORT=5432 IT_POSTGRES_USER=postgres IT_POSTGRES_PASSWORD=… \
IT_MONGODB_URI='mongodb://root:…@127.0.0.1:27017/?authSource=admin' \
npm run test:integration

# databases in Docker containers (backup and restore via docker exec)
IT_DOCKER_COMMAND=docker \
IT_MARIADB_CONTAINER=it-mariadb IT_MARIADB_PASSWORD=… \
IT_POSTGRES_CONTAINER=it-postgres \
IT_MONGODB_CONTAINER=it-mongo IT_MONGODB_URI='mongodb://root:…@localhost:27017/?authSource=admin' \
npm run test:integration
```

`IT_COMPRESSION=gzip|zstd` selects the compression (default `zstd`). **The tests create and drop a database named `bk_it`; never point them at production servers.** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the Docker variant against `mariadb:11`, `postgres:18` and `mongo:9` on every push.

`test/helpers/fake-docker.js` is a Docker CLI stand-in that runs `docker exec` commands on the host. It lets the Docker code paths be tested without Docker and records all arguments, so the tests can assert that no password is passed on a command line.

---

## Upgrading from 1.x

Version 2.0 is a rewrite of the internals. Existing `.env` files keep working. Changes to note:

- **Node.js ≥ 24** is required.
- **Scheduler settings renamed** (the 1.x names were misspelled): use `SCHEDULER_INTERVAL` in `.env` and `app/config/<APP_ENV>/scheduler.json`. Both are optional; the default tick is 15000 ms.
- **Bundle format**: `<period>-YYYY-MM-DD_HH-mm.tar` (uncompressed tar of individually compressed members, plus `manifest.json` and `SHA256SUMS`) instead of `<period>-YYYY.MM.DD-HH:mm.tar.zst`. Timestamps no longer contain colons. Member names changed (`files.tar.zst`, `mariadb.sql.zst`, `postgres-<db>.dump`, `postgres-all.sql.zst`, `mongodb.archive.zst`), and database dumps are now compressed. Old backups in Drive are rotated out normally.
- **MariaDB** single-database dumps now use `--databases` (the dump contains `CREATE DATABASE`/`USE`) and `--single-transaction --quick --routines --triggers`. `MARIADB_DATABASE` accepts a list.
- **PostgreSQL**: `POSTGRES_USER` defaults to `postgres`; `POSTGRES_DATABASE` accepts a list.
- **State is persisted** in `app/data/state.json`. After the upgrade, the first start runs a backup for every configured period about one minute after start-up.
- **Google Drive**: the server folder is now looked up in the root of *My Drive* (or `GOOGLE_DRIVE_FOLDER_ID`), not anywhere in Drive; existing folders created by 1.x are found. `npm run create-auth` requests only `drive.file`; existing tokens keep working.
- **npm scripts**: `npm test` now runs unit tests (the old real backup test is `npm run backup:once`); `create-auth` reads `.env` instead of `.env.dev`; `create-certs` was removed.
- **Failures**: a tar warning ("file changed as we read it") no longer discards the files archive; partial failures are reported to Telegram.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

---

## Project structure

```
app/
  index.js               service entry point (scheduler, signal handling)
  once.js                one-shot backup (npm run backup:once)
  check.js               diagnostics (npm run check)
  bootstrap.js           shared start-up: umask, file config, logger, env validation, redaction, Telegram
  config/live/           logger.json, scheduler.json (loaded with imagic-config)
  libs/
    logger.js            imagic-logger wrapper that redacts secrets
    redact.js            secret registry and redaction
  code/
    config.js            the only module reading process.env; validation
    index.js             wires scheduler, state, Drive client and backup runner
    store.js             persistent state (app/data/state.json)
    create.js            Google OAuth helper (npm run create-auth)
    backup/
      index.js           orchestration: dump → bundle → upload/copy → rotate → report
      files.js mariadb.js postgres.js mongodb.js
    scheduler/
      index.js           imagic-scheduler setup
      tasks/backup.js    due-period detection, retry, overlap guard
    utils/
      exec.js            spawn helpers (no shell, pipelines, timeouts)
      docker.js          docker exec wrapping and container checks
      drive.js           Google Drive API helpers
      tar.js             compression settings
      date.js            UTC period labels and timestamps
      report.js          Telegram reports
      fs.js              hashing, private dirs, lock file
system/                  init, systemd service, log maintenance scripts
test/unit/               unit tests (node:test)
test/integration/        database round-trip tests
test/helpers/            fake Drive client, fake Docker CLI
```

---

## License

[MIT](LICENSE) © iMagicKey
