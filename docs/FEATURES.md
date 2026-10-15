# 功能清單與完成狀態

狀態圖例：✅ 已完成（有實作且有測試覆蓋）｜🟡 已完成但無自動化測試／部分完成｜⏳ 已預留未實作｜⚠️ 已知限制

## 總覽

| 功能區塊 | 端點 / 頁面 | 狀態 |
|---------|-------------|------|
| 會員註冊 | `POST /api/auth/register`、`/login` 註冊分頁 | ✅ |
| 會員登入 | `POST /api/auth/login`、`/login` | ✅ |
| 個人資料 | `GET /api/auth/profile` | ✅（前端未使用） |
| 商品列表（分頁） | `GET /api/products`、`/` | ✅ |
| 商品詳情 | `GET /api/products/:id`、`/products/:id` | ✅ |
| 購物車（訪客 / 會員雙模式） | `/api/cart*`、`/cart` | ✅ |
| 結帳建立訂單 | `POST /api/orders`、`/checkout` | ✅ |
| 我的訂單列表 / 詳情 | `GET /api/orders`、`GET /api/orders/:id`、`/orders`、`/orders/:id` | ✅ |
| 模擬付款 | `PATCH /api/orders/:id/pay` | 🟡（無測試） |
| 後台商品管理 CRUD | `/api/admin/products*`、`/admin/products` | ✅ |
| 後台訂單查詢 | `/api/admin/orders*`、`/admin/orders` | ✅ |
| OpenAPI 文件產生 | `npm run openapi` | ✅ |
| ECPay 綠界金流 | — | ⏳（僅 `.env` 預留與前端 `?payment=` 提示） |
| 購物車登入合併、訂單取消/回補庫存、後台改訂單狀態、會員資料修改、搜尋/分類 | — | ⏳ 未實作 |

---

## 共通行為

### 分頁參數（商品列表、後台商品列表、後台訂單列表）

| 參數 | 預設 | 規則 |
|------|------|------|
| `page` | 1 | `Math.max(1, parseInt(page) \|\| 1)` → 非數字、0、負數都變成 1 |
| `limit` | 10 | `Math.max(1, Math.min(100, parseInt(limit) \|\| 10))` → 上限 100；`0` 或非數字變成 10；負數變成 1 |

回傳 `pagination: { total, page, limit, totalPages: Math.ceil(total / limit) }`。超出範圍的 page 回傳空陣列（不會報錯）。排序一律 `created_at DESC`；同一秒建立的資料（例如 8 筆種子商品）彼此順序不保證。

### 驗證規則

- 必填檢查使用 falsy 判斷（`!value`），所以空字串視為未填，但 `" "`（空白）會通過（後台商品 PUT 例外，會 trim）。
- Email 格式：`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`（註冊、訂單收件人共用）。
- 未知欄位一律忽略，不會報錯。

---

## 1. 會員認證（`src/routes/authRoutes.js`）

### 1.1 註冊 `POST /api/auth/register`

**Body**

| 欄位 | 必填 | 規則 |
|------|------|------|
| `email` | ✔ | 符合 Email regex；不可已存在（區分大小寫比對） |
| `password` | ✔ | 長度 ≥ 6 |
| `name` | ✔ | 非空 |

**行為**：依序檢查「三欄必填 → Email 格式 → 密碼長度 → Email 重複」，通過後以 bcrypt（10 rounds）雜湊密碼，建立 `role = 'user'` 的使用者，**立即簽發 JWT**（7 天）並回 201：

```json
{ "data": { "user": { "id", "email", "name", "role": "user" }, "token": "..." }, "error": null, "message": "註冊成功" }
```

無法透過 API 註冊管理員。

**錯誤**

| 狀態 | error | message |
|------|-------|---------|
| 400 | `VALIDATION_ERROR` | `email、password、name 為必填欄位` / `Email 格式不正確` / `密碼至少需要 6 個字元` |
| 409 | `CONFLICT` | `Email 已被註冊` |
| 500 | `INTERNAL_ERROR` | `JWT_SECRET` 未設定導致簽發失敗（此時使用者**已寫入 DB**） |

### 1.2 登入 `POST /api/auth/login`

**Body**：`email`（必填）、`password`（必填）。

**行為**：以 email 查使用者並 `bcrypt.compareSync`。帳號不存在與密碼錯誤回同一訊息（避免帳號列舉）。成功回 200，格式同註冊（`message: '登入成功'`）。

**錯誤**：400 `VALIDATION_ERROR`（`email 和 password 為必填欄位`）；401 `UNAUTHORIZED`（`Email 或密碼錯誤`）。

沒有登入失敗次數限制、沒有登出端點（登出是前端清除 localStorage）。

### 1.3 個人資料 `GET /api/auth/profile`（JWT）

回傳 DB 中 `{ id, email, name, role, created_at }`。若查無使用者回 404 `NOT_FOUND`（實務上 `authMiddleware` 已先回 401）。

### 1.4 前端登入頁（`/login`，`public/js/pages/login.js`）

- 「登入 / 註冊」雙分頁（`activeTab`），前端先驗證必填與密碼長度（不驗 Email 格式，交給後端）。
- 成功後 `Auth.login(token, user)` 存入 localStorage，導向 `?redirect=` 參數或 `/`。
- 錯誤訊息直接顯示後端 `message`。
- ⚠️ 登入 API 回 401（密碼錯）時，`apiFetch` 的全域 401 處理會清 token、`location.href = '/login'` 並回傳 `undefined`；`login.js` 接著存取 `res.data` 拋 TypeError，只會短暫顯示通用的「登入失敗」toast，隨即整頁重新載入到 `/login`（**`?redirect=` 參數遺失**）。後端的「Email 或密碼錯誤」訊息不會顯示。

---

## 2. 商品瀏覽（`src/routes/productRoutes.js`，公開）

### 2.1 商品列表 `GET /api/products`

查詢參數：`page`、`limit`（見共通分頁）。無搜尋、分類、價格排序或上下架狀態——**所有商品（含庫存 0）都會列出**。回傳 `data.products`（完整欄位）與 `data.pagination`。

首頁（`index.js`）固定以 `limit=9` 載入，並提供「加入購物車（數量 1）」快捷按鈕；`featuredImages` 為寫死的 4 張 Unsplash 圖片。

### 2.2 商品詳情 `GET /api/products/:id`

回傳單一商品完整欄位；不存在回 404 `NOT_FOUND / 商品不存在`。

詳情頁（`product-detail.js`）：數量選擇器範圍 1 ~ `stock`，加入購物車後 toast 並把 header 徽章 +1（前端估算；實際徽章語意是「品項數」，同商品重複加入時會短暫不準確，重新整理後校正）。

### 2.3 種子商品

8 筆（粉色玫瑰花束 1680/30、白色百合花禮盒 1280/25、繽紛向日葵花束 980/40、紫色鬱金香盆栽 750/50、乾燥花藝術花圈 1450/20、迷你多肉組合盆 580/60、經典紅玫瑰花束 3980/15、季節鮮花訂閱 890/100，格式為 價格/庫存）。只有在 `products` 表為空時寫入。

---

## 3. 購物車（`src/routes/cartRoutes.js`，`dualAuth`）

### 3.1 雙模式認證（非標準機制）

| 請求 | 模式 | 購物車擁有者欄位 |
|------|------|------------------|
| 帶有效 `Authorization: Bearer` | 會員 | `cart_items.user_id` |
| 帶無效/過期 Bearer（不論有無 session） | — | **401**，不會退回訪客模式 |
| 無 Bearer、有 `X-Session-Id` | 訪客 | `cart_items.session_id` |
| 兩者皆無 | — | 401 `請提供有效的登入 Token 或 X-Session-Id` |

前端每個請求都同時帶兩個 header，所以登入後一定走會員模式。**訪客購物車在登入後不會合併或轉移**（⏳ 未實作）；只有會員購物車可以結帳。

### 3.2 查看購物車 `GET /api/cart`

回傳：

```json
{
  "data": {
    "items": [
      { "id": "cart_item_id", "product_id": "...", "quantity": 2,
        "product": { "name": "...", "price": 1680, "stock": 30, "image_url": "..." } }
    ],
    "total": 3360
  },
  "error": null, "message": "成功"
}
```

`total` 以**目前**商品售價計算。商品資訊是 JOIN 即時取得，不是快照。

### 3.3 加入購物車 `POST /api/cart`

| 欄位 | 必填 | 預設 | 規則 |
|------|------|------|------|
| `productId` | ✔ | — | 商品必須存在 |
| `quantity` | | 1 | `parseInt` 後須為 ≥ 1 的整數（`"2"` 可，`2.7` 會變 2，`"abc"`/0/負數 → 400） |

**累加邏輯**：
- 該擁有者購物車已有此商品 → 新數量 = 原數量 + quantity；若新數量 > 庫存 → 400 `STOCK_INSUFFICIENT`；否則更新同一列。
- 沒有 → quantity > 庫存 → 400 `STOCK_INSUFFICIENT`；否則新增一列。
- 兩種情況都回 **200**（不是 201），`data: { id, product_id, quantity }`（quantity 為累加後結果），`message: '已加入購物車'`。

庫存只做檢查、**不預留**；多人同時把最後庫存放進購物車都會成功，到結帳時才擋。

**錯誤**：400 `VALIDATION_ERROR`（`productId 為必填欄位` / `quantity 必須為正整數`）、404 `NOT_FOUND`（`商品不存在`）、400 `STOCK_INSUFFICIENT`（`庫存不足`）、401（見 3.1）。

### 3.4 更新數量 `PATCH /api/cart/:itemId`

Body：`quantity`（必填，規則同上）。**設定為絕對值**（不是累加）。項目必須屬於目前擁有者，否則 404 `購物車項目不存在`（不會洩漏他人項目是否存在）。新數量 > 庫存 → 400 `STOCK_INSUFFICIENT`。不支援以 0 刪除項目（0 → 400）。成功回 `data: { id, product_id, quantity }`、`message: '數量已更新'`。

購物車頁的「−」按鈕在數量為 1 時不動作（`if (qty < 1) return`）。

### 3.5 移除項目 `DELETE /api/cart/:itemId`

項目需屬於目前擁有者，否則 404。成功回 `data: null`、`message: '已從購物車移除'`。購物車頁刪除前有自訂確認視窗（非瀏覽器 `confirm()`）。沒有「清空購物車」端點（只有建立訂單時會清空）。

---

## 4. 訂單（`src/routes/orderRoutes.js`，全部需要 JWT）

### 4.1 建立訂單 `POST /api/orders`

| 欄位 | 必填 | 規則 |
|------|------|------|
| `recipientName` | ✔ | 非空 |
| `recipientEmail` | ✔ | Email regex |
| `recipientAddress` | ✔ | 非空 |

**業務流程**：
1. 驗證三欄必填（400 `收件人姓名、Email 和地址為必填欄位`）與 Email 格式（400 `Email 格式不正確`）。
2. 讀取 `cart_items WHERE user_id = 目前使用者` JOIN `products`。
3. 空 → 400 `CART_EMPTY / 購物車為空`。
4. 任何項目 `quantity > stock` → 400 `STOCK_INSUFFICIENT`，message 列出所有不足的商品名稱：`以下商品庫存不足：A, B`。
5. `totalAmount = Σ product.price × quantity`（以目前售價計算）。
6. 產生 `id`（UUID）與 `order_no`（`ORD-YYYYMMDD-XXXXX`，日期為 UTC，後綴取 UUID 前 5 碼轉大寫，碰撞機率低但未重試；碰撞時 UNIQUE 失敗 → 500）。
7. **`db.transaction()` 內**：INSERT `orders`（status 預設 `pending`）→ 每項 INSERT `order_items`（名稱/單價快照）並 `UPDATE products SET stock = stock - quantity` → `DELETE cart_items WHERE user_id`。任何一步失敗整筆回滾。
8. 回 **201**：

```json
{ "data": { "id", "order_no", "total_amount", "status": "pending",
            "items": [{ "product_name", "product_price", "quantity" }], "created_at" },
  "error": null, "message": "訂單建立成功" }
```

**併發說明**：庫存檢查（步驟 4）在 transaction 之外。由於 better-sqlite3 同步執行且 Node 單執行緒，單一程序內兩個請求不會交錯；但若庫存在檢查後被其他程序改變，`CHECK(stock >= 0)` 會讓 transaction 失敗並回 500（不會超賣）。

前端結帳頁（`checkout.js`）：`requireAuth`；載入購物車為空就導回 `/cart`；前端驗證與後端相同規則；成功後導向 `/orders/:id`。

### 4.2 我的訂單列表 `GET /api/orders`

回傳 `data.orders`：本人所有訂單的 `{ id, order_no, total_amount, status, created_at }`，`created_at DESC`，**不分頁**、不含 items。

### 4.3 訂單詳情 `GET /api/orders/:id`

以 `id AND user_id` 查詢——他人的訂單一律 404 `訂單不存在`。回傳訂單全部欄位 + `items`（`order_items` 全欄位：`id, order_id, product_id, product_name, product_price, quantity`）。

### 4.4 模擬付款 `PATCH /api/orders/:id/pay`

Body：`action`（必填，`'success'` 或 `'fail'`）。

| 檢查 | 失敗回應 |
|------|---------|
| `action` 不在 `{success, fail}` | 400 `VALIDATION_ERROR / action 必須為 success 或 fail` |
| 訂單不存在或不屬於本人 | 404 `NOT_FOUND / 訂單不存在` |
| `status !== 'pending'` | 400 `INVALID_STATUS / 訂單狀態不是 pending，無法付款` |

成功：`success → paid`、`fail → failed`，回傳更新後訂單 + items，`message` 為 `付款成功` 或 `付款失敗`。⚠️ `failed` 是終態：不可重新付款、**不會回補庫存**、也沒有取消訂單功能。

前端訂單詳情頁：`status === 'pending'` 時顯示「付款成功 / 付款失敗」兩顆按鈕；URL 的 `?payment=success|failed|cancel` 會顯示對應提示（為 ECPay 導回預留）。

---

## 5. 後台商品管理（`src/routes/adminProductRoutes.js`，JWT + admin）

所有端點：無 token → 401；非 admin → 403。

### 5.1 列表 `GET /api/admin/products`

與公開列表完全相同的查詢與回應（分頁、`created_at DESC`）。後台頁面以 `limit=10` 載入。

### 5.2 新增 `POST /api/admin/products`

| 欄位 | 必填 | 規則 |
|------|------|------|
| `name` | ✔ | truthy（不 trim） |
| `price` | ✔ | **JSON number 型別的正整數**（`Number.isInteger`；字串 `"500"` 會被拒） |
| `stock` | ✔ | JSON number 型別的非負整數 |
| `description` | | 空值存 NULL |
| `image_url` | | 空值存 NULL（**snake_case**，與其他 API 的 camelCase body 不同） |

成功回 201，`data` 為完整商品列，`message: '商品新增成功'`。錯誤：400 `VALIDATION_ERROR`（`name 為必填欄位` / `price 必須為正整數` / `stock 必須為非負整數`）。

### 5.3 更新 `PUT /api/admin/products/:id`（實為部分更新）

只更新 body 中**有出現**（`!== undefined`）的欄位，其他保持原值；`updated_at` 設為現在。

- `name` 有給時 `trim()` 後不可為空（400 `商品名稱不能為空`）；⚠️ 若傳非字串（如數字）會因 `.trim` 拋錯 → 500。
- `price`/`stock` 有給時規則同新增。
- `description`/`image_url` 可傳 `null` 或 `""` 覆寫。
- 商品不存在 → 404 `商品不存在`。

成功回 200，`data` 為更新後商品，`message: '商品更新成功'`。前端編輯 modal 會送出全部 5 個欄位。

### 5.4 刪除 `DELETE /api/admin/products/:id`

1. 不存在 → 404。
2. 若有任何 `status = 'pending'` 的訂單包含此商品 → 409 `CONFLICT / 此商品存在未完成的訂單，無法刪除`。
3. 硬刪除（`DELETE FROM products`），回 `data: null`、`message: '商品刪除成功'`。

`paid`/`failed` 訂單不阻擋刪除；`order_items` 保有快照且沒有 FK，因此歷史訂單不受影響。

⚠️ **已知限制**：若該商品仍在任何人的購物車中（`cart_items.product_id` 有 FK），DELETE 會觸發 `FOREIGN KEY constraint failed`，經 errorHandler 回 **500 `伺服器內部錯誤`**，而非可理解的 409。後台頁僅顯示「刪除失敗」。修正方向：刪除前先刪除相關 `cart_items`（在 transaction 中），或回 409。

---

## 6. 後台訂單查詢（`src/routes/adminOrderRoutes.js`，JWT + admin）

### 6.1 列表 `GET /api/admin/orders`

| 參數 | 預設 | 說明 |
|------|------|------|
| `page` / `limit` | 1 / 10 | 共通分頁 |
| `status` | 無 | `pending`/`paid`/`failed` 才會套用篩選；**其他值會被靜默忽略**並回全部訂單 |

回傳所有使用者的訂單（`orders` 全欄位，不含 items）+ `pagination`。後台頁面切換狀態下拉選單時（`watch(statusFilter)`）重新載入第 1 頁。

### 6.2 詳情 `GET /api/admin/orders/:id`

回傳訂單全欄位 + `items` + `user: { name, email }`（下單者；查不到時為 `null`）。不存在 → 404 `訂單不存在`。

後台目前**唯讀**：沒有修改訂單狀態、出貨、退款等端點（⏳）。

---

## 7. 前台共用 UI 行為

| 元件 | 行為 |
|------|------|
| Header `#auth-nav` | 未登入顯示「登入」；登入顯示使用者名稱、登出，admin 另顯示「後台管理」連結 |
| 「我的訂單」連結 | 僅登入時顯示 |
| 購物車徽章 | 頁面載入時 `GET /api/cart`，顯示**品項數**（不是總數量）；0 時隱藏 |
| Toast | `Notification.show(msg, 'success' \| 'error' \| 'warning' \| 'info')`，3 秒淡出 |
| 金額顯示 | `NT$ {{ n.toLocaleString() }}` |
| 訂單狀態標籤 | pending=待付款、paid=已付款、failed=付款失敗 |
| 404 頁 | 非 `/api` 的未知路徑 render `pages/404`（front layout） |

---

## 8. OpenAPI 文件

`npm run openapi` 會以 `swagger-config.js` 掃描 `src/routes/*.js` 的 `@openapi` 區塊，輸出根目錄 `openapi.json`（OpenAPI 3.0.3，`servers: http://localhost:3001`，安全機制 `bearerAuth` 與 `sessionId`（header `X-Session-Id`））。伺服器本身不提供 Swagger UI 端點；可將 `openapi.json` 匯入 Swagger Editor / Postman 檢視。
