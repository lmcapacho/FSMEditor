# FSM Editor

FSM Editor is a visual finite-state-machine editor for Moore and Mealy
machines. It works as a static web application and as an Icestudio external
plugin. Draw states and transitions, validate the machine, and export
Verilog-2001 or an `.ice` block.

## Usage

Open `index.html` in a modern browser. No installation or server is required.
If the browser restricts downloads from `file://`, serve the folder locally:

```sh
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Features

- Visual state and transition creation and editing.
- Moore and Mealy machines with configurable inputs, outputs and buses.
- Binary, Gray and one-hot encodings; synchronous/asynchronous and
  active-high/active-low reset.
- Automatic or manually editable transition curves, pan, zoom, undo, redo and
  local autosave.
- `.fsm` project files and compatible Verilog-module import.
- Export of a complete Verilog module, Verilog body for `basic.code`, and an
  Icestudio `.ice` file.
- Spanish and English user interface, with included examples.

## Main controls

| Action | Control |
|---|---|
| Create a state | Double-click the canvas, or select **+ State** then click |
| Create a transition | Drag from a state edge, `Shift` + drag, or select **+ Transition** |
| Edit | Double-click, or select an item and press `Enter` |
| Move | Drag a state; hold `Alt` to disable grid snapping |
| Curve a transition | Drag its line or its blue selection handle |
| Delete / duplicate | `Delete` or `Backspace` / `Ctrl+D` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` or `Ctrl+Shift+Z` |
| Save / open / new | `Ctrl+S` / `Ctrl+O` / `Ctrl+N` |

An unconditional transition is the default transition and must have the lowest
priority. The Verilog importer recognizes the editor's three-block format; it
is not intended to parse arbitrary Verilog.

## Icestudio plugin

Copy the project folder into the configured Icestudio external-plugin folder as
`fsm-editor`, matching the `id` in `manifest.json`. Restart Icestudio for the
plugin to appear.

Outside Icestudio, `js/plugin.js` does not affect normal browser or `file://`
operation.

## Development and tests

The application has no runtime dependencies. Development and testing require
Node.js 20 or newer:

```sh
npm ci
npm test
```

`npm run test:core`, `npm run test:ui` and `npm run serve` are also available.
UI tests run with Playwright and Chromium; the editor itself runs in any modern
browser.

## Desktop application

Electron provides a desktop distribution without changing the web or Icestudio
plugin modes:

```sh
npm run desktop
```

The desktop window uses native save dialogs. To create a distributable ZIP for
the current operating system, run:

```sh
npm run make:desktop
```

Build artifacts are written to `out/` and are not committed.

Continuous integration runs for pull requests to `main`, `v*` tags and manual
runs. A version tag publishes the Icestudio plugin ZIP plus desktop ZIPs built
on Linux, Windows and macOS runners. Desktop artifacts are not code-signed yet.

## Architecture

See [docs/arquitectura.md](docs/arquitectura.md) for the module map, design
constraints and test scope.

## Credits and license

Attribution and licensing will be added after rights ownership has been
reviewed. Until then, this repository does not grant permissions beyond those
provided by applicable law.
