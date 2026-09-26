/* ============================================================
   editor.js — Python syntax highlighting and a line-number gutter
   The textarea stays the input surface (undo, IME, selection all keep
   working); a coloured layer is painted underneath it in lockstep.
   ============================================================ */
(function (RC) {
  'use strict';

  var KEYWORDS = ('False None True and as assert async await break class continue def del ' +
    'elif else except finally for from global if import in is lambda nonlocal not or pass ' +
    'raise return try while with yield').split(' ');

  var BUILTINS = ('abs all any bool dict divmod enumerate filter float format frozenset ' +
    'getattr hasattr hash int isinstance issubclass iter len list map max min next object ' +
    'ord print range repr reversed round set setattr sorted str sum tuple type zip ' +
    'Exception ValueError TypeError KeyError IndexError RecursionError StopIteration ' +
    'self super').split(' ');

  /* The simulator's own vocabulary gets its own colour. */
  var API = ('move go_home look scan pos ahead visits size remaining delta name opposite ' +
    'turn_right turn_left SimulationStop LEFT UP RIGHT DOWN UP_LEFT UP_RIGHT DOWN_RIGHT ' +
    'DOWN_LEFT CARDINALS DIAGONALS DIRECTIONS').split(' ');

  function group(words) {
    return '\\b(?:' + words.join('|') + ')\\b';
  }

  /* One pass, ordered so that comments and strings win over everything else. */
  var TOKEN = new RegExp([
    '(#[^\\n]*)',                                             // 1 comment
    "([rbfu]{0,2}\"\"\"[\\s\\S]*?\"\"\"|[rbfu]{0,2}'''[\\s\\S]*?''')", // 2 triple string
    '([rbfu]{0,2}"(?:\\\\.|[^"\\\\\\n])*"|[rbfu]{0,2}\'(?:\\\\.|[^\'\\\\\\n])*\')', // 3 string
    '(\\b(?:def|class)\\s+)(\\w+)',                           // 4+5 definition name
    '(@\\w+)',                                                // 6 decorator
    '(\\b\\d+\\.?\\d*(?:[eE][+-]?\\d+)?\\b)',                 // 7 number
    '(' + group(KEYWORDS) + ')',                              // 8 keyword
    '(' + group(API) + ')',                                   // 9 simulator API
    '(' + group(BUILTINS) + ')'                               // 10 builtin
  ].join('|'), 'g');

  var CLASSES = {
    1: 'cm', 2: 'st', 3: 'st', 5: 'fn', 6: 'dc', 7: 'nu', 8: 'kw', 9: 'api', 10: 'bi'
  };

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlight(source) {
    var out = '';
    var last = 0;
    TOKEN.lastIndex = 0;
    var match;
    while ((match = TOKEN.exec(source)) !== null) {
      out += escapeHtml(source.slice(last, match.index));
      /* `def foo` matches as two captures: keep the keyword, colour the name. */
      if (match[4] !== undefined) {
        out += '<i class="kw">' + escapeHtml(match[4]) + '</i>' +
          '<i class="fn">' + escapeHtml(match[5]) + '</i>';
      } else {
        for (var i = 1; i <= 10; i++) {
          if (match[i] !== undefined && CLASSES[i]) {
            out += '<i class="' + CLASSES[i] + '">' + escapeHtml(match[i]) + '</i>';
            break;
          }
        }
      }
      last = match.index + match[0].length;
    }
    out += escapeHtml(source.slice(last));
    return out;
  }

  /**
   * @param {Object} refs { textarea, highlight, gutter }
   */
  function Editor(refs) {
    this.textarea = refs.textarea;
    this.layer = refs.highlight;
    this.gutter = refs.gutter;
    this.lines = 0;
    this.queued = false;

    var self = this;
    this.textarea.addEventListener('input', function () { self.schedule(); });
    this.textarea.addEventListener('scroll', function () { self.syncScroll(); });
    this.render();
  }

  /* Repainting on the next frame keeps typing smooth on long files. */
  Editor.prototype.schedule = function () {
    if (this.queued) return;
    this.queued = true;
    var self = this;
    requestAnimationFrame(function () {
      self.queued = false;
      self.render();
    });
  };

  Editor.prototype.render = function () {
    var source = this.textarea.value;
    /* A trailing newline would otherwise collapse and shift the last line. */
    this.layer.innerHTML = highlight(source) + '\n';

    var count = source.split('\n').length;
    if (count !== this.lines) {
      this.lines = count;
      var numbers = new Array(count);
      for (var i = 0; i < count; i++) numbers[i] = i + 1;
      this.gutter.textContent = numbers.join('\n');
    }
    this.syncScroll();
  };

  Editor.prototype.syncScroll = function () {
    var top = this.textarea.scrollTop;
    var left = this.textarea.scrollLeft;
    this.layer.style.transform = 'translate(' + -left + 'px, ' + -top + 'px)';
    this.gutter.style.transform = 'translateY(' + -top + 'px)';
  };

  RC.Editor = Editor;
  RC.highlightPython = highlight;
})(window.RC);
