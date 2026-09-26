/* ============================================================
   worker.js — Pyodide runtime + simulation engine
   Runs the user's Python program to completion inside a worker and
   returns a compact move log for the main thread to animate.
   Living in a worker means a runaway loop can be terminated without
   freezing the page.
   ============================================================ */
'use strict';

var PYODIDE_VERSION = 'v0.27.8';
var PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/' + PYODIDE_VERSION + '/full/';

/* [dRow, dCol] per direction index — must match grid.js DELTAS.
   LEFT UP RIGHT DOWN then the four diagonals, all clockwise. */
var DELTAS = [
  [0, -1], [-1, 0], [0, 1], [1, 0],
  [-1, -1], [-1, 1], [1, 1], [1, -1]
];

var WALL = 1;

var KIND_MOVE = 0;
var KIND_BLOCKED = 1;
var KIND_RETURN = 2;

/* Hard ceiling on recorded steps, to keep the log inside a few dozen MB. */
var MAX_LOG = 2000000;

var pyodide = null;
var readyPromise = null;
var sim = null;

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

/* ---- Compact log ------------------------------------------ */

/**
 * Parallel typed arrays instead of one object per step: a million steps cost
 * about 6 MB here versus hundreds of MB as objects. Positions are not stored;
 * the player replays them from the start tile.
 */
function LogBuffer(capacity) {
  this.cap = capacity;
  this.len = 0;
  this.kinds = new Uint8Array(capacity);
  this.dirs = new Uint8Array(capacity);
  this.vals = new Int32Array(capacity);
  this.prints = [];
  this.overflow = false;
}

LogBuffer.prototype._grow = function () {
  var next = Math.min(MAX_LOG, this.cap * 2);
  if (next === this.cap) return false;
  var kinds = new Uint8Array(next);
  var dirs = new Uint8Array(next);
  var vals = new Int32Array(next);
  kinds.set(this.kinds);
  dirs.set(this.dirs);
  vals.set(this.vals);
  this.kinds = kinds;
  this.dirs = dirs;
  this.vals = vals;
  this.cap = next;
  return true;
};

LogBuffer.prototype.push = function (kind, dir, val) {
  if (this.len === this.cap && !this._grow()) {
    this.overflow = true;
    return false;
  }
  this.kinds[this.len] = kind;
  this.dirs[this.len] = dir;
  this.vals[this.len] = val;
  this.len++;
  return true;
};

LogBuffer.prototype.pushPrint = function (text, isStderr) {
  if (this.prints.length < 20000) {
    this.prints.push({ at: this.len, text: text, stderr: !!isStderr });
  }
};

/* ---- Simulation ------------------------------------------- */

/**
 * @param {Object} grid    { rows, cols, cells, start }
 * @param {Object} options { wallLimit, maxCalls }
 */
function Simulation(grid, options) {
  this.rows = grid.rows;
  this.cols = grid.cols;
  this.cells = grid.cells;
  this.startR = grid.start.r;
  this.startC = grid.start.c;
  this.r = this.startR;
  this.c = this.startC;

  this.wallLimit = Math.max(1, options.wallLimit | 0);
  this.maxCalls = Math.max(1, options.maxCalls | 0);

  this.visits = new Int32Array(this.rows * this.cols);
  this.visits[this.index(this.r, this.c)] = 1;

  this.floorTotal = 0;
  for (var i = 0; i < this.cells.length; i++) if (this.cells[i] !== WALL) this.floorTotal++;
  this.cleaned = 1;

  this.calls = 0;
  this.moves = 0;
  this.hits = 0;
  this.returnMoves = 0;
  this.streak = 0;
  this.lastWall = -1;     // flat index of the wall hit on the previous call
  this.stopReason = null;
  this.stopKind = null;   // 'complete' | 'wall' | 'limit' | 'overflow'
  this.log = new LogBuffer(Math.min(MAX_LOG, Math.max(4096, this.maxCalls)));

  this.checkCoverage();
}

Simulation.prototype.index = function (r, c) {
  return r * this.cols + c;
};

Simulation.prototype.inBounds = function (r, c) {
  return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
};

Simulation.prototype.isWall = function (r, c) {
  return !this.inBounds(r, c) || this.cells[this.index(r, c)] === WALL;
};

Simulation.prototype.remaining = function () {
  return this.floorTotal - this.cleaned;
};

Simulation.prototype.checkCoverage = function () {
  if (this.stopReason === null && this.remaining() <= 0) {
    this.stopKind = 'complete';
    this.stopReason = 'All ' + this.floorTotal + ' tiles cleaned.';
  }
};

Simulation.prototype.checkCallLimit = function () {
  if (this.stopReason === null && this.calls >= this.maxCalls) {
    this.stopKind = 'limit';
    this.stopReason = 'Reached the move() call limit (' + this.maxCalls + ').';
  }
};

Simulation.prototype.checkOverflow = function () {
  if (this.stopReason === null && this.log.overflow) {
    this.stopKind = 'overflow';
    this.stopReason = 'Recorded the maximum of ' + MAX_LOG + ' steps.';
  }
};

/**
 * One move attempt.
 * @returns {number} -1 when blocked by a wall, otherwise the visit count
 *                   of the cell the robot just entered (1, 2, 3, …).
 */
Simulation.prototype.move = function (dir) {
  var delta = DELTAS[dir];
  var tr = this.r + delta[0];
  var tc = this.c + delta[1];

  this.calls++;

  if (this.isWall(tr, tc)) {
    /* Out-of-bounds tiles get a negative pseudo-index so they still compare
       as distinct walls. */
    var key = this.inBounds(tr, tc) ? this.index(tr, tc) : -(tr * 4001 + tc) - 2;
    /* The streak only counts consecutive hits against the SAME wall cell.
       A different wall restarts the count at 1. */
    this.streak = key === this.lastWall ? this.streak + 1 : 1;
    this.lastWall = key;
    this.hits++;

    this.log.push(KIND_BLOCKED, dir, this.streak);

    if (this.streak >= this.wallLimit) {
      this.stopKind = 'wall';
      this.stopReason = 'Hit the same wall at (' + tr + ', ' + tc + ') ' +
        this.streak + ' times in a row.';
    } else {
      this.checkCallLimit();
      this.checkOverflow();
    }
    return -1;
  }

  /* Success: the streak resets completely. */
  this.streak = 0;
  this.lastWall = -1;
  this.r = tr;
  this.c = tc;
  this.moves++;

  var idx = this.index(tr, tc);
  if (this.visits[idx] === 0) this.cleaned++;
  this.visits[idx] += 1;

  this.log.push(KIND_MOVE, dir, this.visits[idx]);

  this.checkCoverage();
  this.checkCallLimit();
  this.checkOverflow();
  return this.visits[idx];
};

/** Sensing: the cell in direction `dir` without moving into it. */
Simulation.prototype.look = function (dir) {
  var delta = DELTAS[dir];
  return this.visitsAt(this.r + delta[0], this.c + delta[1]);
};

/** @returns {number} -1 for a wall or out of bounds, otherwise the visit count. */
Simulation.prototype.visitsAt = function (r, c) {
  if (this.isWall(r, c)) return -1;
  return this.visits[this.index(r, c)];
};

/* ---- A* return trip --------------------------------------- */

/* Octile distance: the exact cost of an unobstructed 8-direction walk. */
function octile(r1, c1, r2, c2) {
  var dr = Math.abs(r1 - r2);
  var dc = Math.abs(c1 - c2);
  return (dr + dc) + (Math.SQRT2 - 2) * Math.min(dr, dc);
}

/** Binary min-heap over cell indices, keyed by the f array. */
function Heap(f) {
  this.f = f;
  this.items = [];
}
Heap.prototype.push = function (node) {
  var items = this.items;
  items.push(node);
  var i = items.length - 1;
  while (i > 0) {
    var parent = (i - 1) >> 1;
    if (this.f[items[parent]] <= this.f[items[i]]) break;
    var tmp = items[parent]; items[parent] = items[i]; items[i] = tmp;
    i = parent;
  }
};
Heap.prototype.pop = function () {
  var items = this.items;
  var top = items[0];
  var last = items.pop();
  if (items.length) {
    items[0] = last;
    var i = 0;
    for (;;) {
      var l = i * 2 + 1, r = l + 1, best = i;
      if (l < items.length && this.f[items[l]] < this.f[items[best]]) best = l;
      if (r < items.length && this.f[items[r]] < this.f[items[best]]) best = r;
      if (best === i) break;
      var tmp = items[best]; items[best] = items[i]; items[i] = tmp;
      i = best;
    }
  }
  return top;
};

/**
 * Shortest path from the robot back to its starting tile, using exactly the
 * same movement rules as move() (8 directions, diagonals allowed wherever a
 * move() would be) so a path always exists.
 * @returns {number[]|null} cell indices excluding the current cell.
 */
Simulation.prototype.findReturnPath = function () {
  var goal = this.index(this.startR, this.startC);
  var origin = this.index(this.r, this.c);
  if (origin === goal) return [];

  var n = this.rows * this.cols;
  var g = new Float64Array(n).fill(Infinity);
  var f = new Float64Array(n).fill(Infinity);
  var prev = new Int32Array(n).fill(-1);
  var closed = new Uint8Array(n);

  g[origin] = 0;
  f[origin] = octile(this.r, this.c, this.startR, this.startC);

  var open = new Heap(f);
  open.push(origin);
  var found = false;

  while (open.items.length) {
    var cur = open.pop();
    if (cur === goal) { found = true; break; }
    if (closed[cur]) continue;
    closed[cur] = 1;

    var cr = (cur / this.cols) | 0;
    var cc = cur - cr * this.cols;
    for (var d = 0; d < 8; d++) {
      var nr = cr + DELTAS[d][0];
      var nc = cc + DELTAS[d][1];
      if (this.isWall(nr, nc)) continue;
      var ni = nr * this.cols + nc;
      if (closed[ni]) continue;

      var tentative = g[cur] + (d < 4 ? 1 : Math.SQRT2);
      if (tentative < g[ni]) {
        g[ni] = tentative;
        f[ni] = tentative + octile(nr, nc, this.startR, this.startC);
        prev[ni] = cur;
        open.push(ni);
      }
    }
  }

  if (!found) return null;

  var path = [];
  var node = goal;
  while (node !== origin) {
    path.push(node);
    node = prev[node];
    if (node === -1) return null;
  }
  return path.reverse();
};

/** Append the return trip to the log and park the robot on the start tile. */
Simulation.prototype.appendReturnTrip = function () {
  var path = this.findReturnPath();
  if (path === null) return false;

  for (var i = 0; i < path.length; i++) {
    var tr = (path[i] / this.cols) | 0;
    var tc = path[i] - tr * this.cols;
    var dr = tr - this.r;
    var dc = tc - this.c;
    var dir = 0;
    for (var d = 0; d < 8; d++) {
      if (DELTAS[d][0] === dr && DELTAS[d][1] === dc) { dir = d; break; }
    }
    this.log.push(KIND_RETURN, dir, 0);
    this.r = tr;
    this.c = tc;
    this.returnMoves++;
  }
  return true;
};

/* ---- Python bridge --------------------------------------- */

function jsMove(dir) { return sim ? sim.move(dir | 0) : -1; }
function jsLook(dir) { return sim ? sim.look(dir | 0) : -1; }
function jsVisits(r, c) { return sim ? sim.visitsAt(r | 0, c | 0) : -1; }
function jsPosR() { return sim ? sim.r : 0; }
function jsPosC() { return sim ? sim.c : 0; }
function jsRows() { return sim ? sim.rows : 0; }
function jsCols() { return sim ? sim.cols : 0; }
function jsRemaining() { return sim ? sim.remaining() : 0; }
function jsStopReason() { return sim && sim.stopReason ? sim.stopReason : null; }

var PRELUDE = [
  'import sys, traceback',
  '',
  '# Raised per run in _set_depth() once the map size is known.',
  'sys.setrecursionlimit(20000)',
  '',
  '',
  'def _set_depth(limit):',
  '    sys.setrecursionlimit(limit)',
  '',
  '# Clockwise, so (d + 1) % 4 is a right turn.',
  'LEFT, UP, RIGHT, DOWN = 0, 1, 2, 3',
  'UP_LEFT, UP_RIGHT, DOWN_RIGHT, DOWN_LEFT = 4, 5, 6, 7',
  '',
  'CARDINALS = (LEFT, UP, RIGHT, DOWN)',
  'DIAGONALS = (UP_LEFT, UP_RIGHT, DOWN_RIGHT, DOWN_LEFT)',
  'DIRECTIONS = CARDINALS + DIAGONALS',
  '',
  '_NAMES = {',
  '    LEFT: "LEFT", UP: "UP", RIGHT: "RIGHT", DOWN: "DOWN",',
  '    UP_LEFT: "UP_LEFT", UP_RIGHT: "UP_RIGHT",',
  '    DOWN_RIGHT: "DOWN_RIGHT", DOWN_LEFT: "DOWN_LEFT",',
  '}',
  '',
  '_DELTAS = {',
  '    LEFT: (0, -1), UP: (-1, 0), RIGHT: (0, 1), DOWN: (1, 0),',
  '    UP_LEFT: (-1, -1), UP_RIGHT: (-1, 1),',
  '    DOWN_RIGHT: (1, 1), DOWN_LEFT: (1, -1),',
  '}',
  '',
  '',
  'class SimulationStop(Exception):',
  '    """Raised when a stop rule ends the run."""',
  '',
  '',
  'def _direction(d):',
  '    if isinstance(d, bool) or not isinstance(d, int) or d not in _NAMES:',
  '        raise ValueError(',
  '            "expected a direction constant: LEFT, UP, RIGHT, DOWN, "',
  '            "UP_LEFT, UP_RIGHT, DOWN_RIGHT, DOWN_LEFT"',
  '        )',
  '    return d',
  '',
  '',
  'def move(d):',
  '    """Step one tile. -1 if a wall blocks the way (the robot stays put),',
  '    otherwise the visit count of the tile just entered."""',
  '    _direction(d)',
  '    result = int(__js_move(d))',
  '    reason = __js_stop_reason()',
  '    if reason is not None:',
  '        raise SimulationStop(reason)',
  '    return result',
  '',
  '',
  'def look(d):',
  '    """Peek without moving. -1 wall, 0 not visited yet, n visit count."""',
  '    _direction(d)',
  '    return int(__js_look(d))',
  '',
  '',
  'def scan():',
  '    """look() in all eight directions, as {direction: value}."""',
  '    return {d: look(d) for d in DIRECTIONS}',
  '',
  '',
  'def pos():',
  '    """Current (row, col)."""',
  '    return (int(__js_pos_r()), int(__js_pos_c()))',
  '',
  '',
  'def ahead(d):',
  '    """(row, col) of the neighbouring tile in direction d."""',
  '    _direction(d)',
  '    r, c = pos()',
  '    dr, dc = _DELTAS[d]',
  '    return (r + dr, c + dc)',
  '',
  '',
  'def visits(r, c):',
  '    """Visit count of any tile. -1 for a wall or outside the room."""',
  '    return int(__js_visits(r, c))',
  '',
  '',
  'def size():',
  '    """Room size as (rows, cols)."""',
  '    return (int(__js_rows()), int(__js_cols()))',
  '',
  '',
  'def remaining():',
  '    """How many floor tiles have never been visited."""',
  '    return int(__js_remaining())',
  '',
  '',
  'def delta(d):',
  '    """(dRow, dCol) for direction d."""',
  '    return _DELTAS[_direction(d)]',
  '',
  '',
  'def name(d):',
  '    """Readable name of direction d."""',
  '    return _NAMES[_direction(d)]',
  '',
  '',
  'def opposite(d):',
  '    """Reverse direction."""',
  '    _direction(d)',
  '    return (d + 2) % 4 if d < 4 else (d - 4 + 2) % 4 + 4',
  '',
  '',
  'def turn_right(d):',
  '    """Rotate 90 degrees clockwise."""',
  '    _direction(d)',
  '    return (d + 1) % 4 if d < 4 else (d - 4 + 1) % 4 + 4',
  '',
  '',
  'def turn_left(d):',
  '    """Rotate 90 degrees counter-clockwise."""',
  '    _direction(d)',
  '    return (d + 3) % 4 if d < 4 else (d - 4 + 3) % 4 + 4',
  '',
  '',
  '_API = {',
  '    "move": move, "look": look, "scan": scan, "pos": pos, "ahead": ahead,',
  '    "visits": visits, "size": size, "remaining": remaining,',
  '    "delta": delta, "name": name,',
  '    "opposite": opposite, "turn_right": turn_right, "turn_left": turn_left,',
  '    "SimulationStop": SimulationStop,',
  '    "LEFT": LEFT, "UP": UP, "RIGHT": RIGHT, "DOWN": DOWN,',
  '    "UP_LEFT": UP_LEFT, "UP_RIGHT": UP_RIGHT,',
  '    "DOWN_RIGHT": DOWN_RIGHT, "DOWN_LEFT": DOWN_LEFT,',
  '    "CARDINALS": CARDINALS, "DIAGONALS": DIAGONALS, "DIRECTIONS": DIRECTIONS,',
  '}',
  '',
  '',
  'def __run_user_code(src):',
  '    scope = dict(_API)',
  '    scope["__name__"] = "__main__"',
  '    try:',
  '        exec(compile(src, "<user_code>", "exec"), scope)',
  '    except SimulationStop as stop:',
  '        return ["stopped", str(stop)]',
  '    except BaseException as err:',
  '        # Drop this frame so the traceback starts at the user\'s own code.',
  '        tb = err.__traceback__.tb_next if err.__traceback__ else None',
  '        return ["error", "".join(traceback.format_exception(type(err), err, tb))]',
  '    return ["ok", ""]',
  ''
].join('\n');

function ensurePyodide() {
  if (readyPromise) return readyPromise;

  readyPromise = (async function () {
    post({ type: 'status', text: 'Downloading Python engine…' });
    importScripts(PYODIDE_BASE + 'pyodide.js');
    pyodide = await self.loadPyodide({ indexURL: PYODIDE_BASE });

    pyodide.setStdout({ batched: function (text) { if (sim) sim.log.pushPrint(text, false); } });
    pyodide.setStderr({ batched: function (text) { if (sim) sim.log.pushPrint(text, true); } });

    pyodide.globals.set('__js_move', jsMove);
    pyodide.globals.set('__js_look', jsLook);
    pyodide.globals.set('__js_visits', jsVisits);
    pyodide.globals.set('__js_pos_r', jsPosR);
    pyodide.globals.set('__js_pos_c', jsPosC);
    pyodide.globals.set('__js_rows', jsRows);
    pyodide.globals.set('__js_cols', jsCols);
    pyodide.globals.set('__js_remaining', jsRemaining);
    pyodide.globals.set('__js_stop_reason', jsStopReason);
    pyodide.runPython(PRELUDE);

    post({ type: 'ready', version: PYODIDE_VERSION });
  })();

  readyPromise.catch(function (err) {
    readyPromise = null;
    post({
      type: 'fatal',
      message: 'Could not load the Python engine: ' + String((err && err.message) || err)
    });
  });

  return readyPromise;
}

/* ---- Message handling ------------------------------------ */

self.onmessage = async function (event) {
  var data = event.data || {};

  if (data.type === 'init') {
    try { await ensurePyodide(); } catch (e) { /* already reported */ }
    return;
  }

  if (data.type !== 'run') return;

  try {
    await ensurePyodide();
  } catch (e) {
    return;
  }

  var startedAt = Date.now();
  sim = new Simulation(data.grid, data.options);

  var outcome = 'ok';
  var detail = '';

  if (sim.stopKind === 'complete') {
    /* Nothing left to clean before the program even starts. */
    outcome = 'stopped';
    detail = sim.stopReason;
  } else {
    try {
      /* CPython 3.11+ keeps frames on the heap, so deep recursion is fine — a
         full recursive DFS needs one frame per tile plus a few for the API
         calls nested at the deepest point, hence the ×2 headroom. The ceiling
         only exists so runaway recursion fails with RecursionError instead of
         exhausting memory and taking the worker down with it. */
      var depth = Math.min(4000000, Math.max(20000, sim.floorTotal * 2 + 5000));
      var setDepth = pyodide.globals.get('_set_depth');
      setDepth(depth);
      setDepth.destroy();

      var runner = pyodide.globals.get('__run_user_code');
      var result = runner(data.code);
      var pair = result.toJs ? result.toJs() : result;
      if (result.destroy) result.destroy();
      runner.destroy();
      outcome = pair[0];
      detail = pair[1];
    } catch (err) {
      outcome = 'error';
      detail = String((err && err.message) || err);
    }
  }

  /* A stop rule may have fired on the last call without the exception
     propagating — for example the program ended right after it. */
  if (outcome === 'ok' && sim.stopReason) {
    outcome = 'stopped';
    detail = sim.stopReason;
  }

  /* Full coverage earns the A* trip home. */
  var returnPathFound = true;
  if (sim.stopKind === 'complete') {
    returnPathFound = sim.appendReturnTrip();
  }

  var kinds = sim.log.kinds.slice(0, sim.log.len);
  var dirs = sim.log.dirs.slice(0, sim.log.len);
  var vals = sim.log.vals.slice(0, sim.log.len);

  post({
    type: 'result',
    outcome: outcome,
    stopKind: sim.stopKind,
    detail: detail,
    returnPathFound: returnPathFound,
    elapsedMs: Date.now() - startedAt,
    log: { kinds: kinds, dirs: dirs, vals: vals, prints: sim.log.prints, len: sim.log.len },
    stats: {
      calls: sim.calls,
      moves: sim.moves,
      hits: sim.hits,
      cleaned: sim.cleaned,
      floorTotal: sim.floorTotal,
      returnMoves: sim.returnMoves
    }
  }, [kinds.buffer, dirs.buffer, vals.buffer]);

  sim = null;
};
