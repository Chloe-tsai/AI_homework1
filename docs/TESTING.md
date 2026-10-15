# 測試規範與指南

## 1. 測試架構

| 項目 | 內容 |
|------|------|
| 測試框架 | Vitest 2.1.9（`globals: true`，`describe/it/expect/beforeAll` 免 import） |
| HTTP 測試 | Supertest 7：`request(app).get(...)`，直接把 Express app 包成臨時伺服器，不需要 `npm start` |
| 測試類型 | 全部是 **API 整合測試**（HTTP → 路由 → middleware → 真實 SQLite）；沒有單元測試、沒有前端測試 |
| 資料庫 | **與開發共用專案根目錄的 `database.sqlite`**（`src/database.js` 寫死路徑），無 mock、無 transaction rollback、無清理 |
| 環境 | Vitest 自動設定 `NODE_ENV=test`（只影響 seed admin 的 bcrypt rounds = 1）；`app.js` 經 dotenv 載入 `.env` |
| 設定檔 | `vitest.config.js` |

執行：

```bash
npm test                              # 全部（vitest run）
npx vitest run tests/cart.test.js     # 單一檔案
npx vitest run -t "guest mode"        # 依測試名稱過濾
npx vitest                            # watch 模式
```

前置條件：`.env` 中必須有 `JWT_SECRET`（否則 `jwt.sign` 拋錯，註冊/登入回 500，幾乎所有測試失敗）；seed admin 必須是 `admin@hexschool.com / 12345678`。

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

**關於執行順序**：Vitest 2.1.9 的 `SequenceOptions` 只有 `sequencer / shuffle / concurrent / setupFiles / seed / hooks`。設定中的 `sequence.files` 陣列不會生效；實際順序由預設 `BaseSequencer` 決定——有快取時「上次失敗的檔案優先，其次執行時間長的優先」，無快取時依檔案大小。實測一次的順序為 `orders → cart → adminProducts → auth → adminOrders → products`。

目前每支測試檔都在自己的 `beforeAll` 中建立所需資料（註冊新使用者、取第一個商品、建立訂單），因此**檔案之間沒有真正的依賴**，順序改變不影響結果。新測試必須維持這個特性。若確實需要固定順序，應實作自訂 `sequence.sequencer`，而不是依賴 `sequence.files`。

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

**合計 32 個測試**（2026-10-15 於乾淨資料庫上全部通過）。

**未覆蓋**：`PATCH /api/orders/:id/pay`、庫存不足（`STOCK_INSUFFICIENT`）、各種 `VALIDATION_ERROR` 分支、他人訂單/購物車隔離、刪除有 pending 訂單的商品（409）、購物車中商品被刪除（500）、頁面路由、errorHandler、過期/竄改 token、前端腳本。

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

兩個輔助函式都不檢查回應狀態；若註冊/登入失敗會在存取 `res.body.data.token` 時拋出 `TypeError: Cannot read properties of null`——看到這個錯誤時，先檢查 `JWT_SECRET` 與 admin 帳密。

---

## 5. 撰寫新測試

### 步驟

1. 在 `tests/` 建立 `<resource>.test.js`（camelCase）。
2. 從 `./setup` 取得 `app`、`request` 與需要的輔助函式。
3. 在 `beforeAll` 中**自行建立**所有前置資料（使用 `registerUser()` 產生全新使用者、從 `GET /api/products` 取商品），不要依賴其他測試檔或 DB 中的特定資料。
4. 每個 `it` 至少斷言：HTTP 狀態碼 + 統一回應格式（成功 `error: null`；失敗 `data: null` 且 `error` 非 null）+ 關鍵資料欄位（snake_case）。
5. 會改變共用資料（庫存、商品）的測試，盡量在同一檔案內收尾（例如刪除自己建立的商品）。
6. 執行 `npx vitest run tests/<resource>.test.js` 單獨驗證，再跑 `npm test` 全部驗證。

### 範例：模擬付款（目前缺少的覆蓋）

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

### 認證 header 速查

| 模式 | 寫法 |
|------|------|
| 會員 / 管理員 | `.set('Authorization', \`Bearer ${token}\`)` |
| 購物車訪客 | `.set('X-Session-Id', sessionId)`（任意字串，建議加 `Date.now()` 避免與舊資料衝突） |
| 未登入 | 不設定任何 header |

---

## 6. 常見陷阱

1. **測試會污染開發資料庫**：每次 `npm test` 會在 `database.sqlite` 新增 6 個使用者、2 筆 pending 訂單、1 筆會員購物車項目（數量 2，訪客項目會被測試自行刪除），並讓「列表第一個商品」庫存減 2；後台測試建立的商品會被刪除。若在開發伺服器上看到大量 `test-...@example.com` 帳號或庫存異常，這是原因。重置：停止伺服器並刪除 `database.sqlite*`。
2. **庫存會被耗盡**：`orders.test` 與 `adminOrders.test` 都對 `products[0]` 下單。`products[0]` 是 `created_at DESC` 排序的第一筆（種子商品同一秒建立，實際是哪一筆不固定），長期反覆執行後庫存歸零，建單會回 `STOCK_INSUFFICIENT`，`orderId` 變 `undefined` 導致連鎖失敗。解法：重置 DB，或新測試改用 `products.find(p => p.stock > 0)`。
3. **殘留的購物車項目會阻擋刪除商品**：`cart.test` 會員模式加入的項目從不清除；`cart_items.product_id` 有 FK，因此對該商品呼叫 `DELETE /api/admin/products/:id` 會得到 500。撰寫刪除相關測試時請使用自己新建、未放入任何購物車的商品。
4. **`sequence.files` 無效**：見第 2 節。不要假設某支測試檔會先跑。
5. **不要開啟檔案平行**：移除 `fileParallelism: false` 會讓多個 worker 同時寫同一個 SQLite 檔，可能出現 `SQLITE_BUSY`。
6. **全域 401 不影響測試，但影響手動測試**：前端 `apiFetch` 遇 401 會自動登出並導向 `/login`；API 測試不受影響。
7. **時間戳 email 的碰撞**：`auth.test` 只用 `Date.now()`，若同一毫秒內重複執行可能撞 email（實務上極少）；新測試請用 `registerUser()`（含隨機字串）。
8. **管理員帳密寫死**：`.env` 改了 `ADMIN_EMAIL/ADMIN_PASSWORD` 而 DB 是新建的，`getAdminToken()` 會拿到 `undefined`，後台測試回 401。
9. **測試不會經過 `server.js`**：缺少 `JWT_SECRET` 時不會有「Fatal」提示，而是註冊/登入回 500；看到大量 500 時先檢查 `.env`。
10. **不污染開發 DB 的做法**：將專案（含 `node_modules`、`.env`，不含 `database.sqlite*`）複製到暫存目錄後在該處執行 `npx vitest run`，會產生全新資料庫。長期解法是讓 `database.js` 依環境變數（例如 `DB_PATH`，測試用 `:memory:` 或暫存檔）選擇路徑——目前尚未實作。
