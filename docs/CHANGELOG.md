# 更新日誌

本文件記錄使用者可觀察行為、公開 API、資料模型、開發流程與重要文件變動。專案目前沒有 release tag 或自動版本發布流程；版本資訊依 `package.json` 與 Git 歷史整理，日期使用 `YYYY-MM-DD`。

## [Unreleased]

### Added

- 新增根目錄 `AGENTS.md`，集中專案規則、常用指令與詳細文件引用。
- 新增完整的架構、開發、功能、測試、變更日誌與計畫歸檔文件。
- 明確記錄 JWT／session 雙模式購物車、訂單 transaction、SQLite schema、API envelope、環境變數及 ECPay 本地主動查詢架構。

- 新增 `payments` table，保存每張訂單唯一的 ECPay 商店交易編號、金額 snapshot、查詢次數、provider metadata 與可信付款狀態。
- 新增 ECPay AIO 信用卡結帳：server 產生 SHA-256 CheckMacValue，browser 以 signed form 導至 staging／production cashier。
- 新增 `POST /api/orders/:id/payments/ecpay/verify`；由本機後端呼叫 `QueryTradeInfo/V5`，驗證回應簽章、商店、交易編號及金額後才更新付款與訂單。
- 新增同筆交易預設 600 秒主動查詢節流、10 秒 HTTP timeout、ECPay 專屬錯誤碼及 Node.js >=18 runtime 要求。
- 新增五個 ECPay unit/integration tests，涵蓋官方簽章向量、查詢簽章、checkout form、paid transaction 與舊端點停用；完整 suite 現為 37 tests。

### Changed

- 訂單詳情改為顯示 ECPay 導頁與主動查詢控制，並回傳不含秘密的 payment 摘要。
- 因 localhost 無法接收 Server Notify，付款方式限定為信用卡；`ReturnURL` 不作狀態依據，付款確認只接受 server-side 查詢結果。

### Removed

- 移除可由 client 直接宣告 `success`／`fail` 的 `PATCH /api/orders/:id/pay` 模擬付款端點。

## [1.0.0] - 2026-10-15

對應 Git 初始提交 `9c58b7e`（`Initial commit`）。

### Added

- Express + EJS 單體應用與前台／後台 layout。
- 會員註冊、登入、JWT profile，以及管理員角色授權。
- 公開商品列表、分頁與商品詳情。
- JWT 會員與 `X-Session-Id` 訪客購物車；支援加入、累加、改量、刪除與總價計算。
- 從會員購物車建立訂單；transaction 內建立快照明細、扣減庫存並清空購物車。
- 個人訂單列表／詳情與 `pending → paid|failed` 模擬付款。
- 管理員商品 CRUD、訂單列表／狀態篩選／詳情。
- SQLite schema、管理員 seed 與八筆商品 seed。
- Tailwind CSS 4 主題、Vue 3 CDN 頁面互動、toast 與 localStorage 認證狀態。
- OpenAPI JSDoc 產生器與六個 Vitest/Supertest 整合測試檔。

### 已知限制

- `ECPAY_*` 與 `BASE_URL` 僅存在範例環境設定，沒有執行期整合。
- 測試直接使用根目錄資料庫，沒有 setup／teardown 或每測試隔離。
- 訪客購物車登入後不會搬移至會員購物車。
- 管理端僅能查詢訂單，不能出貨、取消或人工改狀態。

