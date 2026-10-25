# pi-guy

One Pi package with one extension. `package.json` points Pi at `src/index.ts`, which runs every factory listed in `factories`.

## Checks

- `npm run typecheck` typechecks `src/` and `tests/` against the root `tsconfig.json`.
- `npm test` runs every `tests/**/*.test.ts` file.

## Style

- Indent with tabs, except `src/subagents/` and `tests/subagents/`, which use 2 spaces.
- Prefer `import type { … }` over `import { type X }`.
- Use `!` for index access to values known to be present.
- In tests, write literal characters such as `π` and `·`, not `\u` escapes.
- Tests use the literal event channel names, not the constants from `src/lib/events.ts`, so a renamed channel fails a test.

## Patterns

- Each top-level folder under `src/` except `lib/` default-exports one `(pi: ExtensionAPI)` factory from `index.ts` that registers everything it owns. Don't start timers or processes in the factory: start session-wide ones in `session_start` and task-specific ones in the handler that needs them, and make sure `session_shutdown` releases anything still running.
- Keep state inside the factory. Module-level state needs a comment giving the reason.
- Start with `index.ts`. Move code to a named file in the same folder only when it has a separate job, such as `picker.ts`. Put types shared within a folder in `types.ts`. Code goes in `src/lib/` only when three or more folders share it with the same contract.
- Export only what other files in `src/` import. Pure parse, normalize, and format functions may also be exported for tests; test everything else through the factory or tool. Types and interfaces may stay exported.
- Tools define their TypeBox schema as a module-level constant, throw on failure, and render safely when details are missing or the result is partial.
- Commands report errors with `ctx.ui.notify(…, "error")`. Background work may fail quietly and keep its last good value.
- Run programs with `pi.exec`. Use `node:child_process` only when `pi.exec` lacks something the call needs, such as streaming output, per-process environment variables, or an output cap, and say which in a comment.
- Find Pi's config folder with `getAgentDir()`, not a fixed `~/.pi/agent`.
- Pass the abort signal to every network call and process, and give network calls a timeout.
- Measure and cut terminal text with `pi-tui` helpers such as `visibleWidth` and `truncateToWidth`.
- In tests, replace `fetch`, `Date`, and timers with `t.mock`. Inject only process spawners, such as `spawnFn`. Test titles describe behavior, not function names.

## Commits

Use conventional commits. Write messages in the plainest English that keeps the meaning.
