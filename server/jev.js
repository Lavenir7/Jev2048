/**
 * The Jev player.
 *
 * Design: code owns everything deterministic (legal moves, resulting boards,
 * scoring features, and the final action). Jev supplies the judgement:
 *   - one Choice question: "which move is best?"  (calibrated distribution over
 *     the legal moves, which is exactly "one of a defined set")
 *   - one Score question per legal move: "how good is this move for the
 *     long-term health of the board?" (comparable per-item grades)
 *
 * The final action is a code-controlled composite of the two signals, so the
 * decision weight can be tuned without changing the questions.
 */

import { choice, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { applyMove, boardMetrics, legalMoves } from "../shared/engine.js";

export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_CHOICE_WEIGHT = 0.6;
export const QUALITY_MAX = 4;

const QUALITY_LEVELS = [
  "Very bad: the move wrecks the position. It fills the board up, pushes the largest tile out of a corner, or scatters the ordering for no gain.",
  "Poor: playable but clearly worse than the alternatives. It gives up empty space, corner control, or ordering without a worthwhile merge.",
  "Fair: an acceptable move that neither clearly helps nor clearly hurts the long-term position.",
  "Good: keeps the board healthy. It preserves empty space and corner control, keeps tiles ordered and smooth, and creates useful merges.",
  "Excellent: the best available move. It maximises empty space and future merge potential while keeping the largest tile in a corner and the board monotonic.",
];

export function currentModel() {
  return (process.env.TYPESAFE_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

export function jevConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim());
}

/** Used when the live model list is unavailable. */
export const FALLBACK_MODELS = [
  { name: "jev-latest", description: "最新的稳定 Jev 版本（默认）" },
  { name: "jev-preview", description: "最新的 Jev 预览构建" },
  { name: "jev-1.13.0", description: "Jev 1.13.0（固定版本号）" },
];

export async function listModels() {
  const models = await getClient().models.list();
  return models.map((model) => ({
    name: model.name,
    description: model.description,
  }));
}

let client = null;
function getClient() {
  if (!client) client = new TypeSafeClient(); // reads TYPESAFE_API_KEY from the env
  return client;
}

function clamp(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CHOICE_WEIGHT;
  return Math.min(max, Math.max(min, value));
}

function describeCandidate(candidate) {
  const f = candidate.features;
  return [
    `resulting board ${JSON.stringify(candidate.resulting_board)}`,
    `gains ${candidate.gained_points} points from ${candidate.merge_count} merge(s)`,
    `leaves ${f.empty_cells}/16 empty cells`,
    `largest tile ${f.max_tile}${f.max_tile_in_corner ? " (in a corner)" : " (NOT in a corner)"}`,
    `${f.mergeable_adjacent_pairs} adjacent mergeable pair(s)`,
    `monotonicity ${f.monotonicity} (closer to 0 is better)`,
    `smoothness ${f.smoothness} (closer to 0 is better)`,
  ].join("; ");
}

/**
 * Ask Jev which move to play.
 *
 * @param {number[][]} board  4x4 board, 0 = empty
 * @param {{ weight?: number }} [options]
 * @returns {Promise<object>} decision payload for the client
 */
export async function chooseMove(board, options = {}) {
  const legal = legalMoves(board);

  if (legal.length === 0) {
    return { ok: false, error: "game-over", message: "没有可走的步了。" };
  }

  const features = boardMetrics(board);

  // A single legal move is a rule, not a judgement: answer it in code and save
  // the model call.
  if (legal.length === 1) {
    const move = legal[0];
    const result = applyMove(board, move);
    return {
      ok: true,
      source: "only-legal-move",
      move,
      model: null,
      choice: { choice: move, confidence: 1, probabilities: { [move]: 1 } },
      quality: { [move]: null },
      quality_max: QUALITY_MAX,
      composite: { [move]: 1 },
      weights: { choice: 1, quality: 0 },
      features,
      candidates: [
        {
          move,
          gained_points: result.gained,
          merge_count: result.merges,
          features: boardMetrics(result.board),
        },
      ],
      usage: null,
    };
  }

  const candidates = legal.map((move) => {
    const result = applyMove(board, move);
    return {
      move,
      resulting_board: result.board,
      gained_points: result.gained,
      merge_count: result.merges,
      features: boardMetrics(result.board),
    };
  });

  const choiceWeight = clamp(options.weight, 0, 1);
  const qualityWeight = 1 - choiceWeight;
  const model =
    typeof options.model === "string" && options.model.trim()
      ? options.model.trim()
      : currentModel();

  // Code-computed share of the board that a move controls: used as supporting
  // state, not as the decision.
  const state = {
    game: "2048 (4x4 grid, standard rules)",
    objective:
      "Keep merging equal tiles to grow the largest tile. The game ends when no move is possible. Play for long-term board health, not just for the largest immediate merge.",
    how_to_judge: [
      "Prefer moves that keep many empty cells, keep the largest tile in a corner, keep rows/columns ordered, and keep neighbouring tiles similar.",
      "Feature glossary: empty_cells higher is better; monotonicity and smoothness are <= 0 and closer to 0 is better; mergeable_adjacent_pairs is how many equal neighbours could merge later; max_tile_in_corner should stay true.",
      "A move that gains a few points but fills the board or drags the largest tile out of a corner is usually a mistake.",
    ],
    current_board: board,
    current_features: features,
    candidate_moves: candidates,
  };

  const questions = {
    best_move: choice(
      {
        task: "You are the 2048 player. Decide the single best move to play right now.",
        current_board: board,
        current_features: features,
        candidate_moves: candidates,
        question:
          "Which move from `candidate_moves` should be played next? Compare the `resulting_board` and `features` of each candidate and pick exactly one.",
      },
      Object.fromEntries(
        candidates.map((candidate) => [candidate.move, describeCandidate(candidate)]),
      ),
    ),
  };

  for (const candidate of candidates) {
    questions[`quality_${candidate.move}`] = score(
      {
        question: `How good is playing "${candidate.move}" in this position for the long-term health and growth of the board?`,
        current_board: board,
        current_features: features,
        candidate_move: candidate,
      },
      QUALITY_LEVELS,
    );
  }

  const response = await getClient().systemOne({
    state,
    questions,
    model,
  });

  const answers = response.answers || {};
  const choiceAnswer = answers.best_move;
  if (!choiceAnswer || choiceAnswer.type !== "choice") {
    throw new Error("Jev 没有返回 best_move 选择结果。");
  }

  const quality = {};
  for (const candidate of candidates) {
    const answer = answers[`quality_${candidate.move}`];
    quality[candidate.move] =
      answer && typeof answer.score === "number" ? answer.score : null;
  }

  const composite = {};
  for (const candidate of candidates) {
    const probability = choiceAnswer.probabilities?.[candidate.move] ?? 0;
    const grade = quality[candidate.move];
    const normalised = grade === null ? 0.5 : grade / QUALITY_MAX;
    composite[candidate.move] = choiceWeight * probability + qualityWeight * normalised;
  }

  const move = candidates
    .map((candidate) => candidate.move)
    .reduce((best, current) => (composite[current] > composite[best] ? current : best));

  return {
    ok: true,
    source: "jev",
    move,
    model: response.model || model,
    choice: {
      choice: choiceAnswer.choice,
      confidence: choiceAnswer.confidence,
      probabilities: choiceAnswer.probabilities,
    },
    quality,
    quality_max: QUALITY_MAX,
    composite,
    weights: { choice: choiceWeight, quality: qualityWeight },
    features,
    candidates: candidates.map((candidate) => ({
      move: candidate.move,
      gained_points: candidate.gained_points,
      merge_count: candidate.merge_count,
      features: candidate.features,
    })),
    usage: response.usage || null,
  };
}
