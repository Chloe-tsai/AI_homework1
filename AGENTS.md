# AGENTS.md

## 專案概述

花漾生活（`backend-project`）— 以 Node.js、Express 4、EJS、Vue 3 CDN、Tailwind CSS 4 與 SQLite（`better-sqlite3`）實作的單體式花卉電商示範專案。後端同時提供 HTML 頁面與 REST API；登入會員使用 HS256 JWT，購物車另支援 `X-Session-Id` 訪客模式。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `npm install` | 依 `package-lock.json` 安裝依賴。 |
| `npm start` | 先壓縮編譯 Tailwind CSS，再以 `node server.js` 啟動服務。 |
| `npm run dev:server` | 只啟動 Express；不會自動編譯或監看 CSS。 |
| `npm run dev:css` | 監看 `public/css/input.css` 並產生 `public/css/output.css`。開發時需與伺服器分開執行。 |
| `npm run css:build` | 單次產生壓縮版 `public/css/output.css`。 |
| `npm test` | 以 Vitest 依序執行整合測試。注意：目前會直接建立／修改根目錄的 `database.sqlite`。 |
| `npm run openapi` | 從路由 JSDoc 產生根目錄 `openapi.json`。 |

## 關鍵規則

- 專案採 CommonJS（`require`／`module.exports`）；只有 `vitest.config.js` 使用 ESM 語法。新增執行期模組時維持 CommonJS，除非同步規劃完整遷移。
- API 回應固定為 `{ data, error, message }`；成功時 `error: null`，失敗時 `data: null`。新增端點不得另創不相容 envelope。
- `/api/orders` 只接受 JWT；`/api/cart` 才支援 JWT／`X-Session-Id` 雙模式。若 Bearer header 存在但無效，不得退回 session，必須回傳 401。
- 訂單建立、明細快照、扣庫存與清購物車必須維持在同一個同步 SQLite transaction；任何一步失敗都應整筆回滾。
- 付款狀態只能由 server-side ECPay `QueryTradeInfo` 的已驗簽結果更新；不得接受 client 自行宣告成功／失敗，也不得把 HashKey/HashIV 傳到瀏覽器。
- 不要提交 `.env`、`database.sqlite*`、`public/css/output.css` 或 `openapi.json`。修改 API JSDoc 後可本機重建規格，但產物目前是忽略檔。
- 功能開發使用 `docs/plans/` 記錄計畫；完成後移至 `docs/plans/archive/`，並同步更新功能清單與變更日誌。

## 詳細文件

- @docs/README.md — 項目介紹、快速開始、技術棧與文件索引
- @docs/ARCHITECTURE.md — 架構、逐檔目錄、啟動流程、API、資料流與資料庫 schema
- @docs/DEVELOPMENT.md — 開發規範、命名規則、環境變數與擴充流程
- @docs/FEATURES.md — 功能列表、完成狀態、行為、輸入與錯誤情境
- @docs/TESTING.md — 測試規範、執行順序、輔助函式與已知陷阱
- @docs/CHANGELOG.md — 版本與文件更新日誌

