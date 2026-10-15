# 花漾生活 Flower Life — 花卉電商

一個完整的小型電商範例：訪客可瀏覽商品、以匿名 session 使用購物車；會員可結帳建立訂單並（模擬）付款；管理員可在後台管理商品與查詢訂單。

後端是 Express REST API，前端是由 EJS 輸出頁面骨架、再由各頁的 Vue 3 腳本呼叫 API 渲染資料的「SSR 外殼 + CSR 內容」架構，兩者由同一個 Node 程序提供。

---

## 技術棧

| 分類 | 技術 | 版本（package.json） | 用途 / 備註 |
|------|------|------|------|
| Runtime | Node.js | 建議 ≥ 18（開發機為 v24） | 前端使用 `crypto.randomUUID()`、後端使用 CommonJS |
| Web 框架 | Express | `~4.16.1` | 4.16 起內建 `express.json()`；同步處理器拋出的錯誤會進入 `errorHandler` |
| 資料庫 | better-sqlite3 | `^12.8.0` | 同步 API；WAL 模式；`foreign_keys = ON`；檔案 `database.sqlite` |
| 密碼雜湊 | bcrypt | `^6.0.0` | 註冊 10 rounds；測試環境 seed admin 用 1 round |
| 認證 | jsonwebtoken | `^9.0.2` | HS256、有效期 7 天 |
| ID | uuid | `^11.1.0` | 所有主鍵皆為 UUID v4 字串 |
| CORS | cors | `^2.8.5` | origin = `FRONTEND_URL` |
| 環境變數 | dotenv | `^16.4.7` | `app.js` 第一行載入 `.env` |
| 模板 | EJS | `^5.0.1` | 版型/partials；頁面內容是 Vue 模板 |
| 前端框架 | Vue 3 | CDN（unpkg `vue@3` global prod build） | 無打包、無 SFC；每頁一個 `createApp()` |
| CSS | Tailwind CSS v4 + `@tailwindcss/cli` | `^4.2.2` | `public/css/input.css` → `public/css/output.css`（gitignore） |
| API 文件 | swagger-jsdoc | `^6.2.8` | 從路由 `@openapi` 註解產生 `openapi.json`（未提供 Swagger UI） |
| 測試 | Vitest + Supertest | `^2.1.9` / `^7.2.2` | 直接對 `app` 發 HTTP 請求，不需啟動伺服器 |

---

## 快速開始

```bash
# 1. 安裝依賴
npm install

# 2. 建立環境變數檔（務必修改 JWT_SECRET）
cp .env.example .env

# 3. 建置 CSS 並啟動（預設 http://localhost:3001）
npm start
```

Windows PowerShell 的第 2 步可改用：`Copy-Item .env.example .env`

開發時建議開兩個終端：

```bash
npm run dev:css      # 終端 1：Tailwind watch
npm run dev:server   # 終端 2：啟動伺服器（改後端程式需手動重啟，未使用 nodemon）
```

首次啟動會自動：
1. 在專案根目錄建立 `database.sqlite`（及 `-shm`、`-wal`）
2. 建立 5 張資料表
3. 建立管理員帳號（預設 `admin@hexschool.com` / `12345678`，可由 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 覆寫）
4. 若 `products` 表為空，寫入 8 筆花卉商品種子資料

### 試用路徑

| 頁面 | URL | 說明 |
|------|-----|------|
| 首頁 / 商品列表 | `http://localhost:3001/` | 每頁 9 筆 |
| 商品詳情 | `/products/:id` | 可選數量加入購物車 |
| 購物車 | `/cart` | 訪客也可使用（匿名 session） |
| 登入 / 註冊 | `/login` | 支援 `?redirect=/path` |
| 結帳 | `/checkout` | 需登入 |
| 我的訂單 | `/orders`、`/orders/:id` | 需登入；詳情頁可模擬付款成功/失敗 |
| 後台商品管理 | `/admin/products` | 需管理員 |
| 後台訂單管理 | `/admin/orders` | 需管理員 |

---

## 常用指令

| 指令 | 實際執行 | 說明 |
|------|---------|------|
| `npm start` | `npm run css:build && node server.js` | 正式啟動；缺 `JWT_SECRET` 會直接 `process.exit(1)` |
| `npm run dev:server` | `node server.js` | 只啟動伺服器 |
| `npm run dev:css` | `npx @tailwindcss/cli -i public/css/input.css -o public/css/output.css --watch` | CSS 監看 |
| `npm run css:build` | 同上加 `--minify` | CSS 一次性建置 |
| `npm test` | `vitest run` | 依固定順序串行跑全部測試（會寫入 `database.sqlite`） |
| `npm run openapi` | `node generate-openapi.js` | 產生根目錄 `openapi.json` |

重置資料：停止伺服器 → 刪除 `database.sqlite*` 三個檔案 → 重新啟動。

---

## 文件索引

| 文件 | 內容 |
|------|------|
| [`../CLAUDE.md`](../CLAUDE.md) | 專案摘要、常用指令、關鍵規則（給 AI 助手與新成員的入口） |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 目錄結構與每個檔案用途、啟動流程、API 路由總覽、回應格式、認證授權、DB schema、付款流程、前端架構 |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | 命名規則、模組系統、新增 API / middleware / 資料表 / 頁面的步驟、環境變數、JSDoc(OpenAPI) 格式、計畫歸檔流程 |
| [`FEATURES.md`](./FEATURES.md) | 每個功能的行為描述、參數與預設值、業務邏輯、錯誤碼、完成狀態與已知限制 |
| [`TESTING.md`](./TESTING.md) | 測試檔案、執行順序與依賴、輔助函式、撰寫新測試、常見陷阱 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 版本更新日誌 |
| [`plans/`](./plans/) | 進行中的開發計畫；完成後移至 [`plans/archive/`](./plans/archive/) |
