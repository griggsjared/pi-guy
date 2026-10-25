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

## Commits

Use conventional commits. Write messages in the plainest English that keeps the meaning.
