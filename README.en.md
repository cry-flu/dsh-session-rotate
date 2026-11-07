# dsh-session-rotate

English | [简体中文](README.md)

[![test](https://github.com/cry-flu/dsh-session-rotate/actions/workflows/test.yml/badge.svg)](https://github.com/cry-flu/dsh-session-rotate/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/cry-flu/dsh-session-rotate?label=release&color=blue)](https://github.com/cry-flu/dsh-session-rotate/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue.svg)](https://cry-flu.github.io/dsh-session-rotate/)

Long sessions get more expensive with every turn. When a session reaches its step limit, this plugin waits until **the current turn has finished** (it never cuts a turn in half), opens a new session, hands over a handoff summary assembled locally, archives the old session, and switches the UI to the new one. The summary never touches a model — it is plain local templating — so what you save is the whole manual loop: summarize, copy, create a session, remember where you were.

- Runs as a profile plugin inside DeepSeek Harness (DSH) Desktop / Web GUI.
- **Not on npm.** The npm name `dsh-session-rotate` belongs to a different plugin by another author — that is not this project.

## Features

| Capability | What it does |
| --- | --- |
| Per-workspace limits | One `maxSteps` per workspace; leave it empty to inherit the global default — and keep inheriting when the default changes |
| Templated handoff summary | Fixed template, at most 16 lines, built from your latest user message plus the last assistant reply. **No extra model call.** |
| Turn-boundary prediction | Estimates the next turn from the mean of the last 3 turn deltas and rotates at the boundary instead of waiting to blow past the limit |
| Protection gates | `minSteps` hard floor, `cooldownMinutes` cooldown, `maxRotations` consecutive rotations before a workspace is paused |
| Dry run | `dryRun` only writes a log line: no session is created, nothing is archived, the UI does not jump |
| Control panel | Settings → 会话换新 to edit the default limit, the gates and the dry-run switch; saving takes effect immediately |

## Install

**1. Register the dependency and the bundle in your profile's `package.json`** (if you already cloned the repo locally, `"link:<absolute plugin path>"` or `"file:<same>"` works instead of `github:`)

```json
{
  "dependencies": { "dsh-session-rotate": "github:cry-flu/dsh-session-rotate" },
  "dsh": { "profile": { "bundles": ["...", "dsh-session-rotate"] } }
}
```

**2. Make sure `node_modules` actually contains that name** — run your package manager's install inside the profile directory, or just create a junction:

```powershell
cmd /c mklink /J "<profile>\node_modules\dsh-session-rotate" "<absolute plugin path>"
```

**3. Mount and configure it at the end of the profile's `cordis.patch.yml`**

```yaml
- insert:
    - id: dsh-session-rotate
      name: dsh-session-rotate
      config:
        defaultMaxSteps: 40
        workspaces:
          - name: my-workspace      # must match the sidebar name exactly (spaces and case included)
            maxSteps: null          # null / omitted / 0 / "" = follow defaultMaxSteps
```

`workspaces` defaults to an empty array — **empty means the plugin does nothing anywhere**. Add one line per workspace you want it to cover.

**4. Restart the whole DSH process once.** Reopening the window does *not* reload plugins. After the restart the Web GUI port changes — take the new address from the startup log.

## Configuration

Config lives in `~/.dsh/session-rotate/config.json`; the settings page edits the same file and applies on save:

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultMaxSteps` | `40` | Default step limit |
| `workspaces[]` | `[]` | `{ name, maxSteps }`; workspaces not listed here are ignored |
| `minSteps` | `10` | Do not rotate before this many cumulative steps; `0` disables the gate |
| `cooldownMinutes` | `10` | At most one rotation per workspace inside this window |
| `maxRotations` | `3` | Rotating that many times inside `cooldown × maxRotations` pauses the workspace (state lives in `state.json` and survives restarts) |
| `dryRun` | `false` | Dry-run switch |

An empty `maxSteps` follows the default and keeps following it; a positive integer pins that workspace to its own number. The workspace name must match the sidebar name **exactly** — a mismatch is skipped silently, so check `debug.log` to see what actually matched.

## Test it with the dry run

To find out whether "it will fire when the limit is reached", use the dry run instead of lowering your real limit:

1. Add the workspace to `workspaces` with `maxSteps` set to **the value you really use** (e.g. 40);
2. Turn on `dryRun` (settings page, applies on save, no restart);
3. Work normally past that step count;
4. Check `~/.dsh/session-rotate/debug.log`: a hit logs `[dry-run] 只记日志不换` (once per session per step tier, so it will not spam).

Do **not** set `maxSteps` to 2 or 3 to "test" it for real: rotations are real (new session, archived old session, UI jumps away) and you can end up with a screen full of empty sessions in one evening. Turn `dryRun` off when you are done.

## Disable and uninstall

Temporarily off: set `workspaces` to `[]` (or delete the config). Applies on save.

Full removal: delete the `- insert:` block from `cordis.patch.yml`; remove one line each from the profile's `package.json` (`dependencies` and `dsh.profile.bundles`); delete the `node_modules/dsh-session-rotate` link; restart DSH.

```bash
rm -rf ~/.dsh/session-rotate      # optional: logs, pause state and delta history too
```

## Known limitations

- **Hot reload does not work.** After changing plugin code (especially `lib/client.js`) you must restart the whole DSH process; reopening the window is not enough, and the Web GUI port changes afterwards.
- **The limit is soft.** Decisions happen between turns, never mid-turn, so the actual rotation point floats around `maxSteps`: with prediction on it usually lands slightly below, with prediction off it often lands well above (a single turn can burn twenty-odd steps).
- **The first turn of a new session is a real request.** The handoff summary is sent as the first user message; the summary itself is free, but that turn is billed like any other and costs a few tokens.
- Only top-level sessions are covered, sub-sessions are skipped; each session fires at most once; a paused workspace is resumed with `POST /dsh-session-rotate/config` and `{"clearPause": true}`, or by deleting `~/.dsh/session-rotate/state.json` and restarting the plugin.

## Testing status

Only tested in my own environment — **no** cross-platform or cross-version verification: DSH Desktop `0.2.1-rc.3` (Windows) + Node `v24.18.0`, `npm test` → 23 pass / 0 fail (`node --test`). CI (`.github/workflows/test.yml`) runs the unit tests on ubuntu + windows × node 20/22/24, but that covers unit tests only, not host behaviour.

## Disclaimer

Most of the code was AI-assisted, then human-reviewed and tested locally, but behaviour in other environments is **not** guaranteed. Try it on unimportant sessions first, confirm there are no side effects, and only then point it at work you care about.

## Control panel

![Settings → 会话换新: default step limit, workspace list, protection gates and dry run](docs/img/session-rotate-settings.png)

Settings → 会话换新. The top field is the **default step limit** (it only applies to workspaces that are checked but leave their step field empty). The middle block is the **workspace list**: check to enable, type a number to pin that workspace's own limit, leave it empty to follow the default. The bottom block is **protection gates and dry run**: the screenshot only reaches 最小步数 (minimum steps) and 冷却（分钟）(cooldown); below them sit the maximum rotations and the 试运行 (dry run, log only) switch.

## License

[MIT](LICENSE)
