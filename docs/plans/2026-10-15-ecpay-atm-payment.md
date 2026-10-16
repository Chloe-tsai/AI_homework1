# 綠界 ATM 虛擬帳號付款

- 建立日期：2026-10-15
- 狀態：進行中（程式、測試、文件完成；待實機驗證 B）

## User Story
身為沒有信用卡或不想刷卡的會員，我想要在訂單頁選擇「ATM 轉帳」，取得綠界虛擬帳號並在期限內轉帳，以便完成購買；轉帳成功後訂單會自動變成「已付款」。

## Spec

### 一、背景
- 目前只開放信用卡：建立付款時固定送 `ChoosePayment=Credit`（`src/services/ecpay.js` 的 `buildCheckoutParams`）。
- 付款確認的現行原則：回呼只當通知，**只有 `confirmPayment()`（伺服器呼叫 QueryTradeInfo，`TradeStatus=1` 且金額相符）能把訂單改為 `paid`**。
- ATM 與信用卡不同，是**非同步**付款。依綠界官方規格（2026-10-15 查閱）：
  - [ATM 虛擬帳號付款 2872](https://developers.ecpay.com.tw/2872.md)：`ChoosePayment=ATM`；`ExpireDate` 1–60 天、預設 3 天，例如 7/1 成立、3 天 → 7/4 23:59 截止；`PaymentInfoURL` 是取號結果的 server 通知；`ClientRedirectURL` 在取號後讓瀏覽器帶著繳費資訊導回特店。
  - [取號結果通知 2881](https://developers.ecpay.com.tw/2881.md)：ATM 取號成功 `RtnCode=2`（**不是錯誤**），另帶 `BankCode`、`vAccount`、`ExpireDate`（`yyyy/MM/dd`）；必須回 `1|OK`，否則每 5–15 分鐘重送、每日最多 4 次。綠界提醒：**不可只依賴 ClientRedirectURL**，主要以 PaymentInfoURL 為準。
  - [查詢取號結果 5615](https://developers.ecpay.com.tw/5615.md)：`POST /Cashier/QueryPaymentInfo`（`MerchantID`、`MerchantTradeNo`、`TimeStamp`、`CheckMacValue`），回應帶 `BankCode`/`vAccount`/`ExpireDate` 與 CheckMacValue（必須驗證）；已付款的訂單不回取號結果。
  - 實際轉帳後，綠界才送 `ReturnURL`（`RtnCode=1`）。
  - OrderResultURL **不支援** ATM（[產生訂單 2862](https://developers.ecpay.com.tw/2862.md)）。
  - ATM 付款**不能用 API 退款**，只能從綠界後台處理；轉錯金額、逾期、重複轉帳由銀行端檢核，綠界無法阻擋。
- **測試環境的限制**（[測試介接資訊 2856](https://developers.ecpay.com.tw/2856.md)）：ATM 無法真的轉帳，只能在綠界測試後台（`vendor-stage.ecpay.com.tw`，帳號 `stagetest3` / `test1234`）的「一般訂單查詢 > 全方位金流訂單」對已取號的訂單按「模擬付款」。這只會送出一個 `SimulatePaid=1` 的 ReturnURL 通知，**不會改變綠界端的訂單狀態**，所以 QueryTradeInfo 永遠不會回 `TradeStatus=1`。

已決定（2026-10-15）：
1. **付款方式在我方訂單頁選擇**：兩個按鈕「信用卡付款」、「ATM 轉帳」，送出固定的 `ChoosePayment=Credit` 或 `ATM`。不用 `ALL`；綠界建議固定付款方式，避免日後新增的方式漏接通知。
2. **測試環境接受模擬付款**：`ECPAY_ENV !== 'production'` 時，CheckMacValue 正確、`RtnCode=1`、`SimulatePaid=1` 的 ReturnURL 通知可以標記 paid（仍核對金額，並記錄 `simulate_paid=1`）。正式環境一律只認 QueryTradeInfo，`SimulatePaid=1` 的通知只記 log。

### 二、實作方式

#### 1. 資料庫（`src/database.js`）
`payments` 表已存在，`CREATE TABLE IF NOT EXISTS` 不會改它，所以在 `initializeDatabase()` 加入**冪等的 ALTER**：先用 `PRAGMA table_info(payments)` 檢查欄位是否存在，不存在才 `ALTER TABLE payments ADD COLUMN`。

| 新欄位 | 型別 | 說明 |
|--------|------|------|
| `payment_method` | TEXT NOT NULL DEFAULT `'Credit'` | `'Credit'` 或 `'ATM'`；舊資料自動補為 `'Credit'`。值由程式驗證，不加 CHECK（SQLite 對 ADD COLUMN 的 CHECK 支援有限） |
| `bank_code` | TEXT | 綠界 `BankCode`（3 碼） |
| `v_account` | TEXT | 綠界 `vAccount`（虛擬帳號，最長 16 碼） |
| `expire_date` | TEXT | 綠界 `ExpireDate`，原樣保存 `yyyy/MM/dd`（台灣時間當天 23:59 截止） |

`payments.status` 維持 `pending/paid/failed`，不新增狀態。「已取號、待繳費」以 `status='pending'` 且 `v_account` 不為空表示，避免改 CHECK 約束需要重建表。新建的資料庫也直接在 `CREATE TABLE` 中包含這 4 個欄位。

#### 2. 綠界 service（`src/services/ecpay.js`）

| 函式 | 變更 |
|------|------|
| `getConfig()` | 新增 `atmExpireDays`（讀 `ECPAY_ATM_EXPIRE_DAYS`，限制在 1–60，預設 3）、`paymentInfoQueryUrl`（`/Cashier/QueryPaymentInfo`） |
| `buildCheckoutParams(order, items, merchantTradeNo, method)` | 新增 `method` 參數。`Credit`：維持現狀（含 `OrderResultURL`）。`ATM`：`ChoosePayment=ATM`、`ExpireDate`、`PaymentInfoURL=${BASE_URL}/api/ecpay/payment-info`、`ClientRedirectURL=${BASE_URL}/ecpay/payment-info-result`，**不送** `OrderResultURL`（ATM 不支援） |
| `queryPaymentInfo(merchantTradeNo)`（新） | 與 `queryTradeInfo` 相同模式：簽章、POST、解析 URL-encoded、**驗證回應 CheckMacValue**、比對 `MerchantTradeNo`/`MerchantID` |
| `saveAtmInfo({ merchantTradeNo, tradeNo, bankCode, vAccount, expireDate })`（新） | 在 transaction 中寫入 `bank_code/v_account/expire_date/trade_no`。只更新 `payment_method='ATM'` 且 `status='pending'` 的列；重複通知寫入相同值，結果冪等 |
| `isAtmActive(payment, now)`（新） | `payment_method='ATM'`、`status='pending'`、有 `v_account`，且台灣時間尚未超過 `expire_date` 23:59:59 → true |
| `applyPaymentResult` | 不變（已會核對金額，並可寫 `simulate_paid`） |
| `confirmPayment` | 不變。ATM 尚未轉帳時 `TradeStatus=0` → `unpaid` |

#### 3. API 變更

**`POST /api/orders/:id/ecpay`（`orderRoutes.js`，JWT）**
- 新增選填 body `paymentMethod`（camelCase）：`'Credit'`（預設，維持向後相容）或 `'ATM'`；其他值 → 400 `VALIDATION_ERROR / paymentMethod 必須為 Credit 或 ATM`。
- **防止重複付款**：若該訂單已有 `isAtmActive` 的 ATM 付款（帳號未過期），不論新選哪種方式都回 409 `CONFLICT / 此訂單已有尚未到期的 ATM 繳費帳號，請完成轉帳或待期限過後再改用其他方式`。理由：消費者可能兩邊都付，而 ATM 付款無法用 API 退款。
- `payments` 新列寫入 `payment_method`。
- 驗證順序：404 → `INVALID_STATUS`（非 pending）→ `paymentMethod` 格式 → 409。

**`GET /api/orders/:id`、`POST /api/orders/:id/ecpay/query`、`GET /api/admin/orders/:id`**
- 回應 `data` 新增 `payment`：該訂單**最新一筆**付款的摘要，沒有付款時為 `null`。欄位：`payment_method`、`status`、`bank_code`、`v_account`、`expire_date`、`is_expired`，全為 snake_case。不回傳 `merchant_trade_no` 以外的綠界內部欄位。

**`POST /api/orders/:id/ecpay/query`**
- 最新的 pending 付款若是 ATM 且**還沒有 `v_account`**：先呼叫 `queryPaymentInfo()` 補取號資訊。這是給「沒有公開網址、瀏覽器也沒導回」時用的；`RtnCode=2` → `saveAtmInfo`。
- 然後照舊呼叫 `confirmPayment()`。ATM 未轉帳時為 `unpaid`，`message` 為「尚未完成付款」。

**`POST /api/ecpay/payment-info`（新，PaymentInfoURL，`ecpayRoutes.js`，無 JWT）**

| 情境 | 處理 | 回應 |
|------|------|------|
| CheckMacValue 錯誤 | 不處理 | `0\|CheckMacValue Error` |
| `RtnCode='2'`（取號成功） | `saveAtmInfo` | `1\|OK` |
| 其他 `RtnCode`（取號失敗） | `applyPaymentResult` 記錄失敗，訂單維持 pending | `1\|OK` |
| 查無 `MerchantTradeNo` | log | `1\|OK` |

**`POST /ecpay/payment-info-result`（新，ClientRedirectURL，瀏覽器帶回）**
- 驗證 CheckMacValue → `RtnCode='2'` 時 `saveAtmInfo` → 302 `/orders/:id?payment=atm`。
- 失敗 → 302 `/orders/:id?payment=failed`；簽章錯或查無付款 → `/orders?payment=failed`。
- 訂單 id 一律取自 `payments.order_id`，不採信 `CustomField1`。

**`POST /api/ecpay/notify`（ReturnURL）修改**

| 情境 | 現在 | 修改後 |
|------|------|--------|
| `RtnCode='2'`（防禦：取號通知誤送到 ReturnURL） | 被當成失敗（**錯誤**） | 當成取號通知 → `saveAtmInfo`，回 `1\|OK` |
| `RtnCode='1'` 且 `SimulatePaid='1'`、`ECPAY_ENV≠production` | 走 `confirmPayment`，會回 `0\|Not Paid Yet` | `applyPaymentResult`（核對金額，寫入 `simulate_paid=1`）→ 回 `1\|OK` |
| `RtnCode='1'` 且 `SimulatePaid='1'`、正式環境 | 同上 | 不變更狀態、記 log，回 `1\|OK`（不要求重送） |
| `RtnCode='1'` 一般通知 | `confirmPayment` | 不變 |

#### 4. 前端
**`views/pages/order-detail.ejs` + `public/js/pages/order-detail.js`**
- 訂單 `pending` 且沒有有效的 ATM 帳號時，顯示兩個按鈕：「信用卡付款」與「ATM 轉帳」。`payWithEcpay(method)` 送出 `{ paymentMethod }`。
- 最新付款是有效的 ATM 帳號時，改顯示「ATM 繳費資訊」卡片：銀行代碼、虛擬帳號（附「複製」按鈕）、繳費期限、金額，以及「已轉帳？重新查詢付款狀態」。此時隱藏付款按鈕，與後端的 409 規則一致。
- ATM 帳號已過期（`is_expired`）時顯示「繳費期限已過」，並重新顯示兩個付款按鈕。
- 新增 `paymentMessages.atm`：「已取得 ATM 繳費帳號，請於期限內完成轉帳」。
- `?payment=atm` 時**不跑** 5 次自動重試，因為轉帳是之後才發生；只在 ATM 帳號尚未取得時查詢 1 次，用來補取號資訊。
- 測試環境提示加上：「ATM 測試：取號後至綠界測試後台模擬付款（需公開網址）」。

**`public/js/pages/admin-orders.js` / `views/pages/admin/orders.ejs`**：詳情 modal 顯示付款方式與 ATM 帳號、期限（唯讀）。

#### 5. 設定
- `.env.example` 新增 `ECPAY_ATM_EXPIRE_DAYS=3`，並說明：ATM 取號在 localhost 可完成（透過瀏覽器導回或 QueryPaymentInfo）；**模擬付款要讓 ReturnURL 收得到，需要用 ngrok 等工具把 `BASE_URL` 設為公開的 https 網址**。

#### 6. 邊界情況
| 情況 | 行為 |
|------|------|
| 消費者在綠界頁面沒選銀行就離開 | ATM 付款列為 pending 且沒有帳號 → 不擋重新付款（`isAtmActive` 為 false） |
| 重複收到 PaymentInfoURL | `saveAtmInfo` 冪等 |
| 先收到 ReturnURL `RtnCode=2` 再收到 PaymentInfoURL | 都只寫入取號資訊，結果相同 |
| 逾期未轉帳 | 綠界不會通知；訂單維持 pending，前端顯示已逾期並可重新付款，後端 `isAtmActive` 以 `expire_date` 判斷 |
| 正式環境 | 不接受 `SimulatePaid=1`；`paid` 只來自 QueryTradeInfo |
| 金額不符的模擬通知 | `applyPaymentResult` 記為 failed，訂單維持 pending |
| 舊的信用卡付款列 | ALTER 後 `payment_method` 自動為 `'Credit'`，行為不變 |

### 三、驗證方式

#### 1. 自動化測試（新檔 `tests/ecpayAtm.test.js`，可獨立執行；用 `vi.spyOn(global, 'fetch')` 模擬綠界，不連外網）
沿用 `ecpay.test.js` 的 `signedCallback` / `mockQueryTradeInfo` 寫法，在檔案內定義或抽到 `tests/setup.js`；另外新增 `mockQueryPaymentInfo`。

| # | 情境 | 預期 |
|---|------|------|
| 1 | `paymentMethod: 'ATM'` 建立付款 | 200；`params.ChoosePayment='ATM'`、`ExpireDate='3'`、有 `PaymentInfoURL`/`ClientRedirectURL`、**沒有** `OrderResultURL`；CheckMacValue 驗證通過 |
| 2 | 不帶 `paymentMethod` | 仍為 `Credit`（向後相容） |
| 3 | `paymentMethod: 'Cash'` | 400 `VALIDATION_ERROR` |
| 4 | PaymentInfoURL `RtnCode=2` | `1\|OK`；`GET /api/orders/:id` 的 `payment` 有 `bank_code`/`v_account`/`expire_date`，`payment_method='ATM'`；訂單仍 pending |
| 5 | 同一個 PaymentInfoURL 再送一次 | `1\|OK`，資料不變（冪等） |
| 6 | PaymentInfoURL 簽章錯誤 | 不是 `1\|OK`；沒有寫入帳號 |
| 7 | 已有有效 ATM 帳號時再建立付款（不論 ATM 或 Credit） | 409 `CONFLICT` |
| 8 | ATM 帳號已過期（直接改 DB 的 `expire_date` 為昨天）再建立付款 | 200，允許重新付款；`payment.is_expired=true` |
| 9 | ClientRedirectURL `RtnCode=2` | 302 `/orders/:id?payment=atm`，並寫入帳號 |
| 10 | ReturnURL `RtnCode=2`（誤送） | `1\|OK`、寫入帳號，**付款列不會變成 failed** |
| 11 | 沒有帳號時呼叫 query，模擬 QueryPaymentInfo 回 `RtnCode=2` | 補上帳號；QueryTradeInfo `TradeStatus=0` → 訂單仍 pending、message「尚未完成付款」 |
| 12 | 模擬付款通知 `RtnCode=1`、`SimulatePaid=1`（`ECPAY_ENV=staging`） | `1\|OK`、訂單 paid、`simulate_paid=1`；**fetch 沒有被呼叫** |
| 13 | 同 12，但暫時把 `process.env.ECPAY_ENV` 設為 `production`（測試後還原） | `1\|OK`、訂單**維持 pending** |
| 14 | 模擬付款但 `TradeAmt` 不符 | 訂單維持 pending |
| 15 | ATM 一般付款通知 `RtnCode=1`（非模擬），QueryTradeInfo `TradeStatus=1` | paid（走既有 `confirmPayment`） |
| 16 | 他人訂單、未登入 | 404 / 401 |
| 17 | 既有 `tests/ecpay.test.js`（19 個）與其他測試 | 全部照常通過；ALTER 在既有 DB 上重複啟動不出錯 |

執行：先 `npx vitest run tests/ecpayAtm.test.js`，再 `npm test`。預期 8 個檔案全部通過（51 + 新增約 16 個）。

#### 2. 綠界測試環境實機驗證
**A. 不用 ngrok（localhost，驗證取號）**
1. `npm start`，開啟 `http://localhost:3001`，登入 → 加入購物車 → 結帳 → 訂單頁按「ATM 轉帳」。
2. 在綠界頁面選一家銀行 → 取號完成 → 瀏覽器經 ClientRedirectURL 回到 `/orders/:id?payment=atm`。
3. **預期**：畫面顯示銀行代碼、虛擬帳號、期限；付款按鈕隱藏；資料庫 `payments` 該列為 `payment_method='ATM'`，且有 `v_account`。
4. 另測：在綠界取號頁直接關閉、不導回 → 回訂單頁按「重新查詢付款狀態」→ 透過 QueryPaymentInfo 補上帳號。

**B. 用 ngrok（驗證付款完成）**
1. `ngrok http 3001`，把 `.env` 的 `BASE_URL` 設為 ngrok 的 https 網址並重啟伺服器，再用 ngrok 網址重做 A 的取號。
2. 登入 `https://vendor-stage.ecpay.com.tw`（`stagetest3` / `test1234`，統編 `00000000`）→ 一般訂單查詢 > 全方位金流訂單 → 以 `FL...` 查詢 → 「模擬付款」。
3. **預期**：伺服器 log 收到 ReturnURL，回 `1|OK`（綠界後台顯示通知成功）；訂單頁重新查詢後為「已付款」；`payments.simulate_paid=1`。
4. 信用卡流程再走一次（卡號 `4311-9522-2222-2222` / 3D `1234`），確認沒有被影響；這次也一併補上「查詢確認」改版後尚未做的實機驗證。

#### 3. 其他檢查
- `npm run openapi`：新增的 `/api/ecpay/payment-info`、`/ecpay/payment-info-result` 都產生，body `paymentMethod` 有寫在 `/api/orders/{id}/ecpay`。
- 確認 `.env` 改回 `BASE_URL=http://localhost:3001`。

### 四、文件更新
- `AGENTS.md`：綠界規則改為「只有 `confirmPayment()` 能標記 paid；**例外**：非正式環境接受 `SimulatePaid=1` 的 ReturnURL」，並註明 ATM 的 `RtnCode=2` 不是錯誤。
- `docs/ARCHITECTURE.md`：§4 路由表新增 2 條；§7 `payments` 新欄位與 ALTER 方式；§8.2 加入 ATM 流程圖（取號 → 繳費資訊 → 轉帳 → 通知）。
- `docs/FEATURES.md`：§4.5 新增 ATM 小節，包含 body、409 規則、`payment` 欄位、各端點回應、測試方式；總覽表新增一列。
- `docs/DEVELOPMENT.md`：環境變數表新增 `ECPAY_ATM_EXPIRE_DAYS`；在 §6 以本次 ALTER 作為「保留資料加欄位」的實例。
- `docs/TESTING.md`：新增測試檔一列、更新總數、說明 `ECPAY_ENV` 切換測試。
- `docs/CHANGELOG.md`：Added（ATM 付款）、Changed（訂單詳情新增 `payment`、ReturnURL 處理 `RtnCode=2`）。
- 完成後把本計畫移到 `docs/plans/archive/`。

## Tasks
- [x] DB：`payments` 新增 4 欄位（新建表 + 冪等 ALTER）
- [x] service：`buildCheckoutParams` 依付款方式組參數、`queryPaymentInfo`、`saveAtmInfo`、`isAtmActive`、`getConfig` 新設定
- [x] API：`POST /:id/ecpay` 的 `paymentMethod` 與 409；訂單詳情、查詢、後台詳情新增 `payment`；query 補取號
- [x] 回呼：新增 PaymentInfoURL、ClientRedirectURL；ReturnURL 處理 `RtnCode=2` 與測試環境的 `SimulatePaid=1`
- [x] `@openapi` 註解 + `npm run openapi`
- [x] 前端：付款方式按鈕、ATM 繳費資訊卡片、過期狀態、`?payment=atm`；後台詳情顯示付款資訊
- [x] 測試 `tests/ecpayAtm.test.js`（15 個，可獨立執行）＋ `npm test` 66 個全數通過
- [x] 實機驗證 A：localhost 取號成功（第一銀行 007、虛擬帳號、期限 3 天），ClientRedirectURL 導回 `?payment=atm`；真實 QueryPaymentInfo 回 `RtnCode=2`、`ExpireDate=yyyy/MM/dd`、簽章驗證通過；查詢付款狀態為未付款；409 生效
- [x] 信用卡重測：付款後立即經 QueryTradeInfo 確認為 paid（`rtn_msg=QueryTradeInfo TradeStatus=1`）
- [ ] 實機驗證 B（需使用者操作）：ngrok + 綠界測試後台「模擬付款」→ ReturnURL 收到 `SimulatePaid=1` → 訂單 paid、`simulate_paid=1`
- [x] 更新 AGENTS / ARCHITECTURE / FEATURES / DEVELOPMENT / TESTING / CHANGELOG（本計畫待驗證 B 完成後移至 archive）
