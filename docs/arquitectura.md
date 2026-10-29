# Architecture

FSM Editor is a static web application. It needs no server, build step or
runtime dependencies: `index.html` loads classic scripts, each exposing a
single global object.

| Module | Responsibility |
|---|---|
| `js/model.js` | Machine model, validation, serialization and read-only example registry. |
| `examples/*.js` | Read-only example definitions, loaded without `fetch` so they work from `file://`. |
| `js/verilog.js` | Verilog-2001 generation. |
| `js/icestudio.js` | `.ice` block generation. |
| `js/vimport.js` | Import of the editor-generated Verilog format. |
| `js/physics.js` | Curve geometry and layout; no DOM access. |
| `js/editor.js` | SVG canvas, pointer interaction, selection, pan and zoom. |
| `js/app.js` | UI coordination, dialogs, history, autosave and export. |
| `js/i18n.js` | ES/EN dictionaries and language preference. |
| `js/plugin.js` | Optional Icestudio integration. |

The main flow is `model → editor/validation → exporters`. The model does not
depend on the UI, and exporters do not depend on the DOM. This makes core tests
possible in Node while Playwright covers visual interaction.

## Design constraints

- Scripts must remain compatible with `file://`.
- Do not introduce ES modules or a build step.
- Icestudio integration must be inert outside Icestudio.
- Update the shared `?v=` parameter in `index.html` after JavaScript or CSS
  changes.

## Tests

Tests in `test/` cover the model, Verilog, import, physics, plugin and UI flow.
UI tests use Playwright with Chromium in continuous integration.
