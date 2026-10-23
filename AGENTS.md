# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the vanilla JavaScript browser companion, Live2D controllers, and audio/WebSocket logic; `index.html` is the entry page.
- `server/` contains the Express/WebSocket backend and AI integrations. Selfie generation lives in `server/selfie/`; automated tests live in `server/tests/`.
- `desktop-companion/` is a separate Electron package; `src/main/` manages windows and capture, while `src/preload/` exposes renderer bridges.
- `vision-monitor/` is a separate Vite dashboard with a Node WebSocket bridge.
- `public/models/live2d/` holds model assets; `vendor/live2d/` holds the Cubism framework. `config/`, `workflows/`, and `docs/` contain configuration, image-generation workflows, and documentation.

## Build, Test, and Development Commands

Use Node.js 18+. Run commands from the root unless specified. Run `npm install` in each package.

- `npm run dev:all`: start the backend on port 8787 and Vite frontend on port 5173.
- `npm run server` / `npm run dev`: start either service independently.
- `npm run build`: compile the frontend into `dist/`; `npm run preview` serves that build locally.
- `npm test`: run all automated tests; `npm run selfie:test-b` and `npm run selfie:test-c` run planner and job-manager tests individually.
- `npm --prefix vision-monitor run start`: start the monitor bridge and dashboard.
- `npm --prefix desktop-companion run dev`: launch Electron after starting the root services.
- In `desktop-companion/`, run `npm run build:frontend`, then `npm run dist` to produce a Windows x64 NSIS installer.

## Coding Style & Naming Conventions

Follow existing two-space indentation, single-quoted strings, and semicolons. Use ES modules with explicit `.js` imports; Electron preload `.cjs` files use CommonJS. Use camelCase for filenames and functions, PascalCase for classes, and UPPER_SNAKE_CASE for constants. No linter or formatter is configured; match nearby code.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`, named `*.test.js`. Add regression cases for changed behavior and mock external AI/image providers. No coverage threshold is configured. Manually verify affected browser, monitor, or Electron flows; live generation via `npm run selfie:test -- --provider=comfyui --preset=cepat` requires configured ComfyUI and reference assets.

## Commit & Pull Request Guidelines

Follow history's Conventional Commit style: `feat(selfie): ...`, `fix(desktop): ...`, or `docs: ...`. Keep commits focused. PRs should explain behavior changes, list validation commands and results, link relevant issues, and include screenshots for visual changes.

## Security & Configuration Tips

Copy `.env.example` to `.env`; keep API keys in the backend. Never commit secrets, personal reference images, or runtime `data/`. Preserve Electron context isolation and sandboxing, and keep preload APIs narrow. Respect Live2D asset licenses.

## Language
- Reply in English, terse: changed files + how to test. Don't restate the task.
- Code, comments, commit messages, docs: English.
- Keep Indonesian for: avatar speech/captions, STT intent keywords, UI labels.
- Don't re-read the whole repo; use rg and open only relevant files.
