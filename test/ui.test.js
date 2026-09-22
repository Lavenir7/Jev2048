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
// When set, the next JeV reply is parked so a test can land it after a restart.
let holdJev = false;
let releaseJev = null;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/api/status")) {
    return json({ jev: true, model: "jev-latest", pricePerMtok: 0.042, defaultChoiceWeight: 0.6 });
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
    const payload = json({
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
      usage: { input_tokens: 4877, output_tokens: 92 },
      cost_usd: (4877 / 1e6) * 0.042,
      latency_ms: 5,
    });
    if (holdJev) {
      return new Promise((resolve) => {
        releaseJev = () => resolve(payload);
      });
    }
    return payload;
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
// 竞速-only settings: [出手间隔, 步数上限] — their hidden flags, in DOM order.
const raceFieldsHidden = (side) =>
  [...side.querySelectorAll(".race-only")].map((field) => field.hidden);

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

// 出手间隔 / 步数上限 only matter while racing, and the default mode is 同步.
assert.deepEqual(
  raceFieldsHidden(right),
  [true, true],
  "同步模式 hides 出手间隔 / 步数上限",
);
assert.equal(
  right.querySelector(".model-select").closest(".field").hidden,
  false,
  "模型 is not race-only",
);
assert.equal(
  right.querySelector(".weight").closest(".field").hidden,
  false,
  "决策权重 is not race-only",
);

/* ---------------- status lamps & icon buttons ---------------- */

const lamp = (side) => side.querySelector(".side-status");

// A human side: grey light, no word — the 玩家 button already says as much.
assert.ok(lamp(left).classList.contains("status-manual"), "a human side shows the blue lamp");
assert.equal(lamp(left).textContent, "人类玩家", "the word stays in the DOM for screen readers");
assert.equal(lamp(left).title, "人类玩家", "the tooltip names the state");

// A ready Jev side: green light, also bare.
assert.ok(lamp(right).classList.contains("status-ready"), "a ready Jev side shows the green lamp");
assert.equal(lamp(right).textContent, "Jev 就绪", "its word stays in the DOM too");
assert.equal(lamp(right).title, "Jev 就绪", "the tooltip names the state");

// 重开 is a refresh icon now and Jev 走一步 a play icon; both keep their label.
const newBtn = right.querySelector(".new-game");
assert.ok(newBtn.querySelector("svg"), "重开 renders as an icon");
assert.equal(newBtn.textContent.trim(), "", "the icon replaced the 重开 label");
assert.equal(newBtn.getAttribute("aria-label"), "重开", "the icon button keeps an aria-label");
assert.equal(newBtn.title, "重开", "the icon button has a tooltip");

const stepBtn = right.querySelector(".jev-step");
assert.ok(stepBtn.querySelector("svg"), "Jev 走一步 renders as an icon");
assert.equal(stepBtn.textContent.trim(), "", "the icon replaced the Jev 走一步 label");
assert.equal(stepBtn.getAttribute("aria-label"), "Jev 走一步");
assert.equal(stepBtn.title, "Jev 走一步");
assert.ok(
  stepBtn.closest(".side-head") && newBtn.closest(".side-head"),
  "both icon buttons live in the head row",
);
assert.ok(
  stepBtn.compareDocumentPosition(newBtn) & 4,
  "Jev 走一步 sits left of 重开",
);

// The top bar carries the same two glyphs, plus a lamp of its own.
const topStatus = document.getElementById("jev-status");
assert.ok(topStatus.classList.contains("status-ok"), "the top bar shows the green lamp");
assert.equal(topStatus.textContent, "Jev 就绪", "…with its label spelled out");

const primaryBtn = document.getElementById("primary-action");
assert.equal(primaryBtn.title, "Jev 走一步", "the top-bar action starts as Jev 走一步");
assert.ok(primaryBtn.querySelector(".icon-play"), "…using the play glyph");
assert.ok(primaryBtn.querySelector(".icon-stop"), "…and carrying a stop glyph for later");
assert.equal(primaryBtn.getAttribute("aria-label"), "Jev 走一步");

const resetAllBtn = document.getElementById("reset-all");
assert.ok(resetAllBtn.querySelector("svg"), "全部重开 renders as an icon");
assert.equal(resetAllBtn.textContent.trim(), "", "the icon replaced the 全部重开 label");
assert.equal(resetAllBtn.getAttribute("aria-label"), "全部重开");
assert.equal(resetAllBtn.title, "全部重开");

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
// Manual input methods: four per side, multi-select. Nothing is focus-based —
// a key press reaches every human side that enabled that key set.
const allInputs = (side) => [...side.querySelectorAll("[data-input]")];
const checkedInputs = (side) =>
  allInputs(side)
    .filter((box) => box.checked)
    .map((box) => box.dataset.input);
const toggleInput = (side, name, on) => {
  const box = side.querySelector(`[data-input="${name}"]`);
  box.checked = on;
  box.dispatchEvent(new dom.window.Event("change"));
};
const pressKey = (key) => {
  const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
};

assert.deepEqual(
  allInputs(left).map((box) => box.dataset.input),
  ["arrows", "wasd", "swipe", "buttons"],
  "each side offers 上下左右 / WSAD / 滑动 / 界面按键",
);
assert.deepEqual(checkedInputs(left), ["wasd"], "the left side defaults to WSAD");
assert.deepEqual(checkedInputs(right), ["arrows"], "the right side defaults to arrow keys");
assert.equal(left.querySelector(".dpad").hidden, true, "界面按键 is off, so no d-pad");
assert.equal(right.querySelector(".dpad").hidden, true, "a Jev side shows no d-pad either");

toggleInput(left, "buttons", true);
assert.deepEqual(checkedInputs(left), ["wasd", "buttons"], "methods are multi-select");
assert.equal(left.querySelector(".dpad").hidden, false, "enabling 界面按键 shows the d-pad");

// 滑动（触摸）is gated the same way.
const swipe = (side, dx, dy) => {
  const board = side.querySelector(".board");
  for (const [type, x, y] of [
    ["touchstart", 200, 200],
    ["touchend", 200 + dx, 200 + dy],
  ]) {
    const event = new dom.window.Event(type, { bubbles: true });
    event.changedTouches = [{ clientX: x, clientY: y }];
    board.dispatchEvent(event);
  }
};

const beforeSwipe = stepsOf(left);
swipe(left, 90, 0);
await flush(420);
assert.equal(stepsOf(left), beforeSwipe, "滑动 is off until it is switched on");

toggleInput(left, "swipe", true);
let swiped = false;
for (const [dx, dy] of [
  [90, 0],
  [-90, 0],
  [0, 90],
  [0, -90],
]) {
  const before = stepsOf(left);
  swipe(left, dx, dy);
  await flush(420);
  if (stepsOf(left) > before) {
    swiped = true;
    break;
  }
}
assert.equal(swiped, true, "a swipe moves the board once 滑动 is enabled");

// A Jev side never reacts to the keyboard, even with the method enabled.
await flush(1200); // let the sync move caused by the swipe above finish
const jevStepsBefore = stepsOf(right);
pressKey("ArrowRight");
await flush(400);
assert.equal(stepsOf(right), jevStepsBefore, "a Jev side ignores keyboard input");

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
const leftBefore = stepsOf(left);
for (const move of ["left", "right", "up", "down"]) {
  left.querySelector(`.dpad-btn[data-move="${move}"]`).click();
  await flush(600);
  moved = stepsOf(left) > leftBefore;
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
  ["0.0s", "4877 tok · $0.0002"],
  "latency and input-token cost sit in bubbles at the bottom right",
);

// Session spend bubble in the top bar, immediately left of the Jev status pill.
const usd = (value) => {
  const amount = Number(value) || 0;
  if (amount === 0) return "$0.0000";
  const rounded = amount.toFixed(4);
  return rounded === "0.0000" ? "$<0.0001" : `$${rounded}`;
};
const perCall = (4877 / 1e6) * 0.042;

const costBubble = document.getElementById("jev-cost");
assert.ok(
  costBubble.compareDocumentPosition(document.getElementById("jev-status")) & 4,
  "the spend bubble sits left of the Jev status",
);
assert.equal(
  costBubble.textContent,
  `COST ${usd(jevCalls * perCall)}`,
  "the top bar shows COST = the sum of the two sides",
);

// Each side carries its own spend pill at the top of its block.
const sideCosts = [...document.querySelectorAll(".side .side-cost")];
assert.equal(sideCosts.length, 2, "each side shows its own spend");
assert.equal(sideCosts[0].textContent, "$0.0000", "the human side never spends");
assert.equal(
  sideCosts[1].textContent,
  usd(jevCalls * perCall),
  "the Jev side shows its own spend",
);

// A tiny (but non-zero) amount must not render as $0.0000.
assert.equal(usd(0), "$0.0000", "a real zero renders as $0.0000");
assert.equal(usd(0.00002), "$<0.0001", "sub-$0.0001 renders as $<0.0001");
assert.equal(usd(0.0002), "$0.0002", "amounts at/above the 4th decimal render normally");

/* ---------------- race mode ---------------- */

// The top-bar action is an icon button now, so read its label from title/aria.
const primaryLabel = () => document.querySelector("#primary-action").title;

click('[data-mode="race"]');
assert.deepEqual(
  raceFieldsHidden(right),
  [false, false],
  "竞速模式 shows 出手间隔 / 步数上限",
);
assert.equal(
  right.querySelector(".model-select").closest(".field").hidden,
  false,
  "模型 stays visible in both modes",
);
assert.equal(primaryLabel(), "开始竞速", "race mode offers a start action");
assert.ok(
  document.querySelector("#primary-action").querySelector(".icon-play"),
  "开始竞速 shows the play glyph",
);

click("#primary-action");
await flush(1400);
const afterStart = stepsOf(right);
assert.ok(afterStart > 1, "race mode keeps making Jev moves");

assert.equal(primaryLabel(), "停止竞速", "while racing the action offers 停止");
assert.ok(
  document.getElementById("primary-action").classList.contains("is-stop"),
  "停止竞速 swaps in the stop glyph",
);

click("#primary-action");
await flush(400);
assert.equal(primaryLabel(), "开始竞速", "stop returns the action to 开始竞速");
const afterStop = stepsOf(right);
await flush(700);
assert.equal(stepsOf(right), afterStop, "no more Jev moves after stopping the race");

/* ---------------- 竞速步数上限 ---------------- */

const limitInput = right.querySelector(".limit");
assert.equal(limitInput.value, "200", "步数上限 defaults to 200");
const setLimit = (value) => {
  limitInput.value = String(value);
  limitInput.dispatchEvent(new dom.window.Event("input"));
};

click("#reset-all");
await flush(60);
setLimit(2);
assert.equal(right.querySelector(".side-status").textContent, "Jev 就绪", "under the cap the side is ready");

click("#primary-action"); // 开始竞速
await flush(2600);
assert.equal(stepsOf(right), 2, "auto-play stops exactly at the step cap");
assert.match(
  right.querySelector(".side-status").textContent,
  /步数上限 2/,
  "the side says why it stopped auto-playing",
);
assert.ok(
  lamp(right).classList.contains("status-warn"),
  "步数上限 is the amber light",
);
assert.equal(
  primaryLabel(),
  "开始竞速",
  "the race ends once every Jev side is out of budget",
);

// The cap only gates auto-play: a manual 走一步 still works, and 重开 restores the
// budget (the reset also clears the side's spend, so step once more afterwards for
// the cost assertions further down).
const capped = stepsOf(right);
right.querySelector(".jev-step").click();
await flush(900);
assert.equal(stepsOf(right), capped + 1, "the step cap does not block manual steps");
right.querySelector(".new-game").click();
await flush(60);
assert.equal(right.querySelector(".side-status").textContent, "Jev 就绪", "重开 restores the budget");
right.querySelector(".jev-step").click();
await flush(900);

// 0 = no cap.
setLimit(0);
assert.equal(right.querySelector(".side-status").textContent, "Jev 就绪", "0 means unlimited");

// The cap is a race concept: 同步 neither shows the fields nor reports the cap.
setLimit(1); // the side already has 1 step
click('[data-mode="sync"]');
assert.deepEqual(raceFieldsHidden(right), [true, true], "同步模式 hides them again");
assert.equal(
  right.querySelector(".side-status").textContent,
  "Jev 就绪",
  "同步模式 does not report the race cap",
);
click('[data-mode="race"]');
assert.deepEqual(raceFieldsHidden(right), [false, false], "竞速模式 shows them again");
assert.match(
  right.querySelector(".side-status").textContent,
  /步数上限 1/,
  "竞速模式 reports the cap again",
);
setLimit(200);

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

/* ---------------- 重开 / 全部重开 clear the cost ---------------- */

assert.notEqual(
  right.querySelector(".side-cost").textContent,
  "$0.0000",
  "the Jev side has spent something by now",
);
right.querySelector(".new-game").click();
await flush(50);
assert.equal(
  right.querySelector(".side-cost").textContent,
  "$0.0000",
  "restarting a side clears its own COST",
);
assert.equal(
  document.getElementById("jev-cost").textContent,
  "COST $0.0000",
  "the top-bar total drops when a side resets",
);

// Spend again, then reset everything from the top bar.
right.querySelector(".jev-step").click();
await flush(900);
assert.notEqual(
  document.getElementById("jev-cost").textContent,
  "COST $0.0000",
  "spending again raises the total",
);
click("#reset-all");
await flush(80);
assert.equal(
  right.querySelector(".side-cost").textContent,
  "$0.0000",
  "全部重开 clears the side COST",
);
assert.equal(
  document.getElementById("jev-cost").textContent,
  "COST $0.0000",
  "全部重开 clears the top-bar COST",
);

/* ---------------- a Jev reply that lands after 全部重开 is discarded ------- */

holdJev = true;
right.querySelector(".jev-step").click();
await flush(30); // the request is now parked in flight
assert.ok(releaseJev, "the Jev request is in flight");

// 思考中... is the breathing green lamp; its word stays in the DOM / tooltip.
assert.ok(lamp(right).classList.contains("status-wait"), "思考中... uses the green lamp");
assert.equal(lamp(right).textContent, "思考中...", "its word stays in the DOM");
assert.equal(lamp(right).title, "思考中...", "…and in the tooltip");

click("#reset-all");
await flush(30);
releaseJev(); // the reply for the *previous* game finally arrives
releaseJev = null;
holdJev = false;
await flush(60);
assert.equal(
  right.querySelector(".side-cost").textContent,
  "$0.0000",
  "a late reply must not add to the reset side's COST",
);
assert.equal(
  document.getElementById("jev-cost").textContent,
  "COST $0.0000",
  "a late reply must not un-clear the top-bar COST",
);
assert.equal(stepsOf(right), 0, "a late reply must not move the reset board");

/* ---------------- two players share one keyboard (no focus) -------------- */

// left WASD vs right arrows, both human — the player-vs-player setup.
click('[data-mode="sync"]');
assert.deepEqual(
  raceFieldsHidden(right),
  [true, true],
  "switching back to 同步 hides them again",
);
click('[data-side="left"] .seg-btn[data-controller="human"]');
click('[data-side="right"] .seg-btn[data-controller="human"]');
toggleInput(left, "buttons", false);
toggleInput(left, "swipe", false);
assert.deepEqual(checkedInputs(left), ["wasd"], "left is WASD only");
assert.deepEqual(checkedInputs(right), ["arrows"], "right is arrows only");
await flush(20);

/**
 * Restarts both boards (the stubbed RNG makes the spawns identical every time)
 * and reports which sides a key moved, so a key that happens to be illegal on
 * the fresh board is simply skipped.
 */
const tryKey = async (key) => {
  click("#reset-all");
  await flush(60);
  const before = [stepsOf(left), stepsOf(right)];
  const event = pressKey(key);
  await flush(420);
  return { event, moved: [stepsOf(left) > before[0], stepsOf(right) > before[1]] };
};
const findKey = async (keys, want) => {
  for (const key of keys) {
    const result = await tryKey(key);
    if (want(result.moved)) return { key, ...result };
  }
  return null;
};
const anyKey = (moved) => moved[0] || moved[1];
const bothKeys = (moved) => moved[0] && moved[1];
const WASD = ["w", "a", "s", "d"];
const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

// WSAD is only on the left, arrows only on the right.
const wasd = await findKey(WASD, anyKey);
assert.ok(wasd, "a WASD key is legal on a fresh board");
assert.deepEqual(wasd.moved, [true, false], `「${wasd.key}」 moves only the left side`);
assert.equal(wasd.event.defaultPrevented, true, "a handled key does not scroll the page");

const arrow = await findKey(ARROWS, anyKey);
assert.ok(arrow, "an arrow key is legal on a fresh board");
assert.deepEqual(arrow.moved, [false, true], `「${arrow.key}」 moves only the right side`);

// Both sides on 上下左右: one press drives both, whichever side was clicked.
toggleInput(left, "arrows", true);
const shared = await findKey(ARROWS, bothKeys);
assert.ok(shared, "a shared key set is legal on both fresh boards");
assert.deepEqual(shared.moved, [true, true], `「${shared.key}」 drives both sides at once`);

click("#reset-all");
await flush(60);
right.querySelector(".board").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const afterClick = await findKey(ARROWS, bothKeys);
assert.ok(afterClick, "arrows still reach both sides after clicking a board");
assert.deepEqual(
  afterClick.moved,
  [true, true],
  "clicking a board must not take the keys away from the other side",
);

// Switching a method off takes effect immediately.
toggleInput(right, "arrows", false);
const off = await findKey(ARROWS, anyKey);
assert.deepEqual(off.moved, [true, false], "turning 上下左右 off stops the right side only");

console.log("ui tests passed ✓");
process.exit(0);
