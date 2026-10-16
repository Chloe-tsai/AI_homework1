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
│ /  (ecpayRoutes: /api/ecpay/notify、/ecpay/result ← 綠界回呼)        │
│ /  (pageRoutes: 只 render，無資料、無權限檢查)                       │
│ 404 handler → errorHandler                                         │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ better-sqlite3（同步）
                               ▼
                    database.sqlite (WAL, foreign_keys=ON)
```

重點：
- **伺服器端頁面不帶任何業務資料**。EJS 只輸出版型與 Vue 模板（`{{ }}`、`v-if` 等由瀏覽器端 Vue 解析），資料一律由前端呼叫 `/api/*` 取得。少數需要的參數（商品 id、訂單 id、付款結果）透過 `#app` 的 `data-*` 屬性傳給前端。
- **單一程序、單一檔案資料庫**：沒有 ORM、沒有 migration 工具、沒有 repository 層，SQL 直接寫在路由處理器內。唯一的 service 是 `src/services/ecpay.js`（綠界簽章、查詢與付款狀態更新），因為它被 3 支路由共用。
- **同步 DB、少數 async 處理器**：better-sqlite3 為同步 API，絕大多數路由處理器是同步函式，處理器內拋出的例外會被 Express 4 捕捉並送到 `errorHandler`。只有需要對外呼叫綠界的 3 個處理器是 async（`POST /api/orders/:id/ecpay/query`、`POST /api/ecpay/notify`、`POST /ecpay/result`）——Express 4 **不會**接住 rejected promise，所以它們以 try/catch 或 `ecpayRoutes.js` 內的 `asyncHandler` 把錯誤交給 `next(err)`。

---

## 2. 目錄結構

```
.
├── app.js                      # 建立 Express app：載入 .env、初始化 DB、註冊 middleware 與路由、404、errorHandler；export app（測試直接 require 這個檔）
├── server.js                   # 進入點：只在直接執行時檢查 JWT_SECRET 並 listen(PORT || 3001)；被 require 時只 export app
├── generate-openapi.js         # 用 swagger-jsdoc + swagger-config 產生 openapi.json（寫到「執行時的 cwd」）
├── swagger-config.js           # OpenAPI 3.0.3 定義：info、servers、securitySchemes(bearerAuth / sessionId)、apis: ./src/routes/*.js
├── vitest.config.js            # Vitest 設定（ESM 語法）：globals、串行執行（fileParallelism: false）、hookTimeout 10s；其中 sequence.files 不是有效選項、被忽略（且未列 ecpay.test.js）
├── package.json                # scripts 與依賴（無 "type" 欄位 → CommonJS）
├── package-lock.json
├── .env.example                # 環境變數範本（JWT、BASE_URL、Admin seed、ECPay 公開測試帳號與回呼網址說明）
├── .env                        # 實際環境變數（gitignore；測試也會讀取）
├── .gitignore                  # 忽略 node_modules、*.sqlite*、.env、public/css/output.css 等（另有無作用的舊路徑 backend-project/...）
├── database.sqlite(-shm/-wal)  # 執行時產生的 SQLite 檔（gitignore）
├── openapi.json                # `npm run openapi` 產物；⚠ 未列入 .gitignore，提交前自行排除
├── AGENTS.md                   # 專案入口文件（概述、指令、關鍵規則、@docs 引用）；給所有 AI 助手與新成員
├── CLAUDE.md                   # 只含 `@AGENTS.md`，讓 Claude Code 載入同一份內容
├── .claude/
│   ├── settings.json           # Claude Code 專案設定
│   └── skills/ecpay/           # 綠界官方整合 skill（guides、references、test-vectors）；金流實作與測試向量的依據
│
├── src/
│   ├── database.js             # 開啟 DB、設定 pragma、CREATE TABLE IF NOT EXISTS、seed admin 與商品；module.exports = db（單例）
│   ├── middleware/
│   │   ├── authMiddleware.js   # 驗證 Bearer JWT（HS256）、確認使用者仍存在、設定 req.user
│   │   ├── adminMiddleware.js  # 檢查 req.user.role === 'admin'，否則 403
│   │   ├── sessionMiddleware.js# 讀 X-Session-Id header → req.sessionId（全域掛載）
│   │   └── errorHandler.js     # 最後一道錯誤處理：記 log、遮蔽 500 訊息、回統一格式
│   ├── routes/
│   │   ├── authRoutes.js       # /api/auth：register、login、profile
│   │   ├── productRoutes.js    # /api/products：公開商品列表（分頁）與詳情
│   │   ├── cartRoutes.js       # /api/cart：購物車 CRUD；內含 dualAuth 與 getOwnerCondition
│   │   ├── orderRoutes.js      # /api/orders：建立訂單（transaction）、列表、詳情、模擬付款、綠界付款建立與查詢；內含 generateOrderNo
│   │   ├── adminProductRoutes.js # /api/admin/products：後台商品 CRUD
│   │   ├── adminOrderRoutes.js # /api/admin/orders：後台訂單列表（狀態篩選）與詳情
│   │   ├── ecpayRoutes.js      # 綠界回呼：/api/ecpay/notify（ReturnURL）、/api/ecpay/payment-info（ATM PaymentInfoURL）、/ecpay/result（OrderResultURL）、/ecpay/payment-info-result（ATM ClientRedirectURL）；掛在 /
│   │   └── pageRoutes.js       # / 下的頁面路由；renderFront / renderAdmin 兩段式 render
│   └── services/
│       └── ecpay.js            # 綠界 AIO：CheckMacValue 產生/驗證、建單參數、queryTradeInfo、confirmPayment（唯一能標記已付款的路徑）、applyPaymentResult（冪等更新）
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
│       ├── order-detail.ejs    # 訂單詳情 + 付款結果提示 +「信用卡付款」/「ATM 轉帳」/「WebATM（網路ATM）」（手機停用）/「重新查詢付款狀態」+ ATM 繳費資訊卡片（銀行代碼、虛擬帳號可複製、期限）+ 非 production 測試提示；#app data-order-id / data-payment-result / data-ecpay-env
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
│   └── auth / products / cart / orders / adminProducts / adminOrders / ecpay / ecpayAtm .test.js
│
└── docs/                       # 專案文件（本目錄）
    ├── README.md  ARCHITECTURE.md  DEVELOPMENT.md  FEATURES.md  TESTING.md  CHANGELOG.md
    └── plans/                  # 進行中的計畫（YYYY-MM-DD-<feature>.md）
        └── archive/            # 已完成計畫（例：2026-10-15-ecpay-integration.md）
```

---

## 3. 啟動流程

`node server.js`（或 `npm start`）時依序發生：

1. `server.js` → `require('./app')`
2. `app.js` 第 1 行 `require('dotenv').config()`：從 **cwd** 的 `.env` 載入環境變數（不覆蓋已存在的變數）。
3. `require('./src/database')`（模組載入即執行）：
   1. `new Database(<專案根>/database.sqlite)`（路徑以 `src/` 的上一層計算，與 cwd 無關）
   2. `PRAGMA journal_mode = WAL`、`PRAGMA foreign_keys = ON`
   3. `CREATE TABLE IF NOT EXISTS` 六張表（含 `payments`）（**既有表不會被修改**；改 schema 需自行處理，見 DEVELOPMENT.md）
   4. `migratePaymentsColumns()`：以 `PRAGMA table_info(payments)` 檢查，為加入 ATM 前建立的資料庫補上 `payment_method`、`bank_code`、`v_account`、`expire_date`（冪等）
   5. `seedAdminUser()`：若 `ADMIN_EMAIL` 不存在則建立 admin（bcrypt rounds：`NODE_ENV === 'test'` 時 1，否則 10）
   6. `seedProducts()`：`products` 表為空時才以 transaction 寫入 8 筆商品
4. 建立 Express app，依序註冊：
   1. `view engine = ejs`、`views = ./views`
   2. `express.static('public')` — **在所有 API 之前**，`public/` 下同名路徑會優先回傳靜態檔
   3. `cors({ origin: FRONTEND_URL || 'http://localhost:3001' })`
   4. `express.json()`、`express.urlencoded({ extended: false })`
   5. `sessionMiddleware`（全域）
   6. API 路由（順序：auth → admin/products → admin/orders → products → cart → orders）
   7. `ecpayRoutes`（掛在 `/`，提供 `POST /api/ecpay/notify`、`/api/ecpay/payment-info`、`/ecpay/result`、`/ecpay/payment-info-result`；必須在 pageRoutes 與 404 之前）
   8. `pageRoutes`（掛在 `/`）
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
| PATCH | `/api/orders/:id/pay` | `orderRoutes.js` | JWT | 模擬付款 `action: success/fail`（前端已改用綠界，保留供測試） |
| POST | `/api/orders/:id/ecpay` | `orderRoutes.js` | JWT | 建立綠界 AIO 付款資料（新 `payments` 列 + 已簽章表單參數） |
| POST | `/api/orders/:id/ecpay/query` | `orderRoutes.js` | JWT | 向綠界 QueryTradeInfo 查詢並同步訂單狀態 |
| POST | `/api/ecpay/notify` | `ecpayRoutes.js` | 無（CheckMacValue） | 綠界 ReturnURL；純文字 `1\|OK`，或 `0\|CheckMacValue Error` / `0\|Not Paid Yet` / `0\|QueryTradeInfo Error`（HTTP 皆 200） |
| POST | `/ecpay/result` | `ecpayRoutes.js` | 無（CheckMacValue） | 綠界 OrderResultURL（瀏覽器帶回）；302 至 `/orders/:id?payment=success\|failed\|pending`，簽章錯或查無付款至 `/orders?payment=failed` |
| POST | `/api/ecpay/payment-info` | `ecpayRoutes.js` | 無（CheckMacValue） | 綠界 ATM 取號通知 PaymentInfoURL；`RtnCode=2` 寫入虛擬帳號；純文字 `1\|OK` |
| POST | `/ecpay/payment-info-result` | `ecpayRoutes.js` | 無（CheckMacValue） | 綠界 ATM 取號後瀏覽器導回 ClientRedirectURL；302 至 `/orders/:id?payment=atm\|failed` |
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
| `/products/:id` | front | `pages/product-detail` | `product-detail` | `title: '商品詳情'`、`productId` |
| `/cart` | front | `pages/cart` | `cart` | `title: '購物車'` |
| `/checkout` | front | `pages/checkout` | `checkout` | `title: '結帳'` |
| `/login` | front | `pages/login` | `login` | `title: '登入'` |
| `/orders` | front | `pages/orders` | `orders` | `title: '我的訂單'` |
| `/orders/:id` | front | `pages/order-detail` | `order-detail` | `title: '訂單詳情'`、`orderId`、`paymentResult`（= `req.query.payment \|\| ''`）、`ecpayEnv`（= `ECPAY_ENV \|\| 'staging'`） |
| `/admin/products` | admin | `pages/admin/products` | `admin-products` | `title: '商品管理'`、`currentPath` |
| `/admin/orders` | admin | `pages/admin/orders` | `admin-orders` | `title: '訂單管理'`、`currentPath` |

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
| `CONFLICT` | 409 | Email 已註冊、刪除仍有 pending 訂單的商品、訂單仍有未到期的 ATM 繳費帳號時再建立綠界付款 |
| `STOCK_INSUFFICIENT` | 400 | 購物車加入/更新、建立訂單時庫存不足 |
| `CART_EMPTY` | 400 | 建立訂單時購物車為空 |
| `INVALID_STATUS` | 400 | 對非 pending 訂單付款 |
| `PAYMENT_GATEWAY_ERROR` | 502 | `POST /api/orders/:id/ecpay/query`：連不到綠界、HTTP 非 2xx、回應 CheckMacValue 不符，或回應的 `MerchantTradeNo`/`MerchantID` 不是這筆交易。只有訂單 pending 且有 pending 的 `payments` 時才會查詢 |
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

### `payments`（綠界付款嘗試）

既有資料庫的升級：`initializeDatabase()` 內的 `migratePaymentsColumns()` 以 `PRAGMA table_info(payments)` 檢查，缺少 `payment_method`、`bank_code`、`v_account`、`expire_date` 時才 `ALTER TABLE ... ADD COLUMN`（冪等，舊資料 `payment_method` 自動為 `'Credit'`）。

| 欄位 | 型別 | 約束 / 預設 | 說明 |
|------|------|------------|------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `order_id` | TEXT | NOT NULL，FK → `orders(id)` | 一筆訂單可有多次付款嘗試 |
| `merchant_trade_no` | TEXT | UNIQUE NOT NULL | 送給綠界的 `MerchantTradeNo`（20 字元英數） |
| `amount` | INTEGER | NOT NULL | 建立時的 `orders.total_amount`；回呼的 `TradeAmt` 必須相等才算付款成功 |
| `status` | TEXT | NOT NULL DEFAULT `'pending'`，CHECK IN (`'pending'`,`'paid'`,`'failed'`) | |
| `trade_no` | TEXT | 可 NULL | 綠界交易編號 `TradeNo` |
| `payment_type` | TEXT | 可 NULL | 例：`Credit_CreditCard` |
| `rtn_code` / `rtn_msg` | TEXT | 可 NULL | paid 列固定為 `'1'` / `'QueryTradeInfo TradeStatus=1'`；回呼失敗列為綠界的 `RtnCode` / `RtnMsg`；金額不符為 `'1'` / `'付款金額與訂單不符'` |
| `paid_at` | TEXT | 可 NULL | 綠界 `PaymentDate`（台灣時間 `yyyy/MM/dd HH:mm:ss`） |
| `simulate_paid` | INTEGER | 可 NULL | 非正式環境接受後台模擬付款時為 `1`；經 `confirmPayment()`（QueryTradeInfo）確認的為 NULL |
| `payment_method` | TEXT | NOT NULL DEFAULT `'Credit'` | `'Credit'`、`'ATM'` 或 `'WebATM'`（由程式的 `PAYMENT_METHODS` 驗證，未加 CHECK，新增付款方式不需改表） |
| `bank_code` | TEXT | 可 NULL | ATM 銀行代碼（綠界 `BankCode`） |
| `v_account` | TEXT | 可 NULL | ATM 虛擬帳號（綠界 `vAccount`）；有值且 pending 代表「已取號、待繳費」 |
| `expire_date` | TEXT | 可 NULL | ATM 繳費期限，原樣保存 `yyyy/MM/dd`（當天 23:59:59 台灣時間截止） |
| `created_at` | TEXT | NOT NULL DEFAULT `datetime('now')` | |

### 關聯

```
orders 1 ── * payments
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
導向 /orders/:id → 顯示「信用卡付款」「ATM 轉帳」按鈕（見 8.2）
```

### 8.2 付款流程（綠界 ECPay AIO：信用卡 + ATM）

核心原則：**回呼只是「去查詢」的通知；只有伺服器主動呼叫綠界 QueryTradeInfo、得到 `TradeStatus=1` 且金額相符時，訂單才會變成 `paid`**（綠界規格亦註明不可依賴 OrderResultURL 判斷付款結果）。唯一例外是非正式環境的後台模擬付款（見下方 ATM 小節）。以下先說明信用卡流程。

```
order-detail.js「信用卡付款」
   │ POST /api/orders/:id/ecpay（JWT）
   │   訂單屬於本人且 pending → INSERT payments(新 MerchantTradeNo, amount=total_amount)
   │   回傳 { action_url, merchant_trade_no, params(含 CheckMacValue) }
   ▼
瀏覽器以隱藏 form 全頁 POST → payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5
   │ 消費者輸入信用卡、3D 驗證
   ├──▶ ReturnURL  POST /api/ecpay/notify   (綠界 server → 我方；需 BASE_URL 可公開存取)
   │      驗 CheckMacValue 失敗 ──▶ 0|CheckMacValue Error
   │      RtnCode≠1 ──▶ applyPaymentResult 記錄失敗 ──▶ 1|OK
   │      RtnCode=1 ──▶ confirmPayment()
   │                     ├ paid / failed / not_found ──▶ 1|OK
   │                     ├ unpaid（TradeStatus≠1）──▶ 0|Not Paid Yet         （綠界稍後重送）
   │                     └ 查詢失敗 ─────────────▶ 0|QueryTradeInfo Error   （綠界稍後重送）
   └──▶ OrderResultURL POST /ecpay/result   (消費者瀏覽器帶回；localhost 也可用)
          驗 CheckMacValue 失敗或查無 payments ──▶ 302 /orders?payment=failed
          RtnCode≠1 ──▶ 記錄失敗 ──▶ 302 /orders/:id?payment=failed
          RtnCode=1 ──▶ confirmPayment() ──▶ 302 /orders/:id?payment=success | failed | pending
   ▼
order-detail.js
   ├ ?payment=pending 且訂單 pending ──▶ 每 3 秒 POST /api/orders/:id/ecpay/query，最多 5 次
   └ 其他 ?payment 且訂單 pending ──▶ 查詢 1 次；另有「重新查詢付款狀態」按鈕
        POST /api/orders/:id/ecpay/query ──▶ confirmPayment()（失敗 → 502 PAYMENT_GATEWAY_ERROR）
```

**`confirmPayment(merchantTradeNo)`**（`src/services/ecpay.js`，唯一能把訂單標為已付款的路徑）：
1. 以 `merchant_trade_no` 查 `payments`；查無 → `not_found`；已 `paid` → 直接回 `paid`（**不再查詢**；綠界最多重送 4 次也只處理一次）。
2. `queryTradeInfo()`：POST `/Cashier/QueryTradeInfo/V5`（form-urlencoded，`TimeStamp` 為 Unix 秒、有效 3 分鐘，附 CheckMacValue）。回應是 URL-encoded 字串，**回應的 CheckMacValue 也必須驗證通過**；HTTP 非 200、網路錯誤、驗證失敗 → 丟出錯誤。
3. 回應的 `MerchantTradeNo` 或 `MerchantID` 與我方不一致 → 丟出錯誤（防止拿別筆交易的結果冒用）。
4. `TradeStatus !== '1'` → `unpaid`（`0` 未付款或銀行尚未回覆、`10200095` 交易未成立）。
5. `TradeStatus === '1'` → `applyPaymentResult()`：transaction 內再核對 `TradeAmt === payments.amount`。相符 → `payments.status='paid'`（記錄 `trade_no`、`payment_type`、`paid_at`，`rtn_msg='QueryTradeInfo TradeStatus=1'`），並 `UPDATE orders SET status='paid' WHERE id=? AND status='pending'`；不符 → `payments.status='failed'`（`rtn_msg='付款金額與訂單不符'`），**訂單維持 `pending`**。

其他重點：
- 刷卡失敗（回呼 `RtnCode≠1`）只把該筆 `payments` 記為 `failed`，**訂單維持 `pending` 可重新付款**——與舊的模擬付款（`failed` 為終態）不同。
- 每次點「信用卡付款」或「ATM 轉帳」都產生新的 `MerchantTradeNo`（`FL` + 台灣時間 `yyMMddHHmmss` + 6 碼英數 = 20 字元；綠界規定永久不可重複，現有 `order_no` 含 `-` 不可用）。
- `MerchantTradeDate` 一律以 UTC+8 產生；`ItemName` 為 `商品名 x 數量` 以 `#` 串接；先移除 HTML、控制字元與 ``#&<>|;`'"``，再截斷至 200 字（空字串時用 `花漾生活商品`），避免綠界截斷造成 CheckMacValue 不符，也避免被 WAF 攔截。
- 設定：`getConfig()` 每次呼叫時才讀 env（測試與 `.env` 變更都能生效）；未設定 `ECPAY_MERCHANT_ID/HASH_KEY/HASH_IV` 時會改用綠界公開測試帳號，上線前務必設定正式值。`ecpay.js` 會 `require('../database')`，所以載入它就會開啟並初始化 DB。後端使用 Node 內建的 `fetch`，因此需要 **Node 18 以上**。
- `failed` 的付款列之後仍可能經 `confirmPayment()` 變成 `paid`（`confirmPayment` 只跳過已 `paid` 的列），但查詢 API 只會挑 `pending` 的列。
- 本機開發：`ReturnURL` 只接受可公開存取的 80/443 埠，`localhost:3001` 收不到；但 `OrderResultURL`（瀏覽器 POST）與 `QueryTradeInfo`（我方主動呼叫）在本機都能運作，因此不需 ngrok 即可完成付款。正式環境請將 `BASE_URL` 設為公開 HTTPS 網址。
- **回應格式例外**：`/api/ecpay/notify` 依綠界規格回純文字（HTTP 一律 200；只有 `1|OK` 算確認收到，`0|...` 會讓綠界每 5–15 分鐘重送、每日最多 4 次），不是 `{ data, error, message }`；`/ecpay/result` 回 302。這兩個端點無 JWT，真偽由 CheckMacValue（SHA256、`crypto.timingSafeEqual` 比對）驗證。
- 舊的 `PATCH /api/orders/:id/pay`（模擬付款，`failed` 為終態）仍保留於 API 但前端不再使用。
- `?payment=success|failed|cancel|pending` 由 `pageRoutes` 放進 `data-payment-result`，`order-detail.js` 依 `paymentMessages` 顯示提示；`ECPAY_ENV` 放進 `data-ecpay-env`，非 production 時顯示測試卡號提示。

#### WebATM（`ChoosePayment=WebATM`）

即時付款，**流程與上面的信用卡完全相同**（OrderResultURL 導回 → `confirmPayment()` → QueryTradeInfo），只是 `ChoosePayment` 不同；沒有專用端點或回呼。綠界規格註明手機不支援（需讀卡機），訂單頁在手機上停用此按鈕，後端不阻擋。詳見 FEATURES 4.7。

#### ATM 虛擬帳號（`ChoosePayment=ATM`）

ATM 是**非同步**付款：先取號（拿到銀行代碼、虛擬帳號、期限），消費者之後才轉帳。

```
order-detail.js「ATM 轉帳」
   │ POST /api/orders/:id/ecpay { paymentMethod: 'ATM' }
   │   有未到期 ATM 帳號 → 409 CONFLICT（不論選哪種方式；ATM 無法用 API 退款，避免重複付款）
   │   INSERT payments(payment_method='ATM')；params 帶 ExpireDate、PaymentInfoURL、ClientRedirectURL（不帶 OrderResultURL）
   ▼
綠界頁面選銀行 →「取得繳費帳號」
   ├──▶ PaymentInfoURL  POST /api/ecpay/payment-info          （server；需公開網址）
   │      RtnCode=2 → saveAtmInfo（bank_code、v_account、expire_date）→ 1|OK
   ├──▶ ClientRedirectURL POST /ecpay/payment-info-result     （瀏覽器；localhost 也可用）
   │      RtnCode=2 → saveAtmInfo → 302 /orders/:id?payment=atm
   └──（兩者都沒到時）POST /api/orders/:id/ecpay/query → QueryPaymentInfo 補取號資訊
   ▼
訂單頁顯示「ATM 繳費資訊」卡片（付款按鈕隱藏）；消費者轉帳
   ▼
ReturnURL POST /api/ecpay/notify（RtnCode=1）→ confirmPayment()（QueryTradeInfo）→ paid
```

- `saveAtmInfo()` 只更新 `payment_method='ATM'` 且 `status='pending'` 的列，重複通知結果相同（冪等）。ReturnURL 若收到 `RtnCode=2` 也走 `saveAtmInfo`，不會記成失敗。
- `isAtmActive()`：ATM、pending、有 `v_account`、且台灣時間未超過 `expire_date` 23:59:59。過期後前端顯示「已逾期」並可重新付款；綠界不會通知逾期。
- **測試環境的付款完成**：ATM 無法真的轉帳，只能在綠界測試後台（`vendor-stage.ecpay.com.tw`，`stagetest3` / `test1234`）對已取號的訂單「模擬付款」。這只會送一個 `SimulatePaid=1` 的 ReturnURL，**不會改變綠界端狀態**（QueryTradeInfo 仍是 0），所以 `ECPAY_ENV≠production` 時 notify 直接以 `applyPaymentResult()` 接受（仍核對金額、記 `simulate_paid=1`，不呼叫 fetch）；正式環境只記 log。需 `BASE_URL` 為公開網址才收得到。
- 已在綠界測試環境實測：ClientRedirectURL 回到 localhost 正常；QueryPaymentInfo 真實回應 `RtnCode='2'`、`ExpireDate` 為 `yyyy/MM/dd`，CheckMacValue 驗證通過。
- 訂單詳情（前台 `GET /api/orders/:id`、`/ecpay/query`、後台 `GET /api/admin/orders/:id`）回傳 `payment`：最新一筆付款摘要 `{ payment_method, status, bank_code, v_account, expire_date, is_expired }`（`summarizePayment()`）。

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
