# AIAuthSwitcher

AIAuthSwitcher is a VS Code utility for backing up and switching local auth files used by AI coding tools.

It is designed for local-only auth management. The extension reads and writes auth files on your machine so you can switch between previously saved profiles more safely than editing JSON by hand.

At the moment, the implemented target is Codex only. The broader name reflects the direction of the project, not current multi-provider support.

## Features

- Show the current account summary from a local auth file
- Back up the current auth file into the extension backup directory
- Switch to a previously backed up auth file
- Delete old auth backups from the sidebar
- Prompt to reload the VS Code window after switching accounts

## Current Scope

- Current implementation supports Codex auth stored in `~/.codex/auth.json`
- Other AI tools are not supported yet
- The UI is sidebar-first; you do not need to use command-palette commands
- Auth backups are stored in the extension's VS Code global storage directory

## Security

- This extension handles sensitive local auth material, including tokens
- It does not upload auth data to a remote service
- Do not commit exported auth backups to git
- Treat backup files like credentials

## What This Is Not

- It is not a tool for bypassing provider limits, subscriptions, or service controls
- It does not manage remote account state
- It cannot force another extension to re-read auth without a reload if that extension keeps auth in memory

## Development

```bash
npm install
npm run compile
npm run lint
```

To package a local VSIX:

```bash
npx @vscode/vsce package --allow-missing-repository
```

If you later publish this project publicly, add real values for `publisher` and `repository` in `package.json`.

## Known Issues

- This extension currently focuses on local auth file switching; it does not manage remote session state
- If another extension caches auth in memory, a reload is still required
