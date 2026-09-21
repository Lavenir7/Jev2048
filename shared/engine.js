/**
 * Shared 2048 engine.
 *
 * Pure functions only. Imported by the browser client (for rendering, manual
 * play and local rules) and by the Node server (for legal-move enumeration and
 * the deterministic features that are handed to Jev).
 */

export const SIZE = 4;
export const MOVES = ["up", "down", "left", "right"];

export const ARROWS = { up: "↑", down: "↓", left: "←", right: "→" };

const CORNERS = [
  [0, 0],
  [0, SIZE - 1],
  [SIZE - 1, 0],
  [SIZE - 1, SIZE - 1],
];

export function createEmptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

function isPowerOfTwo(value) {
  return value >= 2 && Number.isInteger(Math.log2(value));
}

export function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== SIZE) return false;
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== SIZE) return false;
    for (const value of row) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
      if (value !== 0 && !isPowerOfTwo(value)) return false;
    }
  }
  return true;
}

/**
 * Collapse one line (already ordered in the direction of travel).
 * Returns the resulting line, the points gained and how many merges happened.
 */
export function slideLine(line) {
  const compact = line.filter((value) => value !== 0);
  const result = [];
  let gained = 0;
  let merges = 0;

  for (let i = 0; i < compact.length; i += 1) {
    if (i + 1 < compact.length && compact[i] === compact[i + 1]) {
      const merged = compact[i] * 2;
      result.push(merged);
      gained += merged;
      merges += 1;
      i += 1;
    } else {
      result.push(compact[i]);
    }
  }

  while (result.length < SIZE) result.push(0);
  return { line: result, gained, merges };
}

/** Apply a move to a numeric board. Always returns a fresh board. */
export function applyMove(board, move) {
  const next = createEmptyBoard();
  let gained = 0;
  let merges = 0;
  let moved = false;

  if (move === "left" || move === "right") {
    for (let r = 0; r < SIZE; r += 1) {
      const row = board[r];
      const ordered = move === "left" ? row : row.slice().reverse();
      const res = slideLine(ordered);
      const line = move === "left" ? res.line : res.line.slice().reverse();
      next[r] = line;
      gained += res.gained;
      merges += res.merges;
      for (let c = 0; c < SIZE; c += 1) if (line[c] !== row[c]) moved = true;
    }
  } else {
    for (let c = 0; c < SIZE; c += 1) {
      const column = [];
      for (let r = 0; r < SIZE; r += 1) column.push(board[r][c]);
      const ordered = move === "up" ? column : column.slice().reverse();
      const res = slideLine(ordered);
      const line = move === "up" ? res.line : res.line.slice().reverse();
      for (let r = 0; r < SIZE; r += 1) next[r][c] = line[r];
      gained += res.gained;
      merges += res.merges;
      for (let r = 0; r < SIZE; r += 1) if (line[r] !== column[r]) moved = true;
    }
  }

  return { board: next, gained, merges, moved };
}

export function legalMoves(board) {
  return MOVES.filter((move) => applyMove(board, move).moved);
}

export function isGameOver(board) {
  return legalMoves(board).length === 0;
}

export function tilesToBoard(tiles) {
  const board = createEmptyBoard();
  for (const tile of tiles) board[tile.r][tile.c] = tile.value;
  return board;
}

/**
 * Tile-level move used by the UI so tiles can be animated by identity.
 * Tiles are plain objects: { id, value, r, c }.
 *
 * Returns the surviving tiles (with final positions and, for merges, the new
 * value in `pendingValue`), the tiles absorbed by a merge (kept briefly so they
 * can slide into place), the points gained and whether anything moved.
 */
export function moveTiles(tiles, move) {
  const grid = createEmptyBoard();
  for (const tile of tiles) grid[tile.r][tile.c] = tile;

  const lines = [];
  if (move === "left" || move === "right") {
    for (let r = 0; r < SIZE; r += 1) {
      lines.push(
        Array.from({ length: SIZE }, (_, i) => [r, move === "left" ? i : SIZE - 1 - i]),
      );
    }
  } else {
    for (let c = 0; c < SIZE; c += 1) {
      lines.push(
        Array.from({ length: SIZE }, (_, i) => [move === "up" ? i : SIZE - 1 - i, c]),
      );
    }
  }

  const nextTiles = [];
  const doomed = [];
  let gained = 0;
  let merges = 0;
  let moved = false;

  for (const coords of lines) {
    const line = coords.map(([r, c]) => grid[r][c]).filter(Boolean);
    let write = 0;
    let i = 0;

    while (i < line.length) {
      const a = line[i];
      const b = line[i + 1];
      const [r, c] = coords[write];

      if (b && a.value === b.value) {
        const merged = a.value * 2;
        gained += merged;
        merges += 1;
        if (a.r !== r || a.c !== c) moved = true;
        if (b.r !== r || b.c !== c) moved = true;
        nextTiles.push({ id: a.id, value: a.value, r, c, pendingValue: merged });
        doomed.push({ id: b.id, value: b.value, r, c, pendingValue: null });
        write += 1;
        i += 2;
      } else {
        if (a.r !== r || a.c !== c) moved = true;
        nextTiles.push({ id: a.id, value: a.value, r, c, pendingValue: null });
        write += 1;
        i += 1;
      }
    }
  }

  return { tiles: nextTiles, doomed, gained, merges, moved };
}

/* ------------------------------------------------------------------ */
/* Deterministic features. Code owns the arithmetic; Jev reads the      */
/* numbers and supplies the judgement.                                  */
/* ------------------------------------------------------------------ */

const log2 = (value) => (value > 0 ? Math.log2(value) : 0);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Ordering quality: how monotonic the rows and columns are.
 * <= 0, and closer to 0 is better.
 */
function monotonicity(board) {
  let total = 0;

  for (let r = 0; r < SIZE; r += 1) {
    let up = 0;
    let down = 0;
    for (let c = 0; c < SIZE - 1; c += 1) {
      const a = log2(board[r][c]);
      const b = log2(board[r][c + 1]);
      if (a > b) down += b - a;
      else up += a - b;
    }
    total += Math.max(up, down);
  }

  for (let c = 0; c < SIZE; c += 1) {
    let up = 0;
    let down = 0;
    for (let r = 0; r < SIZE - 1; r += 1) {
      const a = log2(board[r][c]);
      const b = log2(board[r + 1][c]);
      if (a > b) down += b - a;
      else up += a - b;
    }
    total += Math.max(up, down);
  }

  return total;
}

/** How similar neighbouring tiles are. <= 0, closer to 0 is smoother. */
function smoothness(board) {
  let total = 0;
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const value = board[r][c];
      if (!value) continue;
      if (c + 1 < SIZE && board[r][c + 1]) {
        total -= Math.abs(log2(value) - log2(board[r][c + 1]));
      }
      if (r + 1 < SIZE && board[r + 1][c]) {
        total -= Math.abs(log2(value) - log2(board[r + 1][c]));
      }
    }
  }
  return total;
}

function adjacentEqualPairs(board) {
  let count = 0;
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const value = board[r][c];
      if (!value) continue;
      if (c + 1 < SIZE && board[r][c + 1] === value) count += 1;
      if (r + 1 < SIZE && board[r + 1][c] === value) count += 1;
    }
  }
  return count;
}

export function boardMetrics(board) {
  const flat = board.flat();
  const emptyCells = flat.filter((value) => value === 0).length;
  const maxTile = flat.reduce((a, b) => Math.max(a, b), 0);

  const maxPositions = [];
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (board[r][c] === maxTile) maxPositions.push([r, c]);
    }
  }

  const inCorner = maxPositions.some(([r, c]) =>
    CORNERS.some(([cr, cc]) => cr === r && cc === c),
  );

  return {
    empty_cells: emptyCells,
    max_tile: maxTile,
    max_tile_in_corner: inCorner,
    max_tile_positions: maxPositions.map(([r, c]) => `row ${r + 1}, column ${c + 1}`),
    mergeable_adjacent_pairs: adjacentEqualPairs(board),
    monotonicity: round2(monotonicity(board)),
    smoothness: round2(smoothness(board)),
    sum_of_tiles: flat.reduce((a, b) => a + b, 0),
  };
}
