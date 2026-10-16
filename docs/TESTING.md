# 測試規範與指南

## 1. 測試架構

目前測試全是 API integration tests：Vitest 提供 runner/assertion/globals，Supertest 直接呼叫匯出的 Express `app`，不開 TCP port。它們不是 unit tests；每個 request 會經過真實 middleware、route、bcrypt/JWT 與 `better-sqlite3`。

```text
Vitest test case
  → Supertest request(app)
  → Express middleware/routes
  → root database.sqlite（真實持久化檔）
```

最大的測試約束是資料沒有隔離：`database.js` 固定使用 repository 根目錄 `database.sqlite`，沒有 test DB env override、beforeEach transaction rollback、fixture reset 或 afterAll cleanup。執行 `npm test` 會建立／修改這個被 gitignore 的檔案、建立 users/orders 並扣商品庫存。請勿在含重要本機資料的 working tree 直接執行。

## 2. 執行指令

### 全部測試

```powershell
npm test
```

等同 `vitest run`，為單次執行，不進入 watch mode。

### 單一測試檔

```powershell
npx vitest run tests/cart.test.js
```

### 依 test name 篩選

```powershell
npx vitest run tests/orders.test.js -t "should create an order"
```

### 建議的安全執行前檢查

```powershell
Test-Path .\database.sqlite
```

若已存在，不要假設它是 disposable。現有程式沒有 DB path switch；要建立真正隔離測試前，應先實作可注入的 test database，而不是臨時刪除或覆蓋未知資料。

測試需要 `.env` 中有 `JWT_SECRET`。`server.js` 的 fatal check 不會執行（測試 import `app.js`），但註冊／登入的 `jwt.sign` 與 middleware verify 仍需要 secret。預設管理員 helper 還依賴 seed credential `admin@hexschool.com`／`12345678`；若 `.env` 改過 seed 且 DB 是新的，helper 會失敗。

## 3. Vitest 設定、執行順序與依賴

`vitest.config.js` 設定：

- `globals: true`：tests 可直接用 `describe`、`it`、`expect`、`beforeAll`。
- `fileParallelism: false`：測試檔不平行執行，降低共享 SQLite 同時寫入問題。
- `sequence.files` 原始碼列出作者預期順序：auth → products → cart → orders → ecpay → adminProducts → adminOrders；但在目前 Vitest 2.1.9 實測並未依這個檔名陣列排序。
- `hookTimeout: 10000`：hook timeout 10 秒；一般 test timeout 沒另外設定。

重要：不應讓正確性依賴 runner 的跨檔順序。2026-10-15 以目前 lockfile 的 Vitest 2.1.9 實測，順序是 `orders → cart → adminProducts → auth → adminOrders → products`，並非 config 陣列的順序。這個實測順序也不是公開契約，後續可能隨檔案大小、runner 或版本改變。現有每個 suite 大致自行建立必要 user/cart/order，但共同依賴 database initialization 至少 seed 一筆商品和預設管理員。新增測試時應讓單一檔案可獨立執行。

### 設定檔列出的規劃次序與跨檔影響

| 規劃次序（非保證） | 檔案 | 建立／修改的共享資料 | 對其他測試／重跑的影響 |
| --- | --- | --- | --- |
| 1 | `auth.test.js` | 建一名固定 timestamp email user；另讀 seed admin | 重跑同一毫秒極罕見衝突；資料不清除。 |
| 2 | `products.test.js` | 只讀第一頁第一筆商品 | 假設 seed/products 非空。 |
| 3 | `cart.test.js` | 建／刪訪客 item；建一名 user 及其未清除 cart item quantity 2 | 留下會員 cart row，product FK 可能影響後續人工刪商品。 |
| 4 | `orders.test.js` | 建 user、加入第一筆商品、建 order並扣庫存 1；cart 被清除 | 商品 stock 永久 -1，order 留在 pending。 |
| 5 | `ecpay.test.js` | unit case mock fetch；integration fixture 建 user/cart/order 並扣庫存，再將該 order 驗證為 paid | payment/order/user 留存；spy 在案例後 restore。 |
| 6 | `adminProducts.test.js` | 建臨時商品、更新、刪除；另建一般 user | 自建商品會清除；user 留存。 |
| 7 | `adminOrders.test.js` | 建 user、cart、pending order並再扣第一筆商品 stock 1 | order/user 永久留存。 |

跨多次完整執行，第一筆商品每次至少被 orders/adminOrders 各扣 1；seed 只在 products table 完全為空時執行，不會補庫存。Stock 最終過低時 setup 加 cart 或建單可能失敗，後續程式卻直接讀 `orderRes.body.data.id`，造成難以理解的衍生錯誤。

### 檔內順序依賴

Vitest 預設會依宣告順序執行同檔 tests；現有多個 suite 明確共享 `let`：

- `auth.test.js`：第一個 test 設 `registeredEmail`／`userToken`；重複註冊與 profile tests 依賴它。
- `products.test.js`：列表 test 設 `productId`；detail test 依賴它。
- `cart.test.js`：guest add 設 `cartItemId`，之後 get/update/delete 依賴；會員 add 設 `userToken` 但後續未使用。
- `orders.test.js`：`beforeAll` 建 user/cart；第一個 test 設 `orderId`，後面的 detail 依賴；第二個 empty-cart test 依賴第一個已清 cart。
- `adminProducts.test.js`：create 設 `createdProductId`，update/delete 依賴。
- `adminOrders.test.js`：`beforeAll` 完成整個 order fixture，tests 共用 `orderId`。

使用 `.only` 跳過 fixture-producing test 會使後續案例失真。新增測試優先把 fixture 放 `beforeEach`/`beforeAll`，不要依賴另一個 `it()` 的副作用。

## 4. 測試檔案表

| 檔案 | Setup | 覆蓋內容 | 尚未覆蓋的重要分支 |
| --- | --- | --- | --- |
| `tests/setup.js` | import app/request，提供兩 helpers | 共用登入／註冊 | 不檢查 helper response status；失敗時可能讀 null data。 |
| `tests/auth.test.js` | 第一例建立 user | 註冊 201、duplicate 409、admin login、錯密碼 401、profile 200/401 | 缺欄位、email 格式、短密碼、expired/malformed token、token user 不存在。 |
| `tests/products.test.js` | 列表取第一 id | 列表、page/limit、詳情、404 | page/limit clamp、空商品、limit 100 上限。 |
| `tests/cart.test.js` | beforeAll 取第一商品 | Guest add/get/update/delete、JWT add、商品 404 | 無 credential、invalid JWT 不 fallback、累加、stock insufficient、owner isolation、quantity parsing。 |
| `tests/orders.test.js` | beforeAll 建 user + cart | 建單、empty cart、無 auth、list/detail/404 | 收件欄位/email、stock insufficient、transaction rollback、他人訂單。付款另見 ecpay suite。 |
| `tests/ecpay.test.js` | 檔案頂端固定官方 staging credentials；integration beforeAll 建 user/cart/order/payment | 官方 CheckMacValue 向量、query request/response 驗簽、checkout form 冪等重用、paid 狀態 transaction、舊 `/pay` 404 | invalid signature、merchant/amount mismatch、timeout/403、節流、owner isolation、pending/failed provider 狀態。 |
| `tests/adminProducts.test.js` | beforeAll admin token | list、create/update/delete、user 403、missing token 401 | validation、pagination、not found、pending order conflict、cart FK 500。 |
| `tests/adminOrders.test.js` | beforeAll 建 admin、user、order | list、pending filter、detail、user 403 | pagination、invalid status、404、missing/invalid token。 |

## 5. 輔助函式

### `app` 與 `request`

```js
const { app, request } = require('./setup');
const res = await request(app).get('/api/products');
```

`app` 是組裝完成的 Express instance；`request` 是 Supertest module。第一次 import 會觸發 dotenv、SQLite initialization 與 seed。不要在測試中另行 `listen()`。

### `getAdminToken()`

```js
async function getAdminToken() {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@hexschool.com', password: '12345678' });
  return res.body.data.token;
}
```

它假設 seed 使用預設 credentials，且不 assert status/body。若要支援自訂 `ADMIN_EMAIL/PASSWORD`，helper 應讀一致的 test config，並在取 token 前對 200 與 data 做 assertion，避免 `Cannot read properties of null` 掩蓋真正登入錯誤。

### `registerUser(overrides = {})`

預設 email 由 timestamp + `Math.random()` 組成，password `password123`、name `測試使用者`。Overrides 只支援 truthy fallback：傳空字串會被預設值取代，因此不能用它測 missing/empty 欄位；這類案例要直接 Supertest request。

回 `{ token, user }`，同樣未 assert 註冊成功。每次呼叫都在 DB 留下一名 user。

## 6. 撰寫新測試的步驟

1. 先選 scope：新增 route behavior 放對應 test file；全新 domain 才新增檔案。
2. 列出 happy path、validation boundary、unauthenticated、forbidden、wrong-owner、not-found、conflict/transaction failure。
3. 每個 suite 自建最小 fixture。不要引用另一 test file 的變數或假設另一 `it()` 先跑。
4. 使用 `registerUser()` 取得 JWT；admin behavior 使用 `getAdminToken()`，但了解其 credential 假設。
5. Guest cart 每個 suite 用唯一 session id，避免殘留 row 被重用。
6. Assert HTTP status、完整 envelope 以及關鍵資料變化；不要只 assert `error` 存在。
7. Mutation 後做第二次 GET/DB-observable request 驗證持久狀態；transaction 測試同時驗證失敗後沒有半成品與未扣 stock。
8. 若建立可刪 fixture，成功後用 API cleanup；若 schema FK/業務規則不允許，記錄殘留風險。長期應先建立 isolated DB harness。
9. 新 test file 加入 `vitest.config.js` 的明確規劃順序，但仍確保可單檔執行。
10. 執行單檔，再執行整套；重跑至少一次可發現持久資料假設。

## 7. 新測試範例

以下範例測 cart 的「有無效 Bearer 時不得 fallback session」規則，不依賴其他 `it()`：

```js
const { app, request } = require('./setup');

describe('Cart dual auth', () => {
  it('should reject an invalid bearer token even when session id exists', async () => {
    const res = await request(app)
      .get('/api/cart')
      .set('Authorization', 'Bearer invalid-token')
      .set('X-Session-Id', `dual-auth-${Date.now()}-${Math.random()}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({
      data: null,
      error: 'UNAUTHORIZED'
    }));
    expect(res.body.message).toBeTruthy();
  });
});
```

建立可獨立的商品 mutation fixture：

```js
const { app, request, getAdminToken } = require('./setup');

describe('Admin product validation', () => {
  let adminToken;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    expect(adminToken).toBeTruthy();
  });

  it('should reject a non-integer price', async () => {
    const res = await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Boundary product', price: 10.5, stock: 1 });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeNull();
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
```

## 8. Transaction 測試指南

訂單建立的核心不變量是四步 all-or-nothing：order、items、stock、cart。新增／重構測試至少驗證：

1. 成功後 order 和所有 items 存在。
2. 每個 product stock 正確扣除。
3. 成功後該 user cart 清空，但其他 user/session cart 不受影響。
4. 任一步故意失敗時，不存在 order/partial items、stock 不變、cart 保留。
5. Order item 的 name/price 在後續商品修改後仍維持 snapshot。

目前只有成功 API shape 與 empty cart 被測；沒有 fault injection。要安全測 rollback，最好先把 DB path/connection 注入 app factory，再以 isolated SQLite DB 建 constraint-triggered fixture；不要對共用開發 DB任意製造損壞資料。

## 9. 常見陷阱

### 共享資料庫污染

測試不清除 users/orders，且每次扣 seed 商品 stock。症狀可能在數次成功後才出現。不要以增加 seed stock 掩蓋問題；正確方向是讓 DB path 可設定，對每次 suite 建 temp DB並 teardown。

### `.env` 與 seed credential 不一致

`.env` 的 `ADMIN_EMAIL/PASSWORD` 只影響首次 seed。如果 DB 已有舊 admin，改 env 不會更新其密碼；helper 仍硬編碼預設值。清楚區分「環境設定」與「既有 DB state」。

### Import 即有副作用

只要 require setup/app 就建 DB/seed。Mock 環境變數必須在 import app 之前設定；CommonJS module cache 也會讓同 process 後續變更不生效。

### 測試案例互相當 setup

使用 `.only` 或改 test order 時，`cartItemId`/`orderId` 可能是 undefined。把必要 fixture 移到 hook，讓每個 test 的前置條件可見。

### `parseInt` 與 JSON integer 不一致

Cart quantity 先 `parseInt`，admin price/stock 則用 `Number.isInteger`。字串與小數在兩套 API 的行為不同。Boundary tests 應鎖定現況，若要收緊規則則作為 API behavior change 更新文件。

### 401 browser 行為無法由 Supertest 覆蓋

Supertest 只測 server；`apiFetch` 清 localStorage/redirect、admin layout redirect、badge 與 toast 都沒有 DOM/browser tests。修改 browser globals 時至少人工走訪，若功能擴大應加入 jsdom 或 E2E runner。

### 時間與排序

SQLite `datetime('now')` 精度到秒，多筆同秒資料只以 created_at 排序時順序不穩。測試不要假設剛建立的 row 必定是列表第一筆，除非再加 deterministic sort 或按 id 尋找。

### Product delete 的兩種 reference

Route 只把 pending order reference 轉成 409；cart FK reference 會變 500。測試要區分兩者，不能把所有 reference 都期望為 conflict。

### ECPay 外部邊界必須 mock

測試不可真的呼叫 staging，否則會受網路、查詢頻率與測試商店狀態影響。service unit test 將 `fetchImpl` 注入 `queryTradeInfo()`，使用相同 helper 對 mock response 產生有效 CheckMacValue；route integration test 則 spy `ecpayService.queryTradeInfo`，只驗 route 的 owner、金額與 transaction 行為。新增 invalid-signature 測試應放 service 層，新增 order/payment 狀態測試應放 route 層。

`ECPAY_QUERY_MIN_INTERVAL_SECONDS` 預設 600。需要對同一 payment 連續驗證不同狀態時，應建立獨立 fixture，或在 import app 前將測試環境設為 0；不要在測試中加入 sleep，也不要真的觸發綠界 403。

### Vite CJS Node API 警告

目前 `npm test` 會通過，但輸出 `The CJS build of Vite's Node API is deprecated`。這是工具鏈相容性警告，不是 test failure；在升級 Vitest/Vite 或調整 module 設定前，勿為了消除警告而把 runtime 檔案零碎改成 ESM。應以獨立遷移計畫確認 config 與 CommonJS app 的相容方式。

## 10. 測試完成標準

- 新功能至少有 happy path、輸入邊界、認證／授權與 owner isolation。
- Response 同時驗 status、`data`、`error`、必要 message/shape。
- DB mutation 驗證結果與不應改變的資料。
- 測試可單檔執行，且不依賴另一 `it()` 先產生 id。
- 整套至少連續執行兩次仍通過；若因持久 DB 不能重跑，該問題不得被忽略。
- 測試資料或產物不進 Git；執行後檢查 `git status --short`。
- API 行為改變時同步 OpenAPI JSDoc、`FEATURES.md` 與 `CHANGELOG.md`。

