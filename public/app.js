const puzzleContainer = document.getElementById("puzzle-container");
const statusEl = document.getElementById("status");
const reloadBtn = document.getElementById("reload");
const showSolutionBtn = document.getElementById("show-solution");
const solutionOutput = document.getElementById("solution-output");

let currentSolution = [];

// SVG-related refs (updated after we insert the SVG)
let svg = null;
let highlightLayer = null;
let userLayer = null;
let candLayer = null;
let selected = null;

// ---------- Fetch & load puzzle ----------

async function loadPuzzle() {
  try {
    statusEl.textContent = "Loading puzzle…";
    puzzleContainer.innerHTML = "";
    selected = null;

    const res = await fetch("/api/puzzle/today", {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error: ${res.status} ${text}`);
    }

    const data = await res.json(); // { svg: string, solution: number[] }

    // Inject SVG into DOM
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

  // Attach click listeners to each highlight rect
  if (highlightLayer) {
    highlightLayer
      .querySelectorAll("rect.highlight-cell")
      .forEach((rect) => {
        rect.addEventListener("click", () => {
          // Clear previous selection
          highlightLayer
            .querySelectorAll("rect.highlight-cell.selected")
            .forEach((r) => r.classList.remove("selected"));

          rect.classList.add("selected");
          selected = {
            r: +rect.dataset.row,
            c: +rect.dataset.col,
            box: +rect.dataset.box,
            rect,
          };
        });
      });
  }
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

// Key handler (digits 1-9) – attach ONCE
document.addEventListener("keydown", (e) => {
  if (!selected) return;
  if (!/^[1-9]$/.test(e.key)) return;
  if (!userLayer || !candLayer) return;

  const { r, c, box, rect } = selected;

  // Remove any user digit already in this cell
  userLayer
    .querySelectorAll(`text[data-row="${r}"][data-col="${c}"]`)
    .forEach((n) => n.remove());

  // Add new digit
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
  t.textContent = e.key;
  userLayer.appendChild(t);

  // Clear candidates for that cell
  candLayer
    .querySelectorAll(
      `.cell-candidates[data-row="${r}"][data-col="${c}"] text.candidate`
    )
    .forEach((n) => (n.textContent = ""));
});

// ---------- Initial load ----------

loadPuzzle();
