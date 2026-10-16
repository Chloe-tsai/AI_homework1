# 功能清單與行為規格

## 1. 狀態總覽

狀態以目前 repository 的可執行程式為準：`✅ 完成` 表示已有 server/client 實作與至少部分整合測試；`🚧 進行中` 表示核心流程可用但仍有明確缺口；`未實作` 表示只有設定、文案或規劃痕跡。既有功能的舊狀態文字會在其下次實際變更時逐步統一，避免只為格式重寫整張表。

| 功能區塊 | 狀態 | 已有能力 | 主要缺口 |
| --- | --- | --- | --- |
| EJS 前台與響應式樣式 | 完成 | 首頁、商品、購物車、登入、結帳、訂單、404；Tailwind 4 | 依賴未 pin 的 Vue CDN 與外部圖片/字體；無前端自動測試。 |
| 會員註冊／登入／profile | 完成 | bcrypt、7d JWT、使用者存在檢查 | 無 refresh、logout revocation、rate limit、忘記密碼、email verification。 |
| 公開商品瀏覽 | 完成 | 列表、分頁、詳情、庫存顯示 | 無搜尋、分類、排序參數。 |
| 訪客購物車 | 完成 | `X-Session-Id` CRUD、累加、stock 驗證 | Session id 未簽章／到期；不合併登入後 cart。 |
| 會員購物車 | 完成 | JWT owner CRUD | 無 guest-to-user merge，無 DB unique owner/product constraint。 |
| Checkout／建立訂單 | 完成 | 驗證收件人、snapshot、transaction、扣庫存、清 cart | 無運費、折扣、稅、庫存 reservation、多幣別。 |
| 個人訂單 | 完成 | 列表、owner-scoped 詳情 | 列表無分頁／取消訂單。 |
| ECPay 信用卡付款 | ✅ 完成（本機架構） | AIO 導頁、SHA-256 CheckMacValue、payment 紀錄、QueryTradeInfo 主動驗證 | 無 Server Notify、退款、背景輪詢、多次付款嘗試；僅 Credit。 |
| 管理商品 | 完成 | 分頁、create、merge-style PUT、delete | delete 遇 cart FK 時成 500；無圖片上傳、批次操作。 |
| 管理訂單 | 完成（唯讀） | 分頁、status filter、詳情＋買家 | 無狀態更新、出貨、取消、退款。 |
| OpenAPI 產生 | 部分完成 | 路由 JSDoc → OpenAPI 3.0.3 JSON | 無 Swagger UI、CI 驗證；部分細節只在實作存在。 |
| 整合測試 | 部分完成 | 七個 API suite、Supertest；含 ECPay service/route boundary | 污染固定 DB、案例有順序依賴、部分錯誤邊界未覆蓋。 |

## 2. 共通 API 規則

### Request format

- JSON body 使用 `Content-Type: application/json`；app 也接受 `application/x-www-form-urlencoded`（`extended: false`）。
- JWT 使用 `Authorization: Bearer <token>`。
- 訪客 cart 使用 `X-Session-Id: <opaque string>`；server 只要求 truthy，不檢查 UUID。
- UUID path parameter 沒有格式驗證；不存在的任意字串通常回 404。

### Response envelope

```json
{
  "data": null,
  "error": "NOT_FOUND",
  "message": "商品不存在"
}
```

成功時 `error` 必為 `null`；失敗時預期 `data` 為 `null`。刪除成功也回 HTTP 200 + `data: null`，不使用 204。

### 共通認證錯誤

| HTTP | Error | 情境 |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | JWT route 缺 Bearer、token malformed/簽章錯誤/過期、token user 不存在；cart 兩種 credential 都缺少。 |
| 403 | `FORBIDDEN` | JWT 有效且 user 存在，但 token claim role 不是 admin。 |
| 404 | `NOT_FOUND` | 未命中的 `/api/*` path，或 resource 不存在／不屬目前 user。 |
| 500（或 error 指定 status） | `INTERNAL_ERROR` | 未捕捉 exception。500 message 會被安全通用文字取代。 |

Browser `apiFetch` 對任何 401 都清除 `flower_token`、`flower_user` 並導向 `/login`；呼叫端可能拿到 `undefined`，因 redirect 前函式直接 return。

## 3. 身分與會員

### 行為描述

註冊與登入都回 user 摘要和 7 天 JWT，browser 將兩者存在 localStorage。密碼只存 bcrypt hash。註冊角色固定為 `user`，不能由 request 提升權限。管理員由 database initialization 根據環境變數 seed。

JWT payload 的 email/role 是簽發當下快照；middleware 只重新確認 user id 存在，不重新讀 role。登出只刪 browser localStorage，server token 在到期前仍有效。

#### POST `/api/auth/register`

Body：

| 欄位 | 必填 | 型別／規則 | 實際處理 |
| --- | --- | --- | --- |
| `email` | 是 | truthy，符合 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` | 原字串存 DB；不 trim、不轉小寫。 |
| `password` | 是 | truthy，`.length >= 6` | bcrypt cost 10。沒有複雜度或最大長度限制。 |
| `name` | 是 | truthy | 原值存 DB；不 trim、不限制長度。 |

成功 201：建立 UUID user、role `user`，回 `{ data: { user: { id,email,name,role }, token }, error:null, message }`。

| HTTP | Error | 情境 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 任一必填值 falsy。 |
| 400 | `VALIDATION_ERROR` | email regex 失敗。 |
| 400 | `VALIDATION_ERROR` | password length < 6。非字串 truthy 值可能引發非預期行為。 |
| 409 | `CONFLICT` | `users.email` 已存在。查詢為 SQLite 預設 case-sensitive equality。 |

#### POST `/api/auth/login`

Body：`email`、`password` 均必填；沒有額外 email format 驗證。依 email 精確查 user，再 `bcrypt.compareSync`。

成功 200 的 data shape 與 register 相同。不存在 email 與錯誤密碼刻意都回 401 `UNAUTHORIZED` + 相同 message，避免直接區分帳號是否存在。

| HTTP | Error | 情境 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | email 或 password falsy。 |
| 401 | `UNAUTHORIZED` | user 不存在或密碼不符。 |

#### GET `/api/auth/profile`

必須 Bearer JWT。成功 200 回 `{ id, email, name, role, created_at }`。`authMiddleware` 已先確認 user 存在；route 仍有二次 not-found guard（404 `NOT_FOUND`）。

## 4. 公開商品目錄

### 行為描述

商品讀取完全公開。列表依 `created_at DESC`，沒有 secondary sort；同秒建立商品的相對順序不保證。價格是整數，庫存可為 0。前端首頁固定 request `limit=9` 並把前四筆另作「精選」，不是獨立推薦資料。

#### GET `/api/products`

Query：

| 參數 | 必填 | 預設 | 邊界與實際解析 |
| --- | --- | --- | --- |
| `page` | 否 | `1` | `parseInt(value) || 1` 後 `Math.max(1, ...)`。0、負數、非數字成 1；`2abc` 會被當 2。 |
| `limit` | 否 | `10` | 同樣 parse；clamp 至 1..100。 |

成功 200：`data.products` 每筆包含完整 products row；`data.pagination = { total, page, limit, totalPages }`。空資料時 totalPages 為 0。

沒有 route-level 業務錯誤。非法 query 會被 fallback/clamp，而非 400。

#### GET `/api/products/:id`

成功 200 回完整 product row：`id,name,description,price,stock,image_url,created_at,updated_at`。找不到回 404 `NOT_FOUND`。

## 5. 購物車（雙模式認證）

### Owner 與認證流程

購物車是本專案的非標準認證機制：同一組 endpoints 接受 JWT 或 session header。若 Bearer 存在就優先 JWT；無效 Bearer 立即 401，絕不 fallback 到同 request 的 session。JWT owner 寫 `user_id`，訪客 owner 寫 `session_id`。

Browser 每次呼叫都帶 `X-Session-Id`，但登入時 server 仍選 JWT。系統沒有 merge endpoint，所以訪客 cart 與登入後 cart 是兩個獨立集合。Checkout 只由 JWT user cart 建單。

### 查詢購物車：GET `/api/cart`

無 query/body。依 owner 查 cart 並 INNER JOIN products。成功 200：

```json
{
  "data": {
    "items": [
      {
        "id": "cart-item-uuid",
        "product_id": "product-uuid",
        "quantity": 2,
        "product": {
          "name": "商品",
          "price": 500,
          "stock": 10,
          "image_url": "https://..."
        }
      }
    ],
    "total": 1000
  },
  "error": null,
  "message": "成功"
}
```

`total` 每次以目前商品價格 × cart quantity 計算；不是加入購物車時的價格保證。因 INNER JOIN，若資料完整性被外部 writer 破壞，孤兒 item 不會顯示。

### 加入購物車：POST `/api/cart`

Body：

| 欄位 | 必填 | 預設 | 規則 |
| --- | --- | --- | --- |
| `productId` | 是 | 無 | truthy；找 products.id。 |
| `quantity` | 否（OpenAPI 標為 required，但 runtime 有預設） | `1` | `parseInt` 後 >= 1。因 parseInt，`"2abc"`→2、`1.9`→1；這是現況，不是建議輸入。 |

業務邏輯：

- Owner 已有相同 product row：`newQty = existing.quantity + qty`，以累加後數量比較目前 stock；成功 update 原 id。
- 尚無 row：qty 不超過 stock 才新增 UUID row。
- 回 200 而不是 201；data 僅 `{ id, product_id, quantity }`。
- 累加的判斷在 DB 沒有 unique constraint 支援；若外部 writer 產生重複 row，只處理 `.get()` 命中的一筆。

| HTTP | Error | 情境 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | productId 缺少，或 quantity parse 後不是 >=1 integer。 |
| 400 | `STOCK_INSUFFICIENT` | 新增量或累加後總量大於 stock；stock 0 亦同。 |
| 404 | `NOT_FOUND` | productId 不存在。 |

### 修改數量：PATCH `/api/cart/:itemId`

Body `quantity` 必填，採與 POST 相同 parse 規則，但沒有 default。它是「覆寫」不是增量。先以 item id + owner 找 row，再讀商品 stock；成功 update 並回 `{ id, product_id, quantity }`。

| HTTP | Error | 情境 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | quantity 缺少／無法 parse／<1。 |
| 400 | `STOCK_INSUFFICIENT` | quantity > current stock。 |
| 404 | `NOT_FOUND` | item 不存在或屬另一 owner；不洩漏他人 item。 |

若關聯商品被不受外鍵保護的外部程序刪除，`product` 可能 undefined 並造成 500；正常連線啟用 FK 時不會發生。

### 移除：DELETE `/api/cart/:itemId`

先以 item id + owner 查找，只刪自己的 row。成功 200 + `data:null`。不存在或非 owner 回 404 `NOT_FOUND`。

### 前端行為

- Header badge 顯示 `items.length`（商品 row 數），不是 quantities 總和。
- 首頁與詳情加入後 badge 直接 `+1`，即使是既有 row 累加或一次加入多件；重新載入時才校正為 row 數。
- Cart UI 不允許 quantity <1；刪除需要 modal 確認。
- 未登入按結帳會導至 `/login?redirect=/checkout`，但登入後不會合併原 session cart，因此 checkout 可能再導回空 cart。
- UI 顯示滿 NT$500 免運，但 server order 沒有 shipping fee；任何金額實際都等於商品小計。

## 6. Checkout 與訂單

### 建立訂單：POST `/api/orders`

只接受 JWT。Body：

| 欄位 | 必填 | 規則 | DB 欄位 |
| --- | --- | --- | --- |
| `recipientName` | 是 | truthy；未 trim/長度限制 | `recipient_name` |
| `recipientEmail` | 是 | truthy + 簡單 email regex | `recipient_email` |
| `recipientAddress` | 是 | truthy；未 trim/長度限制 | `recipient_address` |

建單只讀 `cart_items.user_id = req.user.userId`，完全忽略 session cart。業務流程：

1. JOIN cart 與目前商品資料。
2. 空 cart → `CART_EMPTY`。
3. 收集所有 `quantity > stock` 商品，回一個錯誤 message 列出名稱。
4. 用目前 `product_price * quantity` 加總；沒有運費、折扣、稅。
5. 產生 `ORD-YYYYMMDD-XXXXX`。日期取 Node `toISOString()` 的 UTC 日期；尾碼取 UUID 前 5 chars uppercase，DB unique 是最後防線。
6. 在單一 transaction 建 `orders`、建立每筆 `order_items` snapshot、扣每項庫存、清空該 user cart。
7. 成功 201；訂單初始 status 由 DB default 為 `pending`。

成功 data 只回 `id,order_no,total_amount,status,items,created_at`；items 只包含 `product_name,product_price,quantity`。收件資訊要由 detail endpoint 取得。

| HTTP | Error | 情境 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 任一收件欄位 falsy。 |
| 400 | `VALIDATION_ERROR` | recipientEmail regex 失敗。 |
| 400 | `CART_EMPTY` | JWT user cart 無 item；session cart 不算。 |
| 400 | `STOCK_INSUFFICIENT` | 一或多項 cart quantity > stock。message 包含商品名稱。 |
| 401 | `UNAUTHORIZED` | JWT missing/invalid/expired/user missing。 |
| 500 | `INTERNAL_ERROR` | transaction SQL 失敗，例如 order number 極低機率碰撞；transaction 會 rollback。 |

重要狀態語意：庫存在「建單」而非「付款成功」時扣除。付款失敗不歸還；系統沒有取消／逾時釋放。

### 自己的訂單列表：GET `/api/orders`

無 query、無分頁。只 select 目前 user 的 `id,order_no,total_amount,status,created_at`，依 `created_at DESC`。空列表仍 200 + `orders: []`。

### 自己的訂單詳情：GET `/api/orders/:id`

SQL 同時以 id + current user id 篩選，所以不存在與別人的訂單都回同一個 404 `NOT_FOUND`。成功回完整 order row（含 `user_id`、收件資訊）、完整 order_items rows，以及 `payment`。尚未開始付款時 `payment:null`；否則摘要只含 `id,provider,merchant_trade_no,amount,status,provider_trade_no,payment_type,paid_at,last_queried_at,query_count,created_at,updated_at`，不會洩漏 HashKey/HashIV。

### 建立 ECPay 付款：POST `/api/orders/:id/payments/ecpay`

沒有 query 或 request body。只允許目前 JWT user 自己的 pending 訂單。第一次呼叫建立 payment；同一張 pending 訂單重複呼叫會重用既有 `merchant_trade_no`，不建立第二筆。成功回：

```json
{
  "data": {
    "payment": { "provider": "ecpay", "status": "created", "amount": 1680 },
    "checkout": {
      "action": "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5",
      "method": "POST",
      "fields": { "MerchantID": "...", "ChoosePayment": "Credit", "CheckMacValue": "..." }
    }
  },
  "error": null,
  "message": "ECPay 付款資料已建立"
}
```

後端以 order snapshot 組 `TotalAmount`，以 order_items 名稱組 `ItemName`；`ChoosePayment` 固定 `Credit`、`EncryptType=1`、`NeedExtraPaidInfo=N`。staging 且 `ECPAY_SIMULATE_PAID=true` 時多送 `SimulatePaid=1`。`ReturnURL` 是 ECPay 協定必填，但 localhost 無法接收，不能拿它更新狀態；`ClientBackURL` 只把瀏覽器帶回訂單頁。HashKey/HashIV 永不出現在 response。

| HTTP | Error | 情境 |
| --- | --- | --- |
| 400 | `INVALID_STATUS` | 訂單已 paid/failed。 |
| 401 | `UNAUTHORIZED` | JWT missing/invalid/expired/user missing。 |
| 404 | `NOT_FOUND` | 訂單不存在或不是目前 user。 |
| 500 | `ECPAY_CONFIG_INVALID` | environment 非 staging/production，或 production 缺 ReturnURL。 |
| 503 | `ECPAY_NOT_CONFIGURED` | MerchantID、HashKey 或 HashIV 缺少。 |

### 主動驗證付款：POST `/api/orders/:id/payments/ecpay/verify`

沒有 query 或 request body。這是本機架構唯一可信的付款確認入口；browser redirect、URL query 與 client body 都不能宣告付款成功。行為如下：

1. 以 order id + JWT user id 驗 owner，再確認已有 payment。
2. order/payment 都已 paid 時直接回本地結果，不呼叫外部 API。
3. 以單一條件 UPDATE 取得查詢名額；同筆交易預設 600 秒內再次呼叫回 429。可用環境變數調整，設 0 僅供測試。
4. 後端呼叫 ECPay `QueryTradeInfo/V5`；request 由 MerchantID、MerchantTradeNo、當下 Unix TimeStamp 與 CheckMacValue 組成。
5. 回應必須先通過 timing-safe CheckMacValue，再匹配 MerchantID、MerchantTradeNo、`TradeAmt === payments.amount`。任一檢查失敗都不改 order。
6. `TradeStatus=1` → payment/order paid；`10200095` → failed；其他值 → payment pending、order 保持 pending。狀態與 provider metadata 在 transaction 內一併寫入。

| HTTP | Error | 情境 |
| --- | --- | --- |
| 400 | `INVALID_STATUS` | order 已不是 pending，且不符合「order/payment 均 paid」的冪等分支。 |
| 404 | `NOT_FOUND` | 訂單不存在或不是目前 user。 |
| 409 | `PAYMENT_NOT_INITIALIZED` | 尚未先建立 ECPay payment。 |
| 429 | `PAYMENT_QUERY_TOO_FREQUENT` | 本地節流尚未到期。 |
| 429 | `ECPAY_RATE_LIMITED` | ECPay 查詢回 HTTP 403。 |
| 500 | `ECPAY_CONFIG_INVALID`、`ECPAY_RUNTIME_UNSUPPORTED` | 設定錯誤或 Node 無內建 fetch。 |
| 502 | `ECPAY_UNAVAILABLE` | 連線／非成功 HTTP；不更新訂單。 |
| 502 | `ECPAY_RESPONSE_INVALID` | 回應缺少或未通過 CheckMacValue。 |
| 502 | `ECPAY_RESPONSE_MISMATCH` | merchant、交易編號或金額與本地 snapshot 不符。 |
| 504 | `ECPAY_TIMEOUT` | 超過查詢 timeout。 |

前端只負責送出後端產生的 form 與觸發 verify。failed 不補回建單時已扣的庫存，且目前一張 order 只有一筆 payment，失敗後需重新下單。

## 7. 管理員商品

### 授權與 UI

所有 `/api/admin/products*` 先 `authMiddleware` 再 `adminMiddleware`。後台頁面本身仍公開 render，admin layout 在 DOM ready 呼叫 `Auth.requireAdmin()`；真正保護來自 API。使用者只要修改 localStorage UI role 可能短暫看到後台 shell，但拿不到資料，因 server 檢查簽章 JWT claim。

### 列表：GET `/api/admin/products`

`page`／`limit` 規則與公開商品列表相同：預設 1/10、limit clamp 1..100、非法值 fallback。成功 shape 也相同，返回完整 rows。

### 建立：POST `/api/admin/products`

| Body 欄位 | 必填 | 規則／儲存 |
| --- | --- | --- |
| `name` | 是 | truthy；未 trim。 |
| `price` | 是 | JavaScript `Number.isInteger(price)` 且 >0；數字字串不接受。 |
| `stock` | 是 | `Number.isInteger(stock)` 且 >=0。 |
| `description` | 否 | falsy 值存 NULL，否則原值。 |
| `image_url` | 否 | falsy 值存 NULL；不驗 URL。 |

成功 201 回完整 product。缺 name、非法 price/stock 都是 400 `VALIDATION_ERROR`。

### 更新：PUT `/api/admin/products/:id`

雖 method 是 PUT，行為其實是 partial merge：`name,description,price,stock,image_url` 全部選填；未提供就沿用既有值。提供 name 時呼叫 `.trim()` 並禁止空字串；因此應傳字串。price/stock 必須是 JSON integer。description/image_url 可明確傳 `null` 以清除。

即使 body 空物件，route 仍執行 UPDATE、刷新 `updated_at` 並 200。找不到先回 404 `NOT_FOUND`；驗證失敗回 400 `VALIDATION_ERROR`。

### 刪除：DELETE `/api/admin/products/:id`

1. 不存在 → 404 `NOT_FOUND`。
2. 若任何 `pending` order_items 引用 → 409 `CONFLICT`。
3. paid/failed order item 不阻擋，因 `order_items.product_id` 無 FK，歷史 name/price snapshot 保留。
4. 任一 cart item 引用時，`cart_items.product_id` FK 會阻擋 DELETE；route 沒轉譯該情境，現況為 500 `INTERNAL_ERROR`。
5. 成功 200 + `data:null`。

## 8. 管理員訂單（唯讀）

### 列表：GET `/api/admin/orders`

Query：

| 參數 | 預設 | 行為 |
| --- | --- | --- |
| `page` | 1 | 與其他分頁相同。 |
| `limit` | 10 | clamp 1..100。後台 UI 固定送 10。 |
| `status` | 無 | 僅 `pending`、`paid`、`failed` 會加入 WHERE；缺少或其他字串會靜默視為「全部」，不回 400。 |

成功回完整 orders rows + pagination，依 created_at DESC。列表的「買家」欄實際顯示 `recipient_name`，不是 users.name。

### 詳情：GET `/api/admin/orders/:id`

不限制 order owner。成功回完整 order、完整 items，以及另查 `users` 的 `{ name,email }`；若 user row 不存在則 `user:null`（正常 FK 下不會發生）。找不到回 404 `NOT_FOUND`。

管理員沒有修改訂單狀態 endpoint。付款狀態只能由訂單 owner 觸發 server-side ECPay 查詢，並由已驗簽結果改變。

## 9. 頁面、導覽與通知

### Server-rendered shell

`pageRoutes` 先 render page fragment，再 render layout。Front layout 共有 header/footer/toast；admin layout 共有 admin header/sidebar/footer/toast。未知非 API path 回 front-layout 404，未知 API path 回 JSON 404。

### Local storage keys

| Key | 內容 | 生命週期 |
| --- | --- | --- |
| `flower_token` | JWT string | login/register 設定；logout 或任何 API 401 移除。 |
| `flower_user` | user JSON | 同 token；前端 role/name 顯示來源。JSON 損壞時 `Auth.getUser()` 會 throw，沒有 recovery。 |
| `flower_session_id` | `crypto.randomUUID()` | 第一次組 auth headers 時建立；logout 不移除，因此訪客 cart id 延續。 |

### 頁面保護

- `/checkout`、`/orders`、`/orders/:id` 的 page JS 啟動時 `Auth.requireAuth()`。
- Admin layout DOM ready 時 `Auth.requireAdmin()`；page-specific script 仍會被載入，redirect 與 API call 時序由 browser event loop 決定，但 API 保持授權。
- Login 成功讀 `redirect` query 並直接 assign；沒有驗證只允許站內 path，可能形成 open redirect 行為，呼叫端應只產生站內值。

### 通知

單一 toast 支援四種顏色；新通知會清除舊 timeout，3 秒後開始 300ms 淡出。若頁面沒有 `#notification-toast` 則靜默忽略。

## 10. Seed、OpenAPI 與建置功能

### Seed

- 管理員：依 `ADMIN_EMAIL` 查存在性；不存在才建立。`NODE_ENV=test` 時 bcrypt cost 1，否則 10。
- 商品：只在 `SELECT COUNT(*) FROM products` 為 0 時，以 transaction 插入八筆；部分刪除後不補 seed。
- Seed 每次 import database 都呼叫，但透過存在檢查達成近似 idempotent。

### Tailwind build

`css:build` 以 Tailwind CLI 從 `public/css/input.css` 產生 minified `public/css/output.css`；`dev:css` 為 watcher。Output 被忽略且 EJS 只引用 output，所以 fresh clone 未 build 前頁面沒有預期樣式。

### OpenAPI

`npm run openapi` 掃描 route JSDoc 並寫 `openapi.json`。定義包含 bearerAuth、sessionId 與 localhost server。它是文件產生，不是 runtime validation；例如 cart POST 的 annotation 把 quantity 列 required，但 runtime 允許省略並預設 1，應以實作與測試為準並修正文檔漂移。

## 11. Error code 索引

| Code | 常見 HTTP | 來源／意義 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 必填、email、數值、enum 等輸入不符。 |
| `CART_EMPTY` | 400 | JWT user cart 無資料，無法建單。 |
| `STOCK_INSUFFICIENT` | 400 | cart 新數量或 checkout 數量超過目前庫存。 |
| `INVALID_STATUS` | 400 | 非 pending 訂單試圖建立／查詢付款。 |
| `PAYMENT_NOT_INITIALIZED` | 409 | 尚未建立 payment 就查詢。 |
| `PAYMENT_QUERY_TOO_FREQUENT` | 429 | 同一 payment 未達本地最低查詢間隔。 |
| `ECPAY_NOT_CONFIGURED`／`ECPAY_CONFIG_INVALID` | 500/503 | 必要憑證或環境設定缺少／無效。 |
| `ECPAY_RATE_LIMITED` | 429 | 綠界拒絕過於頻繁的查詢。 |
| `ECPAY_UNAVAILABLE`／`ECPAY_RESPONSE_INVALID`／`ECPAY_RESPONSE_MISMATCH`／`ECPAY_TIMEOUT` | 502/504 | 外部查詢不可用、簽章／身分／金額不可信或逾時。 |
| `UNAUTHORIZED` | 401 | 缺少／無效 JWT、token user 不存在、cart credential 缺少。 |
| `FORBIDDEN` | 403 | 有效 JWT 但非 admin。 |
| `NOT_FOUND` | 404 | 商品、cart item、訂單、API path 不存在，或 resource 非目前 owner。 |
| `CONFLICT` | 409 | 註冊 email 重複；商品仍有 pending order。 |
| `INTERNAL_ERROR` | 多為 500 | 未捕捉錯誤；global handler 不保留 route-specific machine code。 |

