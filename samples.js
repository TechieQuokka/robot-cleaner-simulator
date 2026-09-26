/* ============================================================
   samples.js — starter algorithms plus the console help text
   Kept deliberately short: the built-in API does the bookkeeping.
   ============================================================ */
(function (RC) {
  'use strict';

  var SAMPLES = {
    dfsSimple: [
      '# Depth-first search, no bookkeeping at all.',
      '# look(d) == 0 means "not a wall, never visited".',
      '',
      'def dfs():',
      '    for d in CARDINALS:',
      '        if look(d) == 0:',
      '            move(d)',
      '            dfs()',
      '            move(opposite(d))   # back out the way we came',
      '',
      'dfs()',
      'go_home()                   # back to the dock: this ends the run',
      ''
    ].join('\n'),

    dfsVisited: [
      '# The same search written the classic way, with an explicit',
      '# visited set. Compare it with the minimal version.',
      '',
      'visited = {pos()}',
      '',
      'def dfs():',
      '    for d in CARDINALS:',
      '        if look(d) == -1:          # wall',
      '            continue',
      '        cell = ahead(d)',
      '        if cell in visited:',
      '            continue',
      '        visited.add(cell)',
      '        move(d)',
      '        dfs()',
      '        move(opposite(d))',
      '',
      'dfs()',
      'print("visited", len(visited), "tiles,", remaining(), "left")',
      'go_home()',
      ''
    ].join('\n'),

    dfsIterative: [
      '# The same walk with no recursion at all: the list holds the',
      '# directions taken to get where we are. Recursion works fine here',
      '# even on a 1000x1000 map, so this is a style choice — not a',
      '# workaround.',
      '',
      'stack = []',
      '',
      'while True:',
      '    for d in CARDINALS:',
      '        if look(d) == 0:',
      '            move(d)',
      '            stack.append(d)',
      '            break',
      '    else:                          # dead end: step back',
      '        if not stack:',
      '            break',
      '        move(opposite(stack.pop()))',
      '',
      'go_home()',
      ''
    ].join('\n'),

    wallFollower: [
      '# Right-hand rule: keep a wall on your right and walk.',
      '# Only reaches tiles connected to the wall it started on.',
      '',
      'heading = RIGHT',
      '',
      'while True:',
      '    for d in (turn_right(heading), heading, turn_left(heading), opposite(heading)):',
      '        if move(d) != -1:',
      '            heading = d',
      '            break',
      '    else:',
      '        print("boxed in at", pos())',
      '        break',
      '',
      'go_home()',
      ''
    ].join('\n'),

    zigzag: [
      '# Sweep a row, then drop to the next one diagonally.',
      '# Uses the diagonal constants, so it needs fewer moves than a',
      '# strict up/down/left/right sweep.',
      '',
      'heading = RIGHT',
      '',
      'while True:',
      '    while move(heading) != -1:',
      '        pass                      # push on until a wall stops us',
      '',
      '    down = DOWN_RIGHT if heading == RIGHT else DOWN_LEFT',
      '    if move(down) == -1 and move(DOWN) == -1:',
      '        print("nowhere left to drop,", remaining(), "tiles missed")',
      '        break',
      '',
      '    heading = opposite(heading)',
      '',
      'go_home()',
      ''
    ].join('\n'),

    randomWalk: [
      '# The dumbest possible strategy, for comparison. Direction',
      '# constants are 0-7, so randrange(8) picks one. Watch the heatmap:',
      '# most tiles get hit many times over before the last one is found.',
      '',
      'import random',
      '',
      'while remaining() > 0:',
      '    move(random.randrange(8))',
      '',
      'go_home()',
      ''
    ].join('\n')
  };

  /* Printed into the output panel on load and by the Help button. */
  var HELP = [
    { text: '🤖 Robot Cleaner Path Simulator', variant: 'head' },
    { text: '', variant: null },
    { text: 'MOVING', variant: 'info' },
    { text: '  move(d)        -1 if a wall blocks it, else the visit count of the new tile', variant: 'dim' },
    { text: '  go_home()      A* back to the start tile — and the run ENDS there', variant: 'dim' },
    { text: '', variant: null },
    { text: 'SENSING  (free — never counts against the move limit)', variant: 'info' },
    { text: '  look(d)        -1 wall · 0 never visited · n visit count', variant: 'dim' },
    { text: '  scan()         look() in all eight directions, as a dict', variant: 'dim' },
    { text: '  pos()          current (row, col)', variant: 'dim' },
    { text: '  ahead(d)       (row, col) of the neighbouring tile', variant: 'dim' },
    { text: '  visits(r, c)   visit count of any tile, -1 for a wall', variant: 'dim' },
    { text: '  size()         room size as (rows, cols)', variant: 'dim' },
    { text: '  remaining()    floor tiles not visited yet', variant: 'dim' },
    { text: '', variant: null },
    { text: 'DIRECTIONS  (clockwise, so (d + 1) % 4 is a right turn)', variant: 'info' },
    { text: '  LEFT=0  UP=1  RIGHT=2  DOWN=3', variant: 'dim' },
    { text: '  UP_LEFT=4  UP_RIGHT=5  DOWN_RIGHT=6  DOWN_LEFT=7', variant: 'dim' },
    { text: '  CARDINALS · DIAGONALS · DIRECTIONS are ready-made tuples', variant: 'dim' },
    { text: '  opposite(d)  turn_right(d)  turn_left(d)  delta(d)  name(d)', variant: 'dim' },
    { text: '', variant: null },
    { text: 'ENDING  (you decide — nothing stops the run on its own)', variant: 'info' },
    { text: '  ✅ go_home() returns the robot to the dock and ends the run', variant: 'dim' },
    { text: '     sweep as many laps as you like first: while remaining() > 0: ...', variant: 'dim' },
    { text: '  ⚠ ending without go_home() warns, then follows Settings → Stop rules', variant: 'dim' },
    { text: '  ⛔ same wall hit N times in a row, the move() limit, or the timeout', variant: 'dim' },
    { text: '', variant: null },
    { text: 'MAP CONTROLS', variant: 'info' },
    { text: '  F3 / F4        cycle Wall · Erase · Start · Pan', variant: 'dim' },
    { text: '  drag           paint with the active tool (Pan mode moves the map)', variant: 'dim' },
    { text: '  wheel / arrows scroll · Ctrl+wheel or +/- zoom · middle-drag pans', variant: 'dim' },
    { text: '  Follow         keeps the camera on the robot while it runs', variant: 'dim' },
    { text: '  Maps go up to 1024 × 1024 — set the size under Settings.', variant: 'dim' },
    { text: '', variant: null },
    { text: 'Press Run, or Ctrl+Enter in the editor.', variant: 'info' }
  ];

  RC.SAMPLES = SAMPLES;
  RC.DEFAULT_CODE = SAMPLES.dfsSimple;
  RC.HELP = HELP;
})(window.RC);
