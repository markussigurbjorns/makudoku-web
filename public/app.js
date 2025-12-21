const puzzleContainer = document.getElementById("puzzle-container");
const svgRoot = document.getElementById("svg-root") || puzzleContainer;
const variantsEl = document.getElementById("variants");
const statusEl = document.getElementById("status");
const puzzleTitleEl = document.getElementById("puzzle-title");
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
let adminLastPuzzleJson = null;
let adminLastSvg = null;
let adminLastVariants = [];
let currentPuzzleDate = null;
let solvedForDate = false;
let checkInFlight = false;

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

const VARIANT_DESCRIPTIONS = {
  kropki_white: "White dots connect consecutive digits (difference of 1).",
  kropki_black: "Black dots connect digits in a 1:2 ratio.",
  thermo: "Thermo lines increase from bulb to tip.",
  arrow: "Digits along the arrow sum to the circle value.",
  killer: "Cages sum to the given total, no repeats in a cage.",
  king: "Kings cannot be a single square apart.",
  knight: "Knights cannot be a knight's move apart.",
  queen: "Queens cannot be a diagonal step apart.",
};

function isTypingInInput() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    el.isContentEditable
  );
}

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

function showHelpModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");

  const modal = document.createElement("div");
  modal.className = "modal";

  const h2 = document.createElement("h2");
  h2.textContent = "Puzzle help";

  const variantsTitle = document.createElement("h3");
  variantsTitle.textContent = "Variants";

  const variantsList = document.createElement("ul");
  variantsList.className = "help-list";

  const variantItems = Array.isArray(variants) ? variants : [];
  if (variantItems.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Classic sudoku rules only.";
    variantsList.appendChild(li);
  } else {
    variantItems.forEach((kind) => {
      const li = document.createElement("li");
      const label = formatVariantLabel(kind);
      const desc = VARIANT_DESCRIPTIONS[kind] || "Special constraint applies.";
      li.textContent = `${label}: ${desc}`;
      variantsList.appendChild(li);
    });
  }

  const numpadTitle = document.createElement("h3");
  numpadTitle.textContent = "Numpad";

  const numpadList = document.createElement("ul");
  numpadList.className = "help-list";
  [
    "Value mode: place digits in cells.",
    "Candidate mode: toggle pencil marks.",
    "Hold Shift to temporarily enter candidate mode.",
    "Multi-select: toggle multiple cells at once.",
    "Check: compare entries against the solution (if available).",
    "Undo/Redo: revert or reapply moves.",
    "Erase: clear values or candidates.",
    "Keyboard: 1-9 to enter, 0/Backspace/Delete to erase, arrows to move.",
  ].forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    numpadList.appendChild(li);
  });

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
  modal.appendChild(variantsTitle);
  modal.appendChild(variantsList);
  modal.appendChild(numpadTitle);
  modal.appendChild(numpadList);
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

function buildFullGridValues() {
  if (!currentState) return null;
  const values = Array(81).fill(null);

  const givens = svg?.querySelectorAll("#givens text.given") ?? [];
  givens.forEach((node) => {
    const r = Number(node.dataset.row);
    const c = Number(node.dataset.col);
    const text = node.textContent?.trim() || "";
    if (r >= 0 && c >= 0 && /^[1-9]$/.test(text)) {
      values[cellIndex(r, c)] = text;
    }
  });

  currentState.values.forEach((v, idx) => {
    if (v && /^[1-9]$/.test(v)) {
      values[idx] = v;
    }
  });

  return values;
}

function buildGridString() {
  const values = buildFullGridValues();
  if (!values) return null;
  return values.map((v) => (v && /^[1-9]$/.test(v) ? v : ".")).join("");
}

function isGridComplete() {
  const values = buildFullGridValues();
  if (!values) return false;
  return values.every((v) => v && /^[1-9]$/.test(v));
}

function maybeCheckSolved() {
  if (document.body.classList.contains("admin")) return;
  if (!currentPuzzleDate || solvedForDate || checkInFlight) return;
  if (!isGridComplete()) return;

  const grid = buildGridString();
  if (!grid) return;

  checkInFlight = true;
  fetch("/api/puzzle/check", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grid }),
  })
    .then((res) => (res.ok ? res.json() : Promise.reject(res)))
    .then((data) => {
      if (data?.status === "complete") {
        solvedForDate = true;
        saveProgress();
        showModal("Congratulations", "You solved today's puzzle!");
      }
    })
    .catch((err) => {
      console.warn("Auto-check failed", err);
    })
    .finally(() => {
      checkInFlight = false;
    });
}

function pushUndo(state) {
  undoStack.push(cloneState(state));
  if (undoStack.length > UNDO_LIMIT) {
    undoStack.shift();
  }
  redoStack = [];
  updateUndoRedoUi();
}

function storageKey() {
  if (!currentPuzzleDate) return null;
  return `makudoku-progress-${currentPuzzleDate}`;
}

function saveProgress() {
  if (document.body.classList.contains("admin")) return;
  const key = storageKey();
  if (!key || !currentState) return;
  const payload = {
    values: currentState.values,
    candidates: currentState.candidates,
    solved: solvedForDate,
  };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (err) {
    console.warn("Failed to save progress", err);
  }
}

function loadProgress() {
  solvedForDate = false;
  const key = storageKey();
  if (!key) return;
  const raw = localStorage.getItem(key);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      !Array.isArray(parsed.values) ||
      !Array.isArray(parsed.candidates)
    ) {
      return;
    }
    if (parsed.values.length !== 81 || parsed.candidates.length !== 81) {
      return;
    }
    currentState = {
      values: parsed.values.slice(),
      candidates: parsed.candidates.slice(),
    };
    solvedForDate = parsed.solved === true;
    applyStateToSvg(currentState);
    undoStack = [];
    redoStack = [];
    updateUndoRedoUi();
  } catch (err) {
    console.warn("Failed to load progress", err);
  }
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

function getPuzzleEndpoint() {
  const meta = document.querySelector('meta[name="puzzle-endpoint"]');
  const fromMeta = meta?.getAttribute("content")?.trim();
  const fromDataset = document.documentElement?.dataset?.puzzleEndpoint?.trim();
  if (fromMeta) return fromMeta;
  if (fromDataset) return fromDataset;
  // Defensive fallback: admin pages should default to random puzzles.
  if (window.location?.pathname?.startsWith("/admin")) return "/api/puzzle/random";
  return "/api/puzzle/today";
}

async function loadPuzzle() {
  try {
    statusEl.textContent = "Loading puzzle…";
    if (svgRoot) svgRoot.innerHTML = "";
    if (variantsEl) variantsEl.innerHTML = "";
    selectedRects.clear();
    focusRect = null;
    setMode("value");
    setMultiSelect(false);

    const endpoint = getPuzzleEndpoint();
    const usePost = endpoint.startsWith("/api/admin/puzzles/generate");
    const res = await fetch(endpoint, {
      method: usePost ? "POST" : "GET",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error: ${res.status} ${text}`);
    }

    const data = await res.json(); // { svg: string, solution: number[] }
    applyPuzzleData(data, "");
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

function extractSolution(data) {
  if (Array.isArray(data.solution) && data.solution.length === 81) {
    return data.solution.map((n) => String(n));
  }
  if (typeof data.puzzle_json === "string") {
    try {
      const parsed = JSON.parse(data.puzzle_json);
      if (Array.isArray(parsed.solution) && parsed.solution.length === 81) {
        return parsed.solution.map((n) => String(n));
      }
    } catch (err) {
      console.warn("Failed to parse puzzle_json for solution", err);
    }
  }
  return null;
}

function applyPuzzleData(data, message) {
  if (!data || !data.svg) {
    statusEl.textContent = "No puzzle data to display.";
    return;
  }

  if (svgRoot) svgRoot.innerHTML = data.svg;

  initSvgInteraction();
  initStateFromSvg();

  const solution = extractSolution(data);
  currentSolution = solution ? solution.map(Number) : [];
  solutionFlat = solution ?? null;

  variants = Array.isArray(data.variants) ? data.variants : [];
  renderVariants(variants);
  statusEl.textContent = message || "";
  if (puzzleTitleEl) {
    puzzleTitleEl.textContent = data.title || "";
  }

  if (document.body.classList.contains("admin")) {
    adminLastPuzzleJson = data.puzzle_json || null;
    adminLastSvg = data.svg || null;
    adminLastVariants = Array.isArray(data.variants) ? data.variants : [];
  } else {
    currentPuzzleDate = data.date_utc || null;
    loadProgress();
    if (currentPuzzleDate) {
      fetch("/api/puzzle/track", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ event: "view" }),
      }).catch((err) => console.warn("Track view failed", err));
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
  if (isTypingInInput()) return;
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
  if (isTypingInInput()) return;
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
  saveProgress();
  maybeCheckSolved();
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
  saveProgress();
}

function redo() {
  if (!redoStack.length || !currentState) return;
  undoStack.push(cloneState(currentState));
  currentState = redoStack.pop();
  applyStateToSvg(currentState);
  updateUndoRedoUi();
  if (updateSelectionStylesFn) updateSelectionStylesFn();
  saveProgress();
}

if (undoBtn) undoBtn.addEventListener("click", undo);
if (redoBtn) redoBtn.addEventListener("click", redo);

if (checkBtn) {
  checkBtn.addEventListener("click", () => {
    const grid = buildGridString();
    if (!grid) return;

    fetch("/api/puzzle/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grid }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Server error: ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        const status = data?.status;
        if (status === "complete") {
          showModal("Solved", "You completed the puzzle.");
        } else if (status === "partial") {
          showModal("Looks good", "Everything is looking correct so far.");
        } else if (status === "incorrect") {
          showModal("Not quite", "There is an error somewhere.");
        } else {
          showModal(
            "Check",
            "No solution is available right now, so I can't validate this puzzle."
          );
        }
      })
      .catch((err) => {
        console.error(err);
        showModal("Check failed", err.message || String(err));
      });
  });
}

const helpBtn = document.getElementById("help-btn");
if (helpBtn) {
  helpBtn.addEventListener("click", () => {
    showHelpModal();
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
    if (isTypingInInput()) return;
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

function initAdminTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = Array.from(document.querySelectorAll(".panel"));
  if (!tabs.length || !panels.length) return;

  const setActive = (tabId) => {
    tabs.forEach((tab) => {
      const isActive = tab.id === tabId;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
      const panelId = tab.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) panel.classList.toggle("active", isActive);
    });
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setActive(tab.id);
    });
  });
}

async function loadReviewPuzzle(date) {
  try {
    statusEl.textContent = "Loading puzzle…";
    const res = await fetch(`/api/admin/puzzles/${date}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Server error: ${res.status}`);
    }
    const data = await res.json();
    applyPuzzleData(data, "");
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Failed to load puzzle.";
    showModal("Load failed", err.message || String(err));
  }
}

function initAdminReviewPicker() {
  const dateInput = document.getElementById("review-date");
  const loadBtn = document.getElementById("review-load");
  if (!dateInput || !loadBtn) return;

  const today = new Date();
  if (!dateInput.value) {
    const utcDate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    );
    dateInput.value = utcDate.toISOString().slice(0, 10);
  }

  loadBtn.addEventListener("click", () => {
    if (!dateInput.value) {
      showModal("Missing date", "Please choose a UTC date to load.");
      return;
    }
    loadReviewPuzzle(dateInput.value);
  });
}

function initAdminAnalytics() {
  const dateInput = document.getElementById("analytics-date");
  const loadBtn = document.getElementById("analytics-load");
  const viewsEl = document.getElementById("stat-views");
  const checksEl = document.getElementById("stat-checks");
  const solvesEl = document.getElementById("stat-solves");
  if (!dateInput || !loadBtn) return;

  const today = new Date();
  if (!dateInput.value) {
    const utcDate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    );
    dateInput.value = utcDate.toISOString().slice(0, 10);
  }

  const loadStats = async () => {
    if (!dateInput.value) return;
    try {
      const res = await fetch(`/api/admin/stats/${dateInput.value}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Server error: ${res.status}`);
      }
      const data = await res.json();
      if (viewsEl) viewsEl.textContent = String(data.views ?? 0);
      if (checksEl) checksEl.textContent = String(data.checks ?? 0);
      if (solvesEl) solvesEl.textContent = String(data.solves ?? 0);
    } catch (err) {
      console.error(err);
      if (viewsEl) viewsEl.textContent = "0";
      if (checksEl) checksEl.textContent = "0";
      if (solvesEl) solvesEl.textContent = "0";
      showModal("Analytics failed", err.message || String(err));
    }
  };

  loadBtn.addEventListener("click", loadStats);
}
function parseConstraintsInput(raw) {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.constraints)) return parsed.constraints;
  throw new Error("Constraints must be a JSON array or object with constraints.");
}

function initAdminCustomForm() {
  const form = document.getElementById("custom-form");
  if (!form) return;

  const dateInput = document.getElementById("custom-date");
  const nameInput = document.getElementById("custom-name");
  const authorInput = document.getElementById("custom-author");
  const statusInput = document.getElementById("custom-status");
  const difficultyInput = document.getElementById("custom-difficulty");
  const cluesInput = document.getElementById("custom-clues");
  const seedInput = document.getElementById("custom-seed");
  const constraintsInput = document.getElementById("custom-constraints");
  const overwriteInput = document.getElementById("custom-overwrite");
  const generateBtn = document.getElementById("custom-generate");
  const saveBtn = document.getElementById("custom-save");
  const constraintType = document.getElementById("constraint-type");
  const constraintA = document.getElementById("constraint-a");
  const constraintB = document.getElementById("constraint-b");
  const constraintPath = document.getElementById("constraint-path");
  const constraintCells = document.getElementById("constraint-cells");
  const constraintSum = document.getElementById("constraint-sum");
  const constraintNoRepeats = document.getElementById("constraint-no-repeats");
  const constraintAdd = document.getElementById("constraint-add");
  const constraintLoad = document.getElementById("constraint-load");
  const constraintClear = document.getElementById("constraint-clear");
  const constraintList = document.getElementById("constraint-list");

  let lastPuzzleJson = null;
  let lastSvg = null;
  let lastVariants = [];
  let constraintItems = [];

  const today = new Date();
  if (dateInput && !dateInput.value) {
    const utcDate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    );
    dateInput.value = utcDate.toISOString().slice(0, 10);
  }

  const builderGroups = Array.from(
    document.querySelectorAll(".builder-group")
  );

  const setBuilderGroupVisibility = (value) => {
    const show = value || "kropki_white";
    builderGroups.forEach((group) => {
      const type = group.dataset.group;
      const shouldShow =
        (type === "pair" && (show === "kropki_white" || show === "kropki_black")) ||
        (type === "path" && (show === "thermo" || show === "arrow")) ||
        (type === "killer" && show === "killer");
      group.style.display = shouldShow ? "grid" : "none";
    });
  };

  setBuilderGroupVisibility(constraintType?.value);
  constraintType?.addEventListener("change", (event) => {
    setBuilderGroupVisibility(event.target.value);
  });

  const parseCell = (token) => {
    const parts = token.split(",").map((p) => p.trim());
    if (parts.length !== 2) throw new Error("Cell must be row,col");
    const r = Number(parts[0]);
    const c = Number(parts[1]);
    if (!Number.isFinite(r) || !Number.isFinite(c)) {
      throw new Error("Cell must be numeric row,col");
    }
    return [r, c];
  };

  const parseCells = (raw) => {
    const tokens = raw
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tokens.length) {
      throw new Error("Provide at least one cell");
    }
    return tokens.map(parseCell);
  };

  const renderConstraintList = () => {
    if (!constraintList) return;
    constraintList.innerHTML = "";
    if (!constraintItems.length) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "No constraints yet.";
      constraintList.appendChild(empty);
      return;
    }
    constraintItems.forEach((item, idx) => {
      const li = document.createElement("li");
      li.className = "constraint-item";

      const code = document.createElement("code");
      code.textContent = JSON.stringify(item);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Remove";
      btn.addEventListener("click", () => {
        constraintItems.splice(idx, 1);
        renderConstraintList();
        syncConstraintsTextarea();
      });

      li.appendChild(code);
      li.appendChild(btn);
      constraintList.appendChild(li);
    });
  };

  const syncConstraintsTextarea = () => {
    if (!constraintsInput) return;
    constraintsInput.value = JSON.stringify(constraintItems, null, 2);
  };

  const loadConstraintsFromTextarea = () => {
    if (!constraintsInput) return;
    let parsed;
    try {
      parsed = parseConstraintsInput(constraintsInput.value.trim());
    } catch (err) {
      showModal("Invalid JSON", err.message || String(err));
      return;
    }
    if (!Array.isArray(parsed)) {
      showModal("Invalid constraints", "Constraints must be a JSON array.");
      return;
    }
    constraintItems = parsed;
    renderConstraintList();
  };

  constraintAdd?.addEventListener("click", () => {
    const type = constraintType?.value || "kropki_white";
    try {
      let item = null;
      if (type === "kropki_white" || type === "kropki_black") {
        const a = parseCell(constraintA?.value?.trim() || "");
        const b = parseCell(constraintB?.value?.trim() || "");
        item = { type, a, b };
      } else if (type === "thermo" || type === "arrow") {
        const path = parseCells(constraintPath?.value?.trim() || "");
        item = { type, path };
      } else if (type === "killer") {
        const cells = parseCells(constraintCells?.value?.trim() || "");
        const sum = Number(constraintSum?.value ?? "");
        if (!Number.isFinite(sum)) {
          throw new Error("Killer sum must be a number");
        }
        item = {
          type,
          cells,
          sum,
          no_repeats: constraintNoRepeats?.checked ?? true,
        };
      } else {
        item = { type };
      }

      constraintItems.push(item);
      renderConstraintList();
      syncConstraintsTextarea();
    } catch (err) {
      showModal("Invalid constraint", err.message || String(err));
    }
  });

  constraintLoad?.addEventListener("click", () => {
    loadConstraintsFromTextarea();
    syncConstraintsTextarea();
  });

  constraintClear?.addEventListener("click", () => {
    constraintItems = [];
    renderConstraintList();
    syncConstraintsTextarea();
  });

  loadConstraintsFromTextarea();
  syncConstraintsTextarea();

  generateBtn?.addEventListener("click", async () => {
    if (!constraintsInput) return;
    let constraints;
    try {
      constraints = parseConstraintsInput(constraintsInput.value.trim());
    } catch (err) {
      showModal("Invalid constraints", err.message || String(err));
      return;
    }

    const clueTarget = Number.parseInt(cluesInput?.value ?? "", 10);
    const seedValue = Number.parseInt(seedInput?.value ?? "", 10);

    const payload = {
      constraints,
      clue_target: Number.isFinite(clueTarget) ? clueTarget : undefined,
      seed: Number.isFinite(seedValue) ? seedValue : undefined,
    };

    try {
      statusEl.textContent = "Generating puzzle…";
      const res = await fetch("/api/admin/puzzles/generate/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Server error: ${res.status}`);
      }
      const data = await res.json();
      lastPuzzleJson = data.puzzle_json || null;
      lastSvg = data.svg || null;
      lastVariants = Array.isArray(data.variants) ? data.variants : [];
      applyPuzzleData(data, "Custom puzzle generated.");
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Failed to generate puzzle.";
      showModal("Generate failed", err.message || String(err));
    }
  });

  saveBtn?.addEventListener("click", async () => {
    if (!lastPuzzleJson || !lastSvg) {
      showModal("Nothing to save", "Generate a puzzle first.");
      return;
    }
    if (!dateInput?.value) {
      showModal("Missing date", "Please choose a UTC date to save.");
      return;
    }

    const difficultyValue = Number.parseInt(difficultyInput?.value ?? "", 10);

    const payload = {
      date_utc: dateInput.value,
      puzzle_json: lastPuzzleJson,
      svg: lastSvg,
      variants: lastVariants,
      name: nameInput?.value?.trim() || null,
      author: authorInput?.value?.trim() || null,
      status: statusInput?.value || "draft",
      difficulty: Number.isFinite(difficultyValue) ? difficultyValue : null,
      overwrite: overwriteInput?.checked ?? true,
    };

    try {
      statusEl.textContent = "Saving puzzle…";
      const res = await fetch("/api/admin/puzzles", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Server error: ${res.status}`);
      }
      await res.json();
      statusEl.textContent = "Puzzle saved.";
      showModal("Saved", "Puzzle stored successfully.");
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Failed to save puzzle.";
      showModal("Save failed", err.message || String(err));
    }
  });
}

function initAdminRandomPublish() {
  const dateInput = document.getElementById("random-date");
  const nameInput = document.getElementById("random-name");
  const authorInput = document.getElementById("random-author");
  const statusInput = document.getElementById("random-status");
  const difficultyInput = document.getElementById("random-difficulty");
  const overwriteInput = document.getElementById("random-overwrite");
  const publishBtn = document.getElementById("random-publish");

  if (!publishBtn) return;

  const today = new Date();
  if (dateInput && !dateInput.value) {
    const utcDate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    );
    dateInput.value = utcDate.toISOString().slice(0, 10);
  }

  publishBtn.addEventListener("click", async () => {
    if (!adminLastPuzzleJson || !adminLastSvg) {
      showModal("Nothing to save", "Generate a puzzle first.");
      return;
    }
    if (!dateInput?.value) {
      showModal("Missing date", "Please choose a UTC date to save.");
      return;
    }

    const difficultyValue = Number.parseInt(difficultyInput?.value ?? "", 10);
    const payload = {
      date_utc: dateInput.value,
      puzzle_json: adminLastPuzzleJson,
      svg: adminLastSvg,
      variants: adminLastVariants,
      name: nameInput?.value?.trim() || null,
      author: authorInput?.value?.trim() || null,
      status: statusInput?.value || "published",
      difficulty: Number.isFinite(difficultyValue) ? difficultyValue : null,
      overwrite: overwriteInput?.checked ?? true,
    };

    try {
      statusEl.textContent = "Saving puzzle…";
      const res = await fetch("/api/admin/puzzles", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Server error: ${res.status}`);
      }
      await res.json();
      statusEl.textContent = "Puzzle saved.";
      showModal("Saved", "Puzzle stored successfully.");
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Failed to save puzzle.";
      showModal("Save failed", err.message || String(err));
    }
  });
}

loadPuzzle();

if (document.body.classList.contains("admin")) {
  initAdminTabs();
  initAdminCustomForm();
  initAdminRandomPublish();
  initAdminReviewPicker();
  initAdminAnalytics();
}
