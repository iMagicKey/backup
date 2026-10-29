# Security policy

## Supported versions

Only the latest release on the `main` branch receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting instead: *Security → Report a vulnerability* on <https://github.com/iMagicKey/backup>.

Include the affected version, a description, and steps to reproduce. Never include real credentials, tokens or backup contents.

## Scope

In scope: leaking credentials (logs, process list, Telegram, files), command injection through configuration values, unsafe file permissions or deletion outside the storage directory, and integrity problems with uploaded backups.

Out of scope: attacks that require control of `.env` or of the account running the service, and the security of Google Drive, Telegram or the database servers themselves.

## Operating the service securely

See the [Security section of the README](README.md#security).
