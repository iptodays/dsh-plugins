# SessionReaper

**A garbage collector for DSH session logs.**

DSH keeps every session event log forever under `$DSH_HOME/sessions/`: one project directory, one directory per session, holding `session.vN.jsonl.zstd` and `session.lock`. Session persistence exposes read / append / flush / close and, by design, **no deletion or retention API** (upstream README, Known Limitations: `No deletion or retention API — pruning stored sessions is out-of-band backend maintenance.`).

SessionReaper is that out-of-band maintenance. It periodically lists every visible session, ages each one, and removes the ones past their retention window that are not protected, then deletes the matching projection-cache record so the sidebar cannot keep a ghost row for a log that no longer exists.

- Package: `@dsh-plugins/session-reaper`
- Shape: host-only Cordis plugin (no browser half)
- Dependencies: none (node: builtins only)
- Defaults: 30-day retention, one sweep per hour, keep the newest 2 sessions per project

## How expiry is decided

Last activity is the larger of the session header's `createdAt` and the newest mtime of any file inside the session directory. Logs are append + fsync, so file mtime is a faithful proxy for the last durable write. A session is expired when `now - lastActivity > retentionDays`. Archived sessions (workspace `archivedSessionIds`) may use a shorter `archivedRetentionDays`.

Expiry is **not** based on creation time: a session created 100 days ago but used today survives, while a session that was never reopened starts ageing from its last write.

## What is never deleted

- sessions with no on-disk directory (created but never materialized);
- live sessions (`ctx.sessions.list()` plus the `DSH_SESSION_ID` of the current process);
- pinned sessions (workspace `pinnedSessionIds`);
- anything matched by a `protect` rule (substring, or an anchored `*`/`?` glob, against id and cwd);
- subagent sessions when `includeSubagentSessions: false`;
- the newest `minRetainedPerProject` sessions of every project (default 2);
- sessions whose write lease is held elsewhere: each candidate is probed with `sessionPersistence.open(id, 'write')` first, and a `SessionAlreadyOwnedError` (another DSH process, or a write handle in this process) skips it and logs a warning.

## What one sweep does

1. list every visible session via `ctx.sessionPersistence.list()`;
2. scan `sessionsRoot` (default `$DSH_HOME/sessions`) to rebuild `id -> directory` plus byte size and newest mtime;
3. apply the protections above and plan candidates, oldest first, capped at `maxDeletesPerSweep` per sweep;
4. probe the write lease and `rm` the whole session directory;
5. delete the `session_projcache` record for that session.

A one-line summary logs at info; a completely idle sweep drops to debug.

## Configuration

```yaml
- insert:
    - id: session-reaper
      name: '@dsh-plugins/session-reaper'
      config:
        retentionDays: 30
        sweepIntervalMinutes: 60
        dryRun: false
        protect:
          - 'session-keep-*'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | when false, only the manual sweep handle is registered |
| `retentionDays` | `30` | retention window in days; `0` expires everything not protected |
| `archivedRetentionDays` | `null` | archived-session window; `null` inherits `retentionDays` |
| `sweepIntervalMinutes` | `60` | sweep interval, minimum 1 |
| `startDelaySeconds` | `90` | delay before the startup sweep |
| `runOnStart` | `true` | run one sweep after startup |
| `dryRun` | `false` | plan and log, delete nothing (recommended for the first run) |
| `verifyOwnership` | `true` | probe the write lease before deleting |
| `maxDeletesPerSweep` | `200` | per-sweep deletion cap; `0` means unlimited |
| `minRetainedPerProject` | `2` | newest sessions kept per project |
| `includeSubagentSessions` | `true` | count subagent sessions as cleanup candidates |
| `deleteProjectionCache` | `true` | also delete the projection-cache record |
| `sessionsRoot` | `null` | session root; `null` means `$DSH_HOME/sessions` |
| `protect` | `[]` | protection rules (substring, or anchored glob when they contain `*`/`?`) |

Config is validated at load time; bad types or out-of-range values fail the plugin with the offending field named.

## Safety boundaries

- This is out-of-band deletion: there is no atomicity between the removal and other processes or read handles. The lease probe narrows the race to the instant between `close` and `rm`.
- Only real directories are considered; symlinks are never treated as project or session directories, so deletion cannot escape `sessionsRoot`.
- Only sessions reported by `sessionPersistence.list()` are touched; anything the current build cannot list is left alone.
- Attachments (content-addressed, shared across sessions) are not reclaimed.
- Workspace `archivedSessionIds` entries for deleted sessions remain as harmless dangling ids.
- A durable `session-query-sqlite` index is not synchronized; ghost search hits are possible there. The default (`:memory:`, `openAt: never`) has no such index.

## Install

```bash
dsh plugin --profile web add 'github:iptodays/dsh-plugins#<full SHA>&path:session-reaper'
dsh plugin --profile web add file:/path/to/dsh-plugins/session-reaper
```

Merge the plugin's **cordis.patch.yml** into the top-level array of `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, then reload. Use the profile you actually run (the desktop app uses `desktop`).

## Development

```bash
npm run build   # src/*.js -> lib/*.js
npm run check   # node --check on sources and artifacts
npm test        # smoke tests (temporary dirs, never the real ~/.dsh)
```

## Changelog

### 0.1.0

- Initial release: scheduled sweeps, retention (with an archived override), live / pinned / allow-list / per-project protections, write-lease probing, dry-run, and projection-cache cleanup.

## License

MIT, see [LICENSE](./LICENSE).
