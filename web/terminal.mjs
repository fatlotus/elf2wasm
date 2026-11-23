/**
 * Self-contained, zero-dependency interactive ANSI/VT100 terminal widget.
 *
 * Renders output strictly via DOM text (`textContent`, never `innerHTML`) into
 * scrollback + active screen row elements so `innerText` / `textContent` remain
 * accurate for accessibility, copy/paste, and automated testing, while making
 * XSS from guest output impossible.
 */

const DEFAULT_FG = null;
const DEFAULT_BG = null;

// Standard 16 ANSI colors (dark developer-console palette)
const ANSI_16 = [
  "#1e222a", // 0 black
  "#f87171", // 1 red
  "#4ade80", // 2 green
  "#facc15", // 3 yellow
  "#60a5fa", // 4 blue
  "#c084fc", // 5 magenta
  "#22d3ee", // 6 cyan
  "#e2e8f0", // 7 white
  "#64748b", // 8 bright black (gray)
  "#fca5a5", // 9 bright red
  "#86efac", // 10 bright green
  "#fde047", // 11 bright yellow
  "#93c5fd", // 12 bright blue
  "#d8b4fe", // 13 bright magenta
  "#67e8f9", // 14 bright cyan
  "#ffffff", // 15 bright white
];

function ansi256ToCss(n) {
  const idx = n & 0xff;
  if (idx < 16) return ANSI_16[idx];
  if (idx < 232) {
    const v = idx - 16;
    const r = Math.floor(v / 36);
    const g = Math.floor((v % 36) / 6);
    const b = v % 6;
    const map = [0, 95, 135, 175, 215, 255];
    return `rgb(${map[r]},${map[g]},${map[b]})`;
  }
  const gray = 8 + (idx - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function defaultStyle() {
  return {
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function cloneStyle(s) {
  return {
    fg: s.fg,
    bg: s.bg,
    bold: s.bold,
    dim: s.dim,
    italic: s.italic,
    underline: s.underline,
    inverse: s.inverse,
  };
}

function styleKey(s) {
  if (
    !s.fg &&
    !s.bg &&
    !s.bold &&
    !s.dim &&
    !s.italic &&
    !s.underline &&
    !s.inverse
  ) {
    return "";
  }
  return `${s.fg || ""}|${s.bg || ""}|${s.bold ? 1 : 0}${s.dim ? 1 : 0}${s.italic ? 1 : 0}${s.underline ? 1 : 0}${s.inverse ? 1 : 0}`;
}

function applyStyleToSpan(span, s) {
  if (s.inverse) {
    span.style.color = s.bg || "var(--term-bg, #0b0f14)";
    span.style.backgroundColor = s.fg || "var(--term-fg, #e6edf3)";
  } else {
    if (s.fg) span.style.color = s.fg;
    if (s.bg) span.style.backgroundColor = s.bg;
  }
  if (s.bold) span.style.fontWeight = "700";
  if (s.dim) span.style.opacity = "0.65";
  if (s.italic) span.style.fontStyle = "italic";
  if (s.underline) span.style.textDecoration = "underline";
}

function createBlankCell() {
  return { ch: " ", style: defaultStyle(), empty: true };
}

function createBlankRow(cols) {
  const row = new Array(cols);
  for (let i = 0; i < cols; i++) {
    row[i] = createBlankCell();
  }
  return row;
}

function rowToPlainText(row) {
  let end = row.length - 1;
  while (end >= 0 && row[end].empty) {
    end--;
  }
  if (end < 0) return "";
  let out = "";
  for (let i = 0; i <= end; i++) {
    out += row[i].ch;
  }
  return out;
}

function renderRowToElement(row, cursorCol = -1, showCursor = false) {
  const div = document.createElement("div");
  div.className = "term-row";

  let end = row.length - 1;
  while (end >= 0 && row[end].empty) {
    end--;
  }
  if (showCursor && cursorCol > end && cursorCol < row.length) {
    end = cursorCol;
  }

  if (end < 0) {
    return div;
  }

  let runText = "";
  let runKey = null;
  let runStyle = null;

  const flushRun = () => {
    if (!runText) return;
    if (!runKey) {
      div.appendChild(document.createTextNode(runText));
    } else {
      const span = document.createElement("span");
      applyStyleToSpan(span, runStyle);
      span.textContent = runText;
      div.appendChild(span);
    }
    runText = "";
    runKey = null;
    runStyle = null;
  };

  for (let i = 0; i <= end; i++) {
    const cell = row[i];
    const ch = cell.empty ? " " : cell.ch;

    if (showCursor && i === cursorCol) {
      flushRun();
      const cursorSpan = document.createElement("span");
      cursorSpan.className = "term-cursor";
      if (!cell.empty && styleKey(cell.style)) {
        applyStyleToSpan(cursorSpan, cell.style);
      }
      cursorSpan.textContent = ch;
      div.appendChild(cursorSpan);
      continue;
    }

    const k = styleKey(cell.style);
    if (runText && k === runKey) {
      runText += ch;
    } else {
      flushRun();
      runText = ch;
      runKey = k;
      runStyle = cell.style;
    }
  }
  flushRun();

  return div;
}

const PARSER_NORMAL = 0;
const PARSER_ESC = 1;
const PARSER_CSI = 2;
const PARSER_OSC = 3;
const PARSER_OSC_ESC = 4;
const PARSER_CHARSET = 5;

export class VT100Terminal {
  constructor(containerEl, options = {}) {
    if (!containerEl) {
      throw new Error("VT100Terminal requires a container DOM element");
    }
    this.el = containerEl;
    this.onData = typeof options.onData === "function" ? options.onData : () => {};
    this.onSignal = typeof options.onSignal === "function" ? options.onSignal : () => {};
    this.onResize = typeof options.onResize === "function" ? options.onResize : () => {};
    this.maxScrollback = options.maxScrollback ?? 2000;
    this.minCols = options.minCols ?? 20;
    this.minRows = options.minRows ?? 6;

    this.cols = Math.max(this.minCols, options.initialCols ?? 80);
    this.rows = Math.max(this.minRows, options.initialRows ?? 24);

    this._decoder = new TextDecoder("utf-8", { fatal: false });
    this._parserState = PARSER_NORMAL;
    this._csiBuf = "";
    this._oscLen = 0;

    this._style = defaultStyle();
    this._cursorRow = 0;
    this._cursorCol = 0;
    this._wrapPending = false;
    this._cursorVisible = true;
    this._savedCursor = { row: 0, col: 0, style: defaultStyle() };

    this._scrollback = []; // Array<string> for getText()
    this._screen = this._createScreen(this.rows, this.cols);
    this._altSavedState = null;

    this._renderPending = false;
    this._renderRafId = null;
    this._renderTimerId = null;
    this._lastRenderAt = 0;
    this._pendingScrollbackRows = [];
    this._resizeTimerId = null;
    this._destroyed = false;

    // Set up DOM inside containerEl
    if (!this.el.hasAttribute("tabindex")) {
      this.el.setAttribute("tabindex", "0");
    }
    this.el.textContent = "";
    this._scrollbackEl = document.createElement("div");
    this._scrollbackEl.className = "term-scrollback";
    this._screenEl = document.createElement("div");
    this._screenEl.className = "term-screen";
    this._inputEl = document.createElement("textarea");
    this._inputEl.className = "term-input";
    this._inputEl.setAttribute("tabindex", "-1");
    this._inputEl.setAttribute("autocapitalize", "off");
    this._inputEl.setAttribute("autocomplete", "off");
    this._inputEl.setAttribute("autocorrect", "off");
    this._inputEl.setAttribute("spellcheck", "false");
    this._inputEl.setAttribute("enterkeyhint", "send");
    this._inputEl.setAttribute("aria-label", "Terminal input");
    this._inputEl.value = " ";
    this._composing = false;
    this.el.appendChild(this._inputEl);
    this.el.appendChild(this._scrollbackEl);
    this.el.appendChild(this._screenEl);

    // Bind event listeners
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onPaste = this._handlePaste.bind(this);
    this._onClick = this._handleClick.bind(this);
    this._onInput = this._handleInput.bind(this);
    this._onCompositionStart = this._handleCompositionStart.bind(this);
    this._onCompositionEnd = this._handleCompositionEnd.bind(this);
    this._onWindowResize = this._scheduleMeasure.bind(this);

    this.el.addEventListener("keydown", this._onKeyDown);
    this.el.addEventListener("paste", this._onPaste);
    this.el.addEventListener("click", this._onClick);
    this._inputEl.addEventListener("input", this._onInput);
    this._inputEl.addEventListener("compositionstart", this._onCompositionStart);
    this._inputEl.addEventListener("compositionend", this._onCompositionEnd);
    window.addEventListener("resize", this._onWindowResize);

    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._scheduleMeasure());
      this._resizeObserver.observe(this.el);
    } else {
      this._resizeObserver = null;
    }

    this._measureAndResize(false);
    this._renderNow();
  }

  _createScreen(rows, cols) {
    const screen = new Array(rows);
    for (let r = 0; r < rows; r++) {
      screen[r] = createBlankRow(cols);
    }
    return screen;
  }

  _resizeScreenBuffer(screen, newRows, newCols) {
    if (
      screen.length === newRows &&
      (newRows === 0 || (screen[0] && screen[0].length === newCols))
    ) {
      return screen;
    }
    const nextScreen = this._createScreen(newRows, newCols);
    const copyRows = Math.min(screen.length, newRows);
    for (let r = 0; r < copyRows; r++) {
      const srcRow = screen[r];
      const copyCols = Math.min(srcRow ? srcRow.length : 0, newCols);
      for (let c = 0; c < copyCols; c++) {
        nextScreen[r][c] = srcRow[c];
      }
    }
    return nextScreen;
  }

  /**
   * Write a UTF-8 Uint8Array, ArrayBuffer, or string chunk to the terminal.
   */
  write(chunk) {
    if (this._destroyed || chunk == null) return;
    let text;
    if (typeof chunk === "string") {
      text = chunk;
    } else if (chunk instanceof Uint8Array) {
      text = this._decoder.decode(chunk, { stream: true });
    } else if (ArrayBuffer.isView(chunk)) {
      text = this._decoder.decode(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        { stream: true }
      );
    } else if (chunk instanceof ArrayBuffer) {
      text = this._decoder.decode(new Uint8Array(chunk), { stream: true });
    } else {
      text = String(chunk);
    }

    if (!text) return;

    for (const ch of text) {
      this._processChar(ch);
    }
    this._scheduleRender();
  }

  _processChar(ch) {
    const code = ch.codePointAt(0);

    switch (this._parserState) {
      case PARSER_NORMAL:
        this._processNormal(ch, code);
        return;

      case PARSER_ESC:
        if (ch === "[") {
          this._csiBuf = "";
          this._parserState = PARSER_CSI;
        } else if (ch === "]") {
          this._oscLen = 0;
          this._parserState = PARSER_OSC;
        } else if (ch === "(" || ch === ")" || ch === "*" || ch === "+") {
          this._parserState = PARSER_CHARSET;
        } else if (ch === "7") {
          this._savedCursor = {
            row: this._cursorRow,
            col: this._cursorCol,
            style: cloneStyle(this._style),
          };
          this._parserState = PARSER_NORMAL;
        } else if (ch === "8") {
          this._cursorRow = Math.min(this.rows - 1, Math.max(0, this._savedCursor.row));
          this._cursorCol = Math.min(this.cols - 1, Math.max(0, this._savedCursor.col));
          this._style = cloneStyle(this._savedCursor.style);
          this._wrapPending = false;
          this._parserState = PARSER_NORMAL;
        } else if (ch === "M") {
          // Reverse Index
          this._wrapPending = false;
          if (this._cursorRow > 0) {
            this._cursorRow--;
          } else {
            this._screen.pop();
            this._screen.unshift(createBlankRow(this.cols));
          }
          this._parserState = PARSER_NORMAL;
        } else if (ch === "D") {
          this._lineFeed();
          this._parserState = PARSER_NORMAL;
        } else if (ch === "E") {
          this._cursorCol = 0;
          this._lineFeed();
          this._parserState = PARSER_NORMAL;
        } else if (ch === "c") {
          this._resetStateOnly();
          this._parserState = PARSER_NORMAL;
        } else {
          this._parserState = PARSER_NORMAL;
        }
        return;

      case PARSER_CHARSET:
        this._parserState = PARSER_NORMAL;
        return;

      case PARSER_CSI:
        if (code === 0x1b) {
          this._parserState = PARSER_ESC;
          return;
        }
        if (code < 0x20) {
          // Execute embedded C0 control character while staying in CSI
          this._processNormal(ch, code);
          return;
        }
        if (code >= 0x40 && code <= 0x7e) {
          const params = this._csiBuf;
          this._csiBuf = "";
          this._parserState = PARSER_NORMAL;
          this._handleCsi(params, ch);
          return;
        }
        if (this._csiBuf.length < 256) {
          this._csiBuf += ch;
        } else {
          this._csiBuf = "";
          this._parserState = PARSER_NORMAL;
        }
        return;

      case PARSER_OSC:
        if (code === 0x07) {
          this._parserState = PARSER_NORMAL;
        } else if (code === 0x1b) {
          this._parserState = PARSER_OSC_ESC;
        } else {
          this._oscLen++;
          if (this._oscLen > 4096) {
            this._parserState = PARSER_NORMAL;
          }
        }
        return;

      case PARSER_OSC_ESC:
        if (ch === "\\") {
          this._parserState = PARSER_NORMAL;
        } else if (ch === "[") {
          this._csiBuf = "";
          this._parserState = PARSER_CSI;
        } else {
          this._parserState = PARSER_NORMAL;
        }
        return;
    }
  }

  _processNormal(ch, code) {
    if (code === 0x1b) {
      this._parserState = PARSER_ESC;
      return;
    }
    if (code === 0x0d) {
      // CR
      this._cursorCol = 0;
      this._wrapPending = false;
      return;
    }
    if (code === 0x0a) {
      // LF -> CR+LF (runtime has no ONLCR post-processing)
      this._cursorCol = 0;
      this._wrapPending = false;
      this._lineFeed();
      return;
    }
    if (code === 0x0b || code === 0x0c) {
      // VT / FF
      this._wrapPending = false;
      this._lineFeed();
      return;
    }
    if (code === 0x08) {
      // BS
      this._wrapPending = false;
      if (this._cursorCol > 0) {
        this._cursorCol--;
      }
      return;
    }
    if (code === 0x09) {
      // TAB (next 8-col tab stop)
      this._wrapPending = false;
      const nextStop = Math.min(this.cols - 1, (Math.floor(this._cursorCol / 8) + 1) * 8);
      this._cursorCol = nextStop;
      return;
    }
    if (code === 0x07 || code < 0x20 || code === 0x7f) {
      // BEL or other ignored C0 control / DEL
      return;
    }

    // Printable character
    if (this._wrapPending) {
      this._cursorCol = 0;
      this._wrapPending = false;
      this._lineFeed();
    }

    const row = this._screen[this._cursorRow];
    if (row && this._cursorCol < this.cols) {
      row[this._cursorCol] = {
        ch,
        style: cloneStyle(this._style),
        empty: false,
      };
    }

    if (this._cursorCol + 1 >= this.cols) {
      this._wrapPending = true;
    } else {
      this._cursorCol++;
    }
  }

  _lineFeed() {
    if (this._cursorRow + 1 < this.rows) {
      this._cursorRow++;
    } else {
      const scrolled = this._screen.shift();
      this._screen.push(createBlankRow(this.cols));
      if (!this._altSavedState) {
        this._pushScrollbackRow(scrolled);
      }
    }
  }

  _pushScrollbackRow(row) {
    this._scrollback.push(rowToPlainText(row));
    this._pendingScrollbackRows.push(row);
    if (this._scrollback.length > this.maxScrollback) {
      this._scrollback.shift();
    }
  }

  _handleCsi(paramsRaw, cmd) {
    // Handle private mode sequences like ?25h, ?25l, ?1049h, ?1049l
    if (paramsRaw.startsWith("?")) {
      const nums = paramsRaw
        .slice(1)
        .split(";")
        .map((s) => parseInt(s, 10));
      if (cmd === "h" || cmd === "l") {
        const enable = cmd === "h";
        for (const n of nums) {
          if (n === 25) {
            this._cursorVisible = enable;
          } else if (n === 1049 || n === 47 || n === 1047) {
            if (enable && !this._altSavedState) {
              this._altSavedState = {
                screen: this._screen,
                cursorRow: this._cursorRow,
                cursorCol: this._cursorCol,
                style: cloneStyle(this._style),
              };
              this._screen = this._createScreen(this.rows, this.cols);
              this._cursorRow = 0;
              this._cursorCol = 0;
              this._wrapPending = false;
            } else if (!enable && this._altSavedState) {
              this._screen = this._resizeScreenBuffer(
                this._altSavedState.screen,
                this.rows,
                this.cols
              );
              this._cursorRow = Math.max(0, Math.min(this.rows - 1, this._altSavedState.cursorRow));
              this._cursorCol = Math.max(0, Math.min(this.cols - 1, this._altSavedState.cursorCol));
              this._style = this._altSavedState.style;
              this._wrapPending = false;
              this._altSavedState = null;
            }
          }
        }
      }
      return;
    }

    // Ignore other non-standard prefixes (>, !, =)
    if (/^[>!<=]/.test(paramsRaw)) {
      return;
    }

    const cleanParams = paramsRaw.replace(/[^0-9;]/g, "");
    const params =
      cleanParams === ""
        ? []
        : cleanParams.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10) || 0));
    const p0 = params[0] || 0;
    const p1 = params[1] || 0;

    switch (cmd) {
      case "A": // CUU - Cursor Up
        this._wrapPending = false;
        this._cursorRow = Math.max(0, this._cursorRow - Math.max(1, p0));
        break;
      case "B": // CUD - Cursor Down
        this._wrapPending = false;
        this._cursorRow = Math.min(this.rows - 1, this._cursorRow + Math.max(1, p0));
        break;
      case "C": // CUF - Cursor Forward
        this._wrapPending = false;
        this._cursorCol = Math.min(this.cols - 1, this._cursorCol + Math.max(1, p0));
        break;
      case "D": // CUB - Cursor Back
        this._wrapPending = false;
        this._cursorCol = Math.max(0, this._cursorCol - Math.max(1, p0));
        break;
      case "E": // CNL - Cursor Next Line
        this._wrapPending = false;
        this._cursorCol = 0;
        this._cursorRow = Math.min(this.rows - 1, this._cursorRow + Math.max(1, p0));
        break;
      case "F": // CPL - Cursor Previous Line
        this._wrapPending = false;
        this._cursorCol = 0;
        this._cursorRow = Math.max(0, this._cursorRow - Math.max(1, p0));
        break;
      case "G": // CHA - Cursor Horizontal Absolute
      case "`":
        this._wrapPending = false;
        this._cursorCol = Math.min(this.cols - 1, Math.max(0, Math.max(1, p0) - 1));
        break;
      case "d": // VPA - Vertical Position Absolute
        this._wrapPending = false;
        this._cursorRow = Math.min(this.rows - 1, Math.max(0, Math.max(1, p0) - 1));
        break;
      case "H": // CUP - Cursor Position
      case "f":
        this._wrapPending = false;
        this._cursorRow = Math.min(this.rows - 1, Math.max(0, Math.max(1, p0) - 1));
        this._cursorCol = Math.min(this.cols - 1, Math.max(0, Math.max(1, p1) - 1));
        break;
      case "J": // ED - Erase in Display
        this._eraseInDisplay(p0);
        break;
      case "K": // EL - Erase in Line
        this._eraseInLine(p0);
        break;
      case "P": {
        // DCH - Delete Character(s)
        const n = Math.min(this.cols, Math.max(1, p0));
        const row = this._screen[this._cursorRow];
        if (row) {
          row.splice(this._cursorCol, n);
          while (row.length < this.cols) {
            row.push(createBlankCell());
          }
        }
        break;
      }
      case "@": {
        // ICH - Insert Character(s)
        const n = Math.min(this.cols, Math.max(1, p0));
        const row = this._screen[this._cursorRow];
        if (row) {
          const blanks = Array.from({ length: n }, () => createBlankCell());
          row.splice(this._cursorCol, 0, ...blanks);
          row.length = this.cols;
        }
        break;
      }
      case "X": {
        // ECH - Erase Character(s)
        const n = Math.min(this.cols, Math.max(1, p0));
        const row = this._screen[this._cursorRow];
        if (row) {
          for (let c = this._cursorCol; c < Math.min(this.cols, this._cursorCol + n); c++) {
            row[c] = createBlankCell();
          }
        }
        break;
      }
      case "L": {
        // IL - Insert Line(s)
        const n = Math.min(this.rows, Math.max(1, p0));
        for (let i = 0; i < n; i++) {
          this._screen.splice(this._cursorRow, 0, createBlankRow(this.cols));
          this._screen.pop();
        }
        break;
      }
      case "M": {
        // DL - Delete Line(s)
        const n = Math.min(this.rows, Math.max(1, p0));
        for (let i = 0; i < n; i++) {
          this._screen.splice(this._cursorRow, 1);
          this._screen.push(createBlankRow(this.cols));
        }
        break;
      }
      case "s":
        this._savedCursor = {
          row: this._cursorRow,
          col: this._cursorCol,
          style: cloneStyle(this._style),
        };
        break;
      case "u":
        this._cursorRow = Math.min(this.rows - 1, Math.max(0, this._savedCursor.row));
        this._cursorCol = Math.min(this.cols - 1, Math.max(0, this._savedCursor.col));
        this._style = cloneStyle(this._savedCursor.style);
        this._wrapPending = false;
        break;
      case "m": // SGR
        this._handleSgr(params.length === 0 ? [0] : params);
        break;
      case "n": // DSR (e.g. \x1b[6n) — silently consume
      default:
        break;
    }
  }

  _eraseInLine(mode) {
    const row = this._screen[this._cursorRow];
    if (!row) return;
    if (mode === 0) {
      for (let c = this._cursorCol; c < this.cols; c++) {
        row[c] = createBlankCell();
      }
    } else if (mode === 1) {
      for (let c = 0; c <= Math.min(this._cursorCol, this.cols - 1); c++) {
        row[c] = createBlankCell();
      }
    } else if (mode === 2) {
      for (let c = 0; c < this.cols; c++) {
        row[c] = createBlankCell();
      }
    }
  }

  _eraseInDisplay(mode) {
    if (mode === 0) {
      this._eraseInLine(0);
      for (let r = this._cursorRow + 1; r < this.rows; r++) {
        this._screen[r] = createBlankRow(this.cols);
      }
    } else if (mode === 1) {
      for (let r = 0; r < this._cursorRow; r++) {
        this._screen[r] = createBlankRow(this.cols);
      }
      this._eraseInLine(1);
    } else if (mode === 2 || mode === 3) {
      for (let r = 0; r < this.rows; r++) {
        this._screen[r] = createBlankRow(this.cols);
      }
      if (mode === 3) {
        this._scrollback = [];
        this._pendingScrollbackRows = [];
        this._scrollbackEl.textContent = "";
      }
    }
  }

  _handleSgr(params) {
    for (let i = 0; i < params.length; i++) {
      const code = params[i];
      if (code === 0) {
        this._style = defaultStyle();
      } else if (code === 1) {
        this._style.bold = true;
      } else if (code === 2) {
        this._style.dim = true;
      } else if (code === 3) {
        this._style.italic = true;
      } else if (code === 4) {
        this._style.underline = true;
      } else if (code === 7) {
        this._style.inverse = true;
      } else if (code === 22) {
        this._style.bold = false;
        this._style.dim = false;
      } else if (code === 23) {
        this._style.italic = false;
      } else if (code === 24) {
        this._style.underline = false;
      } else if (code === 27) {
        this._style.inverse = false;
      } else if (code >= 30 && code <= 37) {
        this._style.fg = ANSI_16[code - 30];
      } else if (code === 39) {
        this._style.fg = DEFAULT_FG;
      } else if (code >= 40 && code <= 47) {
        this._style.bg = ANSI_16[code - 40];
      } else if (code === 49) {
        this._style.bg = DEFAULT_BG;
      } else if (code >= 90 && code <= 97) {
        this._style.fg = ANSI_16[code - 90 + 8];
      } else if (code >= 100 && code <= 107) {
        this._style.bg = ANSI_16[code - 100 + 8];
      } else if (code === 38 || code === 48) {
        const isFg = code === 38;
        const mode = params[i + 1];
        if (mode === 5 && i + 2 < params.length) {
          const color = ansi256ToCss(params[i + 2]);
          if (isFg) this._style.fg = color;
          else this._style.bg = color;
          i += 2;
        } else if (mode === 2 && i + 4 < params.length) {
          const r = Math.min(255, Math.max(0, params[i + 2] || 0));
          const g = Math.min(255, Math.max(0, params[i + 3] || 0));
          const b = Math.min(255, Math.max(0, params[i + 4] || 0));
          const color = `rgb(${r},${g},${b})`;
          if (isFg) this._style.fg = color;
          else this._style.bg = color;
          i += 4;
        }
      }
    }
  }

  _scheduleRender() {
    if (this._destroyed) return;
    const now = performance.now();
    if (!this._renderPending && now - this._lastRenderAt >= 16) {
      this._renderNow();
      return;
    }
    if (this._renderPending) return;
    this._renderPending = true;
    const flush = () => {
      this._renderPending = false;
      if (this._renderRafId !== null) {
        cancelAnimationFrame(this._renderRafId);
        this._renderRafId = null;
      }
      if (this._renderTimerId !== null) {
        clearTimeout(this._renderTimerId);
        this._renderTimerId = null;
      }
      if (!this._destroyed) {
        this._renderNow();
      }
    };
    this._renderRafId = requestAnimationFrame(flush);
    this._renderTimerId = setTimeout(flush, 32);
  }

  _renderNow() {
    this._lastRenderAt = performance.now();

    // Flush newly scrolled-off rows into scrollback DOM
    if (this._pendingScrollbackRows.length > 0) {
      const frag = document.createDocumentFragment();
      for (const row of this._pendingScrollbackRows) {
        frag.appendChild(renderRowToElement(row, -1, false));
      }
      this._pendingScrollbackRows.length = 0;
      this._scrollbackEl.appendChild(frag);
      while (this._scrollbackEl.childNodes.length > this.maxScrollback) {
        this._scrollbackEl.removeChild(this._scrollbackEl.firstChild);
      }
    }

    // Determine last non-empty screen row so we don't emit trailing blank divs
    let lastRow = this._cursorRow;
    for (let r = this.rows - 1; r > lastRow; r--) {
      if (rowToPlainText(this._screen[r]).length > 0) {
        lastRow = r;
        break;
      }
    }

    const frag = document.createDocumentFragment();
    for (let r = 0; r <= lastRow; r++) {
      const showCursor = this._cursorVisible && r === this._cursorRow;
      frag.appendChild(renderRowToElement(this._screen[r], this._cursorCol, showCursor));
    }
    this._screenEl.textContent = "";
    this._screenEl.appendChild(frag);

    // Auto-scroll to bottom
    this.el.scrollTop = this.el.scrollHeight;
  }

  _handleKeyDown(e) {
    if (
      this._destroyed ||
      this._composing ||
      e.isComposing ||
      e.key === "Process" ||
      e.key === "Unidentified" ||
      e.keyCode === 229
    ) {
      return;
    }

    // Allow browser Meta shortcuts (Cmd+C, Cmd+V, Cmd+R, etc.)
    if (e.metaKey) return;

    // Ctrl+C: allow native copy if user has selected text inside #terminal
    if (e.ctrlKey && !e.altKey && (e.key === "c" || e.key === "C")) {
      const sel = window.getSelection();
      if (
        sel &&
        !sel.isCollapsed &&
        sel.toString().length > 0 &&
        this.el.contains(sel.anchorNode)
      ) {
        return;
      }
      e.preventDefault();
      this.onData("\x03");
      this.onSignal("SIGINT");
      return;
    }

    // Ctrl+D: EOF / delete char under cursor in ash
    if (e.ctrlKey && !e.altKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      this.onData("\x04");
      return;
    }

    // Ctrl+L: clear terminal display
    if (e.ctrlKey && !e.altKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      this.clear();
      return;
    }

    // Ctrl+V: allow native paste event
    if (e.ctrlKey && !e.altKey && (e.key === "v" || e.key === "V")) {
      return;
    }

    // Other Ctrl+<key> control codes (Ctrl+A..Z, Ctrl+[\]_^)
    if (e.ctrlKey && !e.altKey && e.key.length === 1) {
      const upper = e.key.toUpperCase().charCodeAt(0);
      if (upper >= 64 && upper <= 95) {
        e.preventDefault();
        this.onData(String.fromCharCode(upper - 64));
        return;
      }
    }

    // Special keys
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        this.onData("\n");
        return;
      case "Backspace":
        e.preventDefault();
        this.onData("\x7f");
        return;
      case "Tab":
        e.preventDefault();
        this.onData("\t");
        return;
      case "Escape":
        e.preventDefault();
        this.onData("\x1b");
        return;
      case "ArrowUp":
        e.preventDefault();
        this.onData("\x1b[A");
        return;
      case "ArrowDown":
        e.preventDefault();
        this.onData("\x1b[B");
        return;
      case "ArrowRight":
        e.preventDefault();
        this.onData("\x1b[C");
        return;
      case "ArrowLeft":
        e.preventDefault();
        this.onData("\x1b[D");
        return;
      case "Home":
        e.preventDefault();
        this.onData("\x1b[H");
        return;
      case "End":
        e.preventDefault();
        this.onData("\x1b[F");
        return;
      case "Delete":
        e.preventDefault();
        this.onData("\x1b[3~");
        return;
      case "PageUp":
        e.preventDefault();
        this.onData("\x1b[5~");
        return;
      case "PageDown":
        e.preventDefault();
        this.onData("\x1b[6~");
        return;
    }

    // Printable characters (including single astral-plane code points)
    if (Array.from(e.key).length === 1 && !e.ctrlKey) {
      e.preventDefault();
      if (e.altKey) {
        this.onData("\x1b" + e.key);
      } else {
        this.onData(e.key);
      }
    }
  }

  _handlePaste(e) {
    if (this._destroyed) return;
    e.preventDefault();
    const raw = e.clipboardData?.getData("text/plain") || "";
    if (!raw) return;
    const normalized = raw.replace(/\r\n?/g, "\n");
    this.onData(normalized);
  }

  _handleClick() {
    if (this._destroyed) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().length > 0) {
      return;
    }
    this.focus();
  }

  _resetInputSentinel() {
    if (!this._inputEl) return;
    this._inputEl.value = " ";
    if (document.activeElement === this._inputEl) {
      try {
        this._inputEl.setSelectionRange(1, 1);
      } catch {
        // Ignore selection errors on unsupported environments
      }
    }
  }

  _handleCompositionStart() {
    this._composing = true;
  }

  _handleCompositionEnd(e) {
    this._composing = false;
    if (this._destroyed) return;
    const raw = typeof e?.data === "string" ? e.data : "";
    if (raw.length > 0) {
      this.onData(raw.replace(/\r\n?/g, "\n"));
    }
    this._resetInputSentinel();
  }

  _handleInput(e) {
    if (this._destroyed || this._composing || e?.isComposing) return;
    const inputType = e?.inputType || "";
    if (inputType === "insertCompositionText") return;

    const val = this._inputEl ? this._inputEl.value : "";

    if (inputType === "deleteContentBackward" || (val.length === 0 && !e?.data)) {
      this.onData("\x7f");
      this._resetInputSentinel();
      return;
    }

    if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
      this.onData("\n");
      this._resetInputSentinel();
      return;
    }

    let text = "";
    if (val.startsWith(" ")) {
      text = val.slice(1);
    } else if (val.length > 0) {
      text = val;
    } else if (typeof e?.data === "string") {
      text = e.data;
    }

    if (text.length > 0) {
      this.onData(text.replace(/\r\n?/g, "\n"));
    }
    this._resetInputSentinel();
  }

  _scheduleMeasure() {
    if (this._destroyed) return;
    if (this._resizeTimerId !== null) {
      clearTimeout(this._resizeTimerId);
    }
    this._resizeTimerId = setTimeout(() => {
      this._resizeTimerId = null;
      if (!this._destroyed) {
        this._measureAndResize(true);
      }
    }, 50);
  }

  _measureAndResize(notify) {
    const rect = this.el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const cs = window.getComputedStyle(this.el);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const innerWidth = Math.max(0, rect.width - padX - 14); // scrollbar margin
    const innerHeight = Math.max(0, rect.height - padY);

    // Measure character cell size using a temporary detached span
    const probe = document.createElement("span");
    probe.style.position = "fixed";
    probe.style.top = "-9999px";
    probe.style.left = "-9999px";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.lineHeight = cs.lineHeight;
    probe.textContent = "MMMMMMMMMM";
    document.body.appendChild(probe);
    const probeRect = probe.getBoundingClientRect();
    document.body.removeChild(probe);

    const charW = probeRect.width > 0 ? probeRect.width / 10 : 8.4;
    const lineH = probeRect.height > 0 ? probeRect.height : 19;

    const newCols = Math.max(this.minCols, Math.min(300, Math.floor(innerWidth / charW)));
    const newRows = Math.max(this.minRows, Math.min(120, Math.floor(innerHeight / lineH)));

    if (newCols === this.cols && newRows === this.rows) return;

    // Resize screen buffer preserving existing content
    const nextScreen = this._resizeScreenBuffer(this._screen, newRows, newCols);

    this.cols = newCols;
    this.rows = newRows;
    this._screen = nextScreen;
    this._cursorRow = Math.min(this.rows - 1, this._cursorRow);
    this._cursorCol = Math.min(this.cols - 1, this._cursorCol);
    this._wrapPending = false;

    this._renderNow();
    if (notify) {
      this.onResize(this.cols, this.rows);
    }
  }

  _resetStateOnly() {
    this._style = defaultStyle();
    this._cursorRow = 0;
    this._cursorCol = 0;
    this._wrapPending = false;
    this._cursorVisible = true;
    this._savedCursor = { row: 0, col: 0, style: defaultStyle() };
    this._altSavedState = null;
    this._scrollback = [];
    this._pendingScrollbackRows = [];
    this._screen = this._createScreen(this.rows, this.cols);
    this._scrollbackEl.textContent = "";
    this._screenEl.textContent = "";
  }

  /**
   * Clear visible screen and scrollback immediately.
   */
  clear() {
    if (this._destroyed) return;
    this._scrollback = [];
    this._pendingScrollbackRows = [];
    this._screen = this._createScreen(this.rows, this.cols);
    this._cursorRow = 0;
    this._cursorCol = 0;
    this._wrapPending = false;
    this._scrollbackEl.textContent = "";
    this._renderNow();
  }

  /**
   * Full reset (decoder, escape parser, SGR attributes, scrollback, screen).
   */
  reset() {
    if (this._destroyed) return;
    this._decoder = new TextDecoder("utf-8", { fatal: false });
    this._parserState = PARSER_NORMAL;
    this._csiBuf = "";
    this._oscLen = 0;
    this._resetStateOnly();
    this._renderNow();
  }

  focus() {
    if (this._destroyed) return;
    const target = this._inputEl || this.el;
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
    this._resetInputSentinel();
  }

  getText() {
    const lines = [...this._scrollback];
    let lastRow = this._cursorRow;
    for (let r = this.rows - 1; r > lastRow; r--) {
      if (rowToPlainText(this._screen[r]).length > 0) {
        lastRow = r;
        break;
      }
    }
    for (let r = 0; r <= lastRow; r++) {
      lines.push(rowToPlainText(this._screen[r]));
    }
    return lines.join("\n");
  }

  getSize() {
    return { cols: this.cols, rows: this.rows };
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._renderRafId !== null) cancelAnimationFrame(this._renderRafId);
    if (this._renderTimerId !== null) clearTimeout(this._renderTimerId);
    if (this._resizeTimerId !== null) clearTimeout(this._resizeTimerId);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this.el.removeEventListener("keydown", this._onKeyDown);
    this.el.removeEventListener("paste", this._onPaste);
    this.el.removeEventListener("click", this._onClick);
    if (this._inputEl) {
      this._inputEl.removeEventListener("input", this._onInput);
      this._inputEl.removeEventListener("compositionstart", this._onCompositionStart);
      this._inputEl.removeEventListener("compositionend", this._onCompositionEnd);
    }
    window.removeEventListener("resize", this._onWindowResize);
  }
}
