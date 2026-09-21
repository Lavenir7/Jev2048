<img src="public/logo.svg" width="72" height="72" alt="Jev 2048" />

# Jev2048

> 网页版 2048 左右对战，每一侧可独立选择**玩家**操控或 **Jev**（TypeSafe · System One）操控。

## 依赖

- **Node.js ≥ 20**（用到 ESM 与顶层 `await`）
- npm 包：运行时 `express`、`@typesafe-ai/sdk`；开发时 `jsdom`（UI 测试用）——`npm install` 会自动装好
- **TypeSafe API Key**（<https://console.typesafe.ai/keys>）：只有让 Jev 出手才需要，没有也能两侧手动玩

## 快速开始

```bash
npm install
cp .env.example .env      # 填入 TYPESAFE_API_KEY
npm start                 # → http://localhost:3000
```

> API Key 只保存在服务端 `.env`，不会下发到浏览器。

### 常用命令

```bash
npm start                                   # 启动服务
npm run dev                                 # 启动并在改动后自动重启
npm test                                    # 引擎测试 + jsdom UI 集成测试（不需要浏览器 / Key）

npm start -- --host 127.0.0.1 --port 8080   # 指定监听地址与端口
npm start -- --port=8080                    # = 号写法同样支持，脚本后面都要加 --
```

### 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe API Key，Jev 必需 | —— |
| `TYPESAFE_MODEL` | 默认模型，两侧可各自覆盖 | `jev-latest` |
| `HOST` | 监听地址（`0.0.0.0` 对外，`127.0.0.1` 仅本机） | `0.0.0.0` |
| `PORT` | 服务端口 | `3000` |

优先级：**命令行参数 > 环境变量（含 `.env`）> 默认值**。

### HTTP 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/status` | `{ jev, model }`：是否配置了 Key、默认模型 |
| `GET /api/models` | `{ models, source }`：可用模型列表（取不到时回退内置列表） |
| `POST /api/jev-move` | body `{ board, weight, model }`，返回 `move` 及 `choice` / `quality` / `composite` / `usage` / `latency_ms` 等判断明细 |
