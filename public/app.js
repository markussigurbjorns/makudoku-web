const puzzleContainer = document.getElementById("puzzle-container");
const svgRoot = document.getElementById("svg-root") || puzzleContainer;
const variantsEl = document.getElementById("variants");
const statusEl = document.getElementById("status");
const reloadBtn = document.getElementById("reload");
const modeValueBtn = document.getElementById("mode-value");
const modeCandidateBtn = document.getElementById("mode-candidate");
const multiSelectBtn = document.getElementById("multi-select");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const checkBtn = document.getElementById("check-btn");
const digitPad = document.querySelector(".digit-pad");

let currentSolution = [];
let variants = [];

// SVG-related refs (updated after we insert the SVG)
let svg = null;
let highlightLayer = null;
let userLayer = null;
let candLayer = null;
let keydownHandler = null;
let isDragging = false;
let wasDragging = false;
let skipNextClick = false;

// Selection state
const selectedRects = new Set();
let focusRect = null; // last clicked/keyboard-focused cell
let inputMode = "value"; // "value" | "candidate"
let multiSelectEnabled = false;
let updateSelectionStylesFn = null;
let shiftCandidateActive = false;
let shiftPreviousMode = null;

const UNDO_LIMIT = 200;
let currentState = null; // { values: (string|null)[], candidates: number[] }
let undoStack = [];
let redoStack = [];
let solutionFlat = null; // string[81]

const VARIANT_LABELS = {
  kropki_white: "Kropki (white)",
  kropki_black: "Kropki (black)",
  thermo: "Thermo",
  arrow: "Arrow",
  killer: "Killer cages",
  king: "King move",
  knight: "Knight move",
  queen: "Queen move",
};

function formatVariantLabel(kind) {
  if (VARIANT_LABELS[kind]) return VARIANT_LABELS[kind];
  return String(kind)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderVariants(kinds) {
  if (!variantsEl) return;
  variantsEl.innerHTML = "";

  const list = Array.isArray(kinds) ? kinds : [];
  if (list.length === 0) {
    const pill = document.createElement("span");
    pill.className = "variant-pill";
    pill.textContent = "Classic";
    variantsEl.appendChild(pill);
    return;
  }

  for (const kind of list) {
    const pill = document.createElement("span");
    pill.className = "variant-pill";
    pill.textContent = formatVariantLabel(kind);
    variantsEl.appendChild(pill);
  }
}

function cellIndex(row, col) {
  return Number(row) * 9 + Number(col);
}

function cloneState(state) {
  return {
    values: state.values.slice(),
    candidates: state.candidates.slice(),
  };
}

function statesEqual(a, b) {
  if (!a || !b) return false;
  for (let i = 0; i < 81; i++) {
    if (a.values[i] !== b.values[i]) return false;
    if (a.candidates[i] !== b.candidates[i]) return false;
  }
  return true;
}

function updateUndoRedoUi() {
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

function showModal(title, message) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");

  const modal = document.createElement("div");
  modal.className = "modal";

  const h2 = document.createElement("h2");
  h2.textContent = title;

  const p = document.createElement("p");
  p.textContent = message;

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const ok = document.createElement("button");
  ok.className = "btn-primary";
  ok.type = "button";
  ok.textContent = "OK";

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    backdrop.remove();
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  ok.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  actions.appendChild(ok);
  modal.appendChild(h2);
  modal.appendChild(p);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  document.addEventListener("keydown", onKeyDown);
  ok.focus();
}

function isBoardCorrectSoFar() {
  if (!solutionFlat || !currentState) return null; // unknown

  for (let i = 0; i < 81; i++) {
    const v = currentState.values[i];
    if (!v) continue;
    if (v !== solutionFlat[i]) return false;
  }
  return true;
}

function pushUndo(state) {
  undoStack.push(cloneState(state));
  if (undoStack.length > UNDO_LIMIT) {
    undoStack.shift();
  }
  redoStack = [];
  updateUndoRedoUi();
}

function applyStateToSvg(state) {
  if (!svg || !userLayer || !candLayer) return;

  // Update user values
  userLayer.querySelectorAll("text.user").forEach((n) => n.remove());
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const idx = r * 9 + c;
      const val = state.values[idx];
      if (!val) continue;

      const rect = highlightLayer?.querySelector(
        `rect.highlight-cell[data-row="${r}"][data-col="${c}"]`
      );
      if (!rect) continue;

      const { x, y } = cellCenter(rect);
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("class", "user");
      t.setAttribute("data-row", String(r));
      t.setAttribute("data-col", String(c));
      t.setAttribute(
        "data-box",
        rect.dataset.box ? String(rect.dataset.box) : "0"
      );
      t.setAttribute("x", x);
      t.setAttribute("y", y);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("dominant-baseline", "middle");
      t.setAttribute("pointer-events", "none");
      t.textContent = val;
      userLayer.appendChild(t);
    }
  }

  // Update candidates
  candLayer.querySelectorAll("text.candidate").forEach((n) => {
    n.textContent = "";
  });
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const idx = r * 9 + c;
      const mask = state.candidates[idx] ?? 0;
      if (!mask) continue;

      const group = candLayer.querySelector(
        `.cell-candidates[data-row="${r}"][data-col="${c}"]`
      );
      if (!group) continue;

      for (let digit = 1; digit <= 9; digit++) {
        const bit = 1 << (digit - 1);
        if (!(mask & bit)) continue;
        const node = group.querySelector(`text.candidate[data-digit="${digit}"]`);
        if (node) node.textContent = String(digit);
      }
    }
  }
}

function initStateFromSvg() {
  const values = Array(81).fill(null);
  const candidates = Array(81).fill(0);

  if (userLayer) {
    userLayer.querySelectorAll("text.user").forEach((node) => {
      const r = node.dataset.row;
      const c = node.dataset.col;
      const text = node.textContent?.trim();
      if (!/^[1-9]$/.test(text ?? "")) return;
      values[cellIndex(r, c)] = text;
    });
  }

  if (candLayer) {
    candLayer.querySelectorAll("g.cell-candidates").forEach((group) => {
      const r = group.dataset.row;
      const c = group.dataset.col;
      let mask = 0;
      group.querySelectorAll("text.candidate").forEach((node) => {
        const digit = node.dataset.digit;
        if (!digit) return;
        if ((node.textContent ?? "").trim() === "") return;
        const d = Number(digit);
        if (d >= 1 && d <= 9) mask |= 1 << (d - 1);
      });
      candidates[cellIndex(r, c)] = mask;
    });
  }

  currentState = { values, candidates };
  undoStack = [];
  redoStack = [];
  updateUndoRedoUi();
}

// ---------- Fetch & load puzzle ----------

async function loadPuzzle() {
  try {
    statusEl.textContent = "Loading puzzle…";
    if (svgRoot) svgRoot.innerHTML = "";
    if (variantsEl) variantsEl.innerHTML = "";
    selectedRects.clear();
    focusRect = null;
    setMode("value");
    setMultiSelect(false);

    const res = await fetch("/api/puzzle/today", {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error: ${res.status} ${text}`);
    }

    const data = await res.json(); // { svg: string, solution: number[] }

    if (svgRoot) svgRoot.innerHTML = data.svg;

    // Init interaction with the *new* SVG
    initSvgInteraction();
    initStateFromSvg();

    currentSolution = Array.isArray(data.solution) ? data.solution : [];
    variants = Array.isArray(data.variants) ? data.variants : [];
    renderVariants(variants);
    statusEl.textContent = "Puzzle loaded.";
    if (currentSolution.length === 81) {
      solutionFlat = currentSolution.map((n) => String(n));
    } else {
      solutionFlat = null;
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Failed to load puzzle.";
    if (variantsEl) variantsEl.innerHTML = "";
    if (svgRoot) {
      svgRoot.innerHTML =
        "<p>Something went wrong loading the puzzle. Try again.</p>";
    } else {
      puzzleContainer.innerHTML =
        "<p>Something went wrong loading the puzzle. Try again.</p>";
    }
  }
}

// ---------- Wire up buttons ----------

if (reloadBtn) {
  reloadBtn.addEventListener("click", () => {
    loadPuzzle();
  });
}

// ---------- Mode toggle ----------

function setMode(mode) {
  inputMode = mode;
  const isValue = mode === "value";
  modeValueBtn.classList.toggle("active", isValue);
  modeValueBtn.setAttribute("aria-pressed", isValue ? "true" : "false");
  modeCandidateBtn.classList.toggle("active", !isValue);
  modeCandidateBtn.setAttribute("aria-pressed", !isValue ? "true" : "false");
}

modeValueBtn.addEventListener("click", () => setMode("value"));
modeCandidateBtn.addEventListener("click", () => setMode("candidate"));

// Hold Shift to temporarily enter candidate mode (only if you were in value mode).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Shift") return;
  if (shiftCandidateActive) return;

  if (inputMode === "value") {
    shiftCandidateActive = true;
    shiftPreviousMode = "value";
    setMode("candidate");
  } else {
    shiftCandidateActive = true;
    shiftPreviousMode = null;
  }
});

document.addEventListener("keyup", (e) => {
  if (e.key !== "Shift") return;
  if (!shiftCandidateActive) return;

  shiftCandidateActive = false;
  if (shiftPreviousMode === "value") {
    shiftPreviousMode = null;
    setMode("value");
  } else {
    shiftPreviousMode = null;
  }
});

function setMultiSelect(enabled) {
  multiSelectEnabled = enabled;
  if (multiSelectBtn) {
    multiSelectBtn.classList.toggle("active", enabled);
    multiSelectBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  if (!enabled && selectedRects.size > 1) {
    const keep = focusRect ?? selectedRects.values().next().value;
    selectedRects.clear();
    if (keep) {
      selectedRects.add(keep);
      focusRect = keep;
    }
    if (updateSelectionStylesFn) {
      updateSelectionStylesFn();
    }
  }
}

if (multiSelectBtn) {
  multiSelectBtn.addEventListener("click", () => {
    setMultiSelect(!multiSelectEnabled);
  });
}

function handleDigitInput(value, isDelete) {
  if (!svg || !userLayer || !candLayer || !currentState) return;
  if (!selectedRects.size) return;

  const valueToWrite = isDelete ? null : value;
  const givenCells = new Set(
    Array.from(svg.querySelectorAll("#givens text.given")).map(
      (node) => `${node.dataset.row}-${node.dataset.col}`
    )
  );

  const next = cloneState(currentState);

  selectedRects.forEach((rect) => {
    const r = rect.dataset.row;
    const c = rect.dataset.col;

    // Do not allow overwriting givens
    if (givenCells.has(`${r}-${c}`)) {
      return;
    }

    const idx = cellIndex(r, c);

    if (inputMode === "value") {
      next.values[idx] = valueToWrite;
      next.candidates[idx] = 0;
    } else if (inputMode === "candidate") {
      if (isDelete) {
        next.candidates[idx] = 0;
        return;
      }

      // Don't allow candidates if the cell already has a user value.
      if (next.values[idx]) {
        return;
      }

      const digit = Number(valueToWrite);
      if (!(digit >= 1 && digit <= 9)) return;
      const bit = 1 << (digit - 1);
      next.candidates[idx] ^= bit;
    }
  });

  if (statesEqual(currentState, next)) return;
  pushUndo(currentState);
  currentState = next;
  applyStateToSvg(currentState);
  if (updateSelectionStylesFn) updateSelectionStylesFn();
}

function digitFromKeyEvent(event) {
  if (/^[1-9]$/.test(event.key)) return event.key;

  // When Shift is held, event.key becomes "!" etc; prefer event.code.
  if (event.code && /^Digit[1-9]$/.test(event.code)) {
    return event.code.slice("Digit".length);
  }
  if (event.code && /^Numpad[1-9]$/.test(event.code)) {
    return event.code.slice("Numpad".length);
  }
  return null;
}

// Digit pad clicks
if (digitPad) {
  digitPad.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    const digit = target.dataset.digit;
    const isErase = target.dataset.erase === "true";
    if (digit) {
      handleDigitInput(digit, false);
    } else if (isErase) {
      handleDigitInput(null, true);
    }
  });
}

function undo() {
  if (!undoStack.length || !currentState) return;
  redoStack.push(cloneState(currentState));
  currentState = undoStack.pop();
  applyStateToSvg(currentState);
  updateUndoRedoUi();
  if (updateSelectionStylesFn) updateSelectionStylesFn();
}

function redo() {
  if (!redoStack.length || !currentState) return;
  undoStack.push(cloneState(currentState));
  currentState = redoStack.pop();
  applyStateToSvg(currentState);
  updateUndoRedoUi();
  if (updateSelectionStylesFn) updateSelectionStylesFn();
}

if (undoBtn) undoBtn.addEventListener("click", undo);
if (redoBtn) redoBtn.addEventListener("click", redo);

if (checkBtn) {
  checkBtn.addEventListener("click", () => {
    const ok = isBoardCorrectSoFar();
    if (ok === null) {
      showModal(
        "Check",
        "No solution is available right now, so I can't validate this puzzle."
      );
    } else if (ok) {
      showModal("Looks good", "Everything is looking correct so far.");
    } else {
      showModal("Not quite", "There is an error somewhere.");
    }
  });
}

// ---------- SVG interaction ----------

function initSvgInteraction() {
  svg = puzzleContainer.querySelector("svg");
  if (!svg) {
    console.warn("No <svg> found inside #puzzle-container");
    return;
  }

  const widthAttr = svg.getAttribute("width");
  const heightAttr = svg.getAttribute("height");
  const hasViewBox = svg.hasAttribute("viewBox");
  if (!hasViewBox && widthAttr && heightAttr) {
    const w = parseFloat(widthAttr);
    const h = parseFloat(heightAttr);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }
  }
  svg.removeAttribute("width");
  svg.removeAttribute("height");

  highlightLayer = svg.querySelector("#highlights");
  userLayer = svg.querySelector("#user-values");
  candLayer = svg.querySelector("#candidates");

  if (!userLayer) {
    userLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    userLayer.setAttribute("id", "user-values");
    svg.appendChild(userLayer);
  }

  if (!highlightLayer) console.warn("Missing #highlights layer");
  if (!candLayer) console.warn("Missing #candidates layer");

  const highlightCells = highlightLayer
    ? Array.from(highlightLayer.querySelectorAll("rect.highlight-cell"))
    : [];
  const givenCells = new Set(
    Array.from(svg.querySelectorAll("#givens text.given")).map(
      (node) => `${node.dataset.row}-${node.dataset.col}`
    )
  );

  const getCellValue = (row, col) => {
    const user = userLayer?.querySelector(
      `text.user[data-row="${row}"][data-col="${col}"]`
    );
    if (user?.textContent) return user.textContent.trim();

    const given = svg.querySelector(
      `#givens text.given[data-row="${row}"][data-col="${col}"]`
    );
    if (given?.textContent) return given.textContent.trim();

    return null;
  };

  const updateSelectionStyles = () => {
    // Determine "same value" highlighting when exactly one cell is selected.
    let selectedValue = null;
    if (selectedRects.size === 1) {
      const only = selectedRects.values().next().value;
      if (only) {
        selectedValue = getCellValue(only.dataset.row, only.dataset.col);
        if (!/^[1-9]$/.test(selectedValue ?? "")) {
          selectedValue = null;
        }
      }
    }

    highlightCells.forEach((rect) => {
      rect.classList.toggle("selected", selectedRects.has(rect));
      if (selectedValue) {
        const rectValue = getCellValue(rect.dataset.row, rect.dataset.col);
        rect.classList.toggle(
          "same-value",
          rectValue === selectedValue && !selectedRects.has(rect)
        );
      } else {
        rect.classList.remove("same-value");
      }
    });
  };
  updateSelectionStylesFn = updateSelectionStyles;

  const clearSelection = () => {
    selectedRects.clear();
    focusRect = null;
    updateSelectionStyles();
  };

  const toggleRect = (rect) => {
    if (!rect) return;
    if (selectedRects.has(rect)) {
      selectedRects.delete(rect);
      if (focusRect === rect) {
        focusRect = null;
      }
    } else {
      selectedRects.add(rect);
      focusRect = rect;
    }
    updateSelectionStyles();
  };

  const selectSingleRect = (rect) => {
    if (!rect) return;
    selectedRects.clear();
    selectedRects.add(rect);
    focusRect = rect;
    updateSelectionStyles();
  };

  const findRectAtPoint = (event) => {
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());

    return highlightCells.find((cell) => {
      const x = parseFloat(cell.getAttribute("x"));
      const y = parseFloat(cell.getAttribute("y"));
      const w = parseFloat(cell.getAttribute("width"));
      const h = parseFloat(cell.getAttribute("height"));
      return (
        svgPt.x >= x &&
        svgPt.x <= x + w &&
        svgPt.y >= y &&
        svgPt.y <= y + h
      );
    });
  };

  // Click/drag selection
  highlightCells.forEach((rect) => {
    rect.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      isDragging = true;
      wasDragging = false;
      skipNextClick = true; // prevent the follow-up click from toggling off

      if (multiSelectEnabled) {
        toggleRect(rect);
        return;
      }

      if (selectedRects.size === 1 && selectedRects.has(rect)) {
        // Clicking an already-selected cell clears selection
        clearSelection();
      } else {
        // Default: single select on click-down
        selectSingleRect(rect);
      }
    });
  });

  svg.addEventListener("mousemove", (event) => {
    if (!isDragging) return;
    const rect = findRectAtPoint(event);
    if (rect && !selectedRects.has(rect)) {
      wasDragging = true;
      selectedRects.add(rect);
      focusRect = rect;
      updateSelectionStyles();
    }
  });

  svg.addEventListener("mouseup", () => {
    isDragging = false;
  });

  svg.addEventListener("mouseleave", () => {
    isDragging = false;
  });

  // Clicking elsewhere in the SVG clears selection
  svg.addEventListener("click", (event) => {
    if (skipNextClick) {
      skipNextClick = false;
      return;
    }

    if (wasDragging) {
      wasDragging = false;
      return; // suppress click-after-drag so multi-selection persists
    }

    if (!highlightCells.length) return;
    const rect = findRectAtPoint(event);
    if (rect) {
      if (multiSelectEnabled) {
        toggleRect(rect);
      } else if (selectedRects.size === 1 && selectedRects.has(rect)) {
        clearSelection();
      } else {
        selectSingleRect(rect);
      }
    } else {
      clearSelection();
    }
  });

  // Key handler – rebind per puzzle load to avoid stacking listeners
  if (keydownHandler) {
    document.removeEventListener("keydown", keydownHandler);
  }
  keydownHandler = (e) => {
    if (!highlightCells.length || !userLayer || !candLayer) return;

    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }

    const digit = digitFromKeyEvent(e);
    const isDigit = digit !== null;
    const isDelete =
      e.key === "Backspace" || e.key === "Delete" || e.key === "0";
    const isArrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
      e.key
    );

    if (isArrow) {
      e.preventDefault();
      const moveBy = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      }[e.key];
      const startRect = focusRect ?? highlightCells[0];
      if (!startRect) return;
      const r = Number(startRect.dataset.row);
      const c = Number(startRect.dataset.col);
      const target = highlightCells.find(
        (cell) =>
          Number(cell.dataset.row) === r + moveBy[0] &&
          Number(cell.dataset.col) === c + moveBy[1]
      );
      if (target) {
        selectSingleRect(target);
      }
      return;
    }

    if (!selectedRects.size) return;
    if (!isDigit && !isDelete) return;

    e.preventDefault();
    handleDigitInput(isDigit ? digit : null, isDelete);
  };
  document.addEventListener("keydown", keydownHandler);
}

// Compute center of a cell from its highlight rect
function cellCenter(rect) {
  const x = parseFloat(rect.getAttribute("x"));
  const y = parseFloat(rect.getAttribute("y"));
  const w = parseFloat(rect.getAttribute("width"));
  const h = parseFloat(rect.getAttribute("height"));

  // baseline tweak to roughly match givens (your givens use y ≈ center + 2)
  const baseY = y + h / 2;
  const tweak = 26 * 0.08; // same fudge you had
  return { x: x + w / 2, y: baseY + tweak };
}

// ---------- Initial load ----------

loadPuzzle();
