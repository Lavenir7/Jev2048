import assert from "node:assert/strict";

import {
  applyMove,
  boardMetrics,
  createEmptyBoard,
  isGameOver,
  legalMoves,
  moveTiles,
  slideLine,
  tilesToBoard,
  validateBoard,
} from "../shared/engine.js";

/* slideLine ---------------------------------------------------------- */

assert.deepEqual(slideLine([2, 2, 0, 0]).line, [4, 0, 0, 0]);
assert.equal(slideLine([2, 2, 0, 0]).gained, 4);
assert.equal(slideLine([2, 2, 0, 0]).merges, 1);

assert.deepEqual(slideLine([2, 2, 2, 2]).line, [4, 4, 0, 0]);
assert.equal(slideLine([2, 2, 2, 2]).merges, 2);

assert.deepEqual(slideLine([4, 4, 2, 2]).line, [8, 4, 0, 0]);
assert.deepEqual(slideLine([2, 0, 0, 2]).line, [4, 0, 0, 0]);
assert.deepEqual(slideLine([0, 0, 0, 0]).line, [0, 0, 0, 0]);

/* applyMove ---------------------------------------------------------- */

const board = [
  [2, 0, 0, 2],
  [0, 0, 0, 0],
  [4, 4, 0, 0],
  [0, 2, 0, 2],
];

assert.deepEqual(applyMove(board, "left").board, [
  [4, 0, 0, 0],
  [0, 0, 0, 0],
  [8, 0, 0, 0],
  [4, 0, 0, 0],
]);

assert.deepEqual(applyMove(board, "right").board, [
  [0, 0, 0, 4],
  [0, 0, 0, 0],
  [0, 0, 0, 8],
  [0, 0, 0, 4],
]);

assert.deepEqual(applyMove(board, "up").board, [
  [2, 4, 0, 4],
  [4, 2, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
]);

assert.equal(applyMove(board, "left").moved, true);
assert.equal(
  applyMove(
    [
      [2, 4, 8, 16],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    "left",
  ).moved,
  false,
);

/* legalMoves / game over -------------------------------------------- */

assert.deepEqual(legalMoves(createEmptyBoard()), []);
assert.deepEqual(
  legalMoves([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]).sort(),
  ["down", "right"],
);

const dead = [
  [2, 4, 2, 4],
  [4, 2, 4, 2],
  [2, 4, 2, 4],
  [4, 2, 4, 2],
];
assert.equal(isGameOver(dead), true);

/* moveTiles must agree with applyMove ------------------------------- */

const tiles = [];
let id = 1;
for (let r = 0; r < 4; r += 1) {
  for (let c = 0; c < 4; c += 1) {
    if (board[r][c]) tiles.push({ id: id++, value: board[r][c], r, c });
  }
}

for (const move of ["up", "down", "left", "right"]) {
  const res = moveTiles(tiles, move);
  const committed = res.tiles.map((t) => ({
    ...t,
    value: t.pendingValue ?? t.value,
    pendingValue: undefined,
  }));
  assert.deepEqual(
    tilesToBoard(committed),
    applyMove(board, move).board,
    `moveTiles / applyMove disagree on "${move}"`,
  );
  assert.equal(res.gained, applyMove(board, move).gained);
}

/* validateBoard ------------------------------------------------------ */

assert.equal(validateBoard(createEmptyBoard()), true);
assert.equal(validateBoard(board), true);
assert.equal(validateBoard([[3, 0, 0, 0]]), false);
assert.equal(validateBoard([[2, 0, 0]]), false);
assert.equal(validateBoard("nope"), false);

/* boardMetrics ------------------------------------------------------- */

const metrics = boardMetrics([
  [64, 32, 16, 8],
  [4, 2, 0, 0],
  [0, 0, 0, 0],
  [0, 2, 0, 0],
]);
assert.equal(metrics.empty_cells, 9);
assert.equal(metrics.max_tile, 64);
assert.equal(metrics.max_tile_in_corner, true);
assert.ok(metrics.monotonicity <= 0);
assert.ok(metrics.smoothness <= 0);

console.log("engine tests passed ✓");
