# Repository Guidelines

## Project Structure & Module Organization
- Application source lives in `src/`.
- Entrypoint is `src/main.tsx`; primary UI is currently in `src/App.tsx`.
- Shared helpers belong in `src/lib/` (for example, `src/lib/utils.ts`).
- Static assets used by the app go in `src/assets/`; public passthrough files (favicons, static icons) go in `public/`.
- Build output is generated in `dist/` and should not be edited manually.

## Build, Test, and Development Commands
- `bun install`: install dependencies from `package.json`/`bun.lock`.
- `bun run dev`: start Vite dev server with HMR.
- `bun run build`: run TypeScript project build (`tsc -b`) and produce production assets via Vite.
- `bun run lint`: run ESLint across the repo.
- `bun run preview`: serve the production build locally for validation.

## Coding Style & Naming Conventions
- Language: TypeScript + React function components.
- Indentation: 2 spaces; keep imports grouped at file top.
- Components and type names use `PascalCase` (`StatusBadge`, `VMDetails`).
- Functions/variables use `camelCase`; constants may use `UPPER_SNAKE_CASE` when truly constant.
- Keep utility logic in `src/lib/` and UI concerns in component files.
- Use ESLint as the baseline quality gate; fix lint warnings before opening a PR.

## Testing Guidelines
- No dedicated test framework is configured yet.
- Minimum pre-PR checks: `bun run lint`, `bun run build`, and manual validation via `bun run dev`.
- When adding tests, place them as `*.test.ts`/`*.test.tsx` near the related module or under a future `src/__tests__/` directory.

## Commit & Pull Request Guidelines
- Git history is not available in this workspace snapshot, so follow Conventional Commit style: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
- Keep commits focused and descriptive (example: `fix: handle VM action fetch errors`).
- PRs should include:
  - Clear summary of behavior changes.
  - Linked issue/task ID when applicable.
  - Screenshots or short recordings for UI changes.
  - Verification notes listing commands run (`bun run lint`, `bun run build`).

## Security & Configuration Tips
- Do not hardcode secrets or internal endpoints; move environment-specific values to `.env` files (Vite `VITE_` variables).
- Avoid committing sensitive infrastructure details in code, logs, or screenshots.
