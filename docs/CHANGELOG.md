# 更新日誌

格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)（目前 `package.json` 版本為 `1.0.0`）。

每次功能完成並將計畫移至 `docs/plans/archive/` 時，在 `[Unreleased]` 下記錄變更；發版時把 `[Unreleased]` 改為版本號與日期。

分類：`Added` 新功能｜`Changed` 既有行為變更｜`Fixed` 錯誤修正｜`Removed` 移除｜`Security` 安全性｜`Docs` 文件

---

## [Unreleased]

### Added
- **綠界 ECPay 金流（AIO）**：訂單詳情頁可選「信用卡付款」（信用卡一次付清）、「ATM 轉帳」（ATM 虛擬帳號）或「WebATM（網路ATM）」。
  - `POST /api/orders/:id/ecpay`：建立付款並回傳已簽章（CheckMacValue SHA256）的綠界表單參數；body `paymentMethod` 為 `Credit`（預設）、`ATM` 或 `WebATM`。每次付款嘗試產生新的 `MerchantTradeNo`。
  - `POST /api/ecpay/notify`（ReturnURL，回純文字 `1|OK`）、`POST /ecpay/result`（信用卡 OrderResultURL，302 回訂單頁）。
  - `POST /api/ecpay/payment-info`（ATM PaymentInfoURL）、`POST /ecpay/payment-info-result`（ATM ClientRedirectURL）：接收銀行代碼、虛擬帳號與繳費期限。
  - `POST /api/orders/:id/ecpay/query`：向綠界 QueryTradeInfo 查詢並同步訂單；ATM 缺少帳號時先以 QueryPaymentInfo 補查。
  - 訂單頁「ATM 繳費資訊」卡片（可複製帳號、轉帳金額、期限、逾期提示）；`?payment=pending` 時每 3 秒重新查詢、最多 5 次；後台訂單詳情顯示付款資訊。
  - **WebATM（網路ATM）**：`paymentMethod: 'WebATM'`，即時付款、沿用信用卡的導回與查詢確認流程；訂單頁新增「WebATM（網路ATM）」按鈕，手機（綠界不支援）時停用並提示。
  - 本機不需 ngrok 即可完成信用卡付款與 ATM 取號（瀏覽器導回 + 主動查詢）。
- 新資料表 `payments`（每次付款嘗試一筆，`merchant_trade_no` 唯一；含 `payment_method`、`bank_code`、`v_account`、`expire_date`）。在加入 ATM 前建立的資料庫，啟動時以冪等 ALTER 自動補欄位。
- 新環境變數 `ECPAY_ATM_EXPIRE_DAYS`（ATM 繳費期限天數，1–60，預設 3）；`BASE_URL`、`ECPAY_*` 開始被讀取。
- `src/services/ecpay.js`、`src/routes/ecpayRoutes.js`；測試 `tests/ecpay.test.js`（19 個，含官方 CheckMacValue 測試向量）、`tests/ecpayAtm.test.js`（15 個）、`tests/ecpayWebAtm.test.js`（6 個），綠界一律以 `vi.spyOn(global, 'fetch')` 模擬。全部測試共 72 個。

### Changed
- 訂單詳情頁的「付款成功 / 付款失敗」模擬按鈕改為「信用卡付款」「ATM 轉帳」「WebATM（網路ATM）」與「重新查詢付款狀態」；後台訂單詳情以對照表顯示付款方式（信用卡 / ATM 轉帳 / 網路ATM）；`PATCH /api/orders/:id/pay` 保留但前端不再使用。
- 綠界付款失敗（刷卡失敗、取號失敗、金額不符）時訂單維持 `pending` 可重新付款，不會變成終態 `failed`。
- 訂單詳情（前台 `GET /api/orders/:id`、`POST /api/orders/:id/ecpay/query`，後台 `GET /api/admin/orders/:id`）回應新增 `payment` 欄位（最新一筆付款摘要：`payment_method`、`status`、`bank_code`、`v_account`、`expire_date`、`is_expired`）。
- 訂單仍有未到期的 ATM 繳費帳號時，`POST /api/orders/:id/ecpay` 回 409 `CONFLICT`（避免重複付款；ATM 無法以 API 退款）。
- **付款改由伺服器端 QueryTradeInfo 確認（安全性）**：ReturnURL / OrderResultURL 回呼即使簽章正確，也不會直接把訂單改為已付款，而是觸發 `confirmPayment()` 向綠界查詢。只有 `TradeStatus=1`、是同一筆交易（`MerchantTradeNo`、`MerchantID`）且金額相符，才標記 `paid`；查詢回應的 CheckMacValue 也會驗證。未確認時 notify 回 `0|Not Paid Yet` / `0|QueryTradeInfo Error` 讓綠界重送，result 導向 `?payment=pending`。
- 非正式環境（`ECPAY_ENV≠production`）的 ReturnURL 接受綠界後台模擬付款（`SimulatePaid=1`），以便測試 ATM；這是上一條規則唯一的例外，正式環境不接受。

### Fixed
- ReturnURL 收到 ATM 取號通知（`RtnCode=2`）時會被記為付款失敗；現改為寫入繳費資訊（此問題存在於加入 ATM 之前的回呼處理）。

### Docs
- 新增 `AGENTS.md` 作為專案入口文件（概述、常用指令、關鍵規則、`@docs` 引用）；`CLAUDE.md` 改為只含 `@AGENTS.md`。
- 依原始碼全面校正 `docs/`：綠界 QueryTradeInfo 確認流程、async 處理器寫法、service 層慣例、測試 mock 外部 HTTP、測試數（當時 51 個）、共通 401/403/404 錯誤、驗證規則的型別陷阱、前端行為細節。
- 新增已知限制：購物車/結帳頁顯示的運費 NT$150（小計 < 500）**沒有**計入訂單金額與綠界扣款。
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
