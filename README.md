# Robot Cleaner Path Simulator

A static web app for experimenting with coverage algorithms — DFS, BFS, wall following —
by writing Python in the browser and watching the robot's path being drawn.
No build step; it deploys to Vercel's free tier as-is.

## How it works

1. Write Python in the editor on the right — with syntax highlighting and line numbers.
2. The code runs inside a **Web Worker running Pyodide** (CPython on WASM), which
   **streams** each batch of steps to the page while the program is still running.
3. The main thread animates them live, drawing the trail on the grid.

Because steps stream out as they happen, a program that loops forever still shows
exactly what the robot did before it got stuck — and the worker can be terminated
without freezing the page. `Stop` and the timeout both keep whatever was recorded.

## Python API

Everything below is already defined — no imports, no constants to declare.

### Moving

| Call | Returns |
| --- | --- |
| `move(d)` | `-1` if a wall blocks the way (the robot stays put), otherwise the **visit count** of the tile just entered (`1`, `2`, `3`, …) |
| `go_home()` | Walks back to the start tile along an **A\*** shortest path and **ends the run**. Nothing after this call executes. |

### Sensing — free, never counts against the move limit

| Call | Returns |
| --- | --- |
| `look(d)` | `-1` wall · `0` never visited · `n` visit count |
| `scan()` | `look()` in all eight directions, as `{direction: value}` |
| `pos()` | current `(row, col)` |
| `ahead(d)` | `(row, col)` of the neighbouring tile |
| `visits(r, c)` | visit count of any tile, `-1` for a wall or outside the room |
| `size()` | `(rows, cols)` |
| `remaining()` | floor tiles not visited yet |

### Directions

Ordered clockwise, so `(d + 1) % 4` is a right turn:

```
LEFT=0  UP=1  RIGHT=2  DOWN=3
UP_LEFT=4  UP_RIGHT=5  DOWN_RIGHT=6  DOWN_LEFT=7
```

`CARDINALS`, `DIAGONALS` and `DIRECTIONS` are ready-made tuples.
Helpers: `opposite(d)`, `turn_right(d)`, `turn_left(d)`, `delta(d)`, `name(d)`.

Revisiting a tile is allowed — visit counts accumulate and show up as a heatmap.
Standard library modules (`random`, `collections`, …) import normally.

### Example — the whole of DFS

```python
def dfs():
    for d in CARDINALS:
        if look(d) == 0:          # not a wall, never visited
            move(d)
            dfs()
            move(opposite(d))     # back out the way we came

dfs()
go_home()
```

## How a run ends

**Your code decides.** Nothing stops the run on its own — full coverage is not an
ending, so you can sweep as many laps as you want before docking:

```python
for lap in range(3):
    sweep()
go_home()          # this is the ending
```

| Outcome | Condition |
| --- | --- |
| ✅ **Home** | `go_home()` ran. The return trip is drawn as a dashed second trail. |
| ⚠ No return | The program ended without calling `go_home()`. The output warns, then follows *Settings → Stop rules*: return home automatically (default) or stop where it is. |
| ⛔ Stuck | The same wall tile was hit N times in a row (default 5). A successful move — or hitting a *different* wall — resets that counter. |
| ⛔ Out of budget | The `move()` call limit was reached. With **Auto** on it is `floor tiles × 10`, capped at the 2,000,000-step log ceiling. |
| ⛔ Timeout | The run took longer than the configured timeout (default 20s); the worker is terminated. |

The A\* return uses exactly the same movement rules as `move()` — eight directions,
diagonals allowed wherever a `move()` would be — so a path home always exists, and
the robot cleans what it drives over on the way back.

## The map

- 16×16 by default, **4–1024 per side** (existing walls are preserved when resizing)
- Tools: **Wall** / **Erase** / **Start** / **Pan** — click or drag; `F3` / `F4` cycle them
- **Empty room** · **Add border** · **Random room** (furniture blocks plus scattered obstacles)
- Code, map, settings, split ratios and theme persist in `localStorage`.
  Walls of maps larger than 256×256 are not saved — only the size and start tile.

### Viewing a map bigger than the window

Cells are drawn at a fixed square size, so a large map does not shrink to fit; you
move around it instead.

| Input | Effect |
| --- | --- |
| Pan mode drag, or middle-drag in any mode | move the map |
| Wheel (Shift for horizontal), arrow keys | scroll |
| Ctrl+wheel, `+` / `-`, the zoom buttons | change cell size (4–56 px) |
| **Follow** toggle | keeps the camera on the robot while it runs; panning by hand turns it off |

Only the visible slice is drawn, so a 1024×1024 room costs roughly the same per
frame as a 16×16 one (~10 ms at 6 px cells on a full-width window).

## Layout

Simulation on the left, editor and output on the right. Both splitters drag:
horizontally between simulation and editor, vertically between editor and output.
Drag a splitter to the far edge to collapse that region into a strip; double-click
resets it. Below 980px everything stacks into one column.

In the editor, `Tab` inserts four spaces and `Ctrl`/`Cmd`+`Enter` runs. The output
panel doubles as the reference: it prints the full API on load, and the **Help**
button brings it back.

## Running locally

Web Workers are blocked on `file://`, so serve the folder:

```bash
python3 -m http.server 4173
# http://localhost:4173
```

The Pyodide runtime is fetched from a CDN on first run (a few MB, cached afterwards).

## Deploying to Vercel

Pure static files, no build step.

```bash
npm i -g vercel
vercel          # preview
vercel --prod   # production
```

Framework preset **Other**, build command empty, output directory `.`.
Connecting a Git repository and pushing works the same way.

## Files

| File | Role |
| --- | --- |
| `index.html` | Layout and settings dialog |
| `styles.css` | Design tokens, light/dark, splitters, responsive rules |
| `editor.js` | Python highlighter and line-number gutter |
| `grid.js` | Map model (walls, start tile, resizing) |
| `board.js` | Canvas renderer, camera and map editor |
| `samples.js` | Sample algorithms and the console help text |
| `worker.js` | Pyodide bootstrap, Python API, simulation engine, A\* return |
| `app.js` | Control wiring, splitters, playback |

### Notes on scale

- The move log is stored as parallel typed arrays (kind, direction, value) and
  transferred from the worker without copying: a million steps costs about 6 MB.
  Positions are recomputed during replay rather than stored.
- Steps are flushed to the page roughly every 60ms, so playback starts on the first
  batch instead of waiting for the program to finish.
- Only the most recent trail segments are drawn (20,000 by default, configurable).
  The visit heatmap is always exact, so coverage stays readable at any size.
- The recursion limit is raised per run to `floor tiles × 2 + 5000`, capped at
  4,000,000. CPython 3.11+ keeps frames on the heap, so a *recursive* DFS sweeps a
  full 1024×1024 room without trouble; the cap only exists so runaway recursion
  raises `RecursionError` instead of exhausting memory. The iterative sample is a
  style choice, not a workaround.
- For reference, a full 1024×1024 sweep takes about 2s of Python and records
  ~1,048,576 steps.
