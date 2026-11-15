![pi-guy](resources/logo.svg)

## Installation

```sh
pi install git:github.com/griggsjared/pi-guy
```

Or try it for one session without adding it to your settings:

```sh
pi -e git:github.com/griggsjared/pi-guy
```

From a local checkout, use `pi -e .`.

## Features

### Subagents

Run exploration, planning, implementation, review, tests, and log analysis in the background.

Ask Pi: “Have a scout find the authentication code while you inspect the routes.”

```text
/subagent-profile                              Choose a model profile
/subagent-tail <id>                             Follow a job's events
/subagent-cancel <id>                           Cancel a job
/subagent-send <id> steer <message>             Redirect the current task
/subagent-send <id> followup <message>          Queue another instruction
```

### Web

`web_search` finds pages; `web_fetch` extracts their text.

Ask Pi: “Find the migration guide and read the breaking changes.”

### Pull requests

`github_pr` inspects pull requests, review feedback, and CI checks without changing them.
Requires `gh` in PATH and access to the repository.

Ask Pi: “Read the unresolved feedback and failing checks on PR #42.”

### Questions

`ask_user` presents interactive choices when a decision needs your input.

Ask Pi: “Ask me which approach to use before implementing it.”

### Header

Shows the package version, context files, and loaded extensions. Appears automatically in interactive sessions.

### Status line

Shows the model, context usage, cache hit rate, and available provider usage. Appears automatically below the editor.

### Working indicator

Animated working text and a custom prompt indicator. Runs automatically while Pi works.

### Context

`/context` opens an estimated breakdown of the current context usage.

```text
/context
```

### Side questions

`/btw` opens a side conversation without continuing the main task.

```text
/btw Why does this function need a lock?
```

### Local instructions

Create `AGENTS.local.md` in the project or a parent directory. Pi Guy loads it at session start and includes it in the agent's instructions.

```markdown
Prefer focused tests for the files changed in this session.
```

## Settings

Pi Guy reads `pi-guy.json` from Pi's agent folder, usually `~/.pi/agent/pi-guy.json`. Each feature has a section named after its folder in `src/`: `agents-local`, `ask-user`, `btw`, `context`, `github-pr`, `header`, `provider-usage`, `statusline`, `subagents`, `web-search`, and `working-indicator`.

Turn a feature off by setting `enabled` to `false` in its section. Changes apply the next time Pi starts or reloads.

```json
{
  "working-indicator": { "enabled": false },
  "btw": { "enabled": false }
}
```

Features that use another feature's data keep working without it. For example, turning off `provider-usage` removes plan usage from the status line, and turning off `agents-local` also stops subagents from loading `AGENTS.local.md`.

## Development

```sh
npm ci
npm run fix    # Apply lint fixes and format
npm run check  # Check formatting, lint, types, unused code, and tests
```
