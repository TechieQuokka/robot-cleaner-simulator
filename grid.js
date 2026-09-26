/* ============================================================
   grid.js — map model
   Rendering and editing live in board.js; this file is pure data.
   ============================================================ */
(function (global) {
  'use strict';

  /* Direction constants, ordered clockwise so (d + 1) % 4 is a right turn.
     The order MUST match worker.js DELTAS. */
  var DIRECTION_NAMES = [
    'LEFT', 'UP', 'RIGHT', 'DOWN',
    'UP_LEFT', 'UP_RIGHT', 'DOWN_RIGHT', 'DOWN_LEFT'
  ];

  /* [dRow, dCol] per direction index. Row grows downward. */
  var DELTAS = [
    [0, -1], [-1, 0], [0, 1], [1, 0],
    [-1, -1], [-1, 1], [1, 1], [1, -1]
  ];

  var EMPTY = 0;
  var WALL = 1;

  var MIN_SIZE = 4;
  var MAX_SIZE = 1024;

  /* Maps bigger than 256x256 are not written to localStorage — the walls of a
     1024x1024 room would not fit in the quota. */
  var PERSIST_CELL_LIMIT = 65536;

  function clampSize(n) {
    n = Math.round(Number(n) || 0);
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
  }

  /* ---- Map model ------------------------------------------ */

  function GridModel(rows, cols) {
    this.rows = clampSize(rows);
    this.cols = clampSize(cols);
    this.cells = new Uint8Array(this.rows * this.cols);
    this.start = { r: 0, c: 0 };
  }

  GridModel.prototype.index = function (r, c) {
    return r * this.cols + c;
  };

  GridModel.prototype.inBounds = function (r, c) {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
  };

  GridModel.prototype.isWall = function (r, c) {
    return !this.inBounds(r, c) || this.cells[this.index(r, c)] === WALL;
  };

  GridModel.prototype.setCell = function (r, c, value) {
    if (!this.inBounds(r, c)) return false;
    var i = this.index(r, c);
    if (this.cells[i] === value) return false;
    this.cells[i] = value;
    /* A wall may never sit under the start marker. */
    if (value === WALL && this.start.r === r && this.start.c === c) {
      this.relocateStart();
    }
    return true;
  };

  GridModel.prototype.setStart = function (r, c) {
    if (!this.inBounds(r, c)) return false;
    this.cells[this.index(r, c)] = EMPTY;
    this.start = { r: r, c: c };
    return true;
  };

  /* Move the start marker to the nearest free cell (used when it gets walled in). */
  GridModel.prototype.relocateStart = function () {
    for (var i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === EMPTY) {
        this.start = { r: Math.floor(i / this.cols), c: i % this.cols };
        return;
      }
    }
    /* Everything is a wall — carve the first cell out. */
    this.cells[0] = EMPTY;
    this.start = { r: 0, c: 0 };
  };

  GridModel.prototype.resize = function (rows, cols) {
    rows = clampSize(rows);
    cols = clampSize(cols);
    if (rows === this.rows && cols === this.cols) return false;

    var next = new Uint8Array(rows * cols);
    var copyRows = Math.min(rows, this.rows);
    var copyCols = Math.min(cols, this.cols);
    for (var r = 0; r < copyRows; r++) {
      next.set(this.cells.subarray(r * this.cols, r * this.cols + copyCols), r * cols);
    }
    this.rows = rows;
    this.cols = cols;
    this.cells = next;
    if (!this.inBounds(this.start.r, this.start.c) || this.isWall(this.start.r, this.start.c)) {
      this.start = { r: 0, c: 0 };
      this.cells[0] = EMPTY;
    }
    return true;
  };

  GridModel.prototype.clearWalls = function () {
    this.cells.fill(EMPTY);
    this.start = { r: 0, c: 0 };
  };

  GridModel.prototype.addBorder = function () {
    var c;
    for (c = 0; c < this.cols; c++) {
      this.cells[this.index(0, c)] = WALL;
      this.cells[this.index(this.rows - 1, c)] = WALL;
    }
    for (var r = 0; r < this.rows; r++) {
      this.cells[this.index(r, 0)] = WALL;
      this.cells[this.index(r, this.cols - 1)] = WALL;
    }
    if (this.isWall(this.start.r, this.start.c)) this.relocateStart();
  };

  /* Furniture-ish random room: border walls plus a few blocks and scattered obstacles. */
  GridModel.prototype.randomRoom = function () {
    this.cells.fill(EMPTY);
    this.addBorder();

    var innerRows = this.rows - 2;
    var innerCols = this.cols - 2;
    if (innerRows < 1 || innerCols < 1) return;

    var area = innerRows * innerCols;
    var blocks = Math.max(1, Math.round(area / 45));
    for (var b = 0; b < blocks; b++) {
      var h = 1 + Math.floor(Math.random() * Math.min(3, innerRows));
      var w = 1 + Math.floor(Math.random() * Math.min(4, innerCols));
      var r0 = 1 + Math.floor(Math.random() * (innerRows - h + 1));
      var c0 = 1 + Math.floor(Math.random() * (innerCols - w + 1));
      for (var r = r0; r < r0 + h; r++) {
        for (var c = c0; c < c0 + w; c++) this.cells[this.index(r, c)] = WALL;
      }
    }

    var scatter = Math.round(area * 0.06);
    for (var s = 0; s < scatter; s++) {
      var rr = 1 + Math.floor(Math.random() * innerRows);
      var cc = 1 + Math.floor(Math.random() * innerCols);
      this.cells[this.index(rr, cc)] = WALL;
    }

    /* Guarantee the robot starts in a pocket of open space. */
    for (var sr = 1; sr <= Math.min(2, this.rows - 2); sr++) {
      for (var sc = 1; sc <= Math.min(2, this.cols - 2); sc++) {
        this.cells[this.index(sr, sc)] = EMPTY;
      }
    }
    this.start = { r: 1, c: 1 };
  };

  GridModel.prototype.emptyCount = function () {
    var n = 0;
    for (var i = 0; i < this.cells.length; i++) if (this.cells[i] === EMPTY) n++;
    return n;
  };

  /** Structured-clone friendly copy for the worker. */
  GridModel.prototype.snapshot = function () {
    return {
      rows: this.rows,
      cols: this.cols,
      cells: this.cells.slice(),
      start: { r: this.start.r, c: this.start.c }
    };
  };

  GridModel.prototype.toJSON = function () {
    var data = {
      rows: this.rows,
      cols: this.cols,
      start: { r: this.start.r, c: this.start.c }
    };
    if (this.cells.length <= PERSIST_CELL_LIMIT) {
      data.cells = Array.prototype.slice.call(this.cells);
    }
    return data;
  };

  GridModel.fromJSON = function (data) {
    var model = new GridModel(data && data.rows, data && data.cols);
    if (data && Array.isArray(data.cells) && data.cells.length === model.rows * model.cols) {
      model.cells = new Uint8Array(data.cells);
    }
    if (data && data.start && model.inBounds(data.start.r, data.start.c)) {
      model.start = { r: data.start.r, c: data.start.c };
    }
    if (model.isWall(model.start.r, model.start.c)) model.relocateStart();
    return model;
  };

  /* ---- Exports -------------------------------------------- */

  global.RC = {
    DIRECTION_NAMES: DIRECTION_NAMES,
    DELTAS: DELTAS,
    EMPTY: EMPTY,
    WALL: WALL,
    MIN_SIZE: MIN_SIZE,
    MAX_SIZE: MAX_SIZE,
    GridModel: GridModel
  };
})(window);
