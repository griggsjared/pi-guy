# pi-guy

One Pi package with one extension. `package.json` points Pi at `src/index.ts`, which runs every factory listed in `factories`, in order. Handlers for the same event run in that order too.

## Layout

Each folder under `src/` except `lib/` is one feature. `tests/` mirrors `src/`.

| Folder              | What it does                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `agents-local`      | Loads `AGENTS.local.md` files into the context.                    |
| `ask-user`          | The `ask_user` tool and its picker.                                |
| `btw`               | The `/btw` side-question command.                                  |
| `context`           | The `/context` usage breakdown.                                    |
| `github-pr`         | The `github_pr` tool.                                              |
| `header`            | The startup header.                                                |
| `provider-usage`    | Fetches and caches plan usage and balances, one file per provider. |
| `statusline`        | The footer below the editor.                                       |
| `subagents`         | Background agents, their tools, commands, and profiles.            |
| `web-search`        | The `web_search` and `web_fetch` tools.                            |
| `working-indicator` | The animated working line.                                         |
| `lib`               | Code and contracts that features share. Registers nothing.         |

To add a feature, create its folder, add its factory to `factories` in `src/index.ts`, and add it to the list in `tests/index.test.ts`.

## Checks

- `npm run check` runs the format check, lint, typecheck, knip, and tests, in the same order as CI. Run it before calling work done.
- `npm run fix` applies lint fixes, then formats. Run `npm run check` afterward, because some lint fixes break the typecheck.
- `npm run typecheck` typechecks `src/` and `tests/` against the root `tsconfig.json`.
- `npm test` runs every `tests/**/*.test.ts` file. To run one file, use `node --test tests/<folder>/<file>.test.ts`.
- oxfmt (`.oxfmtrc.json`) sets formatting and import order. oxlint (`.oxlintrc.json`) enforces `import type` and `interface` for object shapes. knip (`knip.json`) reports unused exports, files, and dependencies.

## Structure

- Each feature folder default-exports one `(pi: ExtensionAPI)` factory from `index.ts`. The factory registers everything the folder owns, directly or by calling the folder's own helpers, such as `registerRenderers(pi)` or `createSubagentTool(deps)`.
- Start with `index.ts`. Move code to a named file in the same folder only when it has a separate job, such as `picker.ts`.
- Keep each type in the file that owns it, exported when another file needs it. Use `types.ts` only for types that several files in the folder share and no one file owns.
- Feature folders never import from each other. They share in three ways:
  - **Code in `src/lib/`.** Put code there when three or more folders use it with the same contract, or when two folders must agree on a contract, such as `usage-status.ts`.
  - **Events.** One folder emits on `pi.events` and another listens. The channel name and payload type live in `src/lib/events.ts`.
  - **Status keys.** One folder publishes with `ctx.ui.setStatus(key, …)` and the footer reads it. Both sides must use the same key.

## State and lifecycle

- Keep state inside the factory. Module-level state needs a comment giving the reason.
- Don't start timers or processes in the factory. Start session-wide ones in `session_start` and task-specific ones in the handler that needs them.
- Make sure `session_shutdown` releases anything still running.
- Background work may fail quietly and keep its last good value.

## Tools, commands, and outside calls

- Tools define their TypeBox schema as a module-level constant, throw on failure, and render safely when details are missing or the result is partial.
- Commands report errors with `ctx.ui.notify(…, "error")`.
- Run programs with `pi.exec`. Use `node:child_process` only when `pi.exec` lacks something the call needs, such as streaming output, per-process environment variables, or an output cap, and say which in a comment.
- Pass the abort signal to every network call and process, and give network calls a timeout.
- Find Pi's config folder with `getAgentDir()`, not a fixed `~/.pi/agent`.
- Measure and cut terminal text with `pi-tui` helpers such as `visibleWidth` and `truncateToWidth`.

## Style

- Use `!` for index access to values known to be present.
- Write top-level helpers as `function` declarations. Arrow functions are fine inside other functions and as callbacks.
- Name values that carry meaning as `UPPER_SNAKE` constants with the unit in the name, such as `FETCH_TIMEOUT_MS` or `MAX_RESPONSE_BYTES`. Keep them with the file's other constants, near the top of the file that owns them. This covers timeouts, intervals, cache lifetimes, limits, sizes, retry counts, and keys or names that more than one place must agree on.
- Leave inline `0`, `1`, `-1`, indexes, layout arithmetic such as `width - 2`, single unit factors such as `ms / 1000`, user-facing text, error messages, and theme keys.
- Write large time factors as products, such as `24 * 60 * 60`, not `86400`, and other large numbers with separators, such as `1_000_000`.

## Tests

- Pure parse, normalize, and format functions may be exported for tests. Test everything else through the factory or tool.
- Replace `fetch`, `Date`, and timers with `t.mock`. Inject only process spawners, such as `spawnFn`.
- Tests must not read or write real files under the home folder. Mock them, as `mockCli` in `tests/helpers/claude-cli.ts` does.
- Use the literal event channel names, not the constants from `src/lib/events.ts`, so a renamed channel fails a test.
- Write literal characters such as `π` and `·`, not `\u` escapes.
- Test titles describe behavior, not function names.
- Shared helpers live in `tests/helpers/`. Helpers for one feature live in that feature's `helpers.ts`.

## Commits

Use conventional commits with the feature folder as the scope, such as `fix(statusline): …`. Write messages in the plainest English that keeps the meaning.
