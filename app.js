/* ============================================================
   app.js — controls, worker orchestration and path playback
   ============================================================ */
(function (RC) {
  'use strict';

  var STORAGE_KEY = 'robot-cleaner-sim/v3';
  var DELTAS = RC.DELTAS;

  var KIND_MOVE = 0;
  var KIND_BLOCKED = 1;
  var KIND_RETURN = 2;

  var SPEEDS = [
    { ms: 600, steps: 1, label: 'Very slow' },
    { ms: 320, steps: 1, label: 'Slow' },
    { ms: 180, steps: 1, label: 'Normal' },
    { ms: 90, steps: 1, label: 'Fast' },
    { ms: 30, steps: 1, label: 'Very fast' },
    { ms: 16, steps: 1, label: 'Turbo 1×' },
    { ms: 16, steps: 10, label: 'Turbo 10×' },
    { ms: 16, steps: 100, label: 'Turbo 100×' },
    { ms: 16, steps: 1000, label: 'Turbo 1000×' }
  ];

  var MODES = ['wall', 'erase', 'start', 'pan'];

  var el = {};
  var board = null;
  var model = null;
  var worker = null;
  var engineReady = false;
  var running = false;
  var runTimer = null;
  var elapsedTimer = null;
  var runStartedAt = 0;
  var floorCount = 0;

  var collapsed = { sim: false, side: false, code: false, console: false };
  var splitX = 0.66;
  var splitY = 0.63;

  /* Playback state */
  var log = null;          // { kinds, dirs, vals, prints, len }
  var cursor = 0;
  var printIdx = 0;
  var playing = false;
  var playTimer = null;
  var visits = null;
  var robotR = 0;
  var robotC = 0;
  var stats = { cleaned: 0, moves: 0, hits: 0, returns: 0 };
  var lastResult = null;
  var summaryShown = false;

  /* ---- Element lookup ------------------------------------- */

  function grab() {
    [
      'engineStatus', 'themeToggle', 'settingsBtn', 'settingsDialog',
      'workspace', 'side', 'simPanel', 'codePanel', 'consolePanel',
      'simCollapse', 'codeCollapse', 'consoleCollapse', 'simStrip', 'sideStrip',
      'splitX', 'splitY',
      'sampleSelect', 'code', 'runBtn',
      'stage', 'canvas', 'hud', 'busy', 'busyText', 'cancelBtn',
      'zoomIn', 'zoomOut', 'zoomOut2', 'followToggle',
      'playBtn', 'stepBtn', 'finishBtn', 'resetBtn',
      'speed', 'speedOut', 'progressFill', 'progressLabel',
      'rows', 'cols', 'clearMapBtn', 'borderBtn', 'randomBtn',
      'wallLimit', 'maxCalls', 'autoCalls', 'timeout',
      'cellSize', 'cellSizeOut', 'trailCap',
      'showTrail', 'showReturn', 'showHeat', 'showCounts',
      'statCleaned', 'statCoverage', 'statMoves', 'statHits', 'statReturn',
      'console', 'clearConsoleBtn', 'helpBtn'
    ].forEach(function (id) { el[id] = document.getElementById(id); });
  }

  /* ---- Persistence --------------------------------------- */

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        code: el.code.value,
        grid: model.toJSON(),
        wallLimit: Number(el.wallLimit.value),
        maxCalls: Number(el.maxCalls.value),
        autoCalls: el.autoCalls.checked,
        timeout: Number(el.timeout.value),
        cellSize: board ? board.cellSize : 28,
        trailCap: Number(el.trailCap.value),
        speed: Number(el.speed.value),
        follow: el.followToggle.checked,
        theme: document.documentElement.dataset.theme,
        collapsed: collapsed,
        splitX: splitX,
        splitY: splitY,
        view: {
          trail: el.showTrail.checked,
          returnPath: el.showReturn.checked,
          heat: el.showHeat.checked,
          counts: el.showCounts.checked
        }
      }));
    } catch (e) { /* storage full or disabled — not fatal */ }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  /* ---- Theme --------------------------------------------- */

  function initTheme(saved) {
    var prefersDark = window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = saved || (prefersDark ? 'dark' : 'light');

    el.themeToggle.addEventListener('click', function () {
      document.documentElement.dataset.theme =
        document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      if (board) board.refreshPalette();
      saveState();
    });
  }

  /* ---- Layout / splitters -------------------------------- */

  function isNarrow() {
    return window.matchMedia('(max-width: 980px)').matches;
  }

  function applyLayout() {
    el.simPanel.classList.toggle('is-collapsed-x', collapsed.sim);
    el.side.classList.toggle('is-collapsed-x', collapsed.side);
    el.codePanel.classList.toggle('is-collapsed', collapsed.code);
    el.consolePanel.classList.toggle('is-collapsed', collapsed.console);

    el.simCollapse.setAttribute('aria-expanded', String(!collapsed.sim));
    el.codeCollapse.setAttribute('aria-expanded', String(!collapsed.code));
    el.consoleCollapse.setAttribute('aria-expanded', String(!collapsed.console));

    if (isNarrow()) {
      el.workspace.style.gridTemplateColumns = '';
      el.side.style.gridTemplateRows = '';
    } else {
      el.workspace.style.gridTemplateColumns = collapsed.sim
        ? '46px 8px 1fr'
        : collapsed.side
          ? '1fr 8px 46px'
          : splitX.toFixed(4) + 'fr 8px ' + (1 - splitX).toFixed(4) + 'fr';

      el.side.style.gridTemplateRows = collapsed.side
        ? '1fr'
        : collapsed.code && collapsed.console
          ? 'auto 8px auto'
          : collapsed.code
            ? 'auto 8px 1fr'
            : collapsed.console
              ? '1fr 8px auto'
              : splitY.toFixed(4) + 'fr 8px ' + (1 - splitY).toFixed(4) + 'fr';
    }
  }

  function bindSplitter(handle, axis) {
    handle.addEventListener('pointerdown', function (event) {
      if (isNarrow()) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      document.body.classList.add(axis === 'x' ? 'is-splitting' : 'is-splitting-y');

      var container = axis === 'x' ? el.workspace : el.side;

      function onMove(moveEvent) {
        var rect = container.getBoundingClientRect();
        var fraction = axis === 'x'
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height;
        fraction = Math.max(0, Math.min(1, fraction));

        if (axis === 'x') {
          /* Dragging all the way to either edge collapses that side. */
          collapsed.sim = fraction < 0.07;
          collapsed.side = fraction > 0.93;
          if (!collapsed.sim && !collapsed.side) splitX = fraction;
        } else {
          collapsed.code = fraction < 0.08;
          collapsed.console = fraction > 0.92;
          if (!collapsed.code && !collapsed.console) splitY = fraction;
        }
        applyLayout();
      }

      function onUp(upEvent) {
        handle.releasePointerCapture(upEvent.pointerId);
        handle.classList.remove('is-dragging');
        document.body.classList.remove('is-splitting', 'is-splitting-y');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        saveState();
      }

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });

    handle.addEventListener('dblclick', function () {
      if (axis === 'x') { splitX = 0.66; collapsed.sim = collapsed.side = false; }
      else { splitY = 0.63; collapsed.code = collapsed.console = false; }
      applyLayout();
      saveState();
    });

    handle.addEventListener('keydown', function (event) {
      var delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.02
        : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 0.02 : 0;
      if (!delta) return;
      event.preventDefault();
      if (axis === 'x') splitX = Math.max(0.1, Math.min(0.9, splitX + delta));
      else splitY = Math.max(0.1, Math.min(0.9, splitY + delta));
      applyLayout();
      saveState();
    });
  }

  /* ---- Console ------------------------------------------- */

  function logLine(text, variant) {
    var line = document.createElement('div');
    line.className = 'console__line' + (variant ? ' console__line--' + variant : '');
    line.textContent = text;
    el.console.appendChild(line);
    el.console.scrollTop = el.console.scrollHeight;
  }

  function clearConsole() {
    el.console.replaceChildren();
  }

  function printHelp() {
    RC.HELP.forEach(function (row) { logLine(row.text, row.variant); });
  }

  /* ---- Stats -------------------------------------------- */

  function refreshStats() {
    el.statCleaned.textContent = stats.cleaned.toLocaleString();
    el.statMoves.textContent = stats.moves.toLocaleString();
    el.statHits.textContent = stats.hits.toLocaleString();
    el.statReturn.textContent = stats.returns.toLocaleString();
    /* Never round up to 100% while tiles are still missing. */
    var pct = floorCount ? (stats.cleaned / floorCount) * 100 : 0;
    el.statCoverage.textContent =
      (stats.cleaned >= floorCount ? 100 : Math.min(99, Math.floor(pct))) + '%';
  }

  function refreshProgress() {
    var total = log ? log.len : 0;
    el.progressLabel.textContent = 'Step ' + cursor.toLocaleString() +
      ' / ' + total.toLocaleString();
    el.progressFill.style.width = total ? ((cursor / total) * 100).toFixed(1) + '%' : '0%';
  }

  function refreshHud() {
    el.hud.textContent = model.rows + ' × ' + model.cols + ' · ' + board.cellSize + 'px';
  }

  /* ---- Playback ----------------------------------------- */

  function speed() { return SPEEDS[Number(el.speed.value)]; }

  function resetPlayback(showGuide) {
    stopPlaying();
    cursor = 0;
    printIdx = 0;
    summaryShown = false;
    visits = new Int32Array(model.rows * model.cols);
    robotR = model.start.r;
    robotC = model.start.c;
    visits[model.index(robotR, robotC)] = 1;
    stats = { cleaned: 1, moves: 0, hits: 0, returns: 0 };

    board.clearTrails();
    board.setVisits(visits);
    board.placeRobot(robotR, robotC, 0);
    board.setReturning(false);
    if (board.follow) board.followRobot(true);

    clearConsole();
    /* With nothing recorded to replay, the output panel doubles as the guide. */
    if (showGuide !== false && (!log || !log.len)) printHelp();

    el.progressFill.classList.remove('is-returning');
    refreshStats();
    refreshProgress();
    updateControls();
  }

  function flushPrints(upTo) {
    var prints = log.prints;
    while (printIdx < prints.length && prints[printIdx].at <= upTo) {
      var p = prints[printIdx++];
      if (p.text !== '') logLine(p.text, p.stderr ? 'error' : null);
    }
  }

  /** Apply the step at `cursor`. Returns false when the log is exhausted. */
  function applyStep(animate, animMs) {
    if (!log || cursor >= log.len) return false;
    flushPrints(cursor);

    var kind = log.kinds[cursor];
    var dir = log.dirs[cursor];
    var val = log.vals[cursor];
    var delta = DELTAS[dir];
    var tr = robotR + delta[0];
    var tc = robotC + delta[1];

    if (kind === KIND_MOVE) {
      var idx = tr * model.cols + tc;
      if (visits[idx] === 0) stats.cleaned++;
      visits[idx] = val;
      stats.moves++;
      board.addTrail(robotR, robotC, tr, tc);
      robotR = tr; robotC = tc;
      board.placeRobot(tr, tc, animate ? animMs : 0);
    } else if (kind === KIND_RETURN) {
      stats.returns++;
      board.setReturning(true);
      board.addReturn(robotR, robotC, tr, tc);
      robotR = tr; robotC = tc;
      board.placeRobot(tr, tc, animate ? animMs : 0);
      el.progressFill.classList.add('is-returning');
    } else {
      stats.hits++;
      if (animate) board.flashHit(tr, tc);
    }

    cursor++;
    flushPrints(cursor - 1);
    return true;
  }

  function advance(count, animate, animMs) {
    var moved = false;
    for (var i = 0; i < count; i++) {
      if (!applyStep(animate && i === count - 1, animMs)) break;
      moved = true;
    }
    if (moved) {
      refreshStats();
      refreshProgress();
    }
    return moved;
  }

  function tick() {
    if (!playing) return;
    var s = speed();
    var animate = s.steps === 1 && s.ms >= 30;
    if (!advance(s.steps, animate, s.ms) || cursor >= log.len) {
      finishPlayback();
      return;
    }
    playTimer = window.setTimeout(tick, s.ms);
  }

  function startPlaying() {
    if (!log || !log.len) return;
    if (cursor >= log.len) resetPlayback();
    playing = true;
    updateControls();
    tick();
  }

  function stopPlaying() {
    playing = false;
    if (playTimer) {
      window.clearTimeout(playTimer);
      playTimer = null;
    }
  }

  function finishPlayback() {
    stopPlaying();
    refreshStats();
    refreshProgress();
    showSummary();
    updateControls();
  }

  function finishInstantly() {
    stopPlaying();
    while (advance(20000, false, 0)) { /* keep applying */ }
    refreshStats();
    refreshProgress();
    showSummary();
    updateControls();
  }

  function showSummary() {
    if (summaryShown || !lastResult) return;
    summaryShown = true;
    if (log) flushPrints(log.len);

    if (lastResult.outcome === 'error') {
      logLine(lastResult.detail, 'error');
      if (/RecursionError/.test(lastResult.detail)) {
        logLine('Recursion went deeper than this map allows. Load the ' +
          '"DFS — iterative" sample, which does the same walk with an ' +
          'explicit stack, or check for a call that never returns.', 'stop');
      }
    } else if (lastResult.stopKind === 'complete') {
      logLine('✅ ' + lastResult.detail, 'ok');
      if (lastResult.returnPathFound === false) {
        logLine('No way back to the start tile — the robot stayed put.', 'stop');
      } else if (stats.returns > 0) {
        logLine('Returned home via A* in ' + stats.returns + ' moves.', 'ok');
      } else {
        logLine('Already home — no return trip needed.', 'ok');
      }
    } else if (lastResult.outcome === 'stopped') {
      logLine('⛔ ' + lastResult.detail, 'stop');
    } else {
      logLine('Program finished with ' + (floorCount - stats.cleaned) +
        ' tiles left uncleaned.', 'stop');
    }

    logLine('— ' + stats.moves.toLocaleString() + ' moves · ' +
      stats.hits.toLocaleString() + ' wall hits · ' +
      stats.cleaned.toLocaleString() + ' tiles cleaned · ' +
      (lastResult.elapsedMs / 1000).toFixed(2) + 's of Python', 'info');
  }

  function updateControls() {
    var hasLog = !!(log && log.len);
    var atEnd = !hasLog || cursor >= log.len;
    el.playBtn.disabled = running || !hasLog || (atEnd && !playing);
    el.stepBtn.disabled = running || atEnd;
    el.finishBtn.disabled = running || atEnd;
    el.resetBtn.disabled = running || !hasLog;
    el.runBtn.disabled = running || !engineReady;
    el.playBtn.innerHTML = playing
      ? '<span aria-hidden="true">⏸</span> Pause'
      : '<span aria-hidden="true">▶</span> Play';
  }

  /* ---- Worker ------------------------------------------- */

  function setEngineStatus(state, text) {
    el.engineStatus.dataset.state = state;
    el.engineStatus.textContent = text;
  }

  function createWorker() {
    worker = new Worker('worker.js');
    worker.onmessage = onWorkerMessage;
    worker.onerror = function (event) {
      setEngineStatus('error', 'Engine error');
      showBusy(false);
      running = false;
      logLine('Worker error: ' + (event.message || 'unknown'), 'error');
      updateControls();
    };
    worker.postMessage({ type: 'init' });
  }

  function onWorkerMessage(event) {
    var data = event.data || {};

    if (data.type === 'status') {
      setEngineStatus('loading', data.text);
      return;
    }
    if (data.type === 'ready') {
      engineReady = true;
      setEngineStatus('ready', 'Python ' + data.version + ' ready');
      updateControls();
      return;
    }
    if (data.type === 'fatal') {
      engineReady = false;
      setEngineStatus('error', 'Engine failed to load');
      showBusy(false);
      running = false;
      logLine(data.message, 'error');
      logLine('Check your connection and reload — Pyodide is fetched from a CDN.', 'info');
      updateControls();
      return;
    }
    if (data.type !== 'result') return;

    clearRunTimeout();
    running = false;
    showBusy(false);

    log = data.log;
    lastResult = {
      outcome: data.outcome,
      stopKind: data.stopKind,
      detail: data.detail,
      returnPathFound: data.returnPathFound,
      elapsedMs: data.elapsedMs
    };

    resetPlayback(false);
    logLine('▶ ' + log.len.toLocaleString() + ' steps recorded (' +
      data.stats.calls.toLocaleString() + ' move() calls, ' +
      (data.elapsedMs / 1000).toFixed(2) + 's)', 'info');
    updateControls();
    /* A program that never moved still has output and a verdict to show. */
    if (log.len) startPlaying(); else finishPlayback();
  }

  function showBusy(visible, text) {
    el.busy.hidden = !visible;
    if (text) el.busyText.textContent = text;
    if (elapsedTimer) { window.clearInterval(elapsedTimer); elapsedTimer = null; }
    if (visible) {
      runStartedAt = Date.now();
      elapsedTimer = window.setInterval(function () {
        el.busyText.textContent = 'Running your code… ' +
          ((Date.now() - runStartedAt) / 1000).toFixed(1) + 's';
      }, 100);
    }
  }

  function clearRunTimeout() {
    if (runTimer) {
      window.clearTimeout(runTimer);
      runTimer = null;
    }
  }

  function cancelRun(reason) {
    clearRunTimeout();
    if (worker) worker.terminate();
    engineReady = false;
    running = false;
    showBusy(false);
    setEngineStatus('loading', 'Restarting engine…');
    if (reason) logLine(reason, 'stop');
    updateControls();
    createWorker();
  }

  function run() {
    if (running || !engineReady) return;
    stopPlaying();
    log = null;
    lastResult = null;
    cursor = 0;
    resetPlayback();
    clearConsole();

    running = true;
    showBusy(true, 'Running your code…');
    updateControls();

    var timeoutMs = Math.max(5, Number(el.timeout.value) || 20) * 1000;

    worker.postMessage({
      type: 'run',
      code: el.code.value,
      grid: model.snapshot(),
      options: {
        wallLimit: Math.max(1, Number(el.wallLimit.value) || 5),
        maxCalls: Math.max(10, Number(el.maxCalls.value) || 5000)
      }
    });

    runTimer = window.setTimeout(function () {
      cancelRun('⛔ Stopped after ' + (timeoutMs / 1000) +
        's without finishing — check for an infinite loop, or raise the timeout.');
    }, timeoutMs);
  }

  /* ---- Map ---------------------------------------------- */

  function recomputeFloor() {
    floorCount = model.emptyCount();
    if (el.autoCalls.checked) {
      /* Beyond the log ceiling the extra budget could never be recorded. */
      el.maxCalls.value = String(Math.min(2000000, Math.max(5000, floorCount * 10)));
    }
  }

  /** Called whenever the map changes: any recorded run becomes stale. */
  function onMapEdit() {
    log = null;
    lastResult = null;
    recomputeFloor();
    resetPlayback();
    refreshHud();
    saveState();
  }

  function applySize() {
    if (model.resize(Number(el.rows.value), Number(el.cols.value))) {
      el.rows.value = String(model.rows);
      el.cols.value = String(model.cols);
      board.setModel(model);
      onMapEdit();
    }
  }

  /* ---- View --------------------------------------------- */

  function applyView() {
    board.setView({
      trail: el.showTrail.checked,
      returnPath: el.showReturn.checked,
      heat: el.showHeat.checked,
      counts: el.showCounts.checked
    });
  }

  function setMode(mode) {
    var input = document.querySelector('input[name="tool"][value="' + mode + '"]');
    if (input) input.checked = true;
    board.setMode(mode);
  }

  function cycleMode(step) {
    var current = document.querySelector('input[name="tool"]:checked');
    var i = MODES.indexOf(current ? current.value : 'wall');
    setMode(MODES[(i + step + MODES.length) % MODES.length]);
  }

  function syncZoom() {
    el.zoomOut2.textContent = board.cellSize + 'px';
    el.cellSize.value = String(board.cellSize);
    el.cellSizeOut.textContent = String(board.cellSize);
    refreshHud();
  }

  /* ---- Wiring ------------------------------------------- */

  function bind() {
    el.runBtn.addEventListener('click', run);
    el.cancelBtn.addEventListener('click', function () { cancelRun('⛔ Run stopped.'); });

    el.simCollapse.addEventListener('click', function () {
      collapsed.sim = true; applyLayout(); saveState();
    });
    /* Expanding from a strip must not restore the sliver the drag ended on. */
    el.simStrip.addEventListener('click', function () {
      collapsed.sim = false;
      if (splitX < 0.2) splitX = 0.66;
      applyLayout(); saveState();
    });
    el.sideStrip.addEventListener('click', function () {
      collapsed.side = false;
      if (splitX > 0.8) splitX = 0.66;
      applyLayout(); saveState();
    });
    el.codeCollapse.addEventListener('click', function () {
      collapsed.code = !collapsed.code; applyLayout(); saveState();
    });
    el.consoleCollapse.addEventListener('click', function () {
      collapsed.console = !collapsed.console; applyLayout(); saveState();
    });

    bindSplitter(el.splitX, 'x');
    bindSplitter(el.splitY, 'y');

    el.settingsBtn.addEventListener('click', function () { el.settingsDialog.showModal(); });
    el.settingsDialog.addEventListener('close', saveState);

    el.playBtn.addEventListener('click', function () {
      if (playing) { stopPlaying(); updateControls(); } else { startPlaying(); }
    });
    el.stepBtn.addEventListener('click', function () {
      stopPlaying();
      if (!advance(1, true, 180) || cursor >= log.len) showSummary();
      updateControls();
    });
    el.finishBtn.addEventListener('click', finishInstantly);
    el.resetBtn.addEventListener('click', resetPlayback);

    el.speed.addEventListener('input', function () {
      el.speedOut.textContent = speed().label;
      saveState();
    });

    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="tool"]'),
      function (input) {
        input.addEventListener('change', function () {
          if (input.checked) board.setMode(input.value);
        });
      }
    );

    el.zoomIn.addEventListener('click', function () {
      board.setCellSize(board.cellSize + 2); syncZoom(); saveState();
    });
    el.zoomOut.addEventListener('click', function () {
      board.setCellSize(board.cellSize - 2); syncZoom(); saveState();
    });
    el.cellSize.addEventListener('input', function () {
      board.setCellSize(Number(el.cellSize.value)); syncZoom(); saveState();
    });

    el.followToggle.addEventListener('change', function () {
      board.setFollow(el.followToggle.checked);
      saveState();
    });

    el.rows.addEventListener('change', applySize);
    el.cols.addEventListener('change', applySize);

    Array.prototype.forEach.call(document.querySelectorAll('.preset'), function (btn) {
      btn.addEventListener('click', function () {
        el.rows.value = btn.dataset.size;
        el.cols.value = btn.dataset.size;
        applySize();
      });
    });

    el.clearMapBtn.addEventListener('click', function () { model.clearWalls(); onMapEdit(); });
    el.borderBtn.addEventListener('click', function () { model.addBorder(); onMapEdit(); });
    el.randomBtn.addEventListener('click', function () { model.randomRoom(); onMapEdit(); });

    el.wallLimit.addEventListener('change', saveState);
    el.maxCalls.addEventListener('change', saveState);
    el.timeout.addEventListener('change', saveState);
    el.autoCalls.addEventListener('change', function () {
      el.maxCalls.disabled = el.autoCalls.checked;
      recomputeFloor();
      saveState();
    });
    el.trailCap.addEventListener('change', function () {
      board.setTrailCapacity(Number(el.trailCap.value));
      el.trailCap.value = String(board.trailCap);
      saveState();
    });

    [el.showTrail, el.showReturn, el.showHeat, el.showCounts].forEach(function (input) {
      input.addEventListener('change', function () { applyView(); saveState(); });
    });

    el.clearConsoleBtn.addEventListener('click', clearConsole);
    el.helpBtn.addEventListener('click', function () { clearConsole(); printHelp(); });

    el.sampleSelect.addEventListener('change', function () {
      var key = el.sampleSelect.value;
      if (!key || !RC.SAMPLES[key]) return;
      el.code.value = RC.SAMPLES[key];
      el.sampleSelect.value = '';
      saveState();
    });

    el.code.addEventListener('input', saveState);

    /* Tab inserts spaces instead of moving focus; Ctrl/Cmd+Enter runs. */
    el.code.addEventListener('keydown', function (event) {
      if (event.key === 'Tab') {
        event.preventDefault();
        el.code.setRangeText('    ', el.code.selectionStart, el.code.selectionEnd, 'end');
        saveState();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        run();
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'F3') { event.preventDefault(); cycleMode(-1); }
      else if (event.key === 'F4') { event.preventDefault(); cycleMode(1); }
    });

    window.addEventListener('resize', function () {
      applyLayout();
      if (board) { board.clampCamera(); board.markDirty(); }
    });
    window.addEventListener('beforeunload', saveState);
  }

  /* ---- Boot --------------------------------------------- */

  function init() {
    grab();
    var saved = loadState();

    model = saved && saved.grid ? RC.GridModel.fromJSON(saved.grid) : new RC.GridModel(16, 16);
    el.rows.value = String(model.rows);
    el.cols.value = String(model.cols);
    el.code.value = saved && typeof saved.code === 'string' ? saved.code : RC.DEFAULT_CODE;
    if (saved) {
      if (saved.wallLimit) el.wallLimit.value = String(saved.wallLimit);
      if (saved.maxCalls) el.maxCalls.value = String(saved.maxCalls);
      if (saved.timeout) el.timeout.value = String(saved.timeout);
      if (saved.trailCap) el.trailCap.value = String(saved.trailCap);
      if (saved.speed != null) el.speed.value = String(saved.speed);
      if (saved.autoCalls != null) el.autoCalls.checked = !!saved.autoCalls;
      if (saved.follow != null) el.followToggle.checked = !!saved.follow;
      if (saved.splitX) splitX = saved.splitX;
      if (saved.splitY) splitY = saved.splitY;
      if (saved.collapsed) {
        collapsed.sim = !!saved.collapsed.sim;
        collapsed.side = !!saved.collapsed.side;
        collapsed.code = !!saved.collapsed.code;
        collapsed.console = !!saved.collapsed.console;
      }
      if (saved.view) {
        el.showTrail.checked = saved.view.trail !== false;
        el.showReturn.checked = saved.view.returnPath !== false;
        el.showHeat.checked = saved.view.heat !== false;
        el.showCounts.checked = saved.view.counts !== false;
      }
    }
    el.speedOut.textContent = speed().label;
    el.maxCalls.disabled = el.autoCalls.checked;

    initTheme(saved && saved.theme);
    applyLayout();

    board = new RC.CanvasBoard(
      { canvas: el.canvas, stage: el.stage },
      { onEdit: onMapEdit, onCameraMove: function () {
        if (board.panning) el.followToggle.checked = false;
        board.follow = el.followToggle.checked;
      } }
    );
    board.setModel(model);
    board.setCellSize(saved && saved.cellSize ? saved.cellSize : 28);
    board.setTrailCapacity(Number(el.trailCap.value));
    board.setFollow(el.followToggle.checked);
    applyView();
    setMode('wall');
    syncZoom();

    recomputeFloor();
    resetPlayback();
    bind();
    createWorker();

    /* Handy from the devtools console when poking at performance. */
    RC.debug = { board: board, model: model, state: function () {
      return { cursor: cursor, len: log ? log.len : 0, stats: stats };
    } };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.RC);
