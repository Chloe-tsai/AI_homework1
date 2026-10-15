# 架構說明

## 1. 架構總覽

```
┌───────────────────────────── Browser ─────────────────────────────┐
│  EJS 輸出的 HTML 骨架 (layout + partials + 頁面 Vue 模板)          │
│  └─ <script> vue.global.prod.js (unpkg CDN)                        │
│  └─ auth.js → api.js → notification.js → [header-init.js]          │
│      → pages/<pageScript>.js  (createApp().mount('#app'))          │
│  localStorage: flower_token / flower_user / flower_session_id      │
└──────────────┬───────────────────────────────┬────────────────────┘
               │ GET /、/cart、/admin/...       │ fetch /api/*  (JSON)
               ▼                               ▼  Authorization: Bearer <JWT>
┌──────────────────────────── Express app (app.js) ──────────────────┐
│ static(public) → cors → json → urlencoded → sessionMiddleware      │
│ /api/auth  /api/admin/products  /api/admin/orders                  │
│ /api/products  /api/cart  /api/orders     ← src/routes/*.js        │
│ /  (pageRoutes: 只 render，無資料、無權限檢查)                       │
│ 404 handler → errorHandler                                         │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ better-sqlite3（同步）
                               ▼
                    database.sqlite (WAL, foreign_keys=ON)
```

重點：
- **伺服器端頁面不帶任何業務資料**。EJS 只輸出版型與 Vue 模板（`{{ }}`、`v-if` 等由瀏覽器端 Vue 解析），資料一律由前端呼叫 `/api/*` 取得。少數需要的參數（商品 id、訂單 id、付款結果）透過 `#app` 的 `data-*` 屬性傳給前端。
- **單一程序、單一檔案資料庫**：沒有 ORM、沒有 migration 工具、沒有 service/repository 層，SQL 直接寫在路由處理器內。
- **同步 I/O**：better-sqlite3 為同步 API，所有路由處理器都是同步函式；處理器內拋出的例外會被 Express 4 捕捉並送到 `errorHandler`。

---

## 2. 目錄結構

```
.
├── app.js                      # 建立 Express app：載入 .env、初始化 DB、註冊 middleware 與路由、404、errorHandler；export app（測試直接 require 這個檔）
├── server.js                   # 進入點：只在直接執行時檢查 JWT_SECRET 並 listen(PORT || 3001)；被 require 時只 export app
├── generate-openapi.js         # 用 swagger-jsdoc + swagger-config 產生 openapi.json（寫到「執行時的 cwd」）
├── swagger-config.js           # OpenAPI 3.0.3 定義：info、servers、securitySchemes(bearerAuth / sessionId)、apis: ./src/routes/*.js
├── vitest.config.js            # Vitest 設定（ESM 語法）：globals、串行執行、測試檔順序、hookTimeout 10s
├── package.json                # scripts 與依賴（無 "type" 欄位 → CommonJS）
├── package-lock.json
├── .env.example                # 環境變數範本（JWT、URL、Admin seed、ECPay 預留）
├── .gitignore                  # 忽略 node_modules、*.sqlite*、.env、public/css/output.css 等
├── database.sqlite(-shm/-wal)  # 執行時產生的 SQLite 檔（gitignore）
├── openapi.json                # `npm run openapi` 產物（未納入版控）
│
├── src/
│   ├── database.js             # 開啟 DB、設定 pragma、CREATE TABLE IF NOT EXISTS、seed admin 與商品；module.exports = db（單例）
│   ├── middleware/
│   │   ├── authMiddleware.js   # 驗證 Bearer JWT（HS256）、確認使用者仍存在、設定 req.user
│   │   ├── adminMiddleware.js  # 檢查 req.user.role === 'admin'，否則 403
│   │   ├── sessionMiddleware.js# 讀 X-Session-Id header → req.sessionId（全域掛載）
│   │   └── errorHandler.js     # 最後一道錯誤處理：記 log、遮蔽 500 訊息、回統一格式
│   └── routes/
│       ├── authRoutes.js       # /api/auth：register、login、profile
│       ├── productRoutes.js    # /api/products：公開商品列表（分頁）與詳情
│       ├── cartRoutes.js       # /api/cart：購物車 CRUD；內含 dualAuth 與 getOwnerCondition
│       ├── orderRoutes.js      # /api/orders：建立訂單（transaction）、列表、詳情、模擬付款；內含 generateOrderNo
│       ├── adminProductRoutes.js # /api/admin/products：後台商品 CRUD
│       ├── adminOrderRoutes.js # /api/admin/orders：後台訂單列表（狀態篩選）與詳情
│       └── pageRoutes.js       # / 下的頁面路由；renderFront / renderAdmin 兩段式 render
│
├── views/
│   ├── layouts/
│   │   ├── front.ejs           # 前台版型：head、header、<main>body</main>、footer、toast、Vue CDN、共用 JS、header-init、頁面腳本
│   │   └── admin.ejs           # 後台版型：admin-header + admin-sidebar；inline script 執行 Auth.requireAdmin()；不載入 header-init.js
│   ├── partials/
│   │   ├── head.ejs            # <head>：title（"<title> - 花漾生活"）、Google Fonts（Noto Sans/Serif TC）、/css/output.css
│   │   ├── header.ejs          # 前台導覽：logo、商品列表、購物車(#cart-badge)、我的訂單(#orders-link)、#auth-nav
│   │   ├── footer.ejs          # 版權列
│   │   ├── notification.ejs    # #notification-toast 容器（Notification.show 使用）
│   │   ├── admin-header.ejs    # 後台頂列：返回前台、#admin-username、登出
│   │   └── admin-sidebar.ejs   # 後台側欄：依 currentPath 高亮「商品管理 / 訂單管理」
│   └── pages/
│       ├── index.ejs           # 首頁：hero/精選圖 + 商品卡片 grid + 分頁
│       ├── product-detail.ejs  # 商品詳情；#app data-product-id
│       ├── cart.ejs            # 購物車列表、數量增減、刪除確認、結帳按鈕
│       ├── checkout.ejs        # 收件資訊表單 + 訂單摘要
│       ├── login.ejs           # 登入 / 註冊 雙分頁表單
│       ├── orders.ejs          # 我的訂單列表
│       ├── order-detail.ejs    # 訂單詳情 + 付款結果提示 + 模擬付款按鈕；#app data-order-id / data-payment-result
│       ├── 404.ejs             # 找不到頁面
│       └── admin/
│           ├── products.ejs    # 商品表格 + 新增/編輯 modal + 刪除確認
│           └── orders.ejs      # 訂單表格 + 狀態篩選 + 詳情 modal + 分頁
│
├── public/                     # express.static 根目錄
│   ├── css/
│   │   ├── input.css           # Tailwind v4 入口：@import "tailwindcss" + @theme 自訂色票 + body 字體/底色
│   │   └── output.css          # 建置產物（gitignore；未建置則頁面無樣式）
│   ├── stylesheets/style.css   # express-generator 遺留檔，未被任何頁面引用
│   └── js/
│       ├── auth.js             # 全域 Auth 物件：token/user/sessionId 存取、getAuthHeaders、requireAuth/requireAdmin
│       ├── api.js              # 全域 apiFetch()：自動帶 headers、401 自動登出導向 /login、非 2xx 拋出 {status,data}
│       ├── notification.js     # 全域 Notification.show(message, type)：右上角 toast，3 秒自動消失
│       ├── header-init.js      # 前台 header：依登入狀態渲染 #auth-nav、顯示/隱藏我的訂單、載入購物車徽章數
│       └── pages/              # 每頁一支 Vue 3 腳本，檔名 = pageRoutes 傳入的 pageScript
│           ├── index.js  product-detail.js  cart.js  checkout.js  login.js
│           ├── orders.js  order-detail.js
│           └── admin-products.js  admin-orders.js
│
├── tests/
│   ├── setup.js                # 匯出 app、request、getAdminToken()、registerUser()
│   └── auth / products / cart / orders / adminProducts / adminOrders .test.js
│
└── docs/                       # 專案文件（本目錄）
    └── plans/ → archive/
```

---

## 3. 啟動流程

`node server.js`（或 `npm start`）時依序發生：

1. `server.js` → `require('./app')`
2. `app.js` 第 1 行 `require('dotenv').config()`：從 **cwd** 的 `.env` 載入環境變數（不覆蓋已存在的變數）。
3. `require('./src/database')`（模組載入即執行）：
   1. `new Database(<專案根>/database.sqlite)`（路徑以 `src/` 的上一層計算，與 cwd 無關）
   2. `PRAGMA journal_mode = WAL`、`PRAGMA foreign_keys = ON`
   3. `CREATE TABLE IF NOT EXISTS` 五張表（**既有表不會被修改**；改 schema 需自行處理，見 DEVELOPMENT.md）
   4. `seedAdminUser()`：若 `ADMIN_EMAIL` 不存在則建立 admin（bcrypt rounds：`NODE_ENV === 'test'` 時 1，否則 10）
   5. `seedProducts()`：`products` 表為空時才以 transaction 寫入 8 筆商品
4. 建立 Express app，依序註冊：
   1. `view engine = ejs`、`views = ./views`
   2. `express.static('public')` — **在所有 API 之前**，`public/` 下同名路徑會優先回傳靜態檔
   3. `cors({ origin: FRONTEND_URL || 'http://localhost:3001' })`
   4. `express.json()`、`express.urlencoded({ extended: false })`
   5. `sessionMiddleware`（全域）
   6. API 路由（順序：auth → admin/products → admin/orders → products → cart → orders）
   7. `pageRoutes`（掛在 `/`）
   8. 404 handler：`/api` 開頭回 JSON `NOT_FOUND`，其他 render `pages/404` 包在 front layout
   9. `errorHandler`
5. `server.js` 判斷 `require.main === module`（直接執行）時：
   - `JWT_SECRET` 未設定 → `console.error('Fatal: JWT_SECRET is not set')` 並 `process.exit(1)`
   - 否則 `app.listen(PORT || 3001)`

> 測試時是 `require('../app')`，**不會經過 `server.js` 的 JWT_SECRET 檢查**，也不會 listen；Supertest 直接把 app 包成臨時伺服器。

---

## 4. API 路由總覽

| 方法 | 路徑 | 檔案 | 認證 | 說明 |
|------|------|------|------|------|
| POST | `/api/auth/register` | `authRoutes.js` | 無 | 註冊，回傳 user + token（201） |
| POST | `/api/auth/login` | `authRoutes.js` | 無 | 登入，回傳 user + token |
| GET | `/api/auth/profile` | `authRoutes.js` | JWT（`authMiddleware`） | 取得目前使用者資料 |
| GET | `/api/products` | `productRoutes.js` | 無 | 商品列表（分頁） |
| GET | `/api/products/:id` | `productRoutes.js` | 無 | 商品詳情 |
| GET | `/api/cart` | `cartRoutes.js` | `dualAuth`（JWT 或 X-Session-Id） | 查看購物車與總額 |
| POST | `/api/cart` | `cartRoutes.js` | `dualAuth` | 加入購物車（同商品累加） |
| PATCH | `/api/cart/:itemId` | `cartRoutes.js` | `dualAuth` | 設定項目數量 |
| DELETE | `/api/cart/:itemId` | `cartRoutes.js` | `dualAuth` | 移除項目 |
| POST | `/api/orders` | `orderRoutes.js` | JWT（router 層） | 由會員購物車建立訂單（201） |
| GET | `/api/orders` | `orderRoutes.js` | JWT | 我的訂單列表（不分頁） |
| GET | `/api/orders/:id` | `orderRoutes.js` | JWT | 我的訂單詳情（含 items） |
| PATCH | `/api/orders/:id/pay` | `orderRoutes.js` | JWT | 模擬付款 `action: success/fail` |
| GET | `/api/admin/products` | `adminProductRoutes.js` | JWT + admin（router 層） | 後台商品列表（分頁） |
| POST | `/api/admin/products` | `adminProductRoutes.js` | JWT + admin | 新增商品（201） |
| PUT | `/api/admin/products/:id` | `adminProductRoutes.js` | JWT + admin | 部分更新商品 |
| DELETE | `/api/admin/products/:id` | `adminProductRoutes.js` | JWT + admin | 刪除商品（有 pending 訂單時 409） |
| GET | `/api/admin/orders` | `adminOrderRoutes.js` | JWT + admin | 後台訂單列表（分頁 + status 篩選） |
| GET | `/api/admin/orders/:id` | `adminOrderRoutes.js` | JWT + admin | 後台訂單詳情（含 items 與下單者） |

### 頁面路由（`pageRoutes.js`）

| 路徑 | 版型 | 頁面模板 | pageScript | 額外 locals |
|------|------|----------|-----------|-------------|
| `/` | front | `pages/index` | `index` | `title: '首頁'` |
| `/products/:id` | front | `pages/product-detail` | `product-detail` | `productId` |
| `/cart` | front | `pages/cart` | `cart` | — |
| `/checkout` | front | `pages/checkout` | `checkout` | — |
| `/login` | front | `pages/login` | `login` | — |
| `/orders` | front | `pages/orders` | `orders` | — |
| `/orders/:id` | front | `pages/order-detail` | `order-detail` | `orderId`、`paymentResult`（= `req.query.payment \|\| ''`） |
| `/admin/products` | admin | `pages/admin/products` | `admin-products` | `currentPath` |
| `/admin/orders` | admin | `pages/admin/orders` | `admin-orders` | `currentPath` |

**兩段式 render**：`renderFront/renderAdmin` 先 render 頁面模板取得 HTML 字串 `body`，再 render layout 並以 `<%- body %>` 插入。EJS 沒有內建 layout 功能，這是本專案的替代做法（`renderFront` 傳入的 `layout: 'front'` local 沒有被使用）。render 失敗時直接 `res.status(500).send(err.message)`（不走 errorHandler）。

**頁面路由沒有任何伺服器端權限檢查**：`/checkout`、`/orders`、`/admin/*` 對任何人都會回 200 HTML，保護完全依賴前端腳本的 `Auth.requireAuth()` / `Auth.requireAdmin()` 轉址，以及 API 本身的認證。

---

## 5. 統一回應格式

所有 API（成功與失敗）皆回傳三個欄位：

```json
{ "data": <object | array | null>, "error": <string | null>, "message": <string> }
```

成功（`GET /api/products?page=1&limit=2`）：

```json
{
  "data": {
    "products": [
      { "id": "uuid", "name": "粉色玫瑰花束", "description": "...", "price": 1680, "stock": 30,
        "image_url": "https://...", "created_at": "2026-10-15 12:00:00", "updated_at": "2026-10-15 12:00:00" }
    ],
    "pagination": { "total": 8, "page": 1, "limit": 2, "totalPages": 4 }
  },
  "error": null,
  "message": "成功"
}
```

業務錯誤（`POST /api/cart` 超過庫存）：

```json
{ "data": null, "error": "STOCK_INSUFFICIENT", "message": "庫存不足" }
```

未預期錯誤（經 `errorHandler`）：

```json
{ "data": null, "error": "INTERNAL_ERROR", "message": "伺服器內部錯誤" }
```

### 錯誤碼一覽

| error | HTTP | 來源 |
|-------|------|------|
| `VALIDATION_ERROR` | 400 | 各路由的欄位驗證 |
| `UNAUTHORIZED` | 401 | `authMiddleware`、`dualAuth`、登入失敗 |
| `FORBIDDEN` | 403 | `adminMiddleware` |
| `NOT_FOUND` | 404 | 資源不存在、`/api` 下未知路徑 |
| `CONFLICT` | 409 | Email 已註冊、刪除仍有 pending 訂單的商品 |
| `STOCK_INSUFFICIENT` | 400 | 購物車加入/更新、建立訂單時庫存不足 |
| `CART_EMPTY` | 400 | 建立訂單時購物車為空 |
| `INVALID_STATUS` | 400 | 對非 pending 訂單付款 |
| `INTERNAL_ERROR` | 任何（多為 500） | `errorHandler`（**不論狀態碼都固定是這個字串**） |

### errorHandler 行為（`src/middleware/errorHandler.js`）

- `console.error('Unhandled error:', err.message)`
- 狀態碼：`err.status || err.statusCode || 500`
- 訊息：500 一律「伺服器內部錯誤」；非 500 時若 `err.isOperational === true` 使用 `err.message`，否則用 `SAFE_MESSAGES[status]`（400/401/403/404/409/422/429），都沒有則「請求處理失敗」
- `error` 欄位固定為 `'INTERNAL_ERROR'`
- 常見觸發情境：JSON body 解析失敗（body-parser 拋出 status 400 → 回 400 `請求格式錯誤`）、SQLite constraint 錯誤（500）、`JWT_SECRET` 未設定時 `jwt.sign` 失敗（500）

目前路由都是**直接 `res.status().json()` 回錯誤**，沒有任何程式拋出 `isOperational` 錯誤；若要讓自訂訊息經過 errorHandler 傳出，需建立 `err.status` 與 `err.isOperational = true` 的錯誤物件再 `next(err)`。

---

## 6. 認證與授權

### 6.1 JWT 參數

| 項目 | 值 |
|------|----|
| 簽發位置 | `authRoutes.js` 的 register 與 login（兩處邏輯相同） |
| 演算法 | HS256（`jwt.sign` 預設；`jwt.verify` 明確限制 `algorithms: ['HS256']`） |
| 密鑰 | `process.env.JWT_SECRET` |
| 有效期 | `expiresIn: '7d'` |
| Payload | `{ userId, email, role }`（+ `iat`、`exp`） |
| 傳遞方式 | `Authorization: Bearer <token>` |
| 前端儲存 | `localStorage.flower_token`；使用者物件存 `localStorage.flower_user` |
| 撤銷/刷新 | 無 refresh token、無黑名單；登出只是前端刪除 localStorage |

### 6.2 `authMiddleware`

1. 沒有 `Authorization` 或不是 `Bearer ` 開頭 → 401 `請先登入`
2. `jwt.verify` 失敗（簽章錯、過期、演算法不符）→ 401 `Token 無效或已過期`
3. 以 `decoded.userId` 查 `users`，不存在 → 401 `使用者不存在，請重新登入`
4. 設定 `req.user = { userId, email, role }`（**值取自 token，不是 DB**）→ `next()`

> **角色以 token 為準**：若在 DB 中把某人改為 admin（或降級），需重新登入取得新 token 才生效；`adminMiddleware` 不會查 DB。

### 6.3 `adminMiddleware`

`!req.user || req.user.role !== 'admin'` → 403 `FORBIDDEN / 權限不足`。必須掛在 `authMiddleware` 之後。兩支 admin router 都以 `router.use(authMiddleware, adminMiddleware)` 一次套用於全部端點，所以「未帶 token → 401」、「一般會員 → 403」。

### 6.4 `sessionMiddleware`（全域）

若 request 有 `X-Session-Id` header，設定 `req.sessionId`；不做格式驗證、不產生 session、不寫 cookie。session id 由前端 `Auth.getSessionId()` 以 `crypto.randomUUID()` 產生並永久保存在 `localStorage.flower_session_id`。前端 `getAuthHeaders()` **每個請求都會帶 X-Session-Id**（登入後也帶）。

### 6.5 `dualAuth`（僅購物車，定義於 `cartRoutes.js`）

```
有 Authorization: Bearer ... ?
 ├─ 是 → verify 成功且使用者存在 → req.user 設定，以 user_id 操作購物車
 │       verify 失敗 → 401「Token 無效或已過期」（不退回 session 模式）
 │       使用者不存在 → 401「使用者不存在，請重新登入」
 └─ 否 → 有 req.sessionId ? → 以 session_id 操作購物車
                           否 → 401「請提供有效的登入 Token 或 X-Session-Id」
```

`getOwnerCondition(req)` 回傳 `{ field: 'user_id' | 'session_id', value }`，欄位名直接插入 SQL 字串（值仍用參數綁定；欄位名來自程式常數，非使用者輸入，因此安全）。

**登入後不會合併購物車**：訪客時期以 `session_id` 存的項目，登入後（請求帶 JWT）就看不到了；它們仍留在 DB 中，登出後（只剩 session id）又會再出現。結帳只讀 `user_id` 的購物車。

### 6.6 前端端的守門

| 函式 | 行為 |
|------|------|
| `Auth.requireAuth()` | 未登入 → 導向 `/login?redirect=<目前路徑>`；用於 checkout、orders、order-detail |
| `Auth.requireAdmin()` | 未登入或 `flower_user.role !== 'admin'` → 導向 `/login`；在 admin layout 的 inline script 執行 |
| `apiFetch` 收到 401 | 清除 token 與 user、導向 `/login`，並 `return undefined`（呼叫端需注意 `res` 可能是 `undefined`） |
| 購物車頁「前往結帳」 | 未登入 → `/login?redirect=/checkout` |

---

## 7. 資料庫 Schema

連線設定：`journal_mode = WAL`、`foreign_keys = ON`。所有 `id` 為應用程式產生的 UUID v4 字串；時間欄位為 SQLite `datetime('now')` 產生的 **UTC** 字串 `YYYY-MM-DD HH:MM:SS`（無時區標記；前端 `new Date()` 會當成本地時間解析）。金額一律為**整數（新台幣元）**。

### `users`

| 欄位 | 型別 | 約束 / 預設 | 說明 |
|------|------|------------|------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `email` | TEXT | UNIQUE NOT NULL | 區分大小寫（未正規化） |
| `password_hash` | TEXT | NOT NULL | bcrypt |
| `name` | TEXT | NOT NULL | |
| `role` | TEXT | NOT NULL DEFAULT `'user'`，CHECK IN (`'user'`,`'admin'`) | 只能透過 seed 或直接改 DB 成為 admin |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | |

### `products`

| 欄位 | 型別 | 約束 / 預設 | 說明 |
|------|------|------------|------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `name` | TEXT | NOT NULL | |
| `description` | TEXT | 可 NULL | |
| `price` | INTEGER | NOT NULL，CHECK(`price > 0`) | |
| `stock` | INTEGER | NOT NULL DEFAULT 0，CHECK(`stock >= 0`) | 建立訂單時扣減 |
| `image_url` | TEXT | 可 NULL | 外部圖片 URL（種子資料為 Unsplash） |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | 列表排序依據（DESC） |
| `updated_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | 後台 PUT 時更新；扣庫存時**不會**更新 |

### `cart_items`

| 欄位 | 型別 | 約束 / 預設 | 說明 |
|------|------|------------|------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `session_id` | TEXT | 可 NULL | 訪客模式擁有者 |
| `user_id` | TEXT | 可 NULL，FK → `users(id)` | 會員模式擁有者 |
| `product_id` | TEXT | NOT NULL，FK → `products(id)` | |
| `quantity` | INTEGER | NOT NULL DEFAULT 1，CHECK(`quantity > 0`) | |

- 每列只會填 `session_id` 或 `user_id` 其中之一（由 `getOwnerCondition` 決定）。
- 沒有 `(owner, product_id)` 唯一索引；「同商品只有一列」由 `POST /api/cart` 的先查後更新邏輯保證。
- FK 到 `products` 且 `foreign_keys = ON`：**任何人的購物車中有該商品時，刪除商品會觸發 FOREIGN KEY constraint 錯誤 → 500**（見 FEATURES.md 已知限制）。

### `orders`

| 欄位 | 型別 | 約束 / 預設 | 說明 |
|------|------|------------|------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `order_no` | TEXT | UNIQUE NOT NULL | `ORD-YYYYMMDD-XXXXX`（UTC 日期 + UUID 前 5 碼大寫） |
| `user_id` | TEXT | NOT NULL，FK → `users(id)` | |
| `recipient_name` | TEXT | NOT NULL | |
| `recipient_email` | TEXT | NOT NULL | |
| `recipient_address` | TEXT | NOT NULL | |
| `total_amount` | INTEGER | NOT NULL | 建單當下 `Σ price × quantity` |
| `status` | TEXT | NOT NULL DEFAULT `'pending'`，CHECK IN (`'pending'`,`'paid'`,`'failed'`) | |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | |

### `order_items`

| 欄位 | 型別 | 約束 / 預設 | 說明 |
|------|------|------------|------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `order_id` | TEXT | NOT NULL，FK → `orders(id)` | |
| `product_id` | TEXT | NOT NULL | **沒有 FK**，商品刪除後仍保留 |
| `product_name` | TEXT | NOT NULL | 下單當下名稱快照 |
| `product_price` | INTEGER | NOT NULL | 下單當下單價快照 |
| `quantity` | INTEGER | NOT NULL | |

### 關聯

```
users 1 ── * orders 1 ── * order_items * ‥‥ (無 FK) ‥‥ 1 products
users 1 ── * cart_items * ── 1 products
(session_id) 1 ── * cart_items
```

沒有任何索引（除了 PK 與 UNIQUE 自動建立的索引），也沒有 `ON DELETE` 動作。

---

## 8. 核心資料流

### 8.1 購物到下單

```
訪客瀏覽 /  ──GET /api/products──▶ 商品卡片
   │ 加入購物車 (X-Session-Id)
   ▼
POST /api/cart  → cart_items(session_id=...)
   │ 前往結帳 → 未登入 → /login?redirect=/checkout
   ▼
登入/註冊 → localStorage 存 token → 導回 /checkout
   │ ⚠ 訪客購物車不會合併；此時 GET /api/cart（帶 JWT）讀的是 user_id 的購物車
   │   若為空 → checkout.js 直接導回 /cart
   ▼
POST /api/orders（JWT）
   ├─ 驗證收件資料
   ├─ 讀取 user 購物車 JOIN products
   ├─ 空 → CART_EMPTY；任一 quantity > stock → STOCK_INSUFFICIENT
   ├─ total = Σ 目前售價 × 數量
   └─ db.transaction:
        INSERT orders(status='pending')
        for 每項: INSERT order_items(快照) + UPDATE products SET stock = stock - qty
        DELETE cart_items WHERE user_id
   ▼
導向 /orders/:id → 顯示「付款成功 / 付款失敗」按鈕
```

### 8.2 付款流程（目前為模擬）

```
order-detail.js ──PATCH /api/orders/:id/pay { action: 'success' | 'fail' }──▶
    訂單屬於本人？ 否 → 404
    status === 'pending'？ 否 → 400 INVALID_STATUS
    success → status='paid'；fail → status='failed'
◀── 回傳更新後訂單 + items；前端顯示付款結果提示
```

- 狀態機：`pending → paid` 或 `pending → failed`，兩者皆為終態（`failed` 不能重付、也不會回補庫存）。
- **ECPay（綠界）整合尚未實作**：`.env.example` 已預留 `ECPAY_MERCHANT_ID`、`ECPAY_HASH_KEY`、`ECPAY_HASH_IV`、`ECPAY_ENV`、`BASE_URL`，程式碼中沒有任何地方讀取它們。前端已預留導回處理：`/orders/:id?payment=success|failed|cancel` 會由 `pageRoutes` 放進 `data-payment-result`，`order-detail.js` 依 `paymentMessages` 顯示提示。若要接金流，預期流程為：建單後由後端產生 ECPay AIO 表單（CheckMacValue 以 HashKey/HashIV 計算）→ 使用者前往綠界付款 → 綠界以 server-to-server `ReturnURL`（需 `BASE_URL` 可公開存取）通知更新 `orders.status` → 使用者以 `OrderResultURL/ClientBackURL` 回到 `/orders/:id?payment=...`。

### 8.3 前端腳本載入與頁面初始化

`front.ejs` 的腳本順序（全部為傳統 `<script>`，以全域變數互相依賴，**順序不可調換**）：

1. `vue.global.prod.js`（提供全域 `Vue`）
2. `/js/auth.js`（`Auth`）
3. `/js/api.js`（`apiFetch`，依賴 `Auth`）
4. `/js/notification.js`（`Notification`，會遮蔽瀏覽器原生 `window.Notification` API）
5. `/js/header-init.js`（僅前台；DOMContentLoaded 後渲染登入狀態並呼叫 `GET /api/cart` 顯示徽章 = 項目種類數）
6. `/js/pages/<pageScript>.js`（`createApp({ setup() {...} }).mount('#app')`）

`admin.ejs` 不載入 `header-init.js`，改以 inline script 執行 `Auth.requireAdmin()` 並填入 `#admin-username`。

頁面模板（`views/pages/*.ejs`）的最外層一律是 `<div id="app" ...>`，內容為 Vue 模板語法；EJS 標籤僅用於輸出 `data-*` 屬性。
