# AGENTS.md — guidance for AI coding agents in this repository

This file summarizes the conventions for any agent working on FSM Editor.

## Project overview

Visual finite-state-machine editor (Moore/Mealy) that exports Verilog-2001 and
Icestudio blocks (`.ice`). It is a static HTML, CSS and classic JavaScript app
with no framework or build step, so it can run directly from `file://`.

## Code rules

- Use classic JavaScript: regular `<script>` tags, no `type="module"`, IIFEs
  such as `(function (global) { ... }(window))`, and one global object per
  file (`FSM`, `VERILOG`, `ICE`, `VIMPORT`, `PHYS`, `EDITOR`, `I18N`, `PLUGIN`).
  Do not add runtime dependencies; Playwright is development-only.
- The repository is also an Icestudio external plugin. `manifest.json` and
  `icon.svg` live at the root, and the installed directory must match the
  manifest ID (`fsm-editor`). Plugin-specific behavior belongs in
  `js/plugin.js` and must remain inert outside Icestudio.
- Keep the app build-free and directly testable through `index.html`.
- When JavaScript or CSS changes, increment the shared `?v=N` cache-buster in
  `index.html`.

## Tests

```
npm ci
npm test           # core + UI (node --test)
npm run test:core  # modelo/Verilog/.ice/import, sin navegador
npm run test:ui    # Playwright con Chromium
```

Every behavior change needs a covering test, and the full suite must pass
before considering work complete. CI runs the same suite on Linux for pull
requests, release tags and manual runs.

## Git workflow

- Make local commits as needed, but **never push unless the user explicitly
  requests it**.
- Never include user prompts or messages in commits or published files; describe
  technical changes only.
- Write commit messages in English, stating what changed and why.

## File map

See [docs/arquitectura.md](docs/arquitectura.md) for the module map and design
constraints.
