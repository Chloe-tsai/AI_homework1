# 系統架構

## 1. 架構總覽

本專案是單一 repository、單一 Node.js process、單一 SQLite 檔案的模組化單體。Express 同時扮演四個角色：

1. 從 `public/` 提供 CSS 與 browser JavaScript。
2. 以 EJS 組合 `views/layouts`、`views/partials` 與 `views/pages`，回傳頁面 shell。
3. 在 `/api/*` 提供 JSON REST API。
4. 於第一次載入 `src/database.js` 時同步建立 schema 與 seed 資料。

瀏覽器頁面不是 SPA：每個 URL 都由 server render 一份 EJS，該頁再從 CDN 載入 Vue 3 並各自建立 app。資料與 mutation 皆透過 same-origin `/api/*`；登入狀態、JWT 與訪客 session id 儲存在 `localStorage`。Server 不使用 cookie session，也不保存 in-memory session。

```text
Browser
  ├─ GET page ──────────────> pageRoutes ─> EJS layout + partial + page
  ├─ GET static asset ──────> express.static(public)
  └─ fetch /api/*
       ├─ Authorization: Bearer <JWT>
       └─ X-Session-Id: <browser UUID>
                    │
                    v
Express middleware / route modules
                    │ synchronous better-sqlite3 calls
                    v
              database.sqlite (WAL)
```

## 2. 目錄與逐檔用途

以下列出 repository 中所有受版控的來源／設定檔；產生物 `database.sqlite*`、`public/css/output.css` 與 `openapi.json` 不在版控內。

### 根目錄

| 檔案 | 用途與整合注意事項 |
| --- | --- |
| `.env.example` | 環境變數範本。包含 JWT、server、管理員 seed、ECPay staging credentials、回傳占位 URL、查詢 timeout 與節流設定。 |
| `.gitignore` | 排除依賴、CSS build、SQLite 主檔與 WAL/SHM、環境檔、log、coverage 等。內含一條歷史路徑 `backend-project/public/css/output.css` 及實際使用路徑 `public/css/output.css`。 |
| `AGENTS.md` | 開發代理／協作者的最短入口：指令、不可破壞的跨模組規則與 `@docs` 引用。 |
| `app.js` | 應用組裝點：載入 dotenv/database、設定 EJS/static/CORS/body/session middleware、掛載 API 與頁面路由、最後安裝 404 與 error handler。匯出 app 供 server 與 Supertest 共用。 |
| `server.js` | process 入口。讀取 `PORT`（預設 3001），檢查 `JWT_SECRET`，只有直接執行時才 `listen()`；被 import 時只匯出 app。 |
| `package.json` | 專案 metadata、CommonJS scripts、runtime/dev dependencies；要求 Node.js >=18，因 ECPay 查詢使用內建 `fetch`／`AbortController`。沒有 `type` 或 lint script。 |
| `package-lock.json` | npm lockfile v3，鎖定完整依賴樹。 |
| `swagger-config.js` | OpenAPI 3.0.3 基本資料、固定 localhost server、Bearer 與 `X-Session-Id` security schemes，以及掃描路徑。 |
| `generate-openapi.js` | 執行 `swagger-jsdoc` 並同步寫入 `openapi.json`。不啟動 Swagger UI，也不做 schema validation。 |
| `vitest.config.js` | 啟用 globals、關閉 test-file parallelism、宣告預期測試檔順序與 10 秒 hook timeout。此檔是唯一使用 `import` 的 ESM-style 設定。 |

### `src/` 後端

| 檔案 | 用途與整合注意事項 |
| --- | --- |
| `src/database.js` | 開啟根目錄 `database.sqlite`，啟用 WAL／foreign keys，`CREATE TABLE IF NOT EXISTS` 六張表，seed 管理員與八筆商品，匯出單例 DB connection。所有 query 都是同步呼叫。 |
| `src/middleware/sessionMiddleware.js` | 若 request 有 `X-Session-Id`，原樣放到 `req.sessionId`；不產生、不驗證、不簽章、不設定 cookie。 |
| `src/middleware/authMiddleware.js` | 要求 Bearer JWT、限制 HS256、驗證簽章／到期日並確認 `users.id` 仍存在；把 token claims 放到 `req.user`。 |
| `src/middleware/adminMiddleware.js` | 要求前置 middleware 已設定 `req.user` 且 token claim `role === 'admin'`；否則 403。 |
| `src/middleware/errorHandler.js` | 最終未捕捉錯誤處理器。記錄 `err.message`，將非 operational 訊息替換為安全文字；回應 error code 固定為 `INTERNAL_ERROR`。 |
| `src/routes/authRoutes.js` | 註冊、登入與 profile；bcrypt hash/compare、JWT 簽發與輸入驗證。 |
| `src/routes/productRoutes.js` | 公開商品分頁與單筆查詢。 |
| `src/routes/cartRoutes.js` | 內建 `dualAuth` 與 owner selection，提供訪客／會員購物車 CRUD、庫存檢查與總價計算。 |
| `src/routes/orderRoutes.js` | 全 router 套用 JWT；建立訂單 transaction、自己的列表／詳情、建立 ECPay AIO 表單及主動查詢付款。owner、狀態、查詢間隔與金額都在此層核對。 |
| `src/services/ecpayService.js` | ECPay AIO 邊界：設定驗證、CheckMacValue SHA-256 產生／timing-safe 驗證、交易編號／日期、信用卡結帳表單、`QueryTradeInfo/V5` HTTP 呼叫及回應身分驗證。 |
| `src/routes/adminProductRoutes.js` | 全 router 套用 JWT + admin；商品分頁、建立、部分欄位更新（雖使用 PUT）與刪除保護。 |
| `src/routes/adminOrderRoutes.js` | 全 router 套用 JWT + admin；跨使用者訂單分頁／狀態篩選與詳情。沒有狀態更新 API。 |
| `src/routes/pageRoutes.js` | 所有 HTML URL；用 callback 先 render page fragment，再插入 front/admin layout。頁面本身無 server-side auth。 |

### `public/` 瀏覽器資源

| 檔案 | 用途與整合注意事項 |
| --- | --- |
| `public/css/input.css` | Tailwind 4 入口及 rose/apricot/sage/cream 等設計 token；設定全站 Noto Sans TC。 |
| `public/stylesheets/style.css` | Express scaffold 遺留 CSS；任何 EJS 都沒有載入，目前不參與畫面。 |
| `public/js/auth.js` | `Auth` singleton：localStorage keys、登入／登出、訪客 UUID、request headers、前端 auth/admin redirect。每次 request 即使有 JWT 也會帶 session header。 |
| `public/js/api.js` | `apiFetch` wrapper：預設 JSON header、合併 auth headers、解析 envelope；任何 401 都會清除登入資料並跳 `/login`。 |
| `public/js/notification.js` | 單一 toast controller，支援 success/error/warning/info，3 秒後淡出。 |
| `public/js/header-init.js` | DOM ready 後更新登入導覽、管理端連結、訂單連結與購物車 badge。badge 顯示 item row 數而非總 quantity。 |
| `public/js/pages/index.js` | 首頁 Vue app：每頁 9 筆商品、商品導頁、加入一件商品與 badge 樂觀加一。 |
| `public/js/pages/product-detail.js` | 商品詳情載入、1..stock 數量控制與加入購物車。 |
| `public/js/pages/cart.js` | 購物車載入、前端合計、改量、刪除確認、登入後才能前往 checkout。 |
| `public/js/pages/checkout.js` | 要求登入、讀會員購物車、驗證收件資訊、建單後導至訂單詳情。 |
| `public/js/pages/login.js` | 登入／註冊 tabs、基本前端驗證、儲存 token/user，採用 `redirect` query 或首頁。 |
| `public/js/pages/orders.js` | 要求登入並載入自己的訂單列表，將三種狀態映射為中文樣式。 |
| `public/js/pages/order-detail.js` | 要求登入、載入自己的訂單；向後端取得已簽章 checkout fields 後建立隱藏 form 導向 ECPay，並呼叫後端主動驗證付款結果。 |
| `public/js/pages/admin-products.js` | 管理商品分頁、create/edit modal、delete confirmation；權限 redirect 由 admin layout 內嵌 script 處理。 |
| `public/js/pages/admin-orders.js` | 管理訂單分頁、status watcher 與詳情 modal。 |

### `views/` EJS

| 檔案 | 用途 |
| --- | --- |
| `views/layouts/front.ejs` | 前台 HTML document；依序載入 Vue → Auth → API → Notification → header init → page script。此順序是全域相依條件。 |
| `views/layouts/admin.ejs` | 後台 document、header/sidebar、admin redirect 與 page script；呼叫 `Auth.requireAdmin()` 只是 UX，API 仍是安全邊界。 |
| `views/partials/head.ejs` | charset、viewport、動態 title、Google Fonts、`/css/output.css`。 |
| `views/partials/header.ejs` | 前台品牌、商品、購物車、條件式訂單與登入區容器。 |
| `views/partials/admin-header.ejs` | 後台標題、回前台、使用者名稱與登出。 |
| `views/partials/admin-sidebar.ejs` | 商品／訂單管理 navigation；依 `currentPath` 標示 active。 |
| `views/partials/footer.ejs` | 共用頁尾。 |
| `views/partials/notification.ejs` | toast 的 DOM mount point。 |
| `views/pages/index.ejs` | 品牌 hero、精選、商品 grid／分頁、品牌故事、評論與服務宣稱。 |
| `views/pages/product-detail.ejs` | 商品 image/info、庫存、數量控制與購買須知。 |
| `views/pages/cart.ejs` | 空狀態、免運提示、商品列、改量／刪除與結帳 CTA。免運提示只是 UI，訂單沒有運費欄位。 |
| `views/pages/checkout.ejs` | 收件表單、欄位錯誤與購物車摘要。 |
| `views/pages/login.ejs` | 登入／註冊切換及表單。 |
| `views/pages/orders.ejs` | 自己的訂單空狀態／列表。 |
| `views/pages/order-detail.ejs` | 訂單、收件人、明細、總額、ECPay 交易編號、付款導向／主動查詢按鈕與 localhost 限制提示。 |
| `views/pages/admin/products.ejs` | 後台商品 table、分頁、create/edit modal、delete dialog。 |
| `views/pages/admin/orders.ejs` | 後台訂單 table、filter、分頁與 detail modal。 |
| `views/pages/404.ejs` | 非 API 404 的 page fragment。 |

### `tests/` 整合測試

| 檔案 | 用途 |
| --- | --- |
| `tests/setup.js` | 匯出 app、Supertest request、管理員登入 helper、隨機會員註冊 helper。不是 Vitest `setupFiles`。 |
| `tests/auth.test.js` | 註冊、重複 email、登入、錯誤密碼、profile auth。檔內案例共享 token/email。 |
| `tests/products.test.js` | 公開列表、分頁、詳情、404。檔內案例共享第一筆 product id。 |
| `tests/cart.test.js` | 訪客 cart CRUD、會員加入與不存在商品。檔內案例刻意依序共享 item id。 |
| `tests/orders.test.js` | beforeAll 建會員 cart；建單、空 cart、缺 token、列表、詳情與 404。建單會扣庫存。 |
| `tests/ecpay.test.js` | 官方 CheckMacValue 向量、QueryTradeInfo request/response 簽章、AIO form、付款查詢後原子更新及舊模擬端點移除。外部 HTTP 以 mock 隔離。 |
| `tests/adminProducts.test.js` | 管理員列表與商品 CRUD、一般會員 403、無 token 401。 |
| `tests/adminOrders.test.js` | beforeAll 建一張真實訂單；管理員列表、status filter、詳情與一般會員 403。 |

### `docs/`

| 檔案／目錄 | 用途 |
| --- | --- |
| `docs/README.md` | 專案入口、技術棧、快速開始、指令與文件索引。 |
| `docs/ARCHITECTURE.md` | 本文件；跨模組架構、路由、schema、資料流與風險。 |
| `docs/DEVELOPMENT.md` | 命名、模組、環境變數、擴充步驟與計畫歸檔。 |
| `docs/FEATURES.md` | 按功能描述完整行為、輸入、錯誤與完成狀態。 |
| `docs/TESTING.md` | 測試表、順序、helper、範例與陷阱。 |
| `docs/CHANGELOG.md` | 版本與重要變更。 |
| `docs/plans/` | 進行中計畫，格式為 User Story → Spec → Tasks。 |
| `docs/plans/archive/` | 已完成計畫的歷史歸檔。 |

## 3. 啟動與 request pipeline

### 正式／本機啟動流程

1. `npm start` 先執行 Tailwind CLI，從 `public/css/input.css` 產生 minified `public/css/output.css`。
2. Node 執行 `server.js`，第一行 `require('./app')`。
3. `app.js` 先載入 dotenv，再 `require('./src/database')`。資料庫因此在 JWT secret 檢查之前就會開啟、建表與 seed。
4. `database.js` 建立單例 connection，設定 `journal_mode = WAL`、`foreign_keys = ON`，執行 idempotent DDL。若管理員 email 不存在則 hash seed 密碼；若商品總數為 0 則以一個 transaction 寫入八筆商品。
5. `app.js` 設定 view engine，安裝 middleware 與 routes，匯出 app。
6. 回到 `server.js`：若是直接執行且 `JWT_SECRET` 缺少，輸出 fatal message 並 `process.exit(1)`；否則監聽 `PORT || 3001`。

`require('./app')` 的副作用很重要：Supertest 不呼叫 `listen()`，但仍會載入 `.env`、建立資料庫與 seed。不能把 import app 當成純函式。

### Middleware 順序

```text
express.static(public)
  → cors({ origin: FRONTEND_URL || 'http://localhost:3001' })
  → express.json()
  → express.urlencoded({ extended: false })
  → sessionMiddleware
  → API routers（其內可能再套 auth/admin/dualAuth）
  → pageRoutes
  → 404（API JSON；頁面 EJS）
  → errorHandler
```

因 static middleware 在 CORS 之前，靜態檔成功命中時不經過後續 CORS。CORS 只設定單一 origin，未啟用 credential cookie；目前認證完全在 headers/localStorage。

## 4. API 路由總覽

### Router 前綴

| 前綴 | 檔案 | 認證 | 說明 |
| --- | --- | --- | --- |
| `/api/auth` | `src/routes/authRoutes.js` | register/login 公開；profile Bearer JWT | 身分建立、token 簽發與 profile。 |
| `/api/admin/products` | `src/routes/adminProductRoutes.js` | Bearer JWT + admin | 商品管理；router-level middleware。 |
| `/api/admin/orders` | `src/routes/adminOrderRoutes.js` | Bearer JWT + admin | 全站訂單查詢；router-level middleware。 |
| `/api/products` | `src/routes/productRoutes.js` | 公開 | 商品讀取。 |
| `/api/cart` | `src/routes/cartRoutes.js` | Bearer JWT 或 `X-Session-Id` | 雙 owner 購物車。 |
| `/api/orders` | `src/routes/orderRoutes.js` | Bearer JWT | 會員自己的訂單、建立 ECPay 信用卡付款及主動查詢驗證。 |
| `/` | `src/routes/pageRoutes.js` | 頁面路由不驗證 | EJS pages；資料仍由受保護 API 控制。 |

### 頁面路由

頁面路由只負責渲染 EJS shell，不在 server-side 阻擋未登入使用者；會員／管理員頁面的前端會做 UX redirect，真正的資料安全邊界仍是 REST API 的 JWT middleware。

| Method | Path | 頁面／用途 | 頁面層認證行為 |
| --- | --- | --- | --- |
| GET | `/` | 首頁、商品列表與分頁 | 公開。 |
| GET | `/products/:id` | 商品詳情 | 公開。 |
| GET | `/cart` | 訪客／會員購物車 | 公開 shell；資料由 JWT 或 `X-Session-Id` API 決定 owner。 |
| GET | `/checkout` | 收件資料與建立訂單 | `checkout.js` 要求登入；訂單 API 再驗 JWT。 |
| GET | `/login` | 登入／註冊 | 公開；支援 `redirect` query。 |
| GET | `/orders` | 個人訂單列表 | `orders.js` 要求登入；API 限定目前 user。 |
| GET | `/orders/:id` | 訂單詳情、ECPay 導頁與主動查詢 | `order-detail.js` 要求登入；API 以 order owner 過濾。 |
| GET | `/admin/products` | 管理商品 | Admin layout 做 UX redirect；API 要求 JWT + admin。 |
| GET | `/admin/orders` | 管理訂單 | Admin layout 做 UX redirect；API 要求 JWT + admin。 |

### REST API 完整端點矩陣

| Method | Path | 認證 | 成功狀態 | 行為摘要 |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/register` | 公開 | 201 | 驗證 email/password/name，建立 `user`，回 JWT。 |
| POST | `/api/auth/login` | 公開 | 200 | bcrypt 比對並回 JWT。 |
| GET | `/api/auth/profile` | JWT | 200 | 回目前使用者欄位。 |
| GET | `/api/products` | 公開 | 200 | `page`/`limit` 分頁，created_at DESC。 |
| GET | `/api/products/:id` | 公開 | 200 | 單筆商品。 |
| GET | `/api/cart` | JWT 或 session | 200 | owner cart items + 動態 total。 |
| POST | `/api/cart` | JWT 或 session | 200 | 新增；相同 owner/product 時累加。 |
| PATCH | `/api/cart/:itemId` | JWT 或 session | 200 | 覆寫 quantity。 |
| DELETE | `/api/cart/:itemId` | JWT 或 session | 200 | 刪除 owner 的 item。 |
| POST | `/api/orders` | JWT | 201 | 由會員 cart 建單、扣庫存、清 cart。 |
| GET | `/api/orders` | JWT | 200 | 自己的訂單，無分頁。 |
| GET | `/api/orders/:id` | JWT | 200 | 自己的訂單、items 與安全的 payment 摘要。 |
| POST | `/api/orders/:id/payments/ecpay` | JWT | 200 | 為 pending 訂單建立／重用 payment，回 AIO form action 與已簽章欄位。 |
| POST | `/api/orders/:id/payments/ecpay/verify` | JWT | 200 | server-side 呼叫 QueryTradeInfo，驗簽並套用可信付款狀態。 |
| GET | `/api/admin/products` | JWT + admin | 200 | 全商品分頁。 |
| POST | `/api/admin/products` | JWT + admin | 201 | 建商品。 |
| PUT | `/api/admin/products/:id` | JWT + admin | 200 | 對提供欄位做 merge/update。 |
| DELETE | `/api/admin/products/:id` | JWT + admin | 200 | 無 pending order reference 時刪除。 |
| GET | `/api/admin/orders` | JWT + admin | 200 | 全訂單分頁，可篩 status。 |
| GET | `/api/admin/orders/:id` | JWT + admin | 200 | 訂單、items 與買家 name/email。 |

端點的完整 input、預設值與錯誤情境見 [FEATURES.md](./FEATURES.md)。

## 5. 統一回應格式

所有 JSON API 的預期 envelope：

```json
{
  "data": {},
  "error": null,
  "message": "成功"
}
```

列表把資料與 pagination 放在 `data`：

```json
{
  "data": {
    "products": [],
    "pagination": {
      "total": 0,
      "page": 1,
      "limit": 10,
      "totalPages": 0
    }
  },
  "error": null,
  "message": "成功"
}
```

預期業務錯誤由 route/middleware 直接回應：

```json
{
  "data": null,
  "error": "VALIDATION_ERROR",
  "message": "quantity 必須為正整數"
}
```

未捕捉例外進入 `errorHandler`。它使用 `err.status || err.statusCode || 500` 作 HTTP status，但 `error` 一律為 `INTERNAL_ERROR`；500 一律隱藏內部訊息，非 500 只有 `err.isOperational` 時保留原訊息。API 未命中則由 `app.js` 回 404/`NOT_FOUND`。EJS render 失敗目前直接 `send(err.message)`，與 JSON error policy 不同。

## 6. 認證與授權

### JWT 參數

| 項目 | 實際值 |
| --- | --- |
| 簽章 secret | `process.env.JWT_SECRET`；server 啟動必填。 |
| 演算法 | 簽發未顯式指定（jsonwebtoken 對對稱 secret 預設 HS256）；驗證顯式只接受 `HS256`。 |
| 有效期 | `7d`，註冊與登入一致。 |
| Payload | `{ userId, email, role }`，另由 library 加入 `iat`／`exp`。 |
| Transport | `Authorization: Bearer <token>`。 |
| Issuer/audience | 未設定、未驗證。 |
| 撤銷機制 | 無 denylist/refresh token；刪除 user 會因存在檢查而使 token 失效。 |

### `authMiddleware` 行為

1. 缺 header 或不是字面前綴 `Bearer `：401 `UNAUTHORIZED`。
2. 取空白後第二段 token，使用 `JWT_SECRET` + allowed algorithm HS256 驗證簽章與 `exp`。
3. 只用 `decoded.userId` 查 `users.id` 是否仍存在。
4. 若存在，把 token 內 `userId`、`email`、`role` 複製到 `req.user`。

Middleware 不重新讀取 email/role；若資料庫角色改變，舊 token 的角色可持續至 7 天到期。管理權限由 `adminMiddleware` 檢查 `req.user.role`，因此角色變更功能若未來加入，必須一併設計 token invalidation 或重新讀取角色。

### 購物車雙模式認證

`dualAuth` 是 cart route 私有函式，優先級不可誤解：

1. 若有 `Authorization: Bearer ...`：一定走 JWT。token 無效或 user 不存在立即 401，即使同一 request 也帶有效 `X-Session-Id`，不會 fallback。
2. 完全沒有 Bearer 時，若 `sessionMiddleware` 已放入 truthy `req.sessionId`，接受訪客模式。
3. 兩者皆無則 401。
4. JWT 模式 owner 是 `cart_items.user_id`；session 模式 owner 是 `cart_items.session_id`。兩個集合永不自動合併。

Browser 的 `Auth.getAuthHeaders()` 永遠產生／附帶 `X-Session-Id`，有 token 時也附 Bearer；server 仍以 JWT owner 為準。這造成訪客先加購物車、再登入後看到空的會員 cart，原訪客 item 留在 session cart。

Session id 是 browser 端 `crypto.randomUUID()` 生成的 bearer-like identifier，儲於 localStorage，server 不驗證格式或擁有權。知道某個 session id 的 caller 就能操作該 cart；不得用它保護個資或訂單。

## 7. 資料庫 schema

資料庫位於 `<repository>/database.sqlite`，時間欄位皆由 SQLite `datetime('now')` 產生 UTC 格式文字。主鍵皆為應用程式產生的 UUID v4。DDL 僅 `CREATE TABLE IF NOT EXISTS`，不是 migration framework；修改既有 schema 不會自動 alter 已存在資料庫。

### `users`

| 欄位 | SQLite 型別 | Null／預設 | 約束與語意 |
| --- | --- | --- | --- |
| `id` | TEXT | NOT NULL | PRIMARY KEY，UUID v4。 |
| `email` | TEXT | NOT NULL | UNIQUE；登入與重複註冊查找。未正規化大小寫。 |
| `password_hash` | TEXT | NOT NULL | bcrypt hash；一般註冊 cost 10，test env seed admin cost 1。 |
| `name` | TEXT | NOT NULL | 顯示名稱；只驗證 truthy，未 trim/限制長度。 |
| `role` | TEXT | NOT NULL，default `'user'` | CHECK `user` 或 `admin`。註冊固定 user，seed 固定 admin。 |
| `created_at` | TEXT | NOT NULL，`datetime('now')` | 建立時間。 |

### `products`

| 欄位 | SQLite 型別 | Null／預設 | 約束與語意 |
| --- | --- | --- | --- |
| `id` | TEXT | NOT NULL | PRIMARY KEY。 |
| `name` | TEXT | NOT NULL | 商品名稱。create 只要求 truthy；update 禁止空字串。 |
| `description` | TEXT | nullable | 商品說明。create 的 falsy 值會存 NULL。 |
| `price` | INTEGER | NOT NULL | CHECK `price > 0`；金額單位為整數新台幣，無小數／currency 欄位。 |
| `stock` | INTEGER | NOT NULL，default `0` | CHECK `stock >= 0`；建單扣減。 |
| `image_url` | TEXT | nullable | 外部圖片 URL；未驗證 scheme。 |
| `created_at` | TEXT | NOT NULL，`datetime('now')` | 建立時間、列表排序鍵。 |
| `updated_at` | TEXT | NOT NULL，`datetime('now')` | 管理員 PUT 時更新；建單扣庫存不更新此欄位。 |

### `cart_items`

| 欄位 | SQLite 型別 | Null／預設 | 約束與語意 |
| --- | --- | --- | --- |
| `id` | TEXT | NOT NULL | PRIMARY KEY。 |
| `session_id` | TEXT | nullable | 訪客 owner。無 FK、格式、索引或 unique。 |
| `user_id` | TEXT | nullable | 會員 owner；FK → `users(id)`。 |
| `product_id` | TEXT | NOT NULL | FK → `products(id)`。 |
| `quantity` | INTEGER | NOT NULL，default `1` | CHECK `quantity > 0`。 |

Schema 沒有 CHECK 保證 `session_id`／`user_id` 恰有一個，也沒有 `(owner, product_id)` unique constraint；去重只靠 route 的先查再新增。因此其他 writer 或競態可能建立重複 row。外鍵沒有 `ON DELETE CASCADE`，使用者／商品仍被 cart 引用時刪除會失敗。

### `orders`

| 欄位 | SQLite 型別 | Null／預設 | 約束與語意 |
| --- | --- | --- | --- |
| `id` | TEXT | NOT NULL | PRIMARY KEY。 |
| `order_no` | TEXT | NOT NULL | UNIQUE；`ORD-YYYYMMDD-` + UUID 前 5 字元大寫。日期來自 app process 的 UTC ISO date。 |
| `user_id` | TEXT | NOT NULL | FK → `users(id)`。 |
| `recipient_name` | TEXT | NOT NULL | 下單當下收件人快照。 |
| `recipient_email` | TEXT | NOT NULL | 以簡單 regex 驗證。 |
| `recipient_address` | TEXT | NOT NULL | 收件地址。 |
| `total_amount` | INTEGER | NOT NULL | 建單當下 price × quantity 合計；沒有運費、折扣或稅。 |
| `status` | TEXT | NOT NULL，default `'pending'` | CHECK `pending`、`paid`、`failed`。 |
| `created_at` | TEXT | NOT NULL，`datetime('now')` | 建立時間；沒有 updated/paid timestamp。 |

### `order_items`

| 欄位 | SQLite 型別 | Null／預設 | 約束與語意 |
| --- | --- | --- | --- |
| `id` | TEXT | NOT NULL | PRIMARY KEY。 |
| `order_id` | TEXT | NOT NULL | FK → `orders(id)`。 |
| `product_id` | TEXT | NOT NULL | 原商品 id，但刻意沒有宣告 FK，可在商品刪除後保留歷史。 |
| `product_name` | TEXT | NOT NULL | 建單當下名稱快照。 |
| `product_price` | INTEGER | NOT NULL | 建單當下單價快照。 |
| `quantity` | INTEGER | NOT NULL | 建單數量；DDL 沒有正數 CHECK，但 route 來源 cart 有 CHECK。 |

### `payments`

每張訂單最多一筆付款嘗試；此限制來自 `order_id UNIQUE`。表內只保存後端整合所需 metadata，不保存卡號、HashKey 或 HashIV。

| 欄位 | SQLite 型別 | Null／預設 | 約束與語意 |
| --- | --- | --- | --- |
| `id` | TEXT | NOT NULL | PRIMARY KEY，UUID v4。 |
| `order_id` | TEXT | NOT NULL | UNIQUE；FK → `orders(id)`，一張訂單一筆 ECPay attempt。 |
| `provider` | TEXT | NOT NULL，default `'ecpay'` | CHECK 僅允許 `ecpay`。 |
| `merchant_trade_no` | TEXT | NOT NULL | UNIQUE；`FL` + 13 位時間尾碼 + 5 位隨機十六進位，共 20 個英數字。送至綠界並用於主動查詢。 |
| `merchant_trade_date` | TEXT | NOT NULL | AIO 格式 `yyyy/MM/dd HH:mm:ss`，以 Asia/Taipei 產生。 |
| `amount` | INTEGER | NOT NULL | CHECK `amount > 0`；建立時複製 `orders.total_amount`，查詢時再與 `TradeAmt` 比對。 |
| `status` | TEXT | NOT NULL，default `'created'` | CHECK `created`、`pending`、`paid`、`failed`。未知／尚未付款的 ECPay 狀態映為 pending。 |
| `provider_trade_no` | TEXT | nullable | 已驗簽查詢回應的 ECPay `TradeNo`。 |
| `payment_type` | TEXT | nullable | 已驗簽查詢回應的 `PaymentType`。 |
| `paid_at` | TEXT | nullable | paid 時保存 ECPay `PaymentDate`；不是 SQLite 自產時間。 |
| `last_queried_at` | TEXT | nullable | 最近一次取得查詢名額的 UTC SQLite 時間；即使外部呼叫失敗仍保留以防重打。 |
| `query_count` | INTEGER | NOT NULL，default `0` | CHECK `>= 0`；每次取得查詢名額加一。 |
| `created_at` | TEXT | NOT NULL，`datetime('now')` | payment row 建立時間。 |
| `updated_at` | TEXT | NOT NULL，`datetime('now')` | 查詢預約與狀態套用時更新。 |

所有外鍵都沒有 cascade；orders 被 user 引用、order_items 被 order 引用時，相應 parent 不能直接刪。專案目前沒有刪 user/order API。

## 8. 核心資料流

### 註冊／登入

1. Browser 表單做最小驗證，`apiFetch` 發 JSON。
2. 註冊 route 驗證必填、email regex、密碼至少 6；查 email unique，bcrypt cost 10 後 INSERT。
3. 登入 route 依原字串 email 查 user，bcrypt compare。
4. 兩者都簽 7d JWT，回 user（不含 hash）與 token。
5. Browser 將 token/user 分別寫入 `flower_token`、`flower_user`。後續 request 同時帶 Bearer 與 browser session id。

### 購物車

1. `sessionMiddleware` 只擷取 header；`dualAuth` 決定 JWT 或 session owner。
2. 加入時 parse quantity，讀商品與 stock。
3. 同 owner/product 已存在：新數量 = 舊數量 + 請求數量；通過 stock 才 update。
4. 不存在：通過 stock 後 insert 新 row。
5. GET 以 INNER JOIN products，將扁平 SQL 欄位轉成 `{ product: ... }`，在 application code 計算 total。
6. PATCH 是絕對數量覆寫；DELETE 只允許 owner 的 item id。

### 建立訂單

1. Router-level JWT 驗證；session cart 不能建單。
2. 驗證三個收件欄位與 email 格式。
3. 查會員 cart 並 JOIN 商品的目前 name/price/stock。空 cart 回 `CART_EMPTY`。
4. 在 transaction 前確認每項 quantity 不超過 stock並以目前價格計算 total。
5. 產生 UUID order id 與 order number。
6. 一個 `better-sqlite3` transaction 依序：INSERT order → 每項 INSERT snapshot item → 每項 `stock = stock - quantity` → DELETE 該 user 所有 cart rows。
7. transaction 同步執行；任何 SQL throw 會 rollback，之後由全域 error handler 回 500。
8. 回傳精簡 order 與不含 item id/product id 的 items。後續 detail 會回完整 rows。

付款失敗不補庫存，且 `failed` 不可再次付款；付款成功只會由 ECPay 主動查詢的可信結果觸發。

### ECPay 本地主動驗證付款

1. 會員在 pending 訂單詳情呼叫 `POST /api/orders/:id/payments/ecpay`；route 用 `id + user_id` 確認 owner。
2. 首次呼叫建立唯一 payment snapshot；重複呼叫重用同一筆交易編號，避免同一訂單任意產生多筆交易。
3. `ecpayService` 以 server-only HashKey/HashIV 對 AIO 欄位產生 SHA-256 CheckMacValue。瀏覽器只收到結帳必需欄位，建立隱藏 form POST 至綠界。
4. `ChoosePayment` 固定 `Credit`。`ReturnURL` 因 localhost 無法接收通知只作協定必填占位；`ClientBackURL` 導回本機訂單頁，但 browser redirect 不視為付款證據。
5. 使用者回到訂單頁後按「查詢付款結果」，browser 呼叫 verify endpoint。後端先以原子 UPDATE 預約查詢名額，同一 payment 預設 600 秒內重查回 429。
6. 後端送 MerchantID、MerchantTradeNo、三分鐘有效的 Unix `TimeStamp` 與 CheckMacValue 至 `QueryTradeInfo/V5`。HTTP 有 timeout；403 轉為 rate-limit 錯誤。
7. 回應先做 timing-safe CheckMacValue 驗證，再比對 MerchantID、MerchantTradeNo 與本地 amount。任何一項不符皆不更新訂單。
8. `TradeStatus=1` 在單一 DB transaction 將 payment/order 設為 paid；`10200095` 設為 failed；其他狀態保存為 pending。已 paid 的查詢具冪等性，直接回本地結果且不再呼叫 ECPay。

### 管理商品刪除

1. 確認商品存在。
2. JOIN `order_items`/`orders` 計算引用該商品的 pending orders；大於 0 回 409。
3. 否則 DELETE products。因 `order_items.product_id` 沒有 FK，paid/failed 歷史不阻擋。
4. 但 `cart_items.product_id` 有 RESTRICT-like 外鍵且 route 沒有預查；任何購物車引用都會使 DELETE throw，最終成為 500 `INTERNAL_ERROR`。這是目前實作缺口，不應文件化為 409。

## 9. 金流與第三方整合

### ECPay AIO 整合邊界

目前已完成 AIO 信用卡導頁、server-side CheckMacValue、交易紀錄及 QueryTradeInfo 主動驗證。舊的 `PATCH /api/orders/:id/pay` 已移除，client 無法自行指定成功或失敗。`ReturnURL` 不承擔狀態更新：staging 未設定時使用 `https://example.com/ecpay/notify` 占位，production 則強制要求顯式設定；本機仍以 verify endpoint 為唯一付款確認來源。

因專案只有 localhost，ATM、CVS、BARCODE、BNPL 等可能在離開結帳頁後才付款的方式不在支援範圍。系統也尚無退款、取消、重新付款、多次 payment attempt、背景輪詢、webhook reconciliation 或正式環境端對端測試。若未來部署可公開接收 Server Notify，應新增獨立通知 endpoint、驗簽、冪等與主動查詢對帳，而不是信任 ClientBackURL query string。

### 其他外部依賴

- Vue 由 `https://unpkg.com/vue@3/dist/vue.global.prod.js` 載入，未 pin patch/version，也無本機 fallback。
- 字體由 Google Fonts 載入。
- 商品 seed 與 UI fallback 使用 Unsplash 遠端圖片。
- CORS origin 由 `FRONTEND_URL` 控制，但頁面通常與 API 同 origin。

## 10. 已知架構限制與整合風險

- 無 migration system、repository/service layer 或 async boundary；routes 直接持有 SQL。schema 變更必須另外設計 migration，不能只改 `CREATE TABLE IF NOT EXISTS`。
- 測試與 app 共用固定 DB 路徑；`NODE_ENV=test` 只降低管理員 seed bcrypt cost，不隔離資料。
- 訪客 cart 不會登入合併；browser 登入後 server 改用 `user_id` owner。
- Session id 未簽章且永久留在 localStorage；適合低敏感度購物車，不適合身分認證。
- JWT 無 refresh/revocation/issuer/audience；admin role 來自可能過期的 claim。
- 商品刪除未處理 cart foreign-key conflict。
- stock pre-check 與 transaction 內扣減沒有 SQL-level `WHERE stock >= ?` 防衛；目前同步 process 降低同 process interleaving，但多 process/外部 writer 會有超賣風險。
- `apiFetch` 對任何 401 清除登入並導頁，包含純 session request；如果 guest session 遇到 401 也會被導向登入。
- 首頁／商品頁加 cart badge 時固定 `+1`，badge 本質是 row count；一次新增多件或累加既有 row 時 UI 可能與 reload 後不同。
- EJS 頁面 route 未 server-side auth，敏感資料不可嵌入 page HTML；所有資料授權必須維持在 API。
- OpenAPI JSDoc 與 runtime 沒有自動一致性驗證；實作才是目前 source of truth。

