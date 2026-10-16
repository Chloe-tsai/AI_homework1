# 花漾生活（Flower Life）

花漾生活是一個可直接啟動的全端花卉電商示範。單一 Node.js process 同時提供 EJS 頁面、靜態資源與 JSON API；瀏覽器端使用 Vue 3 global build 管理各頁互動。系統包含會員註冊／登入、公開商品瀏覽、訪客與會員購物車、會員下單、ECPay AIO 信用卡付款、商品管理及訂單查詢。

目前專案定位是教學／本機示範環境，不是可直接上線的商務系統。因 localhost 無法接收 ECPay Server Notify，付款結果由後端主動呼叫 `QueryTradeInfo/V5` 驗證；這個限制使付款方式刻意只開放信用卡，不支援依賴非同步通知的 ATM／超商代碼／條碼。測試與開發仍共用根目錄 `database.sqlite` 路徑。部署前應先處理 [ARCHITECTURE.md 的已知限制](./ARCHITECTURE.md#已知架構限制與整合風險)。

## 技術棧

| 層級 | 技術 | 專案中的用途 |
| --- | --- | --- |
| 執行環境 | Node.js >=18 | 執行 HTTP server、CSS/OpenAPI 產生器與測試；ECPay 主動查詢使用內建 `fetch`／`AbortController`。 |
| Web framework | Express `~4.16.1` | middleware pipeline、REST API、頁面路由、靜態檔案與錯誤處理。 |
| Template | EJS `^5.0.1` | server-side render 共用 layout、partial 與各頁 HTML。 |
| Browser UI | Vue 3 global production build（CDN） | 每個頁面各自 `createApp()`；無 bundler、SFC 或 client router。 |
| CSS | Tailwind CSS／CLI `^4.2.2` | 從 `public/css/input.css` 掃描並編譯至忽略版控的 `public/css/output.css`。 |
| Database | SQLite + `better-sqlite3` `^12.8.0` | 同步 SQL、WAL、外鍵與訂單 transaction；資料檔位於根目錄。 |
| Auth | `jsonwebtoken` `^9.0.2`、`bcrypt` `^6.0.0` | HS256 JWT、7 天有效期、密碼雜湊。 |
| IDs | `uuid` `^11.1.0` | 使用者、商品、購物車、訂單、明細與付款主鍵；亦用於訂單編號隨機尾碼。 |
| 金流 | ECPay AIO／QueryTradeInfo | 信用卡結帳導頁、SHA-256 CheckMacValue，以及 localhost 無 Server Notify 時的主動付款驗證。 |
| API schema | `swagger-jsdoc` `^6.2.8` | 從 `src/routes/*.js` 的 `@openapi` JSDoc 產生 OpenAPI 3.0.3。 |
| Test | Vitest `^2.1.9`、Supertest `^7.2.2` | 不開網路 port 的 HTTP 整合測試。 |
| 其他 | `dotenv`、`cors` | 讀取根目錄 `.env`；限制 API 的 browser CORS origin。 |

精確依賴樹以 `package-lock.json`（lockfile v3）為準。`bcrypt` 與 `better-sqlite3` 含原生模組；若平台沒有可用的 prebuilt binary，安裝時可能需要相容的 C/C++ 編譯工具鏈。

## 快速開始

### 1. 安裝與設定

以下指令可直接在 PowerShell 執行：

```powershell
npm install
Copy-Item .env.example .env
```

至少把 `.env` 的 `JWT_SECRET` 改成長且不可預測的私密值。`.env.example` 含示範管理員密碼與 sandbox 金流欄位，不應直接用於正式環境。

### 2. 啟動完整服務

```powershell
npm start
```

`npm start` 會先產生 `public/css/output.css`，再於 `PORT`（預設 `3001`）啟動。瀏覽：

- 前台：`http://localhost:3001/`
- 登入：`http://localhost:3001/login`
- 後台商品：`http://localhost:3001/admin/products`
- 預設管理員：由 `ADMIN_EMAIL`／`ADMIN_PASSWORD` 決定；範例值為 `admin@hexschool.com`／`12345678`

管理員只在資料庫中沒有相同 email 時 seed。變更 `.env` 不會更新既有帳號或密碼；需要新的 seed 狀態時，必須明確處理本機資料庫，切勿在有價值資料的環境直接刪檔。

### 3. 開發模式

開兩個 terminal：

```powershell
npm run dev:css
```

```powershell
npm run dev:server
```

`dev:server` 沒有 hot reload；修改 server-side 程式後需重啟。CSS watcher 只負責 Tailwind 輸出，Vue/EJS/JavaScript 靜態檔則由 Express 直接讀取。

### 4. 執行檢查

```powershell
npm test
npm run openapi
```

執行測試前先閱讀 [TESTING.md](./TESTING.md)：測試沒有隔離資料庫，會建立 seed、測試使用者、訂單並扣減庫存。`npm run openapi` 會在根目錄寫入忽略版控的 `openapi.json`。

## 常用指令

| 指令 | 是否持續執行 | 輸入／輸出 | 注意事項 |
| --- | --- | --- | --- |
| `npm install` | 否 | `package-lock.json` → `node_modules/` | 優先保留 lockfile；CI 可考慮 `npm ci`，但目前未定義 script。 |
| `npm start` | 是 | 編譯 CSS後啟動 `server.js` | 啟動入口會檢查 `JWT_SECRET`；缺少時以 code 1 結束。 |
| `npm run dev:server` | 是 | 啟動 `server.js` | 不執行 CSS build。 |
| `npm run dev:css` | 是 | `input.css` → `output.css` | watcher 需另一個 terminal。 |
| `npm run css:build` | 否 | 產生 minified `output.css` | 產物被 `.gitignore` 排除。 |
| `npm test` | 否 | 執行 `tests/*.test.js` | 測試有共享資料與檔案順序依賴；非 hermetic。 |
| `npm run openapi` | 否 | 路由 JSDoc → `openapi.json` | 規格 server URL 固定為 `http://localhost:3001`。 |

## 頁面入口

| URL | 使用者 | 功能 |
| --- | --- | --- |
| `/` | 公開 | 品牌首頁、商品列表、分頁、加入購物車。 |
| `/products/:id` | 公開 | 商品詳情、數量選擇、加入購物車。 |
| `/cart` | 公開／會員 | 依目前 JWT 或 session owner 顯示購物車。 |
| `/checkout` | 會員 | 收件資料驗證並從會員購物車建立訂單。 |
| `/login` | 公開 | 登入與註冊；成功後支援 `redirect` query。 |
| `/orders`、`/orders/:id` | 會員 | 自己的訂單列表、詳情、前往 ECPay 及主動查詢付款結果。 |
| `/admin/products` | 管理員 | 商品分頁、建立、編輯、刪除。 |
| `/admin/orders` | 管理員 | 訂單分頁、狀態篩選、詳情 modal。 |

頁面路由本身不做 server-side 認證；保護頁先 render，再由 browser 的 `Auth.requireAuth()`／`Auth.requireAdmin()` 導頁，而實際資料安全由 API middleware 負責。因此不得把「使用者看不到頁面」視為授權邊界。

## 文件索引

| 文件 | 何時閱讀 |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 修改跨模組流程、路由、認證、schema、訂單或第三方整合前。 |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 新增 API、middleware、資料表、環境變數或撰寫開發計畫時。 |
| [FEATURES.md](./FEATURES.md) | 查功能完成狀態、輸入規格、業務規則及錯誤碼時。 |
| [TESTING.md](./TESTING.md) | 執行或新增測試，以及避免污染開發資料時。 |
| [CHANGELOG.md](./CHANGELOG.md) | 查看可觀察行為與文件變更。 |
| [`plans/`](./plans/) | 放置進行中的 User Story → Spec → Tasks 計畫。 |
| [`plans/archive/`](./plans/archive/) | 保存已完成計畫。 |

