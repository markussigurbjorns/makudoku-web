const puzzleContainer = document.getElementById("puzzle-container");
const statusEl = document.getElementById("status");
const reloadBtn = document.getElementById("reload");
const showSolutionBtn = document.getElementById("show-solution");
const solutionOutput = document.getElementById("solution-output");
const modeValueBtn = document.getElementById("mode-value");
const modeCandidateBtn = document.getElementById("mode-candidate");
const digitPad = document.querySelector(".digit-pad");

let currentSolution = [];

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

// ---------- Fetch & load puzzle ----------

async function loadPuzzle() {
  try {
    statusEl.textContent = "Loading puzzle…";
    puzzleContainer.innerHTML = "";
    selectedRects.clear();
    focusRect = null;
    setMode("value");

    const res = await fetch("/api/puzzle/today", {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error: ${res.status} ${text}`);
    }

    const data = await res.json(); // { svg: string, solution: number[] }

    puzzleContainer.innerHTML = data.svg;

    // Init interaction with the *new* SVG
    initSvgInteraction();

    currentSolution = Array.isArray(data.solution) ? data.solution : [];
    statusEl.textContent = "Puzzle loaded.";
    solutionOutput.textContent = "(hidden – press 'Show solution')";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Failed to load puzzle.";
    puzzleContainer.innerHTML =
      "<p>Something went wrong loading the puzzle. Try again.</p>";
  }
}

// ---------- Solution formatting ----------

function formatSolutionDigits(solutionArr) {
  if (!solutionArr || solutionArr.length === 0) {
    return "(no solution data)";
  }

  if (solutionArr.length === 81) {
    const rows = [];
    for (let r = 0; r < 9; r++) {
      const rowDigits = solutionArr
        .slice(r * 9, (r + 1) * 9)
        .map((d) => d.toString())
        .join(" ");
      rows.push(rowDigits);
    }
    return rows.join("\n");
  }

  return solutionArr.map((d) => d.toString()).join("");
}

// ---------- Wire up buttons ----------

reloadBtn.addEventListener("click", () => {
  loadPuzzle();
});

showSolutionBtn.addEventListener("click", () => {
  solutionOutput.textContent = formatSolutionDigits(currentSolution);
});

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

function handleDigitInput(value, isDelete) {
  if (!svg || !userLayer || !candLayer) return;
  if (!selectedRects.size) return;

  const valueToWrite = isDelete ? null : value;

  selectedRects.forEach((rect) => {
    const r = rect.dataset.row;
    const c = rect.dataset.col;
    const box = rect.dataset.box;

    // Do not allow overwriting givens
    const givenCells = new Set(
      Array.from(svg.querySelectorAll("#givens text.given")).map(
        (node) => `${node.dataset.row}-${node.dataset.col}`
      )
    );
    if (givenCells.has(`${r}-${c}`)) {
      return;
    }

    if (inputMode === "value") {
      // Remove any user digit already in this cell
      userLayer
        .querySelectorAll(`text[data-row="${r}"][data-col="${c}"]`)
        .forEach((n) => n.remove());

      if (valueToWrite) {
        const { x, y } = cellCenter(rect);
        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("class", "user");
        t.setAttribute("data-row", r);
        t.setAttribute("data-col", c);
        t.setAttribute("data-box", box);
        t.setAttribute("x", x);
        t.setAttribute("y", y);
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "middle");
        t.setAttribute("pointer-events", "none");
        t.textContent = valueToWrite;
        userLayer.appendChild(t);
      }

      // Clear candidates for that cell when writing a digit or deleting
      candLayer
        .querySelectorAll(
          `.cell-candidates[data-row="${r}"][data-col="${c}"] text.candidate`
        )
        .forEach((n) => (n.textContent = ""));
    } else if (inputMode === "candidate") {
      const candidatesGroup = candLayer.querySelector(
        `.cell-candidates[data-row="${r}"][data-col="${c}"]`
      );
      if (!candidatesGroup) return;

      if (isDelete) {
        candidatesGroup
          .querySelectorAll("text.candidate")
          .forEach((n) => (n.textContent = ""));
        return;
      }

      const targetCand = candidatesGroup.querySelector(
        `text.candidate[data-digit="${valueToWrite}"]`
      );
      if (targetCand) {
        targetCand.textContent =
          targetCand.textContent === "" ? valueToWrite : "";
      }
    }
  });
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

// ---------- SVG interaction ----------

function initSvgInteraction() {
  svg = puzzleContainer.querySelector("svg");
  if (!svg) {
    console.warn("No <svg> found inside #puzzle-container");
    return;
  }

  highlightLayer = svg.querySelector("#highlights");
  userLayer = svg.querySelector("#user-values");
  candLayer = svg.querySelector("#candidates");

  if (!highlightLayer) console.warn("Missing #highlights layer");
  if (!userLayer) console.warn("Missing #user-values layer");
  if (!candLayer) console.warn("Missing #candidates layer");

  const highlightCells = highlightLayer
    ? Array.from(highlightLayer.querySelectorAll("rect.highlight-cell"))
    : [];
  const givenCells = new Set(
    Array.from(svg.querySelectorAll("#givens text.given")).map(
      (node) => `${node.dataset.row}-${node.dataset.col}`
    )
  );

  const updateSelectionStyles = () => {
    highlightCells.forEach((rect) => {
      rect.classList.toggle("selected", selectedRects.has(rect));
    });
  };

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
    wasDragging = true;
    const rect = findRectAtPoint(event);
    if (rect && !selectedRects.has(rect)) {
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
      if (selectedRects.size === 1 && selectedRects.has(rect)) {
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

    const isDigit = /^[1-9]$/.test(e.key);
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
    handleDigitInput(isDigit ? e.key : null, isDelete);
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
