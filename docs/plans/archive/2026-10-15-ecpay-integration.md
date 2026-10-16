# 綠界 ECPay 金流串接（AIO 信用卡）

- 建立日期：2026-10-15
- 狀態：已完成

## User Story
身為會員，我想要在結帳後以信用卡透過綠界付款，以便完成購買並讓訂單自動變成「已付款」。

## Spec
### Context
Right now the checkout flow (商品 → 購物車 → 結帳 → 訂單) stops at a **simulated** payment: `PATCH /api/orders/:id/pay` with two buttons. `.env.example` already has the ECPay test credentials (`3002607` / `pwFHCqoQZGmho4w6` / `EkRm7iFT261dpevs`, `ECPAY_ENV=staging`) and `BASE_URL`, but no code reads them. The order page already shows a message for `/orders/:id?payment=success|failed|cancel`.

Goal: real ECPay payments in the staging environment, so a test card payment actually marks the order `paid`.

Decisions:
- **AIO (全方位金流), `ChoosePayment=Credit`.** The skill recommends this for server-rendered sites, and the user chose credit card only.
- **The simulate buttons are replaced** in the UI by "前往綠界付款". The PATCH API stays.
- **It must work on localhost without ngrok.** ECPay's server can't reach `localhost:3001` (ReturnURL only works on public port 80/443). So payment is confirmed through three paths, and whichever comes first marks the order paid. Repeats do nothing.
  1. **ReturnURL** (server-to-server). Only arrives when `BASE_URL` is public (ngrok).
  2. **OrderResultURL** (the browser POSTs back to us). This works on localhost. CheckMacValue is checked here too.
  3. **QueryTradeInfo** (we call ECPay). Calls out from localhost work. This is the fallback if the browser never comes back.

Specs checked from the live ECPay pages 2858 (介接注意事項) and 2862 (產生訂單), plus skill guides 01 and 13.

### Database — `src/database.js`
Add a new table in `initializeDatabase()`. `CREATE TABLE IF NOT EXISTS` works on existing databases, so no ALTER is needed:
```sql
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,             -- FK → orders(id)
  merchant_trade_no TEXT UNIQUE NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')),
  trade_no TEXT, payment_type TEXT, rtn_code TEXT, rtn_msg TEXT,
  paid_at TEXT, simulate_paid INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
```
- Each "pay" click creates a new row with a new `MerchantTradeNo`. ECPay never allows a number to be reused, and a user may leave the payment page and try again.
- The format is `FL` + `YYMMDDHHmmss` + 6 random uppercase letters/digits = 20 letters and digits. The current `order_no` can't be used because it contains `-`.

### Backend

### `src/services/ecpay.js` (new, CommonJS)
- `ecpayUrlEncode`, `generateCheckMacValue`, `verifyCheckMacValue`: the Node.js code from skill guides/13, unchanged. It turns `%20` into `+`, `~` into `%7e` and `'` into `%27`, lowercases, restores the .NET characters, and compares with `crypto.timingSafeEqual`.
- `getConfig()` reads `ECPAY_MERCHANT_ID/HASH_KEY/HASH_IV/ENV` and `BASE_URL`. When `ECPAY_ENV === 'production'` it uses `payment.ecpay.com.tw`, otherwise `payment-stage.ecpay.com.tw`. If the variables are missing it falls back to the test account values.
- `formatTaipeiDate(date)` returns `yyyy/MM/dd HH:mm:ss` in UTC+8, whatever the server's time zone.
- `buildCheckoutParams(order, items, merchantTradeNo)` sets:
  - `MerchantID`, `MerchantTradeNo`, `MerchantTradeDate`, `PaymentType=aio`, `TotalAmount=order.total_amount`
  - `TradeDesc='花漾生活訂單'`
  - `ItemName`: `name x qty` joined with `#`, with HTML and control characters removed, cut to 200 characters
  - `ReturnURL=${BASE_URL}/api/ecpay/notify`
  - `OrderResultURL=${BASE_URL}/ecpay/result`
  - `ChoosePayment=Credit`, `EncryptType=1`, `CustomField1=order.id`, `NeedExtraPaidInfo=N`
  - then adds `CheckMacValue`
- `queryTradeInfo(merchantTradeNo)` POSTs form data with `TimeStamp` in Unix seconds to `/Cashier/QueryTradeInfo/V5` using Node's built-in `fetch`. It parses the URL-encoded reply and checks its CheckMacValue.
- `applyPaymentResult({ merchantTradeNo, rtnCode, tradeNo, tradeAmt, paymentType, paymentDate, rtnMsg, simulatePaid })` is shared by all three confirmation paths. It runs inside `db.transaction`:
  - Look up the payment by `merchant_trade_no`. If it isn't found, return `not_found`.
  - If the payment is already `paid`, return the current state (repeats do nothing).
  - If `String(rtnCode) === '1'` and `Number(tradeAmt) === amount`: set the payment to `paid`, then `UPDATE orders SET status='paid' WHERE id=? AND status='pending'`.
  - Otherwise: set the payment to `failed` and save `rtn_msg`. **The order stays `pending`**, so the user can pay again. The existing PATCH `failed` status is final, and we shouldn't lock an order because a card was declined.

### `src/routes/orderRoutes.js` (JWT, existing router)
- **`POST /api/orders/:id/ecpay`**
  - Checks: the order exists and belongs to the user, otherwise 404; the order is `pending`, otherwise 400 `INVALID_STATUS`.
  - Inserts a `payments` row and returns 200 with `{ data: { action_url, params }, error: null, message: '已建立綠界付款資料' }`.
  - The response sends `params` as ECPay's own PascalCase field names. That is part of ECPay's protocol, so the snake_case rule doesn't apply to them.
- **`POST /api/orders/:id/ecpay/query`**
  - Finds the user's latest `pending` payment for that order. If there is none, it returns the order unchanged.
  - Otherwise it calls `queryTradeInfo`. `TradeStatus === '1'` means `applyPaymentResult` with rtnCode `'1'`.
  - Returns `{ ...order, items }`, the same shape as GET `/:id`.
  - If ECPay can't be reached, it returns 502 `PAYMENT_GATEWAY_ERROR / 無法連線綠界查詢付款狀態`.
- Add `@openapi` comments for both endpoints.

### `src/routes/ecpayRoutes.js` (new, no auth, mounted at `/` in app.js before `pageRoutes`)
- **`POST /api/ecpay/notify`** (ReturnURL):
  - Checks CheckMacValue on `req.body`. The URL-encoded parser is already global.
  - If it fails: log it and reply `res.status(200).type('text').send('0|CheckMacValue Error')`.
  - If it passes: `applyPaymentResult`, then reply exactly `1|OK` with status 200 as `text/plain`.
  - This is a documented **exception to the `{data,error,message}` format**, because ECPay requires the `1|OK` reply.
- **`POST /ecpay/result`** (OrderResultURL, the browser's form POST):
  - Checks CheckMacValue, then runs `applyPaymentResult`.
  - Then `302` to `/orders/${CustomField1}?payment=success|failed`.
  - If CheckMacValue fails, or the order can't be found, redirect to `/orders?payment=failed`. The order ID is taken from the payment row, not from the posted `CustomField1`.
- Add `@openapi` comments (tag `ECPay`).

### `app.js`
Register `app.use('/', require('./src/routes/ecpayRoutes'))` after the API routes and before `pageRoutes`.

### Frontend
- **`public/js/pages/order-detail.js`**
  - Remove `simulatePay`, `handlePaySuccess` and `handlePayFail`. Add `payWithEcpay()`. It calls `POST /api/orders/:id/ecpay`, builds a hidden `<form method="POST" action=action_url>` with one hidden input per param, and calls `submit()`. This is a full-page redirect; ECPay forbids iframes.
  - Add `refreshPaymentStatus()`. It calls `/ecpay/query`. It runs automatically on load when `order.status === 'pending'` and `paymentResult` is set, and is also available as a button.
  - Keep the existing `paymentMessages`.
- **`views/pages/order-detail.ejs`**
  - Replace the two buttons with "前往綠界付款" (`rose-primary` style) and a smaller "重新查詢付款狀態" link.
  - Add a note: "測試卡號 4311-9522-2222-2222，3D 驗證碼 1234". Only show it when the environment is not production; pass `ecpayEnv` through `pageRoutes` as `data-ecpay-env`.
- **`public/js/pages/checkout.js`**: after the order is created, keep redirecting to `/orders/:id`. The user pays from there, and that page is where retries happen.

### Config / docs
- `.env.example`: set `BASE_URL=http://localhost:3001` (already set). Add a comment that ReturnURL needs a public URL (ngrok) and OrderResultURL/QueryTradeInfo work on localhost.
- Update the docs:
  - `ARCHITECTURE.md`: routes, schema for `payments`, rewrite §8.2 payment flow, and note the `1|OK` exception
  - `FEATURES.md`: ECPay ⏳ → ✅
  - `DEVELOPMENT.md`: env table, mark the ECPay variables as used
  - `CHANGELOG.md`: Added
  - `CLAUDE.md`: key rules, add the `1|OK` exception
- Plan file `docs/plans/2026-10-15-ecpay-integration.md`, moved to `archive/` when done.

### Tests — `tests/ecpay.test.js` (runs on its own and sets up its own data in `beforeAll`)
1. **CheckMacValue test vectors:** load the SHA256 vectors from `.claude/skills/ecpay/test-vectors/checkmacvalue.json`. They include the `'` special-character case. Check that `generateCheckMacValue` matches `expected`.
2. **Checkout parameters:** register a user, add a product (`find(p => p.stock > 0)`), create an order, then call `POST /api/orders/:id/ecpay`. Check:
   - status 200, `action_url` contains `payment-stage`
   - `TotalAmount === total_amount`
   - `MerchantTradeNo` matches `/^[A-Za-z0-9]{1,20}$/`
   - `CheckMacValue` passes verification
3. **Another user** calling it gets 404. **No token** gets 401.
4. **Notify with a bad CheckMacValue:** the reply body is not `1|OK` and the order is still `pending`.
5. **Notify with a valid self-signed CheckMacValue** (`RtnCode=1`, correct `TradeAmt`): reply text is exactly `1|OK`, and GET order shows `paid`. Sending it again also gets `1|OK` and the order stays `paid`.
6. **Amount mismatch** on a second order: the order stays `pending`.
7. **`/ecpay/result`** with a valid CheckMacValue: 302 to `/orders/:id?payment=success`.
8. **Query:** mock `global.fetch` with `vi.spyOn`, returning `TradeStatus=1` with a valid CheckMacValue. The order becomes `paid`.
9. **After payment:** `POST /api/orders/:id/ecpay` on a paid order returns 400 `INVALID_STATUS`.

### Verification
1. Run `npm test`. The existing 32 tests and the new ECPay tests should all pass.
2. Run `npm run openapi`. The new paths should show up with no warnings.
3. End to end on localhost (`npm start`):
   - log in, add to cart, check out
   - on `/orders/:id`, click 前往綠界付款
   - the browser goes to `payment-stage.ecpay.com.tw`
   - pay with card `4311-9522-2222-2222`, any future expiry, CVV `222`, 3DS code `1234`
   - you come back to `/orders/:id?payment=success` with status **已付款**
   - check that `/admin/orders` shows `paid`
   - optional: run ngrok, set `BASE_URL` to the ngrok URL, and confirm ReturnURL gets `1|OK` in the server log
4. Failure path: start a payment, then go back to the site without paying. The order stays `pending` and can be paid again.

## Tasks
- [x] 後端：services/ecpay.js、orderRoutes 新端點、ecpayRoutes、payments 表
- [x] `@openapi` 註解 + `npm run openapi`
- [x] 測試 tests/ecpay.test.js（16 個，可獨立執行）
- [x] 前端訂單詳情頁
- [x] 綠界測試環境實際刷卡驗證（4311-9522-2222-2222 / 3D 1234 → 已付款）
- [x] 更新 ARCHITECTURE / FEATURES / DEVELOPMENT / TESTING / CHANGELOG / CLAUDE.md

---

## 後續：伺服器端 QueryTradeInfo 驗證（2026-10-15）

### User Story
身為商家，我希望只有在伺服器向綠界查詢確認後才把訂單改為已付款，以免偽造或未完成的回呼讓訂單被誤判為已付款。

### Spec
- `src/services/ecpay.js` 新增 `confirmPayment(merchantTradeNo)`：查 `payments` → 已 paid 直接回傳 → 呼叫 `queryTradeInfo()`（驗證回應 CheckMacValue）→ 比對 `MerchantTradeNo`/`MerchantID` → `TradeStatus=1` 才呼叫 `applyPaymentResult()`（再核對金額）。這是唯一能標記 paid 的路徑。
- `/api/ecpay/notify`：`RtnCode≠1` 只記錄失敗、回 `1|OK`；成功類回呼走 `confirmPayment()`，未確認回 `0|Not Paid Yet`、查詢失敗回 `0|QueryTradeInfo Error`（讓綠界重送）。
- `/ecpay/result`：成功類回呼走 `confirmPayment()`，導向 `?payment=success|failed|pending`。
- `POST /api/orders/:id/ecpay/query` 改用同一個 `confirmPayment()`；回應不是同一筆交易時回 502。
- 前端 `?payment=pending`：每 3 秒查詢、最多 5 次。
- async 處理器以 `asyncHandler` / try-catch 交給 `next(err)`。

### Tasks
- [x] `confirmPayment()` 與回呼、查詢 API 改寫
- [x] 前端 pending 狀態與重試
- [x] 測試：`tests/ecpay.test.js` 19 個（新增：簽章正確但查詢未付款不改 paid、查詢失敗不回 1|OK、金額不符、其他交易 502、冪等不重查）；全部 51 個通過
- [x] 文件更新（ARCHITECTURE §8.2、FEATURES §4.5、TESTING、CHANGELOG、AGENTS.md）
- [ ] 綠界測試環境以新流程再實機刷卡一次（第一次實機驗證是在改為查詢確認之前）
