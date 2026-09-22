import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateBoard } from "../shared/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** Minimal .env loader so the project has no config dependency. */
function loadEnvFile() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

// Imported after the env file is loaded so the client picks up the key.
const { chooseMove, currentModel, jevConfigured, listModels, pricePerMtok, FALLBACK_MODELS } =
  await import("./jev.js");

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/api/status", (_req, res) => {
  res.json({
    jev: jevConfigured(),
    model: currentModel(),
    pricePerMtok: pricePerMtok(),
    defaultChoiceWeight: 0.6,
  });
});

// Live list of models the account can use. Falls back to a static list so the
// per-side pickers always have options.
app.get("/api/models", async (_req, res) => {
  if (!jevConfigured()) {
    return res.json({ models: FALLBACK_MODELS, source: "fallback" });
  }
  try {
    const models = await listModels();
    res.json({ models: models.length ? models : FALLBACK_MODELS, source: "api" });
  } catch (error) {
    res.json({
      models: FALLBACK_MODELS,
      source: "fallback",
      message: error?.message || String(error),
    });
  }
});

app.post("/api/jev-move", async (req, res) => {
  const { board, weight, model } = req.body ?? {};

  if (!validateBoard(board)) {
    return res.status(400).json({
      ok: false,
      error: "invalid-board",
      message: "board 必须是 4x4 的数组，元素为 0 或 2 的幂。",
    });
  }

  let requestedModel;
  if (model !== undefined && model !== null && model !== "") {
    if (typeof model !== "string" || !MODEL_RE.test(model)) {
      return res.status(400).json({ ok: false, error: "invalid-model", message: "model 参数不合法。" });
    }
    requestedModel = model;
  }

  if (!jevConfigured()) {
    return res.status(503).json({
      ok: false,
      error: "no-api-key",
      message: "服务器未配置 TYPESAFE_API_KEY，Jev 无法出手。请复制 .env.example 为 .env 并填入 API Key。",
    });
  }

  const startedAt = Date.now();
  try {
    const decision = await chooseMove(board, {
      weight: Number(weight),
      model: requestedModel,
    });
    if (!decision.ok) {
      const status = decision.error === "game-over" ? 409 : 502;
      return res.status(status).json(decision);
    }
    res.json({ ...decision, latency_ms: Date.now() - startedAt });
  } catch (error) {
    const message = error?.message || String(error);
    console.error("[jev-move] failed:", message);
    res.status(502).json({
      ok: false,
      error: "jev-error",
      message: `调用 Jev 失败：${message}`,
    });
  }
});

app.use("/shared", express.static(path.join(root, "shared")));
app.use(express.static(path.join(root, "public")));

/** `--host 127.0.0.1` / `--host=127.0.0.1` / `--port 8080`. CLI wins over env. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--(host|port)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    if (match[2] !== undefined) out[match[1]] = match[2];
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[match[1]] = argv[++i];
  }
  return out;
}

const cli = parseArgs(process.argv.slice(2));

const host = String(cli.host ?? process.env.HOST ?? "0.0.0.0").trim() || "0.0.0.0";
const rawPort = cli.port ?? process.env.PORT;
const port = rawPort === undefined || rawPort === "" ? 3000 : Number(rawPort);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`\n  端口不合法：${rawPort}（应为 0-65535 的整数）\n`);
  process.exit(1);
}

const server = app.listen(port, host, () => {
  const boundPort = server.address().port;
  const wildcard = host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0";
  const shown = wildcard ? "localhost" : host;
  const urlHost = shown.includes(":") ? `[${shown}]` : shown;
  const keyState = jevConfigured() ? "已配置 ✓" : "未配置 ✗（只能手动玩）";
  console.log(`\n  2048 · Jev   →   http://${urlHost}:${boundPort}`);
  console.log(`  监听 HOST:PORT  →  ${host}:${boundPort}`);
  console.log(`  TYPESAFE_API_KEY: ${keyState}\n`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n  端口 ${port} 已被占用，换一个：npm start -- --port 3001\n`);
  } else if (error.code === "EADDRNOTAVAIL") {
    console.error(`\n  无法绑定 Host「${host}」：本机没有这个地址。\n`);
  } else {
    console.error(`\n  启动失败：${error.message}\n`);
  }
  process.exit(1);
});
