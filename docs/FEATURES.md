# 功能清單與完成狀態

狀態圖例：✅ 已完成（有實作且有測試覆蓋）｜🚧 進行中（尚有待完成或待驗證項目）｜🟡 已完成但無自動化測試／部分完成｜⏳ 已預留未實作｜⚠️ 已知限制

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
| 模擬付款 | `PATCH /api/orders/:id/pay` | 🟡（無測試；前端已改用綠界） |
| 後台商品管理 CRUD | `/api/admin/products*`、`/admin/products` | ✅ |
| 後台訂單查詢 | `/api/admin/orders*`、`/admin/orders` | ✅ |
| OpenAPI 文件產生 | `npm run openapi` | ✅ |
| 綠界付款：信用卡一次付清（4.5） | `POST /api/orders/:id/ecpay`（`paymentMethod: 'Credit'`）、`/ecpay/query`、`/api/ecpay/notify`、`/ecpay/result`、`/orders/:id` | ✅（自動化測試＋綠界測試環境實機付款） |
| 綠界付款：WebATM 網路ATM（4.7） | `POST /api/orders/:id/ecpay`（`paymentMethod: 'WebATM'`）、`/ecpay/result`、`/api/ecpay/notify`、`/ecpay/query` | ✅（自動化測試＋綠界測試環境實機付款：台灣土地銀行，經 QueryTradeInfo 確認） |
| 綠界付款：ATM 虛擬帳號（4.6） | `POST /api/orders/:id/ecpay`（`paymentMethod: 'ATM'`）、`/api/ecpay/payment-info`、`/ecpay/payment-info-result`、`/api/ecpay/notify`、`/ecpay/query` | 🚧（程式與自動化測試完成、取號已實機驗證；「綠界後台模擬付款 → 已付款」待實機驗證） |
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

- 必填檢查使用 falsy 判斷（`!value`），所以空字串視為未填，但 `" "`（空白）會通過（後台商品 PUT 的 `name` 例外：以 trim 後判斷是否為空，但**存入的是未 trim 的原值**）。
- 大多數欄位**沒有型別檢查**：例如註冊 `password` 傳數字時 `.length` 為 undefined 會通過長度檢查，接著 `bcrypt.hashSync` 拋錯 → 500；`email`/`name` 任何 truthy 值都會被存入。只有後台商品 `price`/`stock`（`Number.isInteger`）與購物車 `quantity`（`parseInt`）有數值檢查。
- Email 格式：`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`（註冊、訂單收件人共用）。
- 未知欄位一律忽略，不會報錯。
- 所有 API 也接受 `application/x-www-form-urlencoded` body（`express.urlencoded` 全域掛載），此時所有值都是字串——例如後台商品的 `price`/`stock` 會因不是 number 被拒。

### 共通錯誤（所有需認證的端點）

| 情境 | 回應 | 來源 |
|------|------|------|
| 沒有 `Authorization` 或不是 `Bearer ` 開頭 | 401 `UNAUTHORIZED / 請先登入` | `authMiddleware.js` |
| token 簽章錯、過期、演算法不符 | 401 `UNAUTHORIZED / Token 無效或已過期` | `authMiddleware.js`、`cartRoutes.js`（dualAuth） |
| token 有效但使用者已不存在 | 401 `UNAUTHORIZED / 使用者不存在，請重新登入` | 同上 |
| 非 admin 呼叫 `/api/admin/*` | 403 `FORBIDDEN / 權限不足` | `adminMiddleware.js` |
| `/api/*` 下不存在的路徑 | 404 `NOT_FOUND / 找不到該路徑` | `app.js` 404 handler |
| JSON 格式錯誤等由 errorHandler 處理的錯誤 | 狀態碼照原錯誤（例：400 `請求格式錯誤`），但 `error` **固定是 `INTERNAL_ERROR`** | `errorHandler.js` |

- 角色以 **JWT 內的 `role`** 為準（不查 DB）：DB 改角色後要重新登入才生效；被降級的 admin 在 token 到期（最長 7 天）前仍可使用後台 API。
- CORS 只允許 `FRONTEND_URL`（預設 `http://localhost:3001`）。
- 前端：每個前台頁都會由 `header-init.js` 呼叫 `GET /api/cart`；token 失效時任何前台頁（包含首頁）都會被 `apiFetch` 的 401 處理清除登入並導向 `/login`（**不帶** `?redirect=`）。

---

## 1. 會員認證（`src/routes/authRoutes.js`）

### 1.1 註冊 `POST /api/auth/register`

**Body**

| 欄位 | 必填 | 規則 |
|------|------|------|
| `email` | ✔ | 符合 Email regex；不可已存在（區分大小寫比對） |
| `password` | ✔ | 字串長度 ≥ 6（實作為 `password.length < 6` 則拒絕；非字串見「驗證規則」） |
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

回傳 DB 中 `{ id, email, name, role, created_at }`。若查無使用者回 404 `NOT_FOUND / 使用者不存在`（實務上 `authMiddleware` 已先回 401）。

### 1.4 種子管理員

啟動時若 `ADMIN_EMAIL`（預設 `admin@hexschool.com`）不存在，建立 `role='admin'` 帳號，密碼為 `ADMIN_PASSWORD`（預設 `12345678`）；bcrypt rounds 在 `NODE_ENV=test` 時為 1，否則 10。已存在就不更新（改 `ADMIN_PASSWORD` 不會生效）。這是唯一取得 admin 的方式（另一種是直接改 DB）。測試的 `getAdminToken()` 寫死這組預設帳密。

### 1.5 前端登入頁（`/login`，`public/js/pages/login.js`）

- 「登入 / 註冊」雙分頁（`activeTab`）。登入分頁前端只驗必填；註冊分頁另驗密碼長度 ≥ 6。都不驗 Email 格式（交給後端）。
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

詳情頁（`product-detail.js`）：數量選擇器範圍 1 ~ `stock`，加入購物車後 toast 並把 header 徽章 +1（前端估算；首頁的「加入購物車」也一樣。實際徽章語意是「品項數」，同商品重複加入時會短暫不準確，重新整理後校正）。`stock <= 0` 時按鈕顯示「已售完」並停用（首頁亦同），但詳情頁的「尚有 N 件」文字在庫存 0 時仍會顯示「尚有 0 件」。加入失敗時首頁與詳情頁都只顯示通用的「加入購物車失敗」，不顯示後端訊息（例如庫存不足）。

### 2.3 種子商品

8 筆（粉色玫瑰花束 1680/30、白色百合花禮盒 1280/25、繽紛向日葵花束 980/40、紫色鬱金香盆栽 750/50、乾燥花藝術花圈 1450/20、迷你多肉組合盆 580/60、經典紅玫瑰花束 3980/15、季節鮮花訂閱（月配） 890/100，格式為 價格/庫存）。只有在 `products` 表為空時寫入。

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

驗證順序：**先檢查 `quantity`，再檢查項目歸屬**——對不存在或別人的項目送無效數量會得到 400 而非 404。

購物車頁：「−」按鈕在數量 ≤ 1 時停用（`:disabled`）；「+」按鈕在數量 ≥ 庫存時停用；更新失敗只顯示通用的「更新數量失敗」。改數量或刪除項目後 header 徽章**不會**同步更新（重新整理才會校正）。

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

前端結帳頁（`checkout.js`）：`requireAuth`；載入購物車為空就導回 `/cart`；前端會先 **trim** 三個欄位再驗證（所以只有空白會被前端擋下，後端則接受 `" "`），錯誤訊息為前端自訂的「請輸入收件人姓名 / 請輸入 Email / 請輸入收件地址」與 Email 格式錯誤；成功後導向 `/orders/:id`。

⚠️ **已知限制：運費只存在前端畫面**。購物車與結帳頁在小計 < NT$500 時顯示「運費 NT$ 150」並把它算進「總計」，但後端 `total_amount` 與送給綠界的 `TotalAmount` **都不含運費**——畫面總計與實際扣款會不一致。種子商品最低單價 580，所以目前不會觸發；後台若新增低於 500 的商品就會出現。修正方向：由後端計算運費並寫入訂單（例如新增 `shipping_fee` 欄位、`total_amount` 含運費），前端只顯示後端回傳值。

### 4.2 我的訂單列表 `GET /api/orders`

回傳 `data.orders`：本人所有訂單的 `{ id, order_no, total_amount, status, created_at }`，`created_at DESC`，**不分頁**、不含 items。

### 4.3 訂單詳情 `GET /api/orders/:id`

以 `id AND user_id` 查詢——他人的訂單一律 404 `訂單不存在`。回傳訂單全部欄位 + `items`（`order_items` 全欄位：`id, order_id, product_id, product_name, product_price, quantity`）+ `payment`（最新一筆綠界付款摘要，沒有付款時為 `null`）：

```json
"payment": { "payment_method": "ATM", "status": "pending", "bank_code": "007",
             "v_account": "1057662916579457", "expire_date": "2026/10/18", "is_expired": false }
```

信用卡付款的 `bank_code`/`v_account`/`expire_date` 為 `null`、`is_expired` 為 `false`。後台 `GET /api/admin/orders/:id` 也回傳相同的 `payment`。

### 4.4 模擬付款 `PATCH /api/orders/:id/pay`

Body：`action`（必填，`'success'` 或 `'fail'`）。

| 檢查 | 失敗回應 |
|------|---------|
| `action` 不在 `{success, fail}` | 400 `VALIDATION_ERROR / action 必須為 success 或 fail`（⚠️ 以物件查表 `actionMap[action]` 實作，`"constructor"`、`"toString"` 等繼承屬性會通過檢查，接著 UPDATE 綁定函式值 → 500） |
| 訂單不存在或不屬於本人 | 404 `NOT_FOUND / 訂單不存在` |
| `status !== 'pending'` | 400 `INVALID_STATUS / 訂單狀態不是 pending，無法付款` |

成功：`success → paid`、`fail → failed`，回傳更新後訂單 + items，`message` 為 `付款成功` 或 `付款失敗`。⚠️ `failed` 是終態：不可重新付款、**不會回補庫存**、也沒有取消訂單功能。

前端已不再使用此端點（改為 4.5 綠界付款），API 保留供測試與手動操作。

### 4.5 綠界 ECPay 付款（AIO：信用卡一次付清、ATM 虛擬帳號、WebATM）

規格來源：綠界官方 [產生訂單](https://developers.ecpay.com.tw/2862.md)、[介接注意事項](https://developers.ecpay.com.tw/2858.md)、[ATM](https://developers.ecpay.com.tw/2872.md)、[取號結果通知](https://developers.ecpay.com.tw/2881.md)、[查詢取號結果](https://developers.ecpay.com.tw/5615.md)；實作於 `src/services/ecpay.js`。ATM 的完整流程見 4.6，WebATM 見 4.7。

**建立付款 `POST /api/orders/:id/ecpay`**（JWT）

| Body 欄位 | 必填 | 預設 | 規則 |
|-----------|------|------|------|
| `paymentMethod` | | `'Credit'` | `'Credit'`、`'ATM'` 或 `'WebATM'`；不帶 body 等同 Credit（向後相容） |

| 檢查（依序） | 失敗回應 |
|------|---------|
| 訂單不存在或不屬於本人 | 404 `NOT_FOUND / 訂單不存在` |
| `status !== 'pending'` | 400 `INVALID_STATUS / 訂單狀態不是 pending，無法付款` |
| `paymentMethod` 不是 Credit / ATM / WebATM | 400 `VALIDATION_ERROR / paymentMethod 必須為 Credit、ATM 或 WebATM` |
| 該訂單最新一筆付款是**未到期的 ATM 帳號**（不論這次選哪種方式） | 409 `CONFLICT / 此訂單已有尚未到期的 ATM 繳費帳號，請完成轉帳或待期限過後再改用其他方式`（避免兩邊都付；ATM 無法用 API 退款） |

成功時新增一筆 `payments`（新的 `MerchantTradeNo`、`payment_method`）並回 200：

```json
{ "data": { "action_url": "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5",
            "merchant_trade_no": "FL261015213608LJ3DJ4",
            "params": { "MerchantID": "3002607", "MerchantTradeNo": "...", "TotalAmount": "1680",
                        "ChoosePayment": "Credit", "ReturnURL": "<BASE_URL>/api/ecpay/notify",
                        "OrderResultURL": "<BASE_URL>/ecpay/result", "CustomField1": "<order id>",
                        "CheckMacValue": "...", "...": "..." } },
  "error": null, "message": "已建立綠界付款資料" }
```

`params` 欄位名稱依綠界規格為 PascalCase（不適用 snake_case 規則）。前端用隱藏 form 全頁 POST 到 `action_url`（綠界禁止 iframe）。

參數細節：
- `ItemName`：`商品名 x 數量` 以 `#` 串接；先移除 HTML 標籤、控制字元與 ``#&<>|;`'"``，再截斷至 200 字；結果為空時用 `花漾生活商品`。`TradeDesc` 固定為 `花漾生活訂單`。
- `ReturnURL` = `${BASE_URL}/api/ecpay/notify`，`OrderResultURL` = `${BASE_URL}/ecpay/result`（`BASE_URL` 預設 `http://localhost:3001`，會去掉結尾 `/`）。
- `CustomField1` = 訂單 id（僅供綠界後台對照；我方回呼不採信）。`NeedExtraPaidInfo=N`、`EncryptType=1`。
- `ChoosePayment` 固定為所選方式（不用 `ALL`）。Credit 帶 `OrderResultURL`；ATM 改帶 `ExpireDate`（`ECPAY_ATM_EXPIRE_DAYS`，1–60、預設 3）、`PaymentInfoURL=${BASE_URL}/api/ecpay/payment-info`、`ClientRedirectURL=${BASE_URL}/ecpay/payment-info-result`，**不帶** `OrderResultURL`（ATM 不支援）。
- 每次呼叫都新增一筆 `payments`，不會處理先前仍為 `pending` 的付款；查詢只看最新一筆。
- ⚠️ 未設定 `ECPAY_MERCHANT_ID/HASH_KEY/HASH_IV` 時**會自動使用綠界公開測試帳號**。若設了 `ECPAY_ENV=production` 卻沒給正式帳號，會拿測試帳號打正式環境（綠界會拒絕）；上線前務必三者都設定。
- 舊的 `PATCH /api/orders/:id/pay` 不會建立 `payments`，用它改成 paid 的訂單沒有付款紀錄。

**付款結果確認：伺服器端 QueryTradeInfo**

回呼內容（即使簽章正確、`RtnCode=1`）**不會**直接讓訂單變成已付款。成功類回呼只會觸發 `confirmPayment()`：伺服器呼叫綠界 `QueryTradeInfo/V5`，驗證回應 CheckMacValue、確認是同一筆交易（`MerchantTradeNo`、`MerchantID`），且 `TradeStatus === '1'`、`TradeAmt` 等於建立付款時的金額，才把付款與訂單標為 `paid`。三個入口都以 CheckMacValue SHA256 驗證，並且冪等：

| 端點 | 呼叫者 | 情境 → 回應 |
|------|-------|------------|
| `POST /api/ecpay/notify`（ReturnURL） | 綠界伺服器；需 `BASE_URL` 為公開 80/443 網址 | 簽章錯 → `0\|CheckMacValue Error`；`RtnCode≠1` → 記錄失敗、`1\|OK`；查詢確認已付款（或金額不符已記失敗、查無付款）→ `1\|OK`；查詢 `TradeStatus≠1` → `0\|Not Paid Yet`；查詢失敗 → `0\|QueryTradeInfo Error`。後兩者不算確認，綠界會重送。HTTP 一律 200、`text/plain` |
| `POST /ecpay/result`（OrderResultURL） | 消費者瀏覽器自綠界導回；localhost 可用 | 302 → `/orders/:id?payment=success`（查詢確認）／`failed`（`RtnCode≠1` 或金額不符）／`pending`（尚未確認或查詢失敗）；簽章錯或查無付款 → `/orders?payment=failed`。訂單 id 取自我方 `payments`，不用 `CustomField1` |
| `POST /api/orders/:id/ecpay/query`（JWT） | 前端：`?payment=pending` 時每 3 秒自動呼叫、最多 5 次；其他 `?payment` 時呼叫 1 次；或按「重新查詢付款狀態」 | 以該訂單最新一筆 `pending` 的付款執行 `confirmPayment()`，回訂單詳情（同 4.3），`message` 為 `付款成功` 或 `尚未完成付款`；訂單不存在 → 404；連不到綠界、回應簽章錯或不是同一筆交易 → 502 `PAYMENT_GATEWAY_ERROR / 無法連線綠界查詢付款狀態`。訂單非 pending 或沒有待確認付款時不查詢，直接回訂單 |

業務規則：
- 只有 `confirmPayment()` 能把 `payments` / `orders` 改為 `paid`；`orders.status` 只會從 `pending` 轉為 `paid`。
- 刷卡失敗（回呼 `RtnCode≠1`）、查詢金額不符 → `payments.status='failed'`，**訂單仍為 `pending`**，可再按「信用卡付款」或「ATM 轉帳」重新付款（每次產生新 `MerchantTradeNo`）。
- 已 `paid` 的付款重複通知不會再查詢、不會重複處理（`payments.rtn_msg = 'QueryTradeInfo TradeStatus=1'` 表示由查詢確認）。
- 信用卡剛付完時，銀行可能還沒回覆，`TradeStatus` 會是 `0`。所以有 `?payment=pending` 與前端重試；若 5 次仍未確認，提示使用者稍後按「重新查詢付款狀態」。
- 開放「信用卡一次付清」（`ChoosePayment=Credit`）與「ATM 虛擬帳號」（`ChoosePayment=ATM`，見 4.6），付款方式在我方訂單頁選擇，不使用 `ALL`。超商代碼、條碼等其他方式 ⏳ 未實作；退款（`DoAction`，僅信用卡可用）⏳ 未實作。

前端訂單詳情頁：`pending` 時顯示「信用卡付款」「ATM 轉帳」與「重新查詢付款狀態」（有未到期 ATM 帳號時改顯示繳費資訊卡片，見 4.6）；`ECPAY_ENV` 非 `production` 時顯示測試提示。URL 的 `?payment=success|failed|cancel|pending|atm` 顯示對應提示（pending：「正在向綠界確認付款結果，請稍候…」；atm：「已取得 ATM 繳費帳號，請於期限內完成轉帳。」）。

**測試環境付款**：卡號 `4311-9522-2222-2222`、有效期限任意未來月年、安全碼任意三碼、3D 驗證碼 `1234`。

### 4.6 ATM 虛擬帳號付款

非同步流程：**取號**（拿到銀行代碼、虛擬帳號、期限）→ 消費者之後轉帳 → 綠界通知付款。

**取號結果的三個來源**（都以 CheckMacValue 驗證，都寫入同一筆 `payments`，冪等）：

| 端點 | 呼叫者 | 情境 → 回應 |
|------|-------|------------|
| `POST /api/ecpay/payment-info`（PaymentInfoURL） | 綠界伺服器；需公開網址 | 簽章錯 → `0\|CheckMacValue Error`；`RtnCode=2`（取號成功，**不是錯誤**）→ 存 `bank_code`/`v_account`/`expire_date`，`1\|OK`；其他 RtnCode → 記錄失敗（訂單仍 pending），`1\|OK`；查無付款 → `1\|OK` |
| `POST /ecpay/payment-info-result`（ClientRedirectURL） | 消費者瀏覽器取號後導回；localhost 可用 | `RtnCode=2` → 存帳號，302 `/orders/:id?payment=atm`；失敗 → `?payment=failed`；簽章錯或查無付款 → `/orders?payment=failed` |
| `POST /api/orders/:id/ecpay/query` | 前端「重新查詢付款狀態」，或 `?payment=atm` 但還沒有帳號時自動呼叫 1 次 | 最新 pending 付款是 ATM 且沒有帳號 → 先呼叫 `QueryPaymentInfo` 補帳號（失敗不中斷），再照常 `confirmPayment()` |

`POST /api/ecpay/notify`（ReturnURL）與 ATM 相關的規則：

| 情境 | 處理 |
|------|------|
| `RtnCode=2`（取號通知誤送到 ReturnURL） | 當成取號通知寫入帳號，`1\|OK`，**不記為失敗** |
| `RtnCode=1`、`SimulatePaid=0`（真實轉帳） | `confirmPayment()`（QueryTradeInfo）確認後 paid |
| `RtnCode=1`、`SimulatePaid=1`，`ECPAY_ENV≠production` | 綠界後台模擬付款不會改變綠界端狀態、查詢永遠確認不了，所以直接 `applyPaymentResult()`：金額相符 → paid（`simulate_paid=1`），不呼叫 fetch |
| `RtnCode=1`、`SimulatePaid=1`，正式環境 | 不變更、只記 log，`1\|OK` |

業務規則：
- 「已取號、待繳費」= 付款 `pending` 且有 `v_account`；`payments.status` 不新增狀態。
- 有效期：`expire_date`（`yyyy/MM/dd`）當天 23:59:59 台灣時間前。過期後 `payment.is_expired=true`，可重新付款；綠界不會通知逾期，也不會收到付款通知。
- 未到期時不可建立任何新付款（409）。消費者在綠界頁沒選銀行就離開 → 沒有帳號 → 不擋重新付款。
- ATM 付款**不能用 API 退款**，需由綠界後台處理；轉錯金額、重複轉帳由銀行端檢核。

前端訂單詳情頁：
- 沒有有效 ATM 帳號時顯示「信用卡付款」「ATM 轉帳」兩個按鈕；先前帳號過期時加註「已超過繳費期限」。
- 有有效 ATM 帳號時改顯示「ATM 繳費資訊」卡片：銀行代碼、虛擬帳號（「複製」按鈕）、轉帳金額、期限，以及「已轉帳？重新查詢付款狀態」；付款按鈕隱藏。建立付款收到 409 時也會重新載入並顯示此卡片。
- `?payment=atm` 顯示「已取得 ATM 繳費帳號，請於期限內完成轉帳。」，**不**跑 5 次自動重試（轉帳是之後的事）。
- 後台訂單詳情 modal 顯示付款方式、狀態、銀行代碼、虛擬帳號、期限（已逾期加註）。

**測試環境**：
- 取號在 localhost 即可完成（ClientRedirectURL 導回，或 QueryPaymentInfo 補查）。
- 付款完成只能用綠界測試後台：`https://vendor-stage.ecpay.com.tw`（帳號 `stagetest3`、密碼 `test1234`、統編 `00000000`）→ 一般訂單查詢 > 全方位金流訂單 → 以 `FL...` 查詢 →「模擬付款」。通知只送到 ReturnURL，所以 `BASE_URL` 要設成公開的 https 網址（例如 ngrok）。

### 4.7 WebATM（網路ATM）付款

規格來源：綠界官方 [WebATM](https://developers.ecpay.com.tw/11031.md)。消費者在綠界頁面選擇銀行，進入該銀行的網路 ATM，以**晶片金融卡與讀卡機**即時轉帳。

**行為**：WebATM 是**即時付款**，和信用卡走完全相同的流程，沒有任何 WebATM 專用的端點或回呼：
- 建立付款：`POST /api/orders/:id/ecpay` 帶 `{ "paymentMethod": "WebATM" }` → `ChoosePayment=WebATM`，帶 `OrderResultURL`（綠界規格中 WebATM 支援 OrderResultURL，不支援的只有銀聯卡與 ATM/CVS/BARCODE），**不帶** ATM 的 `ExpireDate`/`PaymentInfoURL`/`ClientRedirectURL`。不指定 `ChooseSubPayment`，銀行由消費者在綠界頁面選擇。
- 付款結果：OrderResultURL（`/ecpay/result`）與 ReturnURL（`/api/ecpay/notify`）都經 `confirmPayment()` 向 QueryTradeInfo 確認後才標記 `paid`；未確認導向 `?payment=pending`，前端每 3 秒重試、最多 5 次。綠界回傳的 `PaymentType` 為 `WebATM_<銀行>`（例：`WebATM_TAISHIN`）。
- 付款失敗（`RtnCode≠1`）或在銀行頁面放棄 → 付款記為 failed 或維持 pending，訂單維持 `pending`，可重新選擇付款方式。WebATM 沒有虛擬帳號，所以不會觸發 409；反之，訂單有未到期的 ATM 帳號時選 WebATM 一樣回 409。
- 訂單詳情的 `payment.payment_method` 為 `'WebATM'`；`bank_code`/`v_account`/`expire_date` 為 `null`。後台付款資訊顯示「網路ATM」。
- 和 ATM 一樣**不能用 API 退款**（`DoAction` 僅限信用卡）。

**裝置限制**：綠界規格註明**手機瀏覽器不支援** WebATM（需要讀卡機）。訂單頁以 `navigator.userAgent` 判斷（`/Android|iPhone|iPad|iPod|Mobile/i`），手機或平板時停用「WebATM（網路ATM）」按鈕並顯示「WebATM 不支援手機，請改用電腦或其他付款方式。」；桌面顯示「需使用電腦、晶片金融卡與讀卡機」。**後端不阻擋**手機呼叫 API（無法可靠判斷裝置），綠界頁面本身會告知不支援。

**測試環境**：綠界測試環境接受 `ChoosePayment=WebATM`，付款頁顯示「網路ATM」與銀行清單（兆豐、土銀、新光、元大、永豐、台銀、中信、玉山、一銀、北富邦、台新、其他）。綠界官方文件沒有說明 WebATM 的測試方式，但 **2026-10-15 實測可在測試環境選「台灣土地銀行」完成付款**：綠界回傳 `PaymentType=WebATM_LAND`，伺服器經 QueryTradeInfo（`TradeStatus=1`）確認後標記已付款，`simulate_paid` 為 NULL（非模擬）。本機即可完成（瀏覽器導回 OrderResultURL + 主動查詢），不需要公開網址。自動化測試見 `tests/ecpayWebAtm.test.js`。

**已知限制**：iPad 開啟「桌面版網站」（Safari 預設）時 User-Agent 與 Mac 相同，無法判斷為行動裝置，WebATM 按鈕仍可按；綠界頁面會再告知不支援。

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

- 先檢查商品是否存在（404 優先於欄位驗證）。
- `name` 有給時 `trim()` 後不可為空（400 `商品名稱不能為空`），但**存入的是未 trim 的原值**；⚠️ 若傳非字串（數字、`null`）會因 `.trim` 拋錯 → 500。
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
| 購物車徽章 | 前台每頁載入時 `GET /api/cart`，`items.length > 0` 時顯示**品項數**（不是總數量）；預設隱藏，之後不會再自動隱藏。首頁/詳情頁加入時前端 +1 估算；購物車頁改數量或刪除不會更新 |
| 前端錯誤訊息 | 只有結帳、登入/註冊、綠界付款/查詢會顯示後端 `message`；加入購物車、改數量、後台儲存（「儲存失敗」）等都是通用訊息。後台商品 modal 前端只檢查 `name.trim()` 與 `price <= 0`（「請填寫必要欄位」），不檢查 stock |
| 後台頁面守門 | 伺服器不檢查；`admin.ejs` 在 DOMContentLoaded 才執行 `Auth.requireAdmin()`（未登入或非 admin → `/login`，不帶 redirect），此時頁面腳本已開始執行，真正的保護在 API 的 401/403 |
| Toast | `Notification.show(msg, 'success' \| 'error' \| 'warning' \| 'info')`，3 秒淡出 |
| 金額顯示 | `NT$ {{ n.toLocaleString() }}` |
| 訂單狀態標籤 | pending=待付款、paid=已付款、failed=付款失敗 |
| 404 頁 | 非 `/api` 的未知路徑 render `pages/404`（front layout） |

---

## 8. OpenAPI 文件

`npm run openapi` 會以 `swagger-config.js` 掃描 `src/routes/*.js` 的 `@openapi` 區塊，輸出根目錄 `openapi.json`（OpenAPI 3.0.3，`servers: http://localhost:3001`，安全機制 `bearerAuth` 與 `sessionId`（header `X-Session-Id`））。伺服器本身不提供 Swagger UI 端點；可將 `openapi.json` 匯入 Swagger Editor / Postman 檢視。
