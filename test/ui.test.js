/**
 * Integration smoke test for the two-board UI.
 *
 * Runs public/app.js inside a jsdom document with a stubbed fetch, so the real
 * controller / sync / race wiring is exercised without a browser or API key.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JSDOM } from "jsdom";

import { legalMoves } from "../shared/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/* ---------------- DOM + globals ---------------- */

const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;

/* ---------------- stubbed API ---------------- */

const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

let jevCalls = 0;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/api/status")) {
    return json({ jev: true, model: "jev-latest", defaultChoiceWeight: 0.6 });
  }
  if (u.endsWith("/api/models")) {
    return json({
      models: [{ name: "jev-latest" }, { name: "jev-1.13.0" }],
      source: "fallback",
    });
  }
  if (u.endsWith("/api/jev-move")) {
    jevCalls += 1;
    const body = JSON.parse(init.body);
    const legal = legalMoves(body.board);
    assert.ok(legal.length > 0, "the UI must only ask Jev when a move exists");
    const move = legal[0];
    const probabilities = {};
    for (const candidate of legal) {
      probabilities[candidate] = candidate === move ? 0.7 : 0.3 / Math.max(1, legal.length - 1);
    }
    return json({
      ok: true,
      source: "jev",
      move,
      model: "jev-1.13.0",
      choice: { choice: move, confidence: 0.7, probabilities },
      quality: Object.fromEntries(legal.map((m) => [m, m === move ? 4 : 2])),
      quality_max: 4,
      composite: Object.fromEntries(legal.map((m) => [m, 0.7])),
      weights: { choice: 0.6, quality: 0.4 },
      features: {},
      candidates: [],
      usage: { input_tokens: 10, output_tokens: 2 },
      latency_ms: 5,
    });
  }
  return json({ ok: false, message: `unexpected fetch ${u}` }, 404);
};

// Deterministic spawns.
Math.random = () => 0.5;

/* ---------------- load the app ---------------- */

const source = fs.readFileSync(path.join(root, "public", "app.js"), "utf8").replace(
  '"/shared/engine.js"',
  JSON.stringify(pathToFileURL(path.join(root, "shared", "engine.js")).href),
);
const tempFile = path.join(os.tmpdir(), `jev2048-app-${process.pid}.mjs`);
fs.writeFileSync(tempFile, source);
await import(pathToFileURL(tempFile).href);
fs.unlinkSync(tempFile);

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const sides = [...document.querySelectorAll(".side")];
assert.equal(sides.length, 2, "expected two boards");
const [left, right] = sides;

const activeController = (side) =>
  side.querySelector('.seg-btn[data-controller].active')?.dataset.controller;
const stepsOf = (side) => Number(side.querySelector(".steps").textContent);
const tileCount = (side) => side.querySelectorAll(".tile").length;
const click = (selector) => document.querySelector(selector).click();

await flush(20); // let /api/status + /api/models resolve

/* ---------------- initial state ---------------- */

assert.equal(activeController(left), "human", "left defaults to 玩家");
assert.equal(activeController(right), "jev", "right defaults to Jev");
assert.equal(tileCount(left), 2, "each board starts with two tiles");
assert.equal(tileCount(right), 2);
assert.equal(left.querySelector(".side-config").hidden, true, "human side hides Jev config");
assert.equal(right.querySelector(".side-config").hidden, false, "Jev side shows its config");
assert.equal(left.querySelector(".side-help").hidden, false, "human side shows the controls panel");
assert.equal(right.querySelector(".side-help").hidden, true, "Jev side hides the controls panel");

// Score row keeps only 得分 / 步数; 最高 moved into a dark bubble next to the status.
assert.deepEqual(
  [...left.querySelectorAll(".side-scores .score-box span")].map((el) => el.textContent),
  ["得分", "步数"],
  "score row only keeps 得分 / 步数",
);
assert.ok(
  right.querySelector(".side-title + .best-bubble"),
  "best score sits in a bubble right of the title/status",
);
assert.match(
  right.querySelector(".best-bubble .best").textContent,
  /^\d+$/,
  "best bubble renders the number",
);

// Slider tracks show a gradient fill up to the thumb (driven by --fill).
const weightSlider = right.querySelector(".weight");
assert.equal(
  weightSlider.style.getPropertyValue("--fill"),
  "60%",
  "weight slider fill matches its value",
);
weightSlider.value = "25";
weightSlider.dispatchEvent(new dom.window.Event("input"));
assert.equal(
  weightSlider.style.getPropertyValue("--fill"),
  "25%",
  "weight slider fill updates while dragging",
);
const delaySlider = right.querySelector(".delay");
delaySlider.value = "3000";
delaySlider.dispatchEvent(new dom.window.Event("input"));
assert.equal(delaySlider.style.getPropertyValue("--fill"), "100%");
// restore defaults so later assertions behave
weightSlider.value = "60";
weightSlider.dispatchEvent(new dom.window.Event("input"));
delaySlider.value = "800";
delaySlider.dispatchEvent(new dom.window.Event("input"));
assert.equal(right.querySelector(".dpad").hidden, true, "Jev side hides the d-pad");
assert.equal(left.querySelector(".dpad").hidden, false, "human side shows the d-pad");

// Dashboard layout: the config / help panels and the game screen are all grid
// items, and the game screens share a row so both boards line up.
const sideChildren = (side) => [...side.children];
for (const side of [left, right]) {
  const kids = sideChildren(side);
  assert.equal(kids.length, 3, "side has config / main / help");
  assert.ok(kids[0].classList.contains("side-config"), "first grid item is the config panel");
  assert.ok(kids[1].classList.contains("side-main"), "second grid item is the game screen");
  assert.ok(kids[2].classList.contains("side-help"), "third grid item is the help panel");
}
assert.equal(
  left.querySelector(".board-wrap").closest(".side-main") !== null,
  true,
  "the board lives in the game screen",
);

/* ---------------- manual move triggers sync ---------------- */

let moved = false;
for (const move of ["left", "right", "up", "down"]) {
  if (stepsOf(left) > 0) break;
  left.querySelector(`.dpad-btn[data-move="${move}"]`).click();
  await flush(600);
  moved = stepsOf(left) > 0;
  if (moved) break;
}
assert.equal(moved, true, "a manual move should land on the left board");
assert.match(
  left.querySelector(".best-bubble .best").textContent,
  /^\d+$/,
  "best bubble still renders after a move",
);

await flush(1200); // human move -> sync -> Jev reply
assert.ok(stepsOf(right) >= 1, "a human move should make the Jev side move once in sync mode");
assert.ok(jevCalls >= 1, "the Jev side should have called the API");
assert.ok(
  right.querySelector(".decision") !== null,
  "the Jev decision should be shown in the log",
);

// Decision block layout: model bubble top-right (left of 把握度), latency/token
// bubbles bottom-right, and "choice% · score" merged on each direction row.
const decision = right.querySelector(".decision");
assert.equal(
  decision.querySelector(".decision-right .model-bubble").textContent,
  "jev-1.13.0",
  "the model name sits in a bubble at the top of the block",
);
const modelBubble = decision.querySelector(".decision-right .model-bubble");
const conf = decision.querySelector(".decision-right .conf");
assert.ok(
  modelBubble.compareDocumentPosition(conf) & 4,
  "the model bubble is placed left of the confidence (把握度)",
);
assert.equal(
  decision.querySelector(".decision-meta"),
  null,
  "the old merged meta line is gone",
);
const barVals = [...decision.querySelectorAll(".bar-val")].map((el) => el.textContent);
assert.ok(
  barVals.length >= 2 && barVals.every((t) => /^\d+% · \d+\.\d{2}$/.test(t)),
  `each direction row shows choice% · score, got ${JSON.stringify(barVals)}`,
);
const foot = [...decision.querySelectorAll(".decision-foot .bubble")].map((el) => el.textContent);
assert.deepEqual(
  foot,
  ["0.0s", "12 tok"],
  "latency and token consumption sit in bubbles at the bottom right",
);

/* ---------------- race mode ---------------- */

click('[data-mode="race"]');
assert.equal(
  document.querySelector("#primary-action").textContent,
  "开始竞速",
  "race mode offers a start button",
);

click("#primary-action");
await flush(1400);
const afterStart = stepsOf(right);
assert.ok(afterStart > 1, "race mode keeps making Jev moves");

click("#primary-action");
await flush(400);
assert.equal(
  document.querySelector("#primary-action").textContent,
  "开始竞速",
  "stop returns the button to 开始竞速",
);
const afterStop = stepsOf(right);
await flush(700);
assert.equal(stepsOf(right), afterStop, "no more Jev moves after stopping the race");

/* ---------------- per-side configuration is independent ---------------- */

left.querySelector('.seg-btn[data-controller="jev"]').click();
await flush(20);
assert.equal(activeController(left), "jev", "left can be switched to Jev");
assert.equal(left.querySelector(".side-config").hidden, false);
assert.equal(left.querySelector(".side-help").hidden, true);

const leftModel = left.querySelector(".model-select");
const rightModel = right.querySelector(".model-select");
assert.ok(leftModel.options.length >= 2, "model picker is populated");
leftModel.value = "jev-1.13.0";
leftModel.dispatchEvent(new dom.window.Event("change"));
rightModel.value = "jev-latest";
rightModel.dispatchEvent(new dom.window.Event("change"));
assert.equal(leftModel.value, "jev-1.13.0");
assert.equal(rightModel.value, "jev-latest");
assert.notEqual(leftModel, rightModel, "each side has its own model picker");

console.log("ui tests passed ✓");
process.exit(0);
