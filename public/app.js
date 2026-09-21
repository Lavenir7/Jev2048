import { ARROWS, SIZE, legalMoves, moveTiles, tilesToBoard } from "/shared/engine.js";

const SLIDE_MS = 120;
const POP_MS = 110;
const SPAWN_MS = 90;
const SYNC_GAP_MS = 140;
const MAX_LOG_ENTRIES = 4;

const KEY_MAP = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (value) => `${Math.round((value || 0) * 100)}%`;
const moveLabel = (move) => `${ARROWS[move]} ${move}`;

/* ================================================================== */
/* Board: one 2048 game, controlled by a human or by Jev              */
/* ================================================================== */

class Board {
  constructor(side, label, root) {
    this.side = side;
    this.label = label;
    this.root = root;

    const q = (selector) => root.querySelector(selector);
    this.els = {
      board: q(".board"),
      overlay: q(".overlay"),
      overlayTitle: q(".overlay-title"),
      overlayText: q(".overlay-text"),
      overlayBtn: q(".overlay-btn"),
      name: q(".side-name"),
      status: q(".side-status"),
      score: q(".score"),
      best: q(".best"),
      steps: q(".steps"),
      config: q(".side-config"),
      help: q(".side-help"),
      model: q(".model-select"),
      weight: q(".weight"),
      weightValue: q(".weight-value"),
      weightRest: q(".weight-rest"),
      delay: q(".delay"),
      delayValue: q(".delay-value"),
      stepBtn: q(".jev-step"),
      newBtn: q(".new-game"),
      dpad: q(".dpad"),
      log: q(".log"),
      controllerBtns: [...root.querySelectorAll(".seg-btn[data-controller]")],
    };
    this.dpadButtons = [...root.querySelectorAll(".dpad-btn")];
    this.els.name.textContent = label;

    this.controller = "human";
    this.config = { model: "", weight: 0.6, delay: 800 };
    this.best = Number(localStorage.getItem(`jev2048.best.${side}`) || 0);

    this.state = Board.freshState();
    this.tileEls = new Map();

    this.auto = false;
    this.autoToken = 0;
    this.stepping = false;
    this.pendingSync = 0;
    this.syncDraining = false;
    this.abort = null;
    this.jevReady = false;

    // Hooks set by Match.
    this.onHumanMove = null;
    this.onControllerChange = null;
    this.onChange = null;

    this.buildGrid();
    this.wireEvents();
    this.applyController();
    this.syncConfigLabels();
    this.updateHud();
  }

  static freshState() {
    return {
      tiles: [],
      doomed: [],
      score: 0,
      steps: 0,
      over: false,
      won: false,
      busy: false,
      thinking: false,
      nextId: 1,
    };
  }

  /* ---------------- construction ---------------- */

  buildGrid() {
    for (let i = 0; i < SIZE * SIZE; i += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";
      this.els.board.appendChild(cell);
    }
  }

  wireEvents() {
    for (const button of this.els.controllerBtns) {
      button.addEventListener("click", () => this.setController(button.dataset.controller));
    }
    this.els.newBtn.addEventListener("click", () => this.newGame());
    this.els.stepBtn.addEventListener("click", () => this.requestSyncMove());
    for (const button of this.dpadButtons) {
      button.addEventListener("click", () => this.handleManualMove(button.dataset.move));
    }
    this.els.overlayBtn.addEventListener("click", () => {
      if (this.els.overlayBtn.dataset.action === "new") this.newGame();
      else this.hideOverlay();
    });
    this.els.model.addEventListener("change", () => {
      this.config.model = this.els.model.value;
    });
    this.els.weight.addEventListener("input", () => {
      this.config.weight = Number(this.els.weight.value) / 100;
      this.syncConfigLabels();
    });
    this.els.delay.addEventListener("input", () => {
      this.config.delay = Number(this.els.delay.value);
      this.syncConfigLabels();
    });

    this.els.board.addEventListener(
      "touchstart",
      (event) => {
        const touch = event.changedTouches[0];
        if (!touch) return;
        this.touchX = touch.clientX;
        this.touchY = touch.clientY;
      },
      { passive: true },
    );
    this.els.board.addEventListener(
      "touchend",
      (event) => {
        const touch = event.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - (this.touchX || 0);
        const dy = touch.clientY - (this.touchY || 0);
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
        this.handleManualMove(
          Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up",
        );
      },
      { passive: true },
    );
  }

  syncConfigLabels() {
    const weight = Number(this.els.weight.value);
    this.els.weightValue.textContent = `${weight}%`;
    this.els.weightRest.textContent = `${100 - weight}%`;
    this.els.delayValue.textContent = `${this.els.delay.value} ms`;
    this.config.weight = weight / 100;
    this.config.delay = Number(this.els.delay.value);
    this.updateRangeFill(this.els.weight);
    this.updateRangeFill(this.els.delay);
  }

  /** Drives the gradient fill of a range slider up to its thumb. */
  updateRangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value);
    const ratio = max === min ? 0 : (value - min) / (max - min);
    input.style.setProperty("--fill", `${Math.round(ratio * 1000) / 10}%`);
  }

  /* ---------------- controller / config ---------------- */

  setController(kind) {
    if (kind === this.controller) return;
    this.controller = kind;
    this.pendingSync = 0;
    if (kind !== "jev") this.stopAuto();
    this.applyController();
    this.updateSideStatus();
    this.updateButtons();
    this.onControllerChange?.(this);
  }

  applyController() {
    const isJev = this.controller === "jev";
    for (const button of this.els.controllerBtns) {
      button.classList.toggle("active", button.dataset.controller === this.controller);
    }
    this.els.config.hidden = !isJev;
    this.els.help.hidden = isJev;
    this.els.stepBtn.hidden = !isJev;
    this.els.dpad.hidden = isJev;
  }

  setJevReady(ready) {
    this.jevReady = ready;
    this.updateSideStatus();
    this.updateButtons();
    if (!ready) this.stopAuto();
  }

  setModels(models, defaultModel) {
    const names = [...new Set((models || []).map((m) => (typeof m === "string" ? m : m?.name)).filter(Boolean))];
    if (defaultModel && !names.includes(defaultModel)) names.unshift(defaultModel);
    if (this.config.model && !names.includes(this.config.model)) names.push(this.config.model);

    this.els.model.innerHTML = "";
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      this.els.model.appendChild(option);
    }
    if (!this.config.model) this.config.model = defaultModel || names[0] || "";
    this.els.model.value = this.config.model;
  }

  /* ---------------- rendering ---------------- */

  setPosition(node, row, col) {
    node.style.setProperty("--row", row);
    node.style.setProperty("--col", col);
  }

  paintTile(node, value) {
    node.dataset.value = value;
    node.dataset.digits = String(value).length;
    node.textContent = value;
    node.classList.toggle("big", value > 2048);
  }

  renderBoard({ updateValues = true } = {}) {
    const live = new Set();

    for (const tile of [...this.state.tiles, ...this.state.doomed]) {
      live.add(tile.id);
      let node = this.tileEls.get(tile.id);
      if (!node) {
        node = document.createElement("div");
        node.className = "tile tile-new";
        this.paintTile(node, tile.value);
        this.setPosition(node, tile.r, tile.c);
        this.els.board.appendChild(node);
        this.tileEls.set(tile.id, node);
      } else {
        this.setPosition(node, tile.r, tile.c);
        if (updateValues && String(tile.value) !== node.dataset.value) {
          this.paintTile(node, tile.value);
        }
      }
    }

    for (const [id, node] of this.tileEls) {
      if (!live.has(id)) {
        node.remove();
        this.tileEls.delete(id);
      }
    }
  }

  popTile(id) {
    const node = this.tileEls.get(id);
    if (!node) return;
    node.classList.remove("tile-merged");
    void node.offsetWidth;
    node.classList.add("tile-merged");
  }

  spawnTile() {
    const board = tilesToBoard(this.state.tiles);
    const empties = [];
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        if (board[r][c] === 0) empties.push([r, c]);
      }
    }
    if (empties.length === 0) return null;

    const [r, c] = empties[Math.floor(Math.random() * empties.length)];
    const tile = {
      id: this.state.nextId,
      value: Math.random() < 0.9 ? 2 : 4,
      r,
      c,
      pendingValue: null,
    };
    this.state.nextId += 1;
    this.state.tiles.push(tile);
    return tile;
  }

  updateHud() {
    if (this.state.score > this.best) {
      this.best = this.state.score;
      localStorage.setItem(`jev2048.best.${this.side}`, String(this.best));
    }
    this.els.score.textContent = this.state.score;
    this.els.best.textContent = this.best;
    this.els.steps.textContent = this.state.steps;
  }

  updateSideStatus() {
    if (this.controller === "human") return this.setSideStatus("wait", "手动");
    if (!this.jevReady) return this.setSideStatus("warn", "无 Key");
    if (this.state.thinking) return this.setSideStatus("wait", "思考中…");
    if (this.state.over) return this.setSideStatus("bad", "已结束");
    if (this.auto) return this.setSideStatus("ok", "自动中");
    return this.setSideStatus("ok", "就绪");
  }

  setSideStatus(kind, text) {
    this.els.status.className = `side-status status status-${kind}`;
    this.els.status.textContent = text;
  }

  updateButtons() {
    const isJev = this.controller === "jev";
    this.els.stepBtn.disabled =
      !isJev ||
      !this.jevReady ||
      this.auto ||
      this.state.busy ||
      this.state.thinking ||
      this.state.over;
    const locked = isJev || this.state.busy || this.state.over;
    for (const button of this.dpadButtons) button.disabled = locked;
  }

  showOverlay(title, text, buttonLabel) {
    this.els.overlayTitle.textContent = title;
    this.els.overlayText.textContent = text;
    this.els.overlayBtn.textContent = buttonLabel;
    this.els.overlayBtn.dataset.action = this.state.over ? "new" : "dismiss";
    this.els.overlay.classList.remove("hidden");
  }

  hideOverlay() {
    this.els.overlay.classList.add("hidden");
  }

  /* ---------------- game flow ---------------- */

  newGame() {
    this.stopAuto();
    this.pendingSync = 0;
    for (const node of this.tileEls.values()) node.remove();
    this.tileEls.clear();

    this.state = Board.freshState();
    this.hideOverlay();
    this.spawnTile();
    this.spawnTile();
    this.renderBoard();
    this.updateHud();
    this.clearLog(
      this.controller === "jev" ? "" : "",
    );
    this.updateSideStatus();
    this.updateButtons();
    this.onChange?.();
  }

  async performMove(move, by = "jev") {
    if (this.state.busy || this.state.over) return false;

    const result = moveTiles(this.state.tiles, move);
    if (!result.moved) return false;

    this.state.busy = true;
    this.state.doomed = result.doomed;
    this.state.tiles = result.tiles;
    this.state.score += result.gained;

    // 1. slide
    this.renderBoard({ updateValues: false });
    await sleep(SLIDE_MS);

    // 2. commit merges, drop absorbed tiles
    const mergedIds = [];
    for (const tile of this.state.tiles) {
      if (tile.pendingValue !== null && tile.pendingValue !== undefined) {
        tile.value = tile.pendingValue;
        tile.pendingValue = null;
        mergedIds.push(tile.id);
      }
    }
    this.state.doomed = [];
    this.renderBoard();
    for (const id of mergedIds) this.popTile(id);
    await sleep(POP_MS);

    // 3. spawn and settle
    this.state.steps += 1;
    this.spawnTile();
    this.renderBoard();
    this.updateHud();
    await sleep(SPAWN_MS);

    this.state.busy = false;
    this.checkGameState();
    this.updateButtons();

    if (by === "human") this.onHumanMove?.(this);
    return true;
  }

  checkGameState() {
    const board = tilesToBoard(this.state.tiles);

    if (!this.state.won && board.some((row) => row.includes(2048))) {
      this.state.won = true;
      if (this.auto) this.stopAuto();
      this.showOverlay("🎉 2048！", "可以继续，或点「重开」。", "继续");
    }

    if (legalMoves(board).length === 0) {
      this.state.over = true;
      this.stopAuto();
      this.updateHud();
      this.updateSideStatus();
      this.showOverlay("游戏结束", `得分 ${this.state.score}，共 ${this.state.steps} 步。`, "重开");
    }
    this.onChange?.();
  }

  handleManualMove(move) {
    if (this.controller !== "human" || this.state.busy || this.state.over) return;
    this.performMove(move, "human");
  }

  /* ---------------- Jev ---------------- */

  requestSyncMove() {
    if (this.controller !== "jev" || this.state.over || this.auto) return;
    this.pendingSync += 1;
    this.drainSync();
  }

  clearPendingSync() {
    this.pendingSync = 0;
  }

  async drainSync() {
    if (this.syncDraining) return;
    this.syncDraining = true;
    while (this.pendingSync > 0 && this.controller === "jev" && !this.state.over && !this.auto) {
      this.pendingSync -= 1;
      const ok = await this.jevStep();
      if (!ok) break;
      await sleep(SYNC_GAP_MS);
    }
    this.pendingSync = 0;
    this.syncDraining = false;
  }

  async jevStep() {
    if (this.controller !== "jev" || !this.jevReady || this.state.over || this.stepping) {
      return false;
    }

    this.stepping = true;
    this.state.thinking = true;
    this.updateSideStatus();
    this.updateButtons();

    try {
      const board = tilesToBoard(this.state.tiles);
      const decision = await this.fetchJevMove(board);
      const legal = legalMoves(board);
      const move = legal.includes(decision.move) ? decision.move : legal[0];
      this.renderDecision(decision, move);
      return await this.performMove(move, "jev");
    } catch (error) {
      if (error?.name === "AbortError") return false;
      this.renderError(error?.message || String(error));
      this.setSideStatus("bad", "出错");
      return false;
    } finally {
      this.stepping = false;
      this.state.thinking = false;
      this.updateSideStatus();
      this.updateButtons();
    }
  }

  async fetchJevMove(board) {
    const controller = new AbortController();
    this.abort = controller;
    try {
      const res = await fetch("/api/jev-move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          board,
          weight: this.config.weight,
          model: this.config.model,
        }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.message || `Jev 请求失败（HTTP ${res.status}）`);
      }
      return data;
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }

  async startAuto() {
    if (this.auto || this.state.over || this.controller !== "jev" || !this.jevReady) return;
    this.auto = true;
    const token = this.autoToken + 1;
    this.autoToken = token;
    this.updateSideStatus();
    this.updateButtons();
    this.onChange?.();

    while (this.auto && token === this.autoToken && !this.state.over) {
      const ok = await this.jevStep();
      if (!ok) break;
      if (!this.auto || token !== this.autoToken) break;
      await sleep(this.config.delay);
    }

    if (token === this.autoToken) {
      this.auto = false;
      this.updateSideStatus();
      this.updateButtons();
      this.onChange?.();
    }
  }

  stopAuto() {
    const changed = this.auto;
    this.auto = false;
    this.autoToken += 1;
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    if (changed) {
      this.updateSideStatus();
      this.updateButtons();
      this.onChange?.();
    }
  }

  /* ---------------- decision log ---------------- */

  clearLog(message) {
    this.els.log.innerHTML = "";
    if (message) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = message;
      this.els.log.appendChild(p);
    }
  }

  pushLog(entry) {
    this.els.log.prepend(entry);
    while (this.els.log.children.length > MAX_LOG_ENTRIES) {
      this.els.log.lastElementChild.remove();
    }
  }

  renderDecision(decision, playedMove) {
    const entry = document.createElement("div");
    entry.className = "decision";

    // ── 顶部：步数 / 方向 ······ 模型气泡 · 把握度 ──
    const top = document.createElement("div");
    top.className = "decision-top";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent =
      decision.source === "only-legal-move" ? "唯一走法" : `第 ${this.state.steps + 1} 步`;
    const move = document.createElement("strong");
    move.className = "move-name";
    move.textContent = moveLabel(playedMove);

    const right = document.createElement("div");
    right.className = "decision-right";
    if (decision.model) {
      const model = document.createElement("span");
      model.className = "bubble model-bubble";
      model.textContent = decision.model;
      model.title = `模型：${decision.model}`;
      right.appendChild(model);
    }
    const conf = document.createElement("span");
    conf.className = "conf";
    conf.textContent =
      decision.source === "only-legal-move"
        ? "代码给出"
        : `把握 ${pct(decision.choice?.confidence)}`;
    right.appendChild(conf);

    top.append(badge, move, right);
    entry.appendChild(top);

    // ── 每个方向一行：choice 概率 · 位置评分（如 97% · 3.41）──
    const probabilities = decision.choice?.probabilities || {};
    const quality = decision.quality || {};
    const rows = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    if (rows.length > 0) {
      const list = document.createElement("ul");
      list.className = "bars";
      for (const [candidate, probability] of rows) {
        const li = document.createElement("li");
        if (candidate === playedMove) li.classList.add("chosen");

        const label = document.createElement("span");
        label.className = "bar-label";
        label.textContent = moveLabel(candidate);

        const bar = document.createElement("span");
        bar.className = "bar";
        const fill = document.createElement("i");
        fill.style.width = `${Math.max(3, Math.round(probability * 100))}%`;
        bar.appendChild(fill);

        const value = document.createElement("span");
        value.className = "bar-val";
        const score = quality[candidate];
        value.textContent =
          typeof score === "number"
            ? `${pct(probability)} · ${score.toFixed(2)}`
            : pct(probability);
        if (typeof score === "number") value.title = "Choice 概率 · 位置评分";

        li.append(label, bar, value);
        list.appendChild(li);
      }
      entry.appendChild(list);
    }

    // ── 右下角：耗时 / token 气泡 ──
    const foot = document.createElement("div");
    foot.className = "decision-foot";
    if (decision.latency_ms != null) {
      const time = document.createElement("span");
      time.className = "bubble";
      time.textContent = `${(decision.latency_ms / 1000).toFixed(1)}s`;
      time.title = "本次请求耗时";
      foot.appendChild(time);
    }
    if (decision.usage) {
      const tokens = document.createElement("span");
      tokens.className = "bubble";
      tokens.textContent = `${(decision.usage.input_tokens || 0) + (decision.usage.output_tokens || 0)} tok`;
      tokens.title = "token 消耗（输入 + 输出）";
      foot.appendChild(tokens);
    }
    if (foot.children.length > 0) entry.appendChild(foot);

    this.pushLog(entry);
  }

  renderError(message) {
    const entry = document.createElement("div");
    entry.className = "decision error";
    const strong = document.createElement("strong");
    strong.textContent = "Jev 出错";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = message;
    entry.append(strong, p);
    this.pushLog(entry);
  }
}

/* ================================================================== */
/* Match: two boards, a mode (sync / race) and the top bar            */
/* ================================================================== */

class Match {
  constructor() {
    this.mode = "sync";
    this.boards = [];
    this.focused = null;
    this.raceRunning = false;
    this.jevReady = false;
    this.defaultModel = "jev-latest";

    this.els = {
      arena: document.getElementById("arena"),
      modeBtns: [...document.querySelectorAll("#mode-switch .seg-btn")],
      modeHint: document.getElementById("mode-hint"),
      primary: document.getElementById("primary-action"),
      resetAll: document.getElementById("reset-all"),
      status: document.getElementById("jev-status"),
    };
  }

  init() {
    const template = document.getElementById("side-template");
    for (const def of [
      { side: "left", label: "左侧" },
      { side: "right", label: "右侧" },
    ]) {
      const fragment = template.content.cloneNode(true);
      const root = fragment.querySelector(".side");
      root.dataset.side = def.side;
      this.els.arena.appendChild(fragment);

      const board = new Board(def.side, def.label, root);
      board.onHumanMove = (source) => this.handleHumanMove(source);
      board.onControllerChange = (changed) => this.handleControllerChange(changed);
      board.onChange = () => this.onBoardChange();
      this.boards.push(board);
    }

    // A natural default: you on the left, Jev on the right.
    this.boards[0].setController("human");
    this.boards[1].setController("jev");

    this.focused = this.boards[0];
    this.applyFocus();

    this.wire();
    this.setMode("sync");
    for (const board of this.boards) board.newGame();
    this.updateTopBar();
    this.fetchStatus();
  }

  wire() {
    for (const button of this.els.modeBtns) {
      button.addEventListener("click", () => this.setMode(button.dataset.mode));
    }
    this.els.primary.addEventListener("click", () => this.primaryAction());
    this.els.resetAll.addEventListener("click", () => this.resetAll());

    document.addEventListener("keydown", (event) => this.onKeyDown(event));
    document.addEventListener("click", (event) => {
      const side = event.target.closest?.(".side");
      if (!side) return;
      const board = this.boards.find((candidate) => candidate.root === side);
      if (board) {
        this.focused = board;
        this.applyFocus();
      }
    });
  }

  /* ---------------- mode & top bar ---------------- */

  setMode(mode) {
    if (mode !== this.mode) {
      this.mode = mode;
      this.stopRace();
      for (const board of this.boards) board.clearPendingSync();
    }
    for (const button of this.els.modeBtns) {
      button.classList.toggle("active", button.dataset.mode === this.mode);
    }
    this.els.modeHint.textContent =
      this.mode === "sync" ? "玩家走一步，Jev 走一步" : "Jev 自动连走";
    this.updateTopBar();
  }

  setStatus(kind, text) {
    this.els.status.className = `status status-${kind}`;
    this.els.status.textContent = text;
  }

  updateTopBar() {
    const jevBoards = this.boards.filter((board) => board.controller === "jev");
    const anyJev = jevBoards.length > 0;
    const allOver = anyJev && jevBoards.every((board) => board.state.over);
    const busy = jevBoards.some(
      (board) => board.state.busy || board.state.thinking || board.stepping,
    );

    if (this.mode === "sync") {
      this.els.primary.textContent = "Jev 走一步";
      this.els.primary.classList.add("primary");
      this.els.primary.classList.remove("danger");
      this.els.primary.disabled = !anyJev || !this.jevReady || allOver || busy;
    } else if (this.raceRunning) {
      this.els.primary.textContent = "停止竞速";
      this.els.primary.classList.remove("primary");
      this.els.primary.classList.add("danger");
      this.els.primary.disabled = false;
    } else {
      this.els.primary.textContent = "开始竞速";
      this.els.primary.classList.add("primary");
      this.els.primary.classList.remove("danger");
      this.els.primary.disabled = !anyJev || !this.jevReady || allOver;
    }

    for (const board of this.boards) board.root.classList.remove("leading");
    if (this.raceRunning && this.boards.length === 2) {
      const [a, b] = this.boards;
      const winner = a.state.score >= b.state.score ? a : b;
      const other = winner === a ? b : a;
      if (winner.state.score > other.state.score) winner.root.classList.add("leading");
    }

    if (!this.jevReady) this.setStatus("warn", "Jev 未配置");
    else this.setStatus("ok", "Jev 就绪");
  }

  onBoardChange() {
    if (this.raceRunning) {
      const jevBoards = this.boards.filter((board) => board.controller === "jev");
      if (jevBoards.length > 0 && !jevBoards.some((board) => !board.state.over)) {
        this.raceRunning = false;
        for (const board of this.boards) board.stopAuto();
      }
    }
    this.updateTopBar();
  }

  /* ---------------- actions ---------------- */

  primaryAction() {
    if (this.mode === "sync") {
      this.stepJevs();
    } else if (this.raceRunning) {
      this.stopRace();
    } else {
      this.startRace();
    }
  }

  stepJevs() {
    for (const board of this.boards) board.requestSyncMove();
  }

  handleHumanMove(source) {
    if (this.mode !== "sync") return;
    for (const board of this.boards) {
      if (board !== source && board.controller === "jev") board.requestSyncMove();
    }
  }

  handleControllerChange(board) {
    if (board.controller === "jev" && this.raceRunning && !board.state.over) {
      board.startAuto();
    }
    if (board.controller !== "jev") board.stopAuto();
    this.updateTopBar();
  }

  startRace() {
    const jevBoards = this.boards.filter(
      (board) => board.controller === "jev" && !board.state.over,
    );
    if (jevBoards.length === 0 || !this.jevReady) return;
    this.raceRunning = true;
    for (const board of jevBoards) board.startAuto();
    this.updateTopBar();
  }

  stopRace() {
    const wasRunning = this.raceRunning;
    this.raceRunning = false;
    for (const board of this.boards) board.stopAuto();
    if (wasRunning) this.updateTopBar();
  }

  resetAll() {
    this.stopRace();
    for (const board of this.boards) board.newGame();
    this.updateTopBar();
  }

  /* ---------------- keyboard & focus ---------------- */

  applyFocus() {
    for (const board of this.boards) {
      board.root.classList.toggle("focused", board === this.focused);
    }
  }

  keyboardBoard() {
    if (this.focused?.controller === "human") return this.focused;
    return this.boards.find((board) => board.controller === "human") || null;
  }

  onKeyDown(event) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const move = KEY_MAP[event.key];
    if (!move) return;
    const board = this.keyboardBoard();
    if (!board) return;
    event.preventDefault();
    board.handleManualMove(move);
  }

  /* ---------------- status ---------------- */

  async fetchStatus() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      this.jevReady = Boolean(data.jev);
      this.defaultModel = data.model || "jev-latest";

      let models = [this.defaultModel];
      if (this.jevReady) {
        const listing = await fetch("/api/models")
          .then((r) => r.json())
          .catch(() => null);
        if (listing?.models?.length) models = listing.models;
      }
      for (const board of this.boards) {
        board.setJevReady(this.jevReady);
        board.setModels(models, this.defaultModel);
      }
    } catch {
      this.jevReady = false;
      for (const board of this.boards) board.setJevReady(false);
      this.setStatus("bad", "服务器未连接");
    }
    this.updateTopBar();
  }
}

new Match().init();
