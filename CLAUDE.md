# CLAUDE.md

## 專案概述
花漾生活 Flower Life（花卉電商）— Node.js + Express 4.16 + better-sqlite3（SQLite, WAL）+ JWT 認證 + EJS 伺服器端版型 + Vue 3（CDN global build）+ Tailwind CSS v4，測試使用 Vitest + Supertest，API 文件以 swagger-jsdoc 從路由註解產生。

同一個 Express 程式同時提供 **REST API（`/api/*`）** 與 **SSR 頁面殼（EJS layout + 前端 Vue 掛載）**，資料庫是專案根目錄下的單一檔案 `database.sqlite`，啟動時自動建表與寫入種子資料。

## 常用指令

| 指令 | 說明 |
|------|------|
| `npm install` | 安裝依賴（better-sqlite3、bcrypt 為原生模組，需能編譯/下載 prebuild） |
| `npm start` | 先 `css:build`（Tailwind 壓縮輸出）再啟動 `node server.js`（port 預設 3001） |
| `npm run dev:server` | 只啟動伺服器（不建 CSS；`public/css/output.css` 不存在時頁面無樣式） |
| `npm run dev:css` | Tailwind watch 模式，輸出 `public/css/output.css` |
| `npm run css:build` | Tailwind 一次性壓縮建置 |
| `npm test` | `vitest run`，依 `vitest.config.js` 指定順序串行執行 6 支測試檔 |
| `npm run openapi` | 掃描 `src/routes/*.js` 的 `@openapi` 註解，輸出根目錄 `openapi.json` |

重置資料庫：停止伺服器後刪除 `database.sqlite`、`database.sqlite-shm`、`database.sqlite-wal`，下次啟動會重建並重新 seed。

## 關鍵規則
- **統一回應格式**：所有 `/api/*` 回應（含錯誤）必須是 `{ data, error, message }`；成功時 `error: null`，失敗時 `data: null` 且 `error` 為大寫錯誤碼（`VALIDATION_ERROR`、`NOT_FOUND`…）。前端 `apiFetch` 與所有測試都依賴這個形狀。
- **命名不對稱是既有契約**：請求 body 用 camelCase（`productId`、`recipientName`），回應與 DB 欄位用 snake_case（`product_id`、`order_no`、`total_amount`）；唯一例外是後台商品 body 的 `image_url`。新增欄位時遵循同一規則，不要「順手統一」而破壞前端/測試。
- **認證有三種模式**：`authMiddleware`（只收 JWT）、`authMiddleware + adminMiddleware`（JWT 且 token 內 `role === 'admin'`）、購物車專用 `dualAuth`（JWT 優先，否則 `X-Session-Id`；帶了無效 JWT 會直接 401，不會退回 session）。頁面路由（`pageRoutes.js`）**沒有**伺服器端權限檢查，權限只在前端 `Auth.requireAuth()/requireAdmin()` 與 API 層把關。
- **測試直接使用開發用的 `database.sqlite`**（沒有獨立測試 DB、沒有清理，會留下測試使用者/訂單並扣減庫存），需 `.env` 內有 `JWT_SECRET`；檔案間串行執行（`fileParallelism: false`）避免 SQLite 鎖衝突。`vitest.config.js` 的 `sequence.files` **不是 Vitest 支援的選項、會被忽略**，實際檔案順序由 Vitest 快取決定——每支測試檔必須在 `beforeAll` 自行建立所需資料，不可依賴其他檔案先執行。
- 同步 DB API：better-sqlite3 全部是同步呼叫，路由處理器不需要 async；多步寫入必須包在 `db.transaction()`（參考建立訂單）。新增/修改 API 時同步更新該路由上方的 `@openapi` JSDoc 註解。
- 功能開發使用 docs/plans/ 記錄計畫；完成後移至 docs/plans/archive/

## 詳細文件
- ./docs/README.md — 項目介紹與快速開始
- ./docs/ARCHITECTURE.md — 架構、目錄結構、資料流
- ./docs/DEVELOPMENT.md — 開發規範、命名規則
- ./docs/FEATURES.md — 功能列表與完成狀態
- ./docs/TESTING.md — 測試規範與指南
- ./docs/CHANGELOG.md — 更新日誌

@docs/README.md
@docs/ARCHITECTURE.md
@docs/DEVELOPMENT.md
@docs/FEATURES.md
@docs/TESTING.md
@docs/CHANGELOG.md
