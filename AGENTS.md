# AGENTS.md

## 專案概述
花漾生活 Flower Life（花卉電商）— Node.js + Express 4.16 + better-sqlite3（SQLite, WAL）+ JWT 認證 + EJS 伺服器端版型 + Vue 3（CDN global build）+ Tailwind CSS v4 + 綠界 ECPay AIO 金流（信用卡一次付清、ATM 虛擬帳號、WebATM；預設測試環境），測試使用 Vitest + Supertest，API 文件以 swagger-jsdoc 從路由註解產生。

同一個 Express 程式同時提供 **REST API（`/api/*`）**、**綠界回呼（`/api/ecpay/notify`、`/api/ecpay/payment-info`、`/ecpay/result`、`/ecpay/payment-info-result`）** 與 **SSR 頁面殼（EJS layout + 前端 Vue 掛載）**。資料庫是專案根目錄下的單一檔案 `database.sqlite`，啟動時自動建表（6 張，含 `payments`）並寫入種子資料。

## 常用指令

| 指令 | 實際執行 | 說明 |
|------|---------|------|
| `npm install` | — | 安裝依賴（better-sqlite3、bcrypt 為原生模組，需能編譯/下載 prebuild） |
| `npm start` | `npm run css:build && node server.js` | 建 CSS 後啟動（port 預設 3001；缺 `JWT_SECRET` 直接 `exit(1)`） |
| `npm run dev:server` | `node server.js` | 只啟動伺服器（不建 CSS；`public/css/output.css` 不存在時頁面無樣式；改後端需手動重啟） |
| `npm run dev:css` | `npx @tailwindcss/cli ... --watch` | Tailwind watch，輸出 `public/css/output.css` |
| `npm run css:build` | `npx @tailwindcss/cli ... --minify` | Tailwind 一次性壓縮建置 |
| `npm test` | `vitest run` | 串行執行 9 支測試檔（順序由 Vitest 決定，`sequence.files` 無效；會寫入 `database.sqlite`） |
| `npm run openapi` | `node generate-openapi.js` | 掃描 `src/routes/*.js` 的 `@openapi` 註解，輸出根目錄 `openapi.json`（勿提交） |

重置資料庫：停止伺服器後刪除 `database.sqlite`、`database.sqlite-shm`、`database.sqlite-wal`，下次啟動會重建並重新 seed。

## 關鍵規則
- **統一回應格式**：所有 `/api/*` 回應（含錯誤）必須是 `{ data, error, message }`；成功時 `error: null`，失敗時 `data: null` 且 `error` 為大寫錯誤碼（`VALIDATION_ERROR`、`NOT_FOUND`…）。前端 `apiFetch` 與所有測試都依賴這個形狀。**唯一例外**是綠界回呼：`POST /api/ecpay/notify` 回純文字 `1|OK`（或 `0|...` 讓綠界重送，HTTP 一律 200），`POST /ecpay/result` 回 302；兩者無 JWT，以 CheckMacValue 驗證。
- **命名不對稱是既有契約**：請求 body 用 camelCase（`productId`、`recipientName`），回應與 DB 欄位用 snake_case（`product_id`、`order_no`、`total_amount`）。例外：後台商品 body 的 `image_url`、分頁的 `pagination.totalPages`、綠界付款 `params`（綠界規定的 PascalCase）。新增欄位遵循同一規則，不要「順手統一」而破壞前端/測試。
- **認證有三種模式**：`authMiddleware`（只收 JWT）、`authMiddleware + adminMiddleware`（JWT 且 token 內 `role === 'admin'`，角色以 token 為準不查 DB）、購物車專用 `dualAuth`（JWT 優先，否則 `X-Session-Id`；帶了無效 JWT 直接 401，不退回 session；訪客購物車登入後不合併）。頁面路由（`pageRoutes.js`）**沒有**伺服器端權限檢查，只靠前端 `Auth.requireAuth()/requireAdmin()` 與 API 層把關。
- **綠界 ECPay（AIO：信用卡 + ATM + WebATM）**：HashKey/HashIV 只能在後端；`MerchantTradeNo` 永久不可重複（每次付款嘗試產生新的並存入 `payments`，含 `payment_method`）。**回呼只當通知，只有 `confirmPayment()`（伺服器端呼叫 QueryTradeInfo，`TradeStatus=1` 且金額相符）能把訂單改為 `paid`**；唯一例外：非正式環境（`ECPAY_ENV≠production`）接受後台模擬付款（`SimulatePaid=1`）的 ReturnURL。ATM 的 `RtnCode=2` 是「取號成功」**不是失敗**；訂單有未到期的 ATM 帳號時禁止再建立付款（409）。付款失敗訂單維持 `pending` 可重付。ReturnURL / PaymentInfoURL 只在 `BASE_URL` 為公開 80/443 網址時才收得到。改金流前先參考 `.claude/skills/ecpay/` 與官方規格。
- **同步 DB、少數 async 處理器**：better-sqlite3 全部是同步呼叫，多步寫入必須包在 `db.transaction()`（參考建立訂單、`applyPaymentResult`）。需要對外 HTTP 的處理器（目前只有綠界相關 3 個）是 async——Express 4 不會接住 rejected promise，必須 try/catch + `next(err)` 或用 `asyncHandler`。新增/修改 API 時同步更新路由上方的 `@openapi` 註解。
- **測試直接使用開發用的 `database.sqlite`**（無獨立測試 DB、不清理，會留下測試使用者/訂單並扣庫存），需 `.env` 有 `JWT_SECRET`；檔案間串行（`fileParallelism: false`）。`sequence.files` **不是 Vitest 支援的選項**，每支測試檔必須在 `beforeAll` 自行建立資料。對外 HTTP（綠界）一律用 `vi.spyOn(global, 'fetch')` 模擬，不連外網。
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
