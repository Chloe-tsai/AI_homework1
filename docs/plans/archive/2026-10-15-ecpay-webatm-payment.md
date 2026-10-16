# 綠界 WebATM（網路ATM）付款

- 建立日期：2026-10-15
- 狀態：已完成

## User Story
身為使用電腦、手邊有晶片金融卡與讀卡機的會員，我想要在訂單頁選擇「WebATM」，直接透過銀行的網路 ATM 即時轉帳付款，以便不用刷卡、也不用另外去 ATM 轉帳就完成購買。

## Spec

### 一、背景
- 目前訂單頁有兩種綠界付款方式：信用卡一次付清（`ChoosePayment=Credit`）與 ATM 虛擬帳號（`ChoosePayment=ATM`，見 `2026-10-15-ecpay-atm-payment.md`）。
- 依綠界官方規格 [WebATM 11031](https://developers.ecpay.com.tw/11031.md)，以及 skill 的 `guides/01`、`guides/15 §20`（2026-10-15 查閱）：
  - `ChoosePayment=WebATM`，其他必填參數與信用卡相同（`PaymentType=aio`、`EncryptType=1`，前端以 form POST 導向）。
  - **即時付款**：OrderResultURL **有支援**，不支援的只有銀聯卡與 ATM/CVS/BARCODE；付款完成後同樣送 ReturnURL（`RtnCode=1`）。和信用卡同一類，不像 ATM 需要取號。
  - **手機瀏覽器不支援**，需要桌面瀏覽器、晶片金融卡與讀卡機。
  - `ChooseSubPayment` 可指定銀行（設定後消費者不能改選），板信銀行每月例行維護期間建單會失敗。本計畫不指定銀行，由消費者在綠界頁面選。
  - 付款通知的 `PaymentType` 為 `WebATM_<銀行>`；若設 `NeedExtraPaidInfo=Y`，另回傳 `WebATMAccBank`、`WebATMAccNo`、`WebATMBankName`。本計畫維持 `N`。
  - 和 ATM 一樣不支援 API 退款（`DoAction` 僅限信用卡）。
- **已實測（2026-10-15）**：用目前的簽章程式送出 `ChoosePayment=WebATM` 到綠界測試環境，綠界接受，付款頁顯示「網路ATM」與 11 家銀行（兆豐、土銀、新光、元大、永豐、台銀、中信、玉山、一銀、北富邦、台新、其他）。說明為「透過您的晶片卡及讀卡機，登入銀行的網路ATM進行繳費」。**測試環境沒有提供測試卡號或模擬銀行頁的說明**，所以實機能否完成付款要在驗證時確認（見三-2）。

### 二、實作方式
因為 WebATM 是即時付款，可以完全沿用信用卡的流程：OrderResultURL 導回，以及 `confirmPayment()` 由伺服器呼叫 QueryTradeInfo 確認。改動很小。

#### 1. 綠界 service（`src/services/ecpay.js`）
| 項目 | 變更 |
|------|------|
| `PAYMENT_METHODS` | `['Credit', 'ATM']` → `['Credit', 'ATM', 'WebATM']` |
| `buildCheckoutParams` | 不需修改邏輯：非 ATM 的方式本來就帶 `OrderResultURL`，`ChoosePayment` 直接用傳入的方式。只更新註解，加上 WebATM 規格連結 |
| `confirmPayment` / `applyPaymentResult` / `summarizePayment` | 不變 |

#### 2. API（`src/routes/orderRoutes.js`）
- `POST /api/orders/:id/ecpay` 的 `paymentMethod` 允許 `'WebATM'`；錯誤訊息改為 `paymentMethod 必須為 Credit、ATM 或 WebATM`。
- 409 規則不變：訂單有未到期的 ATM 帳號時，選 WebATM 也一樣被擋，避免重複付款。
- 更新 `@openapi`：`enum: [Credit, ATM, WebATM]`。

#### 3. 回呼（`src/routes/ecpayRoutes.js`）
不需修改。WebATM 的 ReturnURL（`RtnCode=1`）走 `confirmPayment()`，OrderResultURL 走既有的 `/ecpay/result`，非正式環境的 `SimulatePaid=1` 規則也適用。

#### 4. 前端
- **`views/pages/order-detail.ejs` / `public/js/pages/order-detail.js`**
  - 付款按鈕新增第三個「WebATM（網路ATM）」，與既有兩個並列，按下後呼叫 `payWithEcpay('WebATM')`。
  - 按鈕下方說明「需使用電腦、晶片金融卡與讀卡機」。
  - **手機不支援**：以 `navigator.userAgent` 判斷手機或平板（`/Android|iPhone|iPad|iPod|Mobile/i`）時停用按鈕，並顯示「WebATM 不支援手機，請改用電腦或其他付款方式」。
- **後台 `views/pages/admin/orders.ejs`**：付款方式顯示改為對照表 `{ Credit: '信用卡', ATM: 'ATM 轉帳', WebATM: '網路ATM' }`。目前只判斷 ATM，WebATM 會被誤顯示為「信用卡」。

#### 5. 資料庫
不需修改。`payments.payment_method` 沒有 CHECK 約束，直接存 `'WebATM'`。

#### 6. 邊界情況
| 情況 | 行為 |
|------|------|
| 手機上直接呼叫 API 建立 WebATM 付款 | 後端不擋（無法可靠判斷裝置），綠界頁面會告知不支援；消費者可回訂單頁改用其他方式 |
| 消費者在銀行頁面沒付款就離開 | 付款列維持 pending，訂單 pending，可重新付款（WebATM 沒有帳號，不會觸發 409） |
| 付款成功但瀏覽器沒導回 | 同信用卡：ReturnURL（需公開網址）或訂單頁「重新查詢付款狀態」走 QueryTradeInfo |
| 付款失敗（`RtnCode≠1`） | 記為 failed，訂單維持 pending |

### 三、驗證方式

#### 1. 自動化測試（新檔 `tests/ecpayWebAtm.test.js`，可獨立執行；`vi.spyOn(global, 'fetch')` 模擬綠界）
| # | 情境 | 預期 |
|---|------|------|
| 1 | `paymentMethod: 'WebATM'` 建立付款 | 200；`ChoosePayment='WebATM'`、**有** `OrderResultURL`、**沒有** `ExpireDate`/`PaymentInfoURL`/`ClientRedirectURL`；CheckMacValue 驗證通過；訂單詳情 `payment.payment_method='WebATM'` |
| 2 | `paymentMethod: 'Cash'` | 400 `VALIDATION_ERROR`，訊息包含 WebATM |
| 3 | 訂單已有未到期 ATM 帳號時選 WebATM | 409 `CONFLICT` |
| 4 | ReturnURL `RtnCode=1`（`PaymentType=WebATM_TAISHIN`），QueryTradeInfo `TradeStatus=1` | `1\|OK`、訂單 paid、fetch 呼叫 1 次 |
| 5 | OrderResultURL 成功，但 QueryTradeInfo `TradeStatus=0` | 302 `?payment=pending`，訂單仍 pending |
| 6 | OrderResultURL 成功，QueryTradeInfo `TradeStatus=1` | 302 `?payment=success`，訂單 paid |
| 7 | 既有 `ecpay.test.js`、`ecpayAtm.test.js` 等 | 全部照常通過（預期 9 支檔案、約 72 個測試） |

#### 2. 綠界測試環境實機驗證（電腦瀏覽器）
1. **建單與付款頁**：訂單頁按「WebATM」→ 進入綠界「網路ATM」頁並列出銀行（建單部分已實測可行）。
2. **嘗試完成付款**：選一家銀行 →「前往付款」，確認測試環境是否提供模擬的銀行頁面。
   - **可模擬** → 完成付款 → 導回 `/orders/:id?payment=success`，訂單「已付款」，`payments.rtn_msg='QueryTradeInfo TradeStatus=1'`。
   - **需要真實讀卡機與金融卡**（測試環境可能只是導向真實銀行頁）→ 改用綠界測試後台（`vendor-stage.ecpay.com.tw`）對這筆訂單「模擬付款」，看看 WebATM 訂單能否模擬。需要公開的 `BASE_URL`（目前已有 Cloudflare 通道）；登入後台由使用者自行操作。
   - **兩者都不行** → 實機只驗證到「建單 + 付款頁」，付款完成的部分以自動化測試覆蓋，FEATURES 標記 🚧 並寫明原因。
3. **手機**：用瀏覽器的手機模擬（DevTools 裝置模式）開訂單頁，確認 WebATM 按鈕停用並顯示提示。
4. 信用卡、ATM 按鈕仍正常。

#### 3. 其他檢查
- `npm run openapi`：`/api/orders/{id}/ecpay` 的 `paymentMethod` enum 含 WebATM。
- 沒有新增路由或資料庫欄位，所以 ARCHITECTURE 的路由表與 Schema 不需變更；只更新 §8.2 付款方式說明與 `payment_method` 欄位允許值。

### 四、文件更新
- `docs/FEATURES.md`：總覽表新增「綠界付款：WebATM（網路ATM）」一列（✅ 或 🚧，依實機驗證結果）；新增 §4.7 WebATM 行為描述（參數、手機限制、與信用卡共用的確認流程、測試方式）；§4.5 的 `paymentMethod` 表格加上 WebATM。
- `docs/ARCHITECTURE.md`：§8.2 加入 WebATM（與信用卡同流程）；`payments.payment_method` 說明加上 `'WebATM'`。
- `docs/TESTING.md`：新增測試檔一列，更新總數。
- `docs/CHANGELOG.md`：`[Unreleased]` → Added（WebATM）、Changed（`paymentMethod` 新增值、後台付款方式顯示）。
- `AGENTS.md`：專案概述的付款方式加上 WebATM。
- `docs/README.md`：簡介、技術棧、試用路徑加上 WebATM。
- 完成後以 `mv` 將本計畫移至 `docs/plans/archive/`。

## Tasks
- [x] service：`PAYMENT_METHODS` 加入 WebATM、註解更新
- [x] API：`paymentMethod` 驗證訊息、`@openapi` enum
- [x] 前端：WebATM 按鈕、手機停用與提示；後台付款方式對照表
- [x] 測試 `tests/ecpayWebAtm.test.js`（6 個）＋ `npm test` 72 個全數通過
- [x] 實機驗證（部分）：訂單頁三個按鈕顯示正常；按 WebATM 後綠界測試環境建立交易（真實 QueryTradeInfo：TradeStatus=0、TradeAmt=580），付款頁列出 11 家銀行
- [x] 實機驗證：綠界測試環境以台灣土地銀行完成 WebATM 付款（訂單 FL261015233255NH8PUD，NT$580，`PaymentType=WebATM_LAND`），伺服器經 QueryTradeInfo `TradeStatus=1` 確認為 paid，`simulate_paid` 為 NULL
- [x] 手機判斷：以 7 種 User-Agent 驗證規則（iPhone、Android 手機／平板、LINE 內建瀏覽器停用；Windows、macOS 可用）；iPad 桌面版網站模式無法辨識，已記入 FEATURES 已知限制
- [x] 更新 FEATURES / ARCHITECTURE / TESTING / CHANGELOG / README / AGENTS；計畫已移至 archive

## 結果
- 自動化測試：9 支檔案、72 個全數通過（其中 `tests/ecpayWebAtm.test.js` 6 個）。
- 綠界測試環境實機：WebATM 付款完成並經伺服器端查詢確認（與計畫「三-2」的第一種情況相符：測試環境可直接完成付款，不需讀卡機或後台模擬付款）。
