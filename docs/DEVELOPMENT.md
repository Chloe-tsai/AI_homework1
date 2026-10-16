# 開發指南

## 1. 開發原則

本專案沒有 TypeScript、ORM、controller/service 分層、formatter 或 linter；一致性主要依既有模組邊界與測試維持。修改前先確認行為會影響哪一個 owner（公開、JWT user、session guest、admin）以及資料是否需要 transaction。凡改動公開 API、schema、認證優先級、訂單狀態或回應欄位，都屬跨模組決策，必須同步更新 OpenAPI JSDoc、測試、`FEATURES.md`、`ARCHITECTURE.md`（如適用）與 `CHANGELOG.md`。

## 2. 模組系統與載入規則

### CommonJS 為 runtime 標準

`package.json` 沒有 `"type": "module"`。所有執行期檔案使用：

```js
const express = require('express');
const db = require('../database');

module.exports = router;
```

不要只把單一 runtime 檔案改成 `import`／`export`；Node 會依 CommonJS 解析 `.js`。唯一例外是 `vitest.config.js`，其 `import { defineConfig } from 'vitest/config'` 由 Vitest/Vite 設定載入器處理，不代表整個 app 是 ESM。

### 單例與副作用

- `require('./src/database')` 會立即開檔、建表、seed 並快取匯出的 DB instance。
- `require('./app')` 會載入 dotenv 與 database；即使不呼叫 `listen()` 也有檔案／資料副作用。
- Route modules 都取得同一個 cached `database.js` instance。
- Browser 端沒有 bundler；`front.ejs`／`admin.ejs` 以 script tag 順序建立 `Vue`、`Auth`、`apiFetch`、`Notification` 等 globals。若改檔名或相依順序要同步改 layouts。

## 3. 命名規則對照表

| 對象 | 規則 | 範例 | 注意事項 |
| --- | --- | --- | --- |
| Backend 檔名 | lower camelCase + 類型後綴 | `authRoutes.js`, `sessionMiddleware.js` | 路由採複數領域名；middleware 以 `Middleware` 結尾。 |
| Frontend page JS | kebab-case，與 `pageScript` 完全相同 | `product-detail.js`, `admin-orders.js` | EJS layout 組成 `/js/pages/<pageScript>.js`。 |
| EJS page | kebab-case | `order-detail.ejs` | 管理頁放 `views/pages/admin/`。 |
| JavaScript 變數／函式 | camelCase | `recipientEmail`, `loadProducts` | Request body 對外也採 camelCase。 |
| JavaScript constructor-like/global object | PascalCase | `Auth`, `Notification` | Vue refs/composables 仍 camelCase。 |
| DB table／column | snake_case、複數 table | `order_items`, `recipient_name` | API 讀 DB row 時多數直接保留 snake_case。 |
| Route path | 小寫、複數 resource、必要時 kebab-case | `/api/admin/products`, `/:id/payments/ecpay/verify` | Body camelCase 與 DB snake_case 的轉換在 route 內明寫。 |
| Path param | camelCase 或既有通用 `id` | `:itemId`, `:id` | 保持 JSDoc、實作、前端一致。 |
| Query param | camelCase／簡短小寫 | `page`, `limit`, `status` | 分頁預設 page 1、limit 10；首頁 UI 自訂 limit 9。 |
| Environment variable | UPPER_SNAKE_CASE | `JWT_SECRET`, `ADMIN_EMAIL` | 新增時同步 `.env.example` 與本文件，秘密不可寫入 log。 |
| Error code | UPPER_SNAKE_CASE | `VALIDATION_ERROR`, `STOCK_INSUFFICIENT` | HTTP status 與 machine-readable code 要成對且穩定。 |
| UUID primary key | UUID v4 text | `uuidv4()` | 所有 id 由 application 產生，不用 SQLite rowid。 |
| Test file | 領域 camelCase + `.test.js` | `adminProducts.test.js` | 需要順序時同步 `vitest.config.js`。 |
| Test title | 英文 `should ...` | `should create an order from cart` | 描述外部行為，避免只寫函式名。 |
| Plan file | `YYYY-MM-DD-<feature-name>.md` | `2026-10-15-cart-merge.md` | feature-name 使用短、小寫 kebab-case。 |

## 4. 程式風格與 API 契約

- 縮排採 2 spaces，字串大多單引號，statement 使用分號。
- Backend callback 可用 arrow function；EJS render helper/route 既有部分使用 `function`。新碼以鄰近檔案風格為準。
- SQL 使用 prepared statement `?` parameter；不可把 user input 拼接進 SQL。現有 cart owner column 是由程式固定選出 `user_id` 或 `session_id`，不是直接 user input。
- 成功 JSON：`{ data: <value>, error: null, message: <human message> }`。
- 預期失敗：`{ data: null, error: '<STABLE_CODE>', message: '<safe message>' }`，由 route 明確回正確 status。
- 不可把 password hash、JWT secret、ECPay key/IV、原始 exception stack 放進 response。
- 金額與庫存使用 integer；不要在未設計 currency/rounding 前引入浮點數。
- 訂單明細必須保存 name/price snapshot，不能在歷史訂單只 JOIN 目前商品資料。
- 頁面路由不是授權邊界；任何敏感 query/mutation 都要由 API middleware 保護。

## 5. 新增 API 的步驟

### A. 選擇或建立 router

1. 確定 URL resource 與 owner scope。
2. 公開讀取可放 `productRoutes.js` 類 router；會員 resource 在 router-level 或 endpoint-level 套 `authMiddleware`；管理員 router 依序套 `authMiddleware, adminMiddleware`。
3. 若建立新 router，在 `app.js` 的 API routes 區加入明確 prefix，且放在 page router 與 404 之前。

```js
// app.js
app.use('/api/example', require('./src/routes/exampleRoutes'));
```

### B. 定義認證與授權

不要用前端 `Auth.require*()` 代替 server middleware。一般會員範例：

```js
const authMiddleware = require('../middleware/authMiddleware');

router.get('/', authMiddleware, (req, res) => {
  const userId = req.user.userId;
  // 僅查詢 userId 擁有的資料
});
```

若功能需要 session/JWT 雙模式，優先抽出可測試的共用 middleware，而不是複製 cart 的 `dualAuth`。必須明確定義 Bearer 無效時是否 fallback；目前 cart 的安全規則是「有 Bearer 就不得 fallback」。

### C. 驗證輸入與執行 SQL

1. 分別驗證 missing、型別、範圍、enum 與 owner。
2. 不要依賴 OpenAPI schema 自動驗證：專案沒有 request validator。
3. 用 `db.prepare(...).get/all/run()` 與 placeholders。
4. 跨多筆寫入、計數與狀態變更若必須 all-or-nothing，包入 `db.transaction()`。
5. 查不到「只屬於目前 user」的資料一律回 404，可避免洩漏其他 user 是否擁有該 id。

### D. 回應與錯誤

```js
return res.status(201).json({
  data: created,
  error: null,
  message: '建立成功'
});
```

```js
return res.status(400).json({
  data: null,
  error: 'VALIDATION_ERROR',
  message: '欄位必須為正整數'
});
```

預期的 unique/FK conflict 應事先轉為明確 409，不要讓 SQLite exception 落入 generic 500。若使用 `next(err)` 建立 operational error，需設定 `err.isOperational = true` 才會由全域 handler 保留訊息；同時注意現有 handler 的 `error` 仍固定是 `INTERNAL_ERROR`。

### E. 同步契約與測試

1. 在 route 上方加入完整 `@openapi` block。
2. 新增 success、validation、auth/owner 與 not-found/conflict 測試。
3. 若新增 test file，檢查 `vitest.config.js` 的順序與共享 DB 影響。
4. 更新 `FEATURES.md`；若有新資料流/schema/認證決策，更新 `ARCHITECTURE.md`。
5. 更新 `CHANGELOG.md` 的 Unreleased。
6. 執行 `npm test`；需要檢查規格時執行 `npm run openapi` 並檢視產物，但不要提交忽略檔。

## 6. 新增 middleware 的步驟

1. 在 `src/middleware/<name>Middleware.js` 建立 CommonJS 函式 `(req, res, next)`。
2. 明確寫出它讀取／建立的 request property，例如 `req.user`、`req.sessionId`；避免名稱碰撞。
3. 認證失敗直接回統一 envelope；成功只呼叫一次 `next()`。
4. 若依賴其他 middleware，文件化順序並在 router/app 以固定順序安裝。`adminMiddleware` 必須在 `authMiddleware` 後。
5. 決定 scope：global middleware 會影響 static/API/pages；router-level 只影響 prefix；endpoint-level 最局部。
6. 加測 missing、malformed、valid、expired/forbidden 與 next-called-once 等情境。現有 tests 主要以端點整合驗證 middleware，可沿用。

範例：

```js
function exampleMiddleware(req, res, next) {
  const value = req.headers['x-example'];
  if (!value) {
    return res.status(400).json({
      data: null,
      error: 'VALIDATION_ERROR',
      message: 'X-Example 為必填'
    });
  }
  req.example = value;
  next();
}

module.exports = exampleMiddleware;
```

## 7. 新增／修改資料庫的步驟

### 現況限制

`initializeDatabase()` 只有 `CREATE TABLE IF NOT EXISTS`，沒有版本表或 migration runner。對全新 DB 加欄位有效，對既有 DB 修改 create statement不會生效。因此任何 schema change 必須先決定 migration 策略；不能要求開發者或 production 靜默刪除 DB。

### 建議流程

1. 在計畫文件列出 forward migration、既有資料 backfill、constraint/index、rollback/restore 策略。
2. 為 production-like DB 新增具版本的 migration 機制；在此之前至少用明確、可重複執行的 `ALTER TABLE`／copy-table migration，並記錄 schema version。
3. 開啟 foreign keys 的前提下設計 parent delete 行為：預設 NO ACTION、CASCADE、SET NULL 必須有意選擇。
4. 金額維持 INTEGER；時間格式與既有 UTC text 相容；主鍵沿用 UUID text。
5. 為 owner/filter/join 熱點增加 index，並確認 unique constraint 是否承擔應用層不變量。現有 schema 除 PK/UNIQUE 自動索引外沒有自訂 index。
6. 更新所有直接 `SELECT *` 的 consumers；新增欄位會自動出現在多個 response，可能意外擴張 API。
7. 用全新 DB 測建表/seed，也用含舊資料 DB 測 migration。
8. 更新 schema 文件、OpenAPI、tests 與 changelog。

Transaction 範例保持同步，不要在 `db.transaction` callback 中加入 Promise/`await`：

```js
const writeAll = db.transaction((rows) => {
  const insert = db.prepare('INSERT INTO example (id, value) VALUES (?, ?)');
  for (const row of rows) insert.run(row.id, row.value);
});

writeAll(rows);
```

## 8. 環境變數

| 變數 | 用途 | 必要性 | 程式預設值 | 現況／注意事項 |
| --- | --- | --- | --- | --- |
| `JWT_SECRET` | JWT 簽發與驗證 secret | 啟動 server 必要；auth 測試亦實質必要 | 無 | `server.js` 直接啟動時缺少會 exit 1。測試 import app 繞過該檢查，但簽 token 仍需值。 |
| `PORT` | HTTP listen port | 選填 | `3001` | 未列在 `.env.example`，但 `server.js` 有讀取。 |
| `FRONTEND_URL` | CORS 允許的單一 origin | 選填 | `http://localhost:3001` | `.env.example` 為 `http://localhost:5173`，因此複製範本後允許 5173；不影響 same-origin 非 CORS request。 |
| `BASE_URL` | 產生 ECPay `ClientBackURL` 的本機 base URL | 選填 | `http://localhost:3001` | 去除結尾 `/` 後加 `/orders/:id?payment=return`；只控制 browser 返回位置，不是可信付款通知。 |
| `ADMIN_EMAIL` | 第一次 seed 管理員 email | 選填 | `admin@hexschool.com` | 只在沒有該 email 時建立；改值會另外 seed 新 admin，不會更新舊帳號。 |
| `ADMIN_PASSWORD` | 第一次 seed 管理員密碼 | 選填 | `12345678` | 只在 seed 時使用；正式環境不可沿用範例。 |
| `NODE_ENV` | seed 管理員 bcrypt cost 切換 | 選填 | 非 `test` 行為 | 精確等於 `test` 時 cost 1，其他 cost 10。Express/Vitest 可能也各自使用此常見變數。 |
| `ECPAY_MERCHANT_ID` | ECPay 商店代號；結帳與查詢身分 | 使用付款時必要 | 無 | 僅 server 使用；`.env.example` 是官方 staging 測試值。 |
| `ECPAY_HASH_KEY` | CheckMacValue SHA-256 HashKey | 使用付款時必要 | 無 | 秘密；不得輸出 log、response 或 client bundle。 |
| `ECPAY_HASH_IV` | CheckMacValue SHA-256 HashIV | 使用付款時必要 | 無 | 秘密；不得輸出 log、response 或 client bundle。 |
| `ECPAY_ENV` | 選擇 staging／production endpoint | 選填 | `staging` | 接受 `stage/staging/test` 或 `prod/production`；其他值回設定錯誤。 |
| `ECPAY_RETURN_URL` | AIO 必填 Server Notify URL | production 必要；staging 選填 | staging 使用 `https://example.com/ecpay/notify` | 本機無法接收，因此只作協定欄位；不參與付款狀態更新。正式環境不得依賴占位值。 |
| `ECPAY_SIMULATE_PAID` | staging 要求綠界模擬付款成功 | 選填 | `false` | 僅 staging 有效；`1/true/yes/on` 視為 true。 |
| `ECPAY_QUERY_TIMEOUT_MS` | QueryTradeInfo HTTP timeout | 選填 | `10000` | 必須為正整數，否則回預設值。 |
| `ECPAY_QUERY_MIN_INTERVAL_SECONDS` | 同一 payment 主動查詢最短間隔 | 選填 | `600` | 非負整數；設 0 可關閉本地節流，僅建議測試使用。 |

`.env` 被 gitignore；`.env.example` 必須只放可公開的 placeholder/sandbox 資料。新增環境變數時，同步更新驗證、範本與本表。不要把 secret 寫入 client EJS/JavaScript，因 `public/` 與 rendered HTML 都可被使用者讀取。

ECPay service 使用 Node 18 內建 `fetch` 與 `AbortController`，不要為了單一呼叫再引入 HTTP SDK。新增金流欄位時要同時更新 CheckMacValue input、官方規格註解、service unit test 與 `payments` snapshot；所有外部回應在寫 DB 前都必須驗簽並比對本地 merchant、交易編號及金額。

## 9. OpenAPI JSDoc 格式

`swagger-config.js` 掃描 `./src/routes/*.js`，annotation 必須以 `@openapi` 開始。至少記錄完整 mounted path、HTTP method、summary、tag、security、parameters/requestBody、success envelope 與主要錯誤 status。

```js
/**
 * @openapi
 * /api/widgets/{id}:
 *   patch:
 *     summary: 更新 widget
 *     tags: [Widgets]
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
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: 更新成功
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
 *         description: 輸入驗證失敗
 *       401:
 *         description: 未登入
 *       404:
 *         description: Widget 不存在
 */
router.patch('/:id', authMiddleware, handler);
```

雙模式 security 是 OpenAPI 的 OR，寫成兩個 list item：

```yaml
security:
  - bearerAuth: []
  - sessionId: []
```

不要把它寫在同一個 object（那會代表 AND）。OpenAPI annotation 不會執行驗證；變更後要以 runtime tests 為主，並執行 `npm run openapi` 確認 YAML/JSDoc 可解析。

## 10. 前端頁面擴充流程

1. 在 `views/pages/` 新增 EJS fragment，不要重複 `<html>`/`<head>`。
2. 在 `pageRoutes.js` 透過 `renderFront` 或 `renderAdmin` 設 `title` 與 `pageScript`；需要 route param 時以 locals 傳入並寫到 `data-*`。
3. 在 `public/js/pages/<pageScript>.js` 建立 Vue app 並 mount `#app`。
4. 透過 `apiFetch` 呼叫 API，以保留 headers、401 行為與 error shape；不要直接複製 fetch logic。
5. 需要 toast 時用 `Notification.show`。保護頁可做 `Auth.requireAuth/Admin` UX redirect，但仍必須保護 API。
6. 需要新 Tailwind token 時改 `public/css/input.css`，執行 CSS build；不要手改 generated `output.css`。

使用 `v-html`、動態 `innerHTML` 或 EJS unescaped output 時必須先做 XSS threat review。既有 header 用字串組出 user name 的 `innerHTML`，因此未來若碰觸此處應優先改成 DOM textContent/render binding。

## 11. 計畫歸檔流程

1. 計畫檔案命名格式：`YYYY-MM-DD-<feature-name>.md`
2. 計畫文件結構：User Story → Spec → Tasks
3. 功能完成後：移至 `docs/plans/archive/`
4. 更新 `docs/FEATURES.md` 和 `docs/CHANGELOG.md`

在 Bash 環境使用下列命令歸檔，保留原日期與檔名：

```bash
mv docs/plans/YYYY-MM-DD-<feature-name>.md docs/plans/archive/
```

建議完整模板：

```markdown
# <功能名稱>

## User Story

身為 <角色>，我希望 <能力>，以便 <價值>。

### 驗收條件

- [ ] 可觀察且可測試的結果

## Spec

### API / UI

### 資料模型與 migration

### 認證、授權與錯誤

### 相容性與 rollout

## Tasks

- [ ] 實作
- [ ] 測試
- [ ] OpenAPI 與文件
```

歸檔不是刪除：保留原日期與檔名，以便從 changelog 回溯決策。若功能取消，在計畫頂端標記取消原因並移至 archive；不得把未完成能力在 `FEATURES.md` 標為完成。

## 12. 提交前檢查清單

- [ ] 未提交 `.env`、SQLite、CSS/OpenAPI 產物或秘密。
- [ ] API envelope、HTTP status、error code 與 owner filter 一致。
- [ ] 新 SQL 全部 parameterized，跨寫入不變量有 transaction。
- [ ] JWT/session/admin 優先級與越權案例有測試。
- [ ] 新環境變數同步 `.env.example` 與本文件。
- [ ] Route JSDoc 與 runtime input/output 一致。
- [ ] `npm test` 通過，且了解它對本機 DB 的修改。
- [ ] `FEATURES.md`、`CHANGELOG.md` 與相關架構文件已同步。
- [ ] 完成的 plan 已移至 `docs/plans/archive/`。

