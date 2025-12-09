
const puzzleContainer = document.getElementById("puzzle-container");
const statusEl = document.getElementById("status");
const reloadBtn = document.getElementById("reload");
const showSolutionBtn = document.getElementById("show-solution");
const solutionOutput = document.getElementById("solution-output");

let currentSolution = [];

// Fetch puzzle JSON from your Rust API
async function loadPuzzle() {
  try {
    statusEl.textContent = "Loading puzzle…";
    puzzleContainer.innerHTML = "";

    const res = await fetch("/api/puzzle/today", {
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error: ${res.status} ${text}`);
    }

    const data = await res.json();
    // data: { svg: string, solution: number[] }

    // Inject SVG into DOM
    puzzleContainer.innerHTML = data.svg;

    // Save solution (Vec<u8> mapped to JS number[])
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

// Turn the Vec<u8> into something readable
function formatSolutionDigits(solutionArr) {
  if (!solutionArr || solutionArr.length === 0) {
    return "(no solution data)";
  }

  // If it's a flat 81-digit sudoku solution, group by 9 per row
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

  // Fallback: just print them all in one line
  return solutionArr.map((d) => d.toString()).join("");
}

// Wire up buttons
reloadBtn.addEventListener("click", () => {
  loadPuzzle();
});

// Show solution in the <pre>
showSolutionBtn.addEventListener("click", () => {
  solutionOutput.textContent = formatSolutionDigits(currentSolution);
});

// Initial load
loadPuzzle();

