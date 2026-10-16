# 開發規範

## 1. 模組系統

| 範圍 | 模組系統 | 說明 |
|------|---------|------|
| 後端（`app.js`、`server.js`、`src/**`、`swagger-config.js`、`generate-openapi.js`） | **CommonJS** | `require` / `module.exports`；`package.json` 沒有 `"type": "module"`，不要改成 ESM |
| 測試（`tests/**`） | CommonJS | `require('./setup')`；`describe/it/expect/beforeAll/afterEach/vi` 都來自 Vitest `globals: true`，不需 import |
| `vitest.config.js` | ESM 語法 | 由 Vitest 自行轉譯，是唯一例外 |
| 前端（`public/js/**`） | **無模組（傳統 script）** | 以全域變數 `Auth`、`apiFetch`、`Notification`、`Vue` 互相引用；載入順序由 layout 決定 |

匯出慣例：
- middleware：一個檔案一個函式，`module.exports = fnName;`
- routes：`const router = express.Router(); ... module.exports = router;`
- database：`module.exports = db;`（better-sqlite3 連線單例，整個程序共用）
- services（`src/services/<name>.js`，目前只有 `ecpay.js`）：匯出具名函式物件 `module.exports = { fnA, fnB };`。放「多支路由共用、或與第三方整合」的邏輯；可直接 `require('../database')`（載入即會初始化 DB），多步寫入一樣用 `db.transaction(...)`（例：`applyPaymentResult`）。設定值請在函式內讀取 `process.env`（例：`getConfig()`），**不要**在模組載入時讀，否則測試與 `.env` 變更不會生效。

前端 page 腳本的頂層 `const { createApp, ref, ... } = Vue;` 在每頁只會載入一次，因此不會重複宣告衝突；**不要在同一頁載入兩支 page 腳本**。

---

## 2. 命名規則

| 對象 | 規則 | 範例 |
|------|------|------|
| 路由檔 | camelCase + `Routes.js` | `cartRoutes.js`、`adminProductRoutes.js` |
| Middleware 檔 | camelCase + `Middleware.js`（錯誤處理例外：`errorHandler.js`） | `authMiddleware.js` |
| Service 檔 | 小寫資源/服務名，無後綴 | `src/services/ecpay.js` |
| 函式 / 變數 | camelCase | `getOwnerCondition`、`generateOrderNo` |
| 資料表 | snake_case 複數 | `cart_items`、`order_items` |
| 資料欄位 | snake_case | `password_hash`、`total_amount`、`created_at` |
| API 路徑 | 小寫複數資源；後台加 `/admin` 前綴；對資源的動作用子路徑 | `/api/orders/:id/pay`、`/api/orders/:id/ecpay/query`、`/api/admin/products` |
| 例外：第三方回呼 | 依第三方命名；瀏覽器導回的頁面型端點不加 `/api` | `/api/ecpay/notify`（server 回呼）、`/ecpay/result`（瀏覽器導回） |
| 路徑參數 | camelCase | `:id`、`:itemId` |
| **請求 body 欄位** | **camelCase** | `productId`、`quantity`、`recipientName`、`recipientEmail`、`recipientAddress` |
| 例外：後台商品 body | snake_case（直接對應欄位） | `image_url` |
| **回應 data 欄位** | **snake_case**（直接回傳 DB 列） | `product_id`、`order_no`、`total_amount` |
| 例外：分頁物件 | camelCase | `pagination.totalPages` |
| 例外：第三方規定的欄位 | 照第三方原樣（PascalCase） | 回應 `data.params.MerchantTradeNo`；綠界回呼 body `RtnCode`、`TradeAmt`（form-urlencoded） |
| 巢狀物件 | 允許，欄位仍為 snake_case | 購物車 `items[].product.image_url` |
| 錯誤碼 | 大寫 SNAKE_CASE | `STOCK_INSUFFICIENT`、`CART_EMPTY` |
| 使用者訊息 `message` | 繁體中文 | `庫存不足`、`訂單建立成功` |
| EJS 頁面 | kebab-case | `views/pages/order-detail.ejs` |
| 前端 page 腳本 | kebab-case，與 `pageScript` 同名；後台加 `admin-` 前綴 | `public/js/pages/admin-orders.js` |
| 前端 localStorage key | `flower_` 前綴 snake_case | `flower_token`、`flower_user`、`flower_session_id` |
| 測試檔 | `<resource>.test.js`（camelCase） | `adminProducts.test.js`、`ecpay.test.js` |
| 計畫檔 | `YYYY-MM-DD-<feature-name>.md`（kebab-case） | `2026-10-15-ecpay-integration.md` |

> body camelCase / 回應 snake_case 的不對稱是**既有對外契約**，前端與測試都依賴它。新增欄位請沿用，不要只改一側。

---

## 3. 程式風格與慣例

- **回應一律** `res.status(code).json({ data, error, message })`。錯誤時 `data: null`；成功時 `error: null`。**唯一例外**是第三方回呼：`/api/ecpay/notify` 依綠界規格 `res.status(200).type('text/plain').send('1|OK')`，`/ecpay/result` 用 `res.redirect(...)`。
- 驗證寫在處理器開頭，**早回傳**（`return res.status(400).json(...)`）。
- 路由處理器預設為同步函式（better-sqlite3 是同步 API）。**需要 `await`（例如呼叫外部 API）時**，Express 4 **不會**自動接住 rejected promise，必須用以下其中一種寫法，否則錯誤會變成未處理的 rejection、請求懸住：
  ```js
  // A. 單一路由：try/catch + next(err)（orderRoutes.js 的 /:id/ecpay/query）
  router.post('/:id/x', async (req, res, next) => {
    try { /* ... await ... */ } catch (err) { next(err); }
  });

  // B. 整支 router：包一層 asyncHandler（ecpayRoutes.js）
  const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  router.post('/y', asyncHandler(async (req, res) => { /* ... */ }));
  ```
  對外部服務的失敗應自行回可理解的錯誤（例：502 `PAYMENT_GATEWAY_ERROR`），不要讓它落到 errorHandler 變成 500。
- 對外 HTTP 請求使用 Node 內建 `fetch`（Node 18+），並在測試中以 `vi.spyOn(global, 'fetch')` 模擬（見 TESTING.md）。
- SQL 一律使用 `db.prepare(sql).get/all/run(...params)` 的參數綁定；只有欄位名（來自程式常數，如 `getOwnerCondition`）可以字串插值，**絕不可插值使用者輸入**。
- 多步寫入必須用 `db.transaction(() => { ... })()`，例如 `orderRoutes.js` 建立訂單、`database.js` seed。
- 新資源的 id 用 `uuidv4()`；時間用 SQLite `datetime('now')`（例外：保存第三方回傳的時間字串時照原樣存，如 `payments.paid_at` 存綠界 `PaymentDate`）。`created_at` 只精確到秒，查「最新一筆」時要加 `rowid DESC` 作為次排序（見 `orderRoutes.js` 查最新付款）。
- 金額與數量皆為整數；不要引入浮點金額。
- 權限設定放在 router 層（`router.use(authMiddleware)`）或單一路由（`router.get('/profile', authMiddleware, ...)`），不要在處理器內自行解析 token（`cartRoutes.js` 的 `dualAuth` 是唯一特例）。第三方回呼（`ecpayRoutes.js`）沒有 JWT，改在處理器內以簽章驗證（`ecpay.verifyWithConfig(req.body)`），且**不採信回呼內容做狀態變更**，要再向第三方查詢確認（`confirmPayment()`）。
- 回應訊息使用繁體中文；程式碼註解使用英文（與現有程式一致）。
- 前端呼叫 API 一律使用 `apiFetch`，不要直接 `fetch`（會漏掉 Authorization / X-Session-Id 與 401 處理）。`apiFetch` 在 401 時回 `undefined`，非 2xx 時 `throw { status, data }`，呼叫端以 `err?.data?.message` 取後端訊息。

---

## 4. 新增 API 的步驟

1. **決定掛載位置**：既有資源加在對應 `src/routes/*Routes.js`；新資源建立 `src/routes/<resource>Routes.js`。
2. **撰寫路由**（範本）：

   ```js
   const express = require('express');
   const { v4: uuidv4 } = require('uuid');
   const db = require('../database');
   const authMiddleware = require('../middleware/authMiddleware');

   const router = express.Router();

   router.use(authMiddleware); // 若整支 router 都需登入

   /**
    * @openapi
    * /api/wishlist:
    *   post:
    *     summary: 加入願望清單
    *     tags: [Wishlist]
    *     security:
    *       - bearerAuth: []
    *     ...（見第 8 節）
    */
   router.post('/', (req, res) => {
     const { productId } = req.body;
     if (!productId) {
       return res.status(400).json({ data: null, error: 'VALIDATION_ERROR', message: 'productId 為必填欄位' });
     }
     // ... db.prepare(...).run(...)
     res.status(201).json({ data: { id }, error: null, message: '已加入願望清單' });
   });

   module.exports = router;
   ```

3. **在 `app.js` 註冊**：放在 `// API Routes` 區塊，**必須在 `pageRoutes` 與 404 handler 之前**：

   ```js
   app.use('/api/wishlist', require('./src/routes/wishlistRoutes'));
   ```

   注意前綴衝突：更具體的前綴（如 `/api/admin/...`）要放在較籠統的前面。

   **不在 `/api` 下、或需要完整路徑的端點**（例如第三方回呼）：像 `ecpayRoutes.js` 一樣在 router 內寫完整路徑（`router.post('/ecpay/result', ...)`），以 `app.use('/', require(...))` 掛在 API 路由之後、`pageRoutes` 之前。這種 router 會看到所有請求，路徑不可與頁面路由重疊。第三方以 form POST 傳資料時依賴全域的 `express.urlencoded`。
4. **補上 `@openapi` 註解**並執行 `npm run openapi` 確認可產生。
5. **新增測試**（見 TESTING.md）：測試檔需能獨立執行（`vitest.config.js` 的 `sequence.files` 不會生效）。
6. **更新文件**：ARCHITECTURE.md 路由總覽、FEATURES.md 行為描述、CHANGELOG.md。

---

## 5. 新增 Middleware 的步驟

1. 建立 `src/middleware/<name>Middleware.js`：

   ```js
   function rateLimitMiddleware(req, res, next) {
     if (/* 不通過 */ false) {
       return res.status(429).json({ data: null, error: 'TOO_MANY_REQUESTS', message: '請求過於頻繁' });
     }
     next();
   }

   module.exports = rateLimitMiddleware;
   ```

2. 掛載方式：
   - 全域：在 `app.js` 的 `// Global middleware` 區塊（`sessionMiddleware` 附近）`app.use(...)`。順序很重要：需要 `req.body` 的要放在 `express.json()` 與 `express.urlencoded({ extended: false })` 之後（後者讓綠界的 form POST 能解析）。
   - 整支 router：`router.use(a, b)`（例：admin 路由的 `authMiddleware, adminMiddleware`）。
   - 單一路由：`router.get('/x', mw, handler)`。
3. 拒絕請求時直接回統一格式；需要交給 errorHandler 時 `next(err)`，並設定 `err.status` 與（若要顯示自訂訊息）`err.isOperational = true`。注意 errorHandler 的 `error` 欄位**固定是 `INTERNAL_ERROR`**，只有狀態碼與訊息會變；需要特定錯誤碼（如 `TOO_MANY_REQUESTS`）時請直接回應，不要交給 errorHandler。
4. 依賴 `req.user` 的 middleware 必須排在 `authMiddleware` 之後。

---

## 6. 新增 / 修改資料表的步驟

本專案**沒有 migration 機制**，schema 全在 `src/database.js` 的 `initializeDatabase()`，以 `CREATE TABLE IF NOT EXISTS` 建立。

**新增資料表**：
1. 在 `db.exec(\`...\`)` 模板字串中加入 `CREATE TABLE IF NOT EXISTS <name> (...)`。主鍵用 `id TEXT PRIMARY KEY`（UUID），時間欄位 `TEXT NOT NULL DEFAULT (datetime('now'))`，列舉用 `CHECK(col IN (...))`，金額 `INTEGER`。
2. 需要 FK 時加 `FOREIGN KEY (...) REFERENCES ...(id)`；記得 `foreign_keys = ON` 會讓刪除被參照的資料失敗（參考 `cart_items → products` 的已知問題），必要時考慮 `ON DELETE CASCADE`。
3. 既有環境下次啟動時會自動建立新表。

**修改既有資料表**（加欄位、改約束）：
- `CREATE TABLE IF NOT EXISTS` **不會**修改已存在的表。開發環境最簡單的方法是刪除 `database.sqlite*` 重建（會遺失資料）。
- 需要保留資料時，在 `initializeDatabase()` 中加入冪等的 `ALTER TABLE`，例如先以 `PRAGMA table_info(<table>)` 檢查欄位是否存在再 `ALTER TABLE ... ADD COLUMN`。SQLite 無法直接修改 CHECK 約束，需建新表搬資料。**實例**：`database.js` 的 `migratePaymentsColumns()`（為 ATM 新增 `payment_method`、`bank_code`、`v_account`、`expire_date`）；同時把新欄位寫進 `CREATE TABLE`，讓新資料庫直接具備。新增 NOT NULL 欄位必須帶 DEFAULT，舊列才會被補值。
- 若需要新的「狀態」但不想重建表，可用既有欄位組合表示（例：ATM「已取號、待繳費」= `status='pending'` 且 `v_account` 有值），避免改 CHECK。
- 同步更新 ARCHITECTURE.md 第 7 節 schema 表格。

**種子資料**：寫在 `seedXxx()` 並在 `initializeDatabase()` 呼叫；必須冪等（先檢查是否已存在），大量寫入包在 `db.transaction`。

---

## 7. 新增前端頁面的步驟

1. `views/pages/<page>.ejs`：最外層 `<div id="app">`，內容使用 Vue 模板語法；需要伺服器參數時以 `data-*` 屬性輸出（`<%= value %>` 會自動跳脫）。
2. `public/js/pages/<page>.js`：

   ```js
   const { createApp, ref, onMounted } = Vue;

   createApp({
     setup() {
       if (!Auth.requireAuth()) return {}; // 需登入時
       const loading = ref(true);
       onMounted(async function () {
         try {
           const res = await apiFetch('/api/...');
           // ...
         } catch (e) {
           Notification.show(e?.data?.message || '載入失敗', 'error');
         } finally {
           loading.value = false;
         }
       });
       return { loading };
     }
   }).mount('#app');
   ```

3. `src/routes/pageRoutes.js` 新增路由：`renderFront(res, '<page>', { title: '...', pageScript: '<page>' })`；後台用 `renderAdmin` 並傳 `currentPath`，模板放 `views/pages/admin/`，並在 `admin-sidebar.ejs` 加連結。
4. 使用新的 Tailwind class 後執行 `npm run css:build`（或保持 `dev:css` 運行）；自訂色票在 `public/css/input.css` 的 `@theme`（`rose-primary`、`rose-dark`、`rose-light`、`apricot`、`sage`、`cream`、`blush`、`rose-bg`、`text-primary/secondary/muted`）。
5. 頁面路由不做權限檢查；保護資料要靠 API 的 middleware。
6. 後台頁面不同：模板放 `views/pages/admin/`、腳本加 `admin-` 前綴，**不要**在腳本內呼叫 `Auth.requireAuth()`——`admin.ejs` 已用 inline script 在 DOMContentLoaded 時執行 `Auth.requireAdmin()`，且後台版型不載入 `header-init.js`。
7. `data-*` 參數可以來自網址 query（例：`paymentResult` = `req.query.payment`）。EJS 的 `<%= %>` 會跳脫，但前端仍要把它當成不可信的值，只拿來查表（如 `paymentMessages[paymentResult]`），不要直接插入 HTML。

---

## 8. JSDoc / OpenAPI 註解格式

每個 API 處理器上方都有一個 `/** @openapi ... */` 區塊（YAML，2 空白縮排），由 `swagger-jsdoc` 讀取（`swagger-config.js` 的 `apis: ['./src/routes/*.js']`）。這是本專案主要的 JSDoc 用途；一般輔助函式只用單行 `//` 註解，`tests/setup.js` 的輔助函式使用一般 JSDoc 說明（`/** Register a new user and return { token, user }. */`）。

格式規則：
- 第一行 `@openapi`，接著是**完整路徑**（含 `/api/...` 前綴；不在 `/api` 下的端點如 `/ecpay/result` 照實際路徑寫；路徑參數寫成 `{id}`，不是 `:id`）。
- `tags` 使用既有分類：`Auth`、`Products`、`Cart`、`Orders`、`Admin Products`、`Admin Orders`、`ECPay`。
- 只掃描 `src/routes/*.js`（`swagger-config.js` 的 `apis`），寫在 `src/services/` 等其他位置的 `@openapi` 會被**靜默忽略**。
- 非 JSON 的端點照實描述：綠界回呼的 requestBody 用 `application/x-www-form-urlencoded`、回應用 `text/plain` 或 `302`，不加 `security`（見 `ecpayRoutes.js`）；較複雜的行為可加 `description:`。
- 需要認證時加 `security`：JWT 為 `- bearerAuth: []`；購物車同時列 `- bearerAuth: []` 與 `- sessionId: []`。
- `responses` 描述成功的完整 `{ data, error, message }` 結構，錯誤狀態碼至少寫 `description`。

範例（取自 `orderRoutes.js`，節錄）：

```js
/**
 * @openapi
 * /api/orders/{id}/pay:
 *   patch:
 *     summary: 模擬付款（更新訂單付款狀態）
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [success, fail]
 *     responses:
 *       200:
 *         description: 付款狀態更新成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                 error:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 *       400:
 *         description: action 無效或訂單狀態不是 pending
 *       404:
 *         description: 訂單不存在
 */
router.patch('/:id/pay', (req, res) => { ... });
```

查詢參數範例（`adminOrderRoutes.js`）：

```yaml
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, paid, failed]
```

驗證方式：`npm run openapi`，YAML 縮排錯誤時 swagger-jsdoc 會輸出警告或該路徑缺漏。

---

## 9. 環境變數

`app.js` 透過 `dotenv` 從**執行目錄**的 `.env` 載入。`.env` 已被 gitignore，範本為 `.env.example`。

| 變數 | 用途 | 必要性 | 預設值（程式內） | 使用位置 |
|------|------|--------|-----------------|---------|
| `JWT_SECRET` | JWT 簽章密鑰 | **必要** | 無；`server.js` 直接執行時缺少即 `exit(1)`；測試時缺少會讓註冊/登入回 500 | `authRoutes.js`、`authMiddleware.js`、`cartRoutes.js` |
| `PORT` | 監聽埠 | 選用 | `3001` | `server.js` |
| `FRONTEND_URL` | CORS 允許的 origin | 選用 | `http://localhost:3001`（`.env.example` 為 `http://localhost:5173`） | `app.js` |
| `ADMIN_EMAIL` | 種子管理員帳號 | 選用 | `admin@hexschool.com` | `database.js` |
| `ADMIN_PASSWORD` | 種子管理員密碼 | 選用 | `12345678` | `database.js` |
| `NODE_ENV` | `test` 時 seed admin 的 bcrypt rounds 降為 1 | 選用 | 未設定（Vitest 執行時自動設為 `test`） | `database.js` |
| `BASE_URL` | 伺服器對外網址，用來組綠界 `ReturnURL`、`OrderResultURL` | 建議 | `http://localhost:3001` | `src/services/ecpay.js` |
| `ECPAY_MERCHANT_ID` | 綠界特店編號 | 正式環境必要 | 未設定時用測試特店 `3002607` | `src/services/ecpay.js` |
| `ECPAY_HASH_KEY` | 綠界 HashKey（僅後端使用，不可出現在前端） | 正式環境必要 | 未設定時用測試值 | `src/services/ecpay.js` |
| `ECPAY_HASH_IV` | 綠界 HashIV（僅後端使用） | 正式環境必要 | 未設定時用測試值 | `src/services/ecpay.js` |
| `ECPAY_ENV` | `production` 時打 `payment.ecpay.com.tw`，其他值打 `payment-stage`；非 production 時接受後台模擬付款（`SimulatePaid=1`） | 選用 | `staging` | `src/services/ecpay.js`、`pageRoutes.js` |
| `ECPAY_ATM_EXPIRE_DAYS` | ATM 虛擬帳號繳費期限（天），超出範圍會被限制在 1–60 | 選用 | `3` | `src/services/ecpay.js` |

注意：
- seed 只在 admin email 不存在時執行，**修改 `ADMIN_PASSWORD` 不會更新既有帳號**；改 `ADMIN_EMAIL` 則會再建立一個新 admin。
- 測試的 `getAdminToken()` 寫死 `admin@hexschool.com / 12345678`，若改了 `ADMIN_EMAIL/ADMIN_PASSWORD`，後台相關測試會失敗。
- 更換 `JWT_SECRET` 會使所有已簽發的 token 失效（前端收到 401 後自動導向登入）。

---

## 10. Git 與提交

- 主分支 `main`；功能開發建議開分支 `feat/<feature-name>`、修正用 `fix/<name>`。
- 提交前執行 `npm test`。
- 不要提交 `.env`、`database.sqlite*`、`public/css/output.css`、`openapi.json`（前三者已在 `.gitignore`；`openapi.json` 目前未列入，提交前請確認）。
- `.gitignore` 中的 `backend-project/public/css/output.css` 是舊路徑殘留，無作用但無害。
- 新增的檔案記得 `git add`（例如 `src/services/`、新的路由與測試檔）；未追蹤的檔案不會出現在 `git diff`，容易漏提交。

---

## 11. 計畫歸檔流程

1. 計畫檔案命名格式：`YYYY-MM-DD-<feature-name>.md`，放在 `docs/plans/`（日期為建立計畫當天）。
2. 計畫文件結構：User Story → Spec → Tasks
3. 功能完成後：移至 `docs/plans/archive/`（已提交過的計畫用 `git mv docs/plans/<file> docs/plans/archive/`；尚未提交的計畫 `git mv` 會失敗，直接 `mv` 後再 `git add`）
4. 更新 `docs/FEATURES.md` 和 `docs/CHANGELOG.md`

計畫範本：

```markdown
# <功能名稱>

- 建立日期：YYYY-MM-DD
- 狀態：進行中 | 已完成

## User Story
身為 <角色>，我想要 <行為>，以便 <價值>。

## Spec
- API：方法 / 路徑 / 認證 / body（camelCase）/ 回應 data（snake_case）/ 錯誤碼
- 資料庫：新增或修改的表與欄位（含既有 DB 的升級方式）
- 前端：影響的頁面與 page 腳本
- 邊界情況：庫存、權限、併發、空資料

## Tasks
- [ ] 後端路由與驗證
- [ ] `@openapi` 註解 + `npm run openapi`
- [ ] 測試（可獨立執行，不依賴其他測試檔）
- [ ] 前端頁面
- [ ] 更新 ARCHITECTURE / FEATURES / CHANGELOG
```
