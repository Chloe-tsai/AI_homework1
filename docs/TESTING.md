# 測試規範與指南

## 1. 測試架構

| 項目 | 內容 |
|------|------|
| 測試框架 | Vitest 2.1.9（`globals: true`，`describe/it/expect/beforeAll/afterEach/vi` 免 import） |
| HTTP 測試 | Supertest 7：`request(app).get(...)`，直接把 Express app 包成臨時伺服器，不需要 `npm start` |
| 測試類型 | 以 **API 整合測試**為主（HTTP → 路由 → middleware → 真實 SQLite）；另有少量直接呼叫 service 的單元測試（`ecpay.test.js` 的 CheckMacValue 官方測試向量、台灣時間格式）；沒有前端測試 |
| 資料庫 | **與開發共用專案根目錄的 `database.sqlite`**（`src/database.js` 寫死路徑），DB 不 mock、無 transaction rollback、無清理 |
| 外部服務 | **一律不連外網**：綠界 QueryTradeInfo 以 `vi.spyOn(global, 'fetch')` 模擬（見 5.2）；綠界回呼以測試自行簽章的 form body 模擬 |
| 環境 | Vitest 自動設定 `NODE_ENV=test`（只影響 seed admin 的 bcrypt rounds = 1）；`app.js` 經 dotenv 載入 `.env` |
| 設定檔 | `vitest.config.js` |

執行：

```bash
npm test                              # 全部（vitest run）
npx vitest run tests/cart.test.js     # 單一檔案
npx vitest run -t "guest mode"        # 依測試名稱過濾
npx vitest                            # watch 模式
```

前置條件：
- `.env` 中必須有 `JWT_SECRET`（否則 `jwt.sign` 拋錯，註冊/登入回 500，幾乎所有測試失敗）。
- seed admin 必須是 `admin@hexschool.com / 12345678`。
- **Node 18+**（測試使用全域 `fetch`/`Response`）。
- `ECPAY_ENV` 不可設為 `production`（`ecpay.test` 斷言 `action_url` 含 `payment-stage`）。綠界 API 測試透過 `getConfig()` 讀 `.env` 的 `ECPAY_*` 計算簽章，所以任何帳號都能通過；但 CheckMacValue 測試向量寫死公開測試的 HashKey/HashIV，與 `.env` 無關。

---

## 2. `vitest.config.js` 設定解析

```js
test: {
  globals: true,              // 全域注入 describe/it/expect/beforeAll...
  fileParallelism: false,     // 測試檔一個接一個執行（共用 SQLite 檔，避免寫入鎖衝突）
  sequence: { files: [...] }, // ⚠️ 不是 Vitest 支援的選項，會被忽略
  hookTimeout: 10000,         // beforeAll 最多 10 秒（bcrypt 註冊需時間）
}
```

**關於執行順序**：Vitest 2.1.9 的 `SequenceOptions` 只有 `sequencer / shuffle / concurrent / setupFiles / seed / hooks`。設定中的 `sequence.files` 陣列不會生效；實際順序由預設 `BaseSequencer` 決定——有快取時「上次失敗的檔案優先，其次執行時間長的優先」，無快取時依檔案大小。實測順序為 `ecpay → orders → cart → adminProducts → auth → adminOrders → products`（`sequence.files` 陣列甚至沒有列 `ecpay.test.js`，反正無效）。

每支測試檔都自行建立所需資料：多數在 `beforeAll`（註冊新使用者、取商品、建立訂單）；`auth.test` 與 `products.test` 沒有 `beforeAll`，在第一個 `it` 建立/取得；`adminProducts.test` 的 `beforeAll` 只取 admin token，商品在 `it` 內建立。因此**檔案之間沒有真正的依賴**，順序改變不影響結果。新測試必須維持這個特性。若確實需要固定順序，應實作自訂 `sequence.sequencer`，而不是依賴 `sequence.files`。

**檔案內**的 `it` 則是依序執行且有依賴（共用 `let` 變數），見下一節。

---

## 3. 測試檔案一覽

| 檔案 | 測試數 | 涵蓋端點 | 檔案內依賴 / 建立的資料 |
|------|-------|---------|------------------------|
| `tests/setup.js` | — | 輔助模組（非測試） | — |
| `tests/auth.test.js` | 6 | register、login、profile | 第 1 個 it 註冊 `auth-test-<timestamp>@example.com` 並存 `userToken`；後續「重複註冊」「取 profile」依賴它。登入使用 seed admin |
| `tests/products.test.js` | 4 | `GET /api/products`、`/:id` | 第 1 個 it 取得 `productId` 供詳情測試；唯讀 |
| `tests/cart.test.js` | 6 | cart GET/POST/PATCH/DELETE | `sessionId = 'test-session-<timestamp>'`；訪客模式 新增 → 查看 → 改數量為 3 → 刪除（依序依賴 `cartItemId`）；再註冊會員加入 2 個商品（**留在 DB 中未清除**）；不存在商品 404 |
| `tests/orders.test.js` | 6 | orders POST/GET/GET:id | `beforeAll` 註冊使用者並加入 1 個商品；建立訂單（扣庫存 1）→ 空購物車再建單 400 → 無 token 401 → 列表 → 詳情 → 不存在 404 |
| `tests/adminProducts.test.js` | 6 | admin products 全部 | 列表 → 新增「測試花卉商品」→ 更新名稱/價格 → 刪除並以公開 API 驗證 404；一般會員 403；無 token 401 |
| `tests/adminOrders.test.js` | 4 | admin orders 全部 | `beforeAll` 以新會員建立一筆訂單（扣庫存 1）；列表、`?status=pending` 篩選、詳情含 `user`、一般會員 403 |
| `tests/ecpay.test.js` | 19 | `POST /api/orders/:id/ecpay`、`/ecpay/query`、`/api/ecpay/notify`、`/ecpay/result`；CheckMacValue | 兩個 describe：① CheckMacValue（3 個，純函式）② 付款 API（16 個，`beforeAll` 註冊會員並建 1 筆訂單，大部分 it 共用這筆訂單、依序執行到「已付款」；後段 4 個 it 各自另建訂單）。`afterEach(vi.restoreAllMocks)`。檔案內輔助函式見 5.2 |

| `tests/ecpayAtm.test.js` | 15 | ATM：`POST /api/orders/:id/ecpay`（`paymentMethod`、409）、`/api/ecpay/payment-info`、`/ecpay/payment-info-result`、`/api/ecpay/notify`（`RtnCode=2`、`SimulatePaid=1`）、`/ecpay/query`（QueryPaymentInfo）、後台詳情 `payment` | `beforeAll` 註冊會員並挑**庫存最多**的商品（避免耗盡其他測試用的 `products[0]`）；大多數 it 各自建訂單；巢狀 describe「number taken via PaymentInfoURL」共用一筆訂單依序執行（簽章錯 → 取號 → 重送 → 409 → 直接改 DB 讓帳號過期 → 可重新付款）。`mockEcpay({ tradeInfo, paymentInfo })` 依 URL 分派兩個查詢 API；測正式環境時暫改 `process.env.ECPAY_ENV` 並在 `finally` 還原 |

| `tests/ecpayWebAtm.test.js` | 6 | WebATM：`POST /api/orders/:id/ecpay`（`paymentMethod: 'WebATM'`、驗證訊息、ATM 帳號未到期時 409）、`/api/ecpay/notify` 與 `/ecpay/result`（QueryTradeInfo 確認 / 未確認導向 pending） | `beforeAll` 註冊會員並挑庫存最多的商品；每個 it 各自建訂單。檔案內 `webAtmNotice()`（簽章的 `PaymentType=WebATM_TAISHIN` 通知）與 `mockQueryTradeInfo()`；`afterEach(vi.restoreAllMocks)` |

**合計 72 個測試，9 支檔案**（2026-10-15 全部通過）。

`ecpay.test` 涵蓋的重點：建單參數與簽章、每次新 `MerchantTradeNo`、他人訂單 404、未登入 401、簽章錯誤不處理且**不呼叫 fetch**、**簽章正確的成功回呼但查詢 `TradeStatus=0` → 不改 paid**（核心安全測試）、查詢連線失敗 → notify 不回 `1|OK`、查詢金額不符、刷卡失敗不查詢、查詢確認後 paid 且重送不再查詢（冪等）、已付款不可再建付款（400 `INVALID_STATUS`）、result 導向 success、查詢回應為其他交易 → 502、查詢失敗 → 502。

**未覆蓋**：`PATCH /api/orders/:id/pay`、庫存不足（`STOCK_INSUFFICIENT`）、各種 `VALIDATION_ERROR` 分支、他人購物車隔離與 `GET /api/orders/:id` 他人訂單、刪除有 pending 訂單的商品（409）、購物車中商品被刪除（500）、頁面路由、errorHandler、過期/竄改 token、前端腳本（含 `order-detail.js` 的 pending 重試）、真實連線綠界（只做過手動實測）。

---

## 4. 輔助函式（`tests/setup.js`）

```js
const { app, request, getAdminToken, registerUser } = require('./setup');
```

| 匯出 | 說明 |
|------|------|
| `app` | `require('../app')` 的 Express app（載入時即初始化 DB 與 seed） |
| `request` | `supertest` |
| `getAdminToken()` | 以 `admin@hexschool.com / 12345678` 登入，回傳 JWT 字串。帳密寫死，不讀 `ADMIN_EMAIL/ADMIN_PASSWORD` |
| `registerUser(overrides = {})` | 註冊新會員並回傳 `{ token, user }`。預設 email `test-<Date.now()>-<random>@example.com`、密碼 `password123`、名稱 `測試使用者`；可用 `overrides.email/password/name` 覆寫。**每次呼叫都產生新使用者**，確保測試間資料隔離 |

`ecpay.test.js` 另有檔案內的輔助函式（`signedCallback`、`mockQueryTradeInfo`、`createOrder`…），見 5.2。

兩個輔助函式都不檢查回應狀態；若註冊/登入失敗會在存取 `res.body.data.token` 時拋出 `TypeError: Cannot read properties of null`——看到這個錯誤時，先檢查 `JWT_SECRET` 與 admin 帳密。

---

## 5. 撰寫新測試

### 步驟

1. 在 `tests/` 建立 `<resource>.test.js`（camelCase）。
2. 從 `./setup` 取得 `app`、`request` 與需要的輔助函式。
3. 在 `beforeAll` 中**自行建立**所有前置資料（使用 `registerUser()` 產生全新使用者、從 `GET /api/products` 取商品），不要依賴其他測試檔或 DB 中的特定資料。
4. 每個 `it` 至少斷言：HTTP 狀態碼 + 統一回應格式（成功 `error: null`；失敗 `data: null` 且 `error` 非 null）+ 關鍵資料欄位（snake_case）。不回 JSON 的端點改斷言實際輸出：綠界 notify 斷言 `res.text`（`1|OK` / 非 `1|OK`），result 斷言 `res.status === 302` 與 `res.headers.location`，並再用 API 查訂單狀態確認副作用。
5. 程式碼會對外發 HTTP（`fetch`）時，一律在測試中模擬，並在 `afterEach` 還原（見 5.2）。
6. 會改變共用資料（庫存、商品）的測試，盡量在同一檔案內收尾（例如刪除自己建立的商品）。
7. 執行 `npx vitest run tests/<resource>.test.js` 單獨驗證，再跑 `npm test` 全部驗證。

### 5.1 範例：模擬付款（目前缺少的覆蓋）

```js
const { app, request, registerUser } = require('./setup');

describe('Order Payment API', () => {
  let token;
  let orderId;

  beforeAll(async () => {
    ({ token } = await registerUser());

    const prodRes = await request(app).get('/api/products');
    const product = prodRes.body.data.products.find((p) => p.stock > 0);

    await request(app)
      .post('/api/cart')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 1 });

    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipientName: '付款測試', recipientEmail: 'pay@example.com', recipientAddress: '台北市付款路 1 號' });

    orderId = orderRes.body.data.id;
  });

  it('should reject invalid action', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'refund' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('data', null);
    expect(res.body).toHaveProperty('error', 'VALIDATION_ERROR');
  });

  it('should mark order as paid', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'success' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error', null);
    expect(res.body.data).toHaveProperty('status', 'paid');
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it('should not pay a non-pending order', async () => {
    const res = await request(app)
      .patch(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'success' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'INVALID_STATUS');
  });

  it("should not access another user's order", async () => {
    const { token: otherToken } = await registerUser();
    const res = await request(app)
      .patch(`/api/orders/${orderId}/pay`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ action: 'success' });

    expect(res.status).toBe(404);
  });
});
```

### 5.2 模擬第三方 HTTP 與回呼（以綠界為例，`tests/ecpay.test.js`）

後端以 Node 內建 `fetch` 呼叫綠界 QueryTradeInfo，測試**絕不連外網**，改用 `vi.spyOn(global, 'fetch')` 回傳假的綠界回應。檔案內的輔助函式（未放進 `setup.js`，需要時可複製或抽出）：

| 函式 | 作用 |
|------|------|
| `signedCallback(fields)` | 產生一份「像綠界送來的」成功回呼 form body（`RtnCode: '1'` 等預設值 + `fields` 覆寫），用 `ecpay.getConfig()` 的 HashKey/IV 算出 CheckMacValue。要測簽章錯誤時再把 `CheckMacValue` 改壞 |
| `mockQueryTradeInfo(fields)` | `vi.spyOn(global, 'fetch')` 並讓每次呼叫回傳**新的** `Response`（body 只能讀一次），內容是帶正確 CheckMacValue 的 URL-encoded 回應；`fields` 指定 `MerchantTradeNo`、`TradeAmt`、`TradeStatus`。回傳 spy，可斷言呼叫次數與送出的 body |
| `createOrder(token)` | 取第一個有庫存的商品（`?limit=100` + `find(p => p.stock > 0)`）→ 加入會員購物車 → 建立訂單，回傳訂單資料 |
| `startPayment(token, orderId)` | 呼叫 `POST /api/orders/:id/ecpay` |
| `getOrder(token, orderId)` | 取訂單詳情，用來確認狀態副作用 |

```js
afterEach(() => {
  vi.restoreAllMocks();            // 必要：否則 fetch mock 會漏到下一個 it
});

it('should not mark paid when QueryTradeInfo says unpaid', async () => {
  const start = await startPayment(token, order.id);
  const merchantTradeNo = start.body.data.merchant_trade_no;
  const fetchSpy = mockQueryTradeInfo({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount), TradeStatus: '0' });
  const body = signedCallback({ MerchantTradeNo: merchantTradeNo, TradeAmt: String(order.total_amount) });

  const notify = await request(app).post('/api/ecpay/notify').type('form').send(body);
  expect(notify.text).not.toBe('1|OK');                      // 綠界會重送
  expect(fetchSpy).toHaveBeenCalledOnce();
  expect((await getOrder(token, order.id)).status).toBe('pending');
});
```

要點：
- 回呼要用 `.type('form')` 送出（綠界是 form POST），不是 JSON。
- 斷言「**不應**呼叫外部服務」時，先 `vi.spyOn(global, 'fetch')`（不給實作）再斷言 `not.toHaveBeenCalled()`。
- 模擬網路失敗：`vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'))`。
- `MerchantTradeNo` 一律從 `POST /api/orders/:id/ecpay` 的回應取得（`data.merchant_trade_no`），不要自己編，因為回呼與查詢都會先找 `payments` 列。

### 認證 header 速查

| 模式 | 寫法 |
|------|------|
| 會員 / 管理員 | `.set('Authorization', \`Bearer ${token}\`)` |
| 購物車訪客 | `.set('X-Session-Id', sessionId)`（任意字串，建議加 `Date.now()` 避免與舊資料衝突） |
| 未登入 | 不設定任何 header |

---

## 6. 常見陷阱

1. **測試會污染開發資料庫**：每次 `npm test` 會在 `database.sqlite` 新增 6 個使用者、2 筆 pending 訂單、1 筆會員購物車項目（數量 2，訪客項目會被測試自行刪除），並讓「列表第一個商品」庫存減 2；後台測試建立的商品會被刪除。`ecpay.test` 另外新增 2 個使用者、5 筆訂單（3 筆 paid、2 筆 pending）與約 13 筆 `payments`，並對第一個有庫存的商品扣庫存 5。`ecpayAtm.test` 另外新增 2 個使用者、11 筆訂單（2 筆 paid、9 筆 pending，其中數筆帶 ATM 虛擬帳號），並對**庫存最多**的商品扣庫存 11。`ecpayWebAtm.test` 另外新增 1 個使用者、6 筆訂單（2 筆 paid）並對庫存最多的商品扣庫存 6。若在開發伺服器上看到大量 `test-...@example.com` 帳號或庫存異常，這是原因。重置：停止伺服器並刪除 `database.sqlite*`。
2. **庫存會被耗盡**：`orders.test`、`adminOrders.test` 都對 `products[0]` 下單；`cart.test` 也用 `products[0]`（訪客改數量為 3、會員加入 2，所以庫存低於 3 時它會最先失敗）；`ecpay.test` 用第一個有庫存的商品，通常是同一筆——每次 `npm test` 約讓同一商品減少 7。`products[0]` 是 `created_at DESC` 排序的第一筆（種子商品同一秒建立，實際是哪一筆不固定），長期反覆執行後庫存歸零，建單會回 `STOCK_INSUFFICIENT`，`orderId` 變 `undefined` 導致連鎖失敗。解法：重置 DB，或新測試改用 `products.find(p => p.stock > 0)`。
3. **殘留的購物車項目會阻擋刪除商品**：`cart.test` 會員模式加入的項目從不清除；`cart_items.product_id` 有 FK，因此對該商品呼叫 `DELETE /api/admin/products/:id` 會得到 500。另外 `orders`、`adminOrders`、`ecpay` 測試留下的 **pending 訂單**也會讓該商品的刪除回 **409**。撰寫刪除相關測試時請使用自己新建、未放入任何購物車也未下過單的商品。
4. **`sequence.files` 無效**：見第 2 節。不要假設某支測試檔會先跑。
5. **不要開啟檔案平行**：移除 `fileParallelism: false` 會讓多個 worker 同時寫同一個 SQLite 檔，可能出現 `SQLITE_BUSY`。
6. **全域 401 不影響測試，但影響手動測試**：前端 `apiFetch` 遇 401 會自動登出並導向 `/login`；API 測試不受影響。
7. **時間戳 email 的碰撞**：`auth.test` 只用 `Date.now()`，若同一毫秒內重複執行可能撞 email（實務上極少）；新測試請用 `registerUser()`（含隨機字串）。
8. **管理員帳密寫死**：`.env` 改了 `ADMIN_EMAIL/ADMIN_PASSWORD` 而 DB 是新建的，`getAdminToken()` 登入失敗，`res.body.data` 為 `null`，存取 `.token` 時在 `beforeAll` 拋出 `TypeError`，整個後台測試檔失敗（見第 4 節）。
9. **測試不會經過 `server.js`**：缺少 `JWT_SECRET` 時不會有「Fatal」提示，而是註冊/登入回 500；看到大量 500 時先檢查 `.env`。
10. **忘記還原 fetch mock**：沒有 `afterEach(vi.restoreAllMocks)` 時，前一個 `it` 的 `fetch` 模擬會影響後面的測試；另外同一個 `Response` 物件的 body 只能讀一次，模擬多次呼叫時要用 `mockImplementation(async () => new Response(...))` 每次產生新的。
11. **`ECPAY_ENV=production` 會讓 ecpay 測試失敗**（斷言打測試環境、ATM 測試預期接受模擬付款），本機 `.env` 請維持 `staging`。需要測正式環境行為時，像 `ecpayAtm.test` 一樣在單一 `it` 內暫改 `process.env.ECPAY_ENV`（`getConfig()` 每次呼叫才讀 env，所以立即生效），並在 `finally` 還原。
12. **不污染開發 DB 的做法**：將專案（含 `node_modules`、`.env`，不含 `database.sqlite*`）複製到暫存目錄後在該處執行 `npx vitest run`，會產生全新資料庫。長期解法是讓 `database.js` 依環境變數（例如 `DB_PATH`，測試用 `:memory:` 或暫存檔）選擇路徑——目前尚未實作。
