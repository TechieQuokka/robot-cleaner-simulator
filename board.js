/* ============================================================
   board.js — canvas renderer, camera and map editor
   Only the visible slice of the map is drawn, so a 1000x1000 room
   costs the same per frame as a 10x10 one.
   ============================================================ */
(function (RC) {
  'use strict';

  var WALL = RC.WALL;
  var EMPTY = RC.EMPTY;

  var MIN_CELL = 4;
  var MAX_CELL = 56;

  var HIT_FLASH_MS = 320;
  /* Keep the robot inside the middle 60% of the viewport while following. */
  var DEAD_ZONE = 0.6;

  function parseTriplet(value) {
    var parts = String(value).trim().split(/[\s,]+/).map(Number);
    return parts.length >= 3 && parts.every(function (n) { return !isNaN(n); })
      ? parts.slice(0, 3)
      : [128, 128, 128];
  }

  function rgba(triplet, alpha) {
    return 'rgba(' + triplet[0] + ',' + triplet[1] + ',' + triplet[2] + ',' + alpha + ')';
  }

  /**
   * @param {Object} refs  { canvas, stage }
   * @param {Object} hooks { onEdit, onCameraMove }
   */
  function CanvasBoard(refs, hooks) {
    this.canvas = refs.canvas;
    this.stage = refs.stage;
    this.ctx = this.canvas.getContext('2d');
    this.onEdit = (hooks && hooks.onEdit) || function () {};
    this.onCameraMove = (hooks && hooks.onCameraMove) || function () {};

    this.model = null;
    this.visits = null;

    this.cellSize = 28;
    this.camX = 0;
    this.camY = 0;
    this.width = 0;
    this.height = 0;

    this.mode = 'wall';
    this.follow = true;
    this.view = { trail: true, returnPath: true, heat: true, counts: true };

    this.robot = { r: 0, c: 0 };
    this.anim = null;          // { fromR, fromC, toR, toC, t0, dur }
    this.returning = false;
    this.hit = null;           // { r, c, t0 }

    this.trailCap = 20000;
    this.trailData = new Int32Array(this.trailCap * 4);
    this.trailLen = 0;
    this.trailHead = 0;

    this.returnSegs = [];

    this.painting = false;
    this.panning = null;
    this.paintValue = WALL;

    this.dirty = true;
    this.palette = null;

    this.refreshPalette();
    this._bindInput();
    this._observeSize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ---- Setup ---------------------------------------------- */

  CanvasBoard.prototype.setModel = function (model) {
    this.model = model;
    this.robot = { r: model.start.r, c: model.start.c };
    this.anim = null;
    this.clampCamera();
    this.dirty = true;
  };

  CanvasBoard.prototype.setVisits = function (visits) {
    this.visits = visits;
    this.dirty = true;
  };

  CanvasBoard.prototype.setMode = function (mode) {
    this.mode = mode;
    this.canvas.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
  };

  CanvasBoard.prototype.setView = function (view) {
    this.view = view;
    this.dirty = true;
  };

  CanvasBoard.prototype.setFollow = function (on) {
    this.follow = !!on;
    if (this.follow) this.followRobot(true);
  };

  CanvasBoard.prototype.setTrailCapacity = function (cap) {
    cap = Math.max(100, Math.min(400000, cap | 0));
    if (cap === this.trailCap) return;
    this.trailCap = cap;
    this.trailData = new Int32Array(cap * 4);
    this.trailLen = 0;
    this.trailHead = 0;
    this.dirty = true;
  };

  CanvasBoard.prototype.refreshPalette = function () {
    var css = getComputedStyle(document.documentElement);
    function v(name) { return css.getPropertyValue(name).trim(); }
    this.palette = {
      floor: v('--bg-sunken'),
      wall: v('--wall'),
      wallEdge: v('--wall-edge'),
      line: v('--line'),
      text: v('--text-soft'),
      start: v('--start'),
      danger: v('--danger'),
      heat: parseTriplet(v('--heat-rgb')),
      trail: parseTriplet(v('--trail-rgb')),
      ret: parseTriplet(v('--return-rgb')),
      robot: parseTriplet(v('--robot-rgb')),
      elev: v('--bg-elev')
    };
    this.dirty = true;
  };

  CanvasBoard.prototype._observeSize = function () {
    var self = this;
    function measure() {
      var rect = self.stage.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      self.width = Math.max(1, Math.floor(rect.width));
      self.height = Math.max(1, Math.floor(rect.height));
      self.canvas.width = Math.floor(self.width * dpr);
      self.canvas.height = Math.floor(self.height * dpr);
      self.canvas.style.width = self.width + 'px';
      self.canvas.style.height = self.height + 'px';
      self.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      self.clampCamera();
      self.dirty = true;
    }
    if (window.ResizeObserver) {
      new ResizeObserver(measure).observe(this.stage);
    } else {
      window.addEventListener('resize', measure);
    }
    measure();
  };

  /* ---- Camera --------------------------------------------- */

  CanvasBoard.prototype.visibleCols = function () { return this.width / this.cellSize; };
  CanvasBoard.prototype.visibleRows = function () { return this.height / this.cellSize; };

  CanvasBoard.prototype.clampCamera = function () {
    if (!this.model) return;
    var vw = this.visibleCols();
    var vh = this.visibleRows();
    /* When the map is smaller than the viewport, centre it instead. */
    this.camX = this.model.cols <= vw
      ? (this.model.cols - vw) / 2
      : Math.min(this.model.cols - vw, Math.max(0, this.camX));
    this.camY = this.model.rows <= vh
      ? (this.model.rows - vh) / 2
      : Math.min(this.model.rows - vh, Math.max(0, this.camY));
  };

  CanvasBoard.prototype.panBy = function (dCols, dRows) {
    this.camX += dCols;
    this.camY += dRows;
    this.clampCamera();
    this.dirty = true;
    this.onCameraMove();
  };

  CanvasBoard.prototype.centerOn = function (r, c) {
    this.camX = c + 0.5 - this.visibleCols() / 2;
    this.camY = r + 0.5 - this.visibleRows() / 2;
    this.clampCamera();
    this.dirty = true;
  };

  /** Scroll only when the robot leaves the dead zone, so the view stays calm. */
  CanvasBoard.prototype.followRobot = function (force) {
    if (!this.model) return;
    var vw = this.visibleCols();
    var vh = this.visibleRows();
    if (force) { this.centerOn(this.robot.r, this.robot.c); return; }

    var marginX = vw * (1 - DEAD_ZONE) / 2;
    var marginY = vh * (1 - DEAD_ZONE) / 2;
    var x = this.robot.c + 0.5;
    var y = this.robot.r + 0.5;
    var moved = false;

    if (x < this.camX + marginX) { this.camX = x - marginX; moved = true; }
    else if (x > this.camX + vw - marginX) { this.camX = x - vw + marginX; moved = true; }
    if (y < this.camY + marginY) { this.camY = y - marginY; moved = true; }
    else if (y > this.camY + vh - marginY) { this.camY = y - vh + marginY; moved = true; }

    if (moved) { this.clampCamera(); this.dirty = true; }
  };

  CanvasBoard.prototype.setCellSize = function (px, anchor) {
    var next = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.round(px)));
    if (next === this.cellSize) return;
    /* Keep the anchor point (default: viewport centre) in place while zooming. */
    var ax = anchor ? anchor.x : this.width / 2;
    var ay = anchor ? anchor.y : this.height / 2;
    var worldX = this.camX + ax / this.cellSize;
    var worldY = this.camY + ay / this.cellSize;
    this.cellSize = next;
    this.camX = worldX - ax / next;
    this.camY = worldY - ay / next;
    this.clampCamera();
    this.dirty = true;
    this.onCameraMove();
  };

  /* ---- Robot / trail state -------------------------------- */

  CanvasBoard.prototype.placeRobot = function (r, c, durationMs) {
    if (durationMs > 0) {
      this.anim = {
        fromR: this.robot.r, fromC: this.robot.c,
        toR: r, toC: c,
        t0: performance.now(), dur: durationMs
      };
    } else {
      this.anim = null;
    }
    this.robot = { r: r, c: c };
    if (this.follow) this.followRobot(false);
    this.dirty = true;
  };

  CanvasBoard.prototype.setReturning = function (on) {
    this.returning = !!on;
    this.dirty = true;
  };

  CanvasBoard.prototype.addTrail = function (fr, fc, tr, tc) {
    var i = this.trailHead * 4;
    this.trailData[i] = fr;
    this.trailData[i + 1] = fc;
    this.trailData[i + 2] = tr;
    this.trailData[i + 3] = tc;
    this.trailHead = (this.trailHead + 1) % this.trailCap;
    if (this.trailLen < this.trailCap) this.trailLen++;
    this.dirty = true;
  };

  CanvasBoard.prototype.addReturn = function (fr, fc, tr, tc) {
    if (this.returnSegs.length < 200000) this.returnSegs.push(fr, fc, tr, tc);
    this.dirty = true;
  };

  CanvasBoard.prototype.clearTrails = function () {
    this.trailLen = 0;
    this.trailHead = 0;
    this.returnSegs.length = 0;
    this.returning = false;
    this.hit = null;
    this.dirty = true;
  };

  CanvasBoard.prototype.flashHit = function (r, c) {
    this.hit = { r: r, c: c, t0: performance.now() };
    this.dirty = true;
  };

  CanvasBoard.prototype.markDirty = function () { this.dirty = true; };

  /* ---- Rendering ------------------------------------------ */

  CanvasBoard.prototype._loop = function (now) {
    var animating = (this.anim && now - this.anim.t0 < this.anim.dur) ||
      (this.hit && now - this.hit.t0 < HIT_FLASH_MS);
    if (this.dirty || animating) {
      this.dirty = false;
      this.render(now);
    }
    requestAnimationFrame(this._loop);
  };

  CanvasBoard.prototype.render = function (now) {
    var ctx = this.ctx;
    var model = this.model;
    if (!model) return;

    var cs = this.cellSize;
    var pal = this.palette;
    var w = this.width;
    var h = this.height;

    ctx.clearRect(0, 0, w, h);

    var c0 = Math.max(0, Math.floor(this.camX));
    var r0 = Math.max(0, Math.floor(this.camY));
    var c1 = Math.min(model.cols - 1, Math.ceil(this.camX + w / cs));
    var r1 = Math.min(model.rows - 1, Math.ceil(this.camY + h / cs));

    var self = this;
    function sx(c) { return (c - self.camX) * cs; }
    function sy(r) { return (r - self.camY) * cs; }

    /* Floor */
    ctx.fillStyle = pal.floor;
    ctx.fillRect(sx(c0), sy(r0), (c1 - c0 + 1) * cs, (r1 - r0 + 1) * cs);

    /* Heatmap */
    if (this.view.heat && this.visits) {
      for (var r = r0; r <= r1; r++) {
        var rowBase = r * model.cols;
        for (var c = c0; c <= c1; c++) {
          var n = this.visits[rowBase + c];
          if (n > 0) {
            ctx.fillStyle = rgba(pal.heat, Math.min(0.55, 0.13 + n * 0.1));
            ctx.fillRect(sx(c), sy(r), cs, cs);
          }
        }
      }
    }

    /* Walls */
    ctx.fillStyle = pal.wall;
    for (var wr = r0; wr <= r1; wr++) {
      var wbase = wr * model.cols;
      var runStart = -1;
      for (var wc = c0; wc <= c1 + 1; wc++) {
        var isWall = wc <= c1 && model.cells[wbase + wc] === WALL;
        if (isWall && runStart === -1) runStart = wc;
        if (!isWall && runStart !== -1) {
          ctx.fillRect(sx(runStart), sy(wr), (wc - runStart) * cs, cs);
          runStart = -1;
        }
      }
    }

    /* Grid lines */
    if (cs >= 12) {
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var gc = c0; gc <= c1 + 1; gc++) {
        var gx = Math.round(sx(gc)) + 0.5;
        ctx.moveTo(gx, sy(r0));
        ctx.lineTo(gx, sy(r1 + 1));
      }
      for (var gr = r0; gr <= r1 + 1; gr++) {
        var gy = Math.round(sy(gr)) + 0.5;
        ctx.moveTo(sx(c0), gy);
        ctx.lineTo(sx(c1 + 1), gy);
      }
      ctx.stroke();
    }

    /* Visit counts */
    if (this.view.counts && this.visits && cs >= 18) {
      ctx.fillStyle = pal.text;
      ctx.font = '600 ' + Math.round(cs * 0.34) + 'px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      for (var tr = r0; tr <= r1; tr++) {
        var tbase = tr * model.cols;
        for (var tc = c0; tc <= c1; tc++) {
          var tn = this.visits[tbase + tc];
          if (tn > 0) ctx.fillText(String(tn), sx(tc + 1) - cs * 0.12, sy(tr + 1) - cs * 0.1);
        }
      }
    }

    /* Start marker */
    var startX = sx(model.start.c);
    var startY = sy(model.start.r);
    if (startX > -cs && startY > -cs && startX < w && startY < h) {
      ctx.strokeStyle = pal.start;
      ctx.lineWidth = Math.max(1.5, cs * 0.08);
      ctx.setLineDash([cs * 0.18, cs * 0.14]);
      ctx.strokeRect(startX + cs * 0.2, startY + cs * 0.2, cs * 0.6, cs * 0.6);
      ctx.setLineDash([]);
    }

    /* Cleaning trail */
    if (this.view.trail && this.trailLen) {
      ctx.strokeStyle = rgba(pal.trail, 0.55);
      ctx.lineWidth = Math.max(1.5, cs * 0.16);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      var startIdx = (this.trailHead - this.trailLen + this.trailCap) % this.trailCap;
      for (var t = 0; t < this.trailLen; t++) {
        var ti = ((startIdx + t) % this.trailCap) * 4;
        var fr = this.trailData[ti], fc = this.trailData[ti + 1];
        var tr2 = this.trailData[ti + 2], tc2 = this.trailData[ti + 3];
        if (Math.max(fr, tr2) < r0 - 1 || Math.min(fr, tr2) > r1 + 1 ||
            Math.max(fc, tc2) < c0 - 1 || Math.min(fc, tc2) > c1 + 1) continue;
        ctx.moveTo(sx(fc + 0.5), sy(fr + 0.5));
        ctx.lineTo(sx(tc2 + 0.5), sy(tr2 + 0.5));
      }
      ctx.stroke();
    }

    /* A* return path */
    if (this.view.returnPath && this.returnSegs.length) {
      ctx.strokeStyle = rgba(pal.ret, 0.95);
      ctx.lineWidth = Math.max(1.2, cs * 0.11);
      ctx.setLineDash([cs * 0.26, cs * 0.22]);
      ctx.beginPath();
      for (var s = 0; s < this.returnSegs.length; s += 4) {
        var sfr = this.returnSegs[s], sfc = this.returnSegs[s + 1];
        var str = this.returnSegs[s + 2], stc = this.returnSegs[s + 3];
        if (Math.max(sfr, str) < r0 - 1 || Math.min(sfr, str) > r1 + 1 ||
            Math.max(sfc, stc) < c0 - 1 || Math.min(sfc, stc) > c1 + 1) continue;
        ctx.moveTo(sx(sfc + 0.5), sy(sfr + 0.5));
        ctx.lineTo(sx(stc + 0.5), sy(str + 0.5));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* Wall-hit flash */
    if (this.hit) {
      var age = now - this.hit.t0;
      if (age < HIT_FLASH_MS) {
        ctx.fillStyle = rgba([239, 68, 68], 0.8 * (1 - age / HIT_FLASH_MS));
        ctx.fillRect(sx(this.hit.c), sy(this.hit.r), cs, cs);
      } else {
        this.hit = null;
      }
    }

    /* Robot */
    var rr = this.robot.r;
    var rc = this.robot.c;
    if (this.anim) {
      var k = Math.min(1, (now - this.anim.t0) / this.anim.dur);
      rr = this.anim.fromR + (this.anim.toR - this.anim.fromR) * k;
      rc = this.anim.fromC + (this.anim.toC - this.anim.fromC) * k;
      if (k >= 1) this.anim = null;
    }
    var bx = sx(rc + 0.5);
    var by = sy(rr + 0.5);
    var radius = Math.max(2.5, cs * 0.33);
    ctx.fillStyle = rgba(this.returning ? pal.ret : pal.robot, 1);
    ctx.strokeStyle = pal.elev;
    ctx.lineWidth = Math.max(1, cs * 0.06);
    ctx.beginPath();
    ctx.arc(bx, by, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (cs >= 12) {
      ctx.fillStyle = pal.elev;
      ctx.beginPath();
      ctx.arc(bx, by - radius * 0.3, Math.max(1, radius * 0.3), 0, Math.PI * 2);
      ctx.fill();
    }
  };

  /* ---- Input ---------------------------------------------- */

  CanvasBoard.prototype.cellAt = function (event) {
    var rect = this.canvas.getBoundingClientRect();
    return {
      r: Math.floor(this.camY + (event.clientY - rect.top) / this.cellSize),
      c: Math.floor(this.camX + (event.clientX - rect.left) / this.cellSize)
    };
  };

  CanvasBoard.prototype._bindInput = function () {
    var self = this;
    var canvas = this.canvas;

    canvas.addEventListener('pointerdown', function (event) {
      if (!self.model) return;
      canvas.focus();
      event.preventDefault();

      /* Middle button or Pan mode grabs the map. */
      if (event.button === 1 || self.mode === 'pan') {
        self.panning = {
          x: event.clientX, y: event.clientY,
          camX: self.camX, camY: self.camY
        };
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = 'grabbing';
        return;
      }
      if (event.button !== 0) return;

      var pos = self.cellAt(event);
      if (!self.model.inBounds(pos.r, pos.c)) return;

      if (self.mode === 'start') {
        self.model.setStart(pos.r, pos.c);
        self.onEdit();
        return;
      }

      var current = self.model.cells[self.model.index(pos.r, pos.c)];
      self.paintValue = self.mode === 'erase' ? EMPTY : (current === WALL ? EMPTY : WALL);
      self.painting = true;
      canvas.setPointerCapture(event.pointerId);
      self._paint(pos);
    });

    canvas.addEventListener('pointermove', function (event) {
      if (self.panning) {
        self.camX = self.panning.camX - (event.clientX - self.panning.x) / self.cellSize;
        self.camY = self.panning.camY - (event.clientY - self.panning.y) / self.cellSize;
        self.clampCamera();
        self.dirty = true;
        self.onCameraMove();
        return;
      }
      if (self.painting) self._paint(self.cellAt(event));
    });

    function release(event) {
      if (self.panning) {
        self.panning = null;
        canvas.style.cursor = self.mode === 'pan' ? 'grab' : 'crosshair';
      }
      self.painting = false;
      if (canvas.hasPointerCapture && event.pointerId != null &&
          canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener('wheel', function (event) {
      event.preventDefault();
      if (event.ctrlKey) {
        var rect = canvas.getBoundingClientRect();
        self.setCellSize(self.cellSize + (event.deltaY < 0 ? 2 : -2),
          { x: event.clientX - rect.left, y: event.clientY - rect.top });
        return;
      }
      var stepX = event.shiftKey ? event.deltaY : event.deltaX;
      var stepY = event.shiftKey ? 0 : event.deltaY;
      self.panBy(stepX / self.cellSize, stepY / self.cellSize);
    }, { passive: false });

    canvas.addEventListener('keydown', function (event) {
      var step = event.shiftKey ? 10 : 1;
      var handled = true;
      switch (event.key) {
        case 'ArrowLeft': self.panBy(-step, 0); break;
        case 'ArrowRight': self.panBy(step, 0); break;
        case 'ArrowUp': self.panBy(0, -step); break;
        case 'ArrowDown': self.panBy(0, step); break;
        case '+': case '=': self.setCellSize(self.cellSize + 2); break;
        case '-': case '_': self.setCellSize(self.cellSize - 2); break;
        default: handled = false;
      }
      if (handled) event.preventDefault();
    });

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  };

  CanvasBoard.prototype._paint = function (pos) {
    if (!this.model.inBounds(pos.r, pos.c)) return;
    if (this.model.setCell(pos.r, pos.c, this.paintValue)) {
      this.dirty = true;
      this.onEdit();
    }
  };

  RC.CanvasBoard = CanvasBoard;
  RC.MIN_CELL = MIN_CELL;
  RC.MAX_CELL = MAX_CELL;
})(window.RC);
