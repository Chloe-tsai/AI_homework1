# 更新日誌

格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)（目前 `package.json` 版本為 `1.0.0`）。

每次功能完成並將計畫移至 `docs/plans/archive/` 時，在 `[Unreleased]` 下記錄變更；發版時把 `[Unreleased]` 改為版本號與日期。

分類：`Added` 新功能｜`Changed` 既有行為變更｜`Fixed` 錯誤修正｜`Removed` 移除｜`Security` 安全性｜`Docs` 文件

---

## [Unreleased]

### Docs
- 新增 `CLAUDE.md` 與 `docs/`（README、ARCHITECTURE、DEVELOPMENT、FEATURES、TESTING、CHANGELOG）以及 `docs/plans/`、`docs/plans/archive/` 計畫目錄。
- 記錄已知限制：
  - 刪除仍在購物車中的商品會回 500（`cart_items` FK）
  - 登入密碼錯誤時前端全域 401 處理會蓋掉錯誤訊息並遺失 `?redirect=`
  - 訪客購物車在登入後不會合併
  - `vitest.config.js` 的 `sequence.files` 不是有效的 Vitest 選項
  - 測試與開發共用 `database.sqlite`

---

## [1.0.0] - 2026-10-15

初始版本（commit `9c58b7e` Initial commit）。

### Added
- **基礎架構**：Express 4.16 應用（`app.js` / `server.js`），統一回應格式 `{ data, error, message }`，`/api` 404 JSON 與頁面 404、集中式 `errorHandler`（遮蔽 500 訊息）。
- **資料庫**：better-sqlite3（WAL、foreign_keys）；`users`、`products`、`cart_items`、`orders`、`order_items` 五張表；自動 seed 管理員帳號與 8 筆花卉商品。
- **會員認證**：註冊、登入（bcrypt + JWT HS256、7 天有效）、個人資料；`authMiddleware`、`adminMiddleware`。
- **商品**：公開商品列表（分頁，limit 上限 100）與詳情。
- **購物車**：JWT / `X-Session-Id` 雙模式認證；加入（同商品累加、庫存檢查）、查看（含總額）、更新數量、移除。
- **訂單**：由會員購物車建立訂單（transaction：寫入訂單與明細快照、扣庫存、清空購物車）、訂單列表、詳情、模擬付款（pending → paid / failed）。
- **後台**：商品 CRUD（刪除時檢查 pending 訂單）、訂單列表（狀態篩選、分頁）與詳情（含下單者）。
- **前端**：EJS 前台 / 後台版型，Vue 3（CDN）頁面：首頁、商品詳情、購物車、結帳、登入/註冊、我的訂單、訂單詳情、後台商品管理、後台訂單管理；Tailwind CSS v4 自訂色票。
- **API 文件**：各路由 `@openapi` 註解與 `npm run openapi` 產生 `openapi.json`。
- **測試**：Vitest + Supertest，6 支測試檔共 32 個 API 整合測試。
- **環境變數範本**：`.env.example`（含預留的 ECPay 綠界設定，尚未實作）。
