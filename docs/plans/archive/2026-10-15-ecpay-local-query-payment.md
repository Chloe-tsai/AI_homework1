# ECPay 本地主動查詢付款

## User Story

身為本機花店的會員，我希望從自己的待付款訂單前往 ECPay 完成信用卡付款，回到 localhost 後由應用程式主動向 ECPay 查詢並確認付款，讓系統不依賴無法送達本機的 Server Notify。

### 驗收條件

- [x] 待付款訂單可建立唯一 ECPay payment，並由 browser form POST 前往 AIO。
- [x] HashKey、HashIV 只存在 server；CheckMacValue 依官方 SHA-256 規則產生與驗證。
- [x] 本機後端主動呼叫 QueryTradeInfo，驗證簽章、MerchantID、MerchantTradeNo 與 TradeAmt。
- [x] 只有已驗證的 `TradeStatus=1` 能把 payment/order 設為 paid。
- [x] 已移除由 client 自行宣告 success/fail 的模擬付款端點。
- [x] API、schema、環境變數、測試、OpenAPI 與專案文件已同步。

## Spec

### API / UI

- `POST /api/orders/:id/payments/ecpay`：建立或重用 payment，回傳 AIO form action 與 signed fields。
- `POST /api/orders/:id/payments/ecpay/verify`：server-side 呼叫 QueryTradeInfo，驗證後回傳可信狀態。
- 訂單詳情回傳 payment 摘要；UI 可前往 ECPay 並手動觸發查詢。
- AIO 固定 `ChoosePayment=Credit`，排除依賴延遲通知的 ATM、CVS、BARCODE 與 BNPL。

### 資料模型與 migration

- 新增 `payments` table：一張 order 一筆 payment，保存 merchant trade number、amount snapshot、狀態、ECPay metadata、查詢時間與次數。
- 沿用專案既有 `CREATE TABLE IF NOT EXISTS` 初始化策略；既有 orders schema 不變。

### 認證、授權與錯誤

- 兩個 endpoint 都位於 JWT orders router，並以 `orders.user_id` 確認 owner。
- Query response 使用 timing-safe CheckMacValue 驗證，並核對 merchant、交易編號及金額。
- 查詢有 timeout、本地 600 秒節流與 ECPay HTTP 403 映射；不把 secret 或原始例外傳給 client。

### 相容性與 rollout

- runtime 最低 Node.js 18，以使用內建 fetch/AbortController。
- staging 可設定 `SimulatePaid`；production 不允許 fallback ReturnURL。
- ReturnURL 不承擔本機狀態更新；ClientBackURL 只負責 browser 返回。

## Tasks

- [x] 新增 ECPay service 與 crypto/query helpers。
- [x] 新增 payments schema 與 order payment APIs。
- [x] 更新訂單詳情付款 UI。
- [x] 新增 unit/integration tests。
- [x] 更新環境變數、OpenAPI 與詳細文件。
- [x] 執行完整 tests、OpenAPI generation 與產生物清理。

## 完成紀錄

- 完成日期：2026-10-15
- 驗證：`npm test`，7 files／37 tests 全數通過。
- 架構決策：localhost 無 Server Notify，因此採使用者觸發、server-side 主動查詢；client redirect 永遠不視為付款證據。
