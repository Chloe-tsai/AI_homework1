# 建立 AGENTS.md 並把 docs/ 校正到與現行程式碼一致

- 建立日期：2026-10-15
- 狀態：已完成

## User Story
身為開發者（或 AI 助手），我想要有一份 `AGENTS.md` 入口與一套和原始碼完全一致的詳細文件，以便在不讀遍原始碼的情況下，正確地開發與整合其他模組。

## Spec
### 一、背景
需求：建立 `AGENTS.md` 與 `docs/` 這套結構，每份文件都要詳細、要先讀過原始碼才寫；只記錄「開發者不知道就會影響其他模組開發或整合」的知識點。

現況：
| 項目 | 狀態 |
|------|------|
| `CLAUDE.md` | 已存在，內容就是這份範本（44 行） |
| `docs/` 的 6 份文件 | 都已存在，共約 1,500 行，已涵蓋需求列出的大部分項目 |
| `docs/plans/`、`docs/plans/archive/` | 已存在，各有 `.gitkeep`；archive 裡有綠界計畫 |
| `AGENTS.md` | **不存在** |
| 文件與程式碼是否一致 | **不一致**：綠界改為「伺服器端 QueryTradeInfo 確認」後，有多處說法已過時（見二-2） |

已決定：**`AGENTS.md` 是唯一的內容來源**，`CLAUDE.md` 只放一行 `@AGENTS.md`，Claude Code 仍會載入全部內容，兩份也不會不同步。

### 二、實作方式

#### 1. `AGENTS.md`（新建）與 `CLAUDE.md`（改為匯入）
- 照範本結構：`# AGENTS.md` → `## 專案概述` → `## 常用指令` → `## 關鍵規則` → `## 詳細文件`，最後放 `@docs/README.md` 等 6 行引用。
- 內容以現在的 `CLAUDE.md` 為基礎，校正如下：
  - 專案概述：補上綠界 ECPay AIO（信用卡）。
  - 常用指令：依 `package.json` scripts 重新核對（`start`、`dev:server`、`dev:css`、`css:build`、`test`、`openapi`），附上重置資料庫的方法。
  - 關鍵規則（依「不知道會影響其他模組」挑選，維持精簡）：
    1. 統一回應格式 `{ data, error, message }`；唯一例外是綠界回呼（`1|OK`、302）。
    2. body 用 camelCase、回應用 snake_case 的既有契約；例外是 `image_url` 與綠界 `params` 的 PascalCase。
    3. 三種認證模式；頁面路由沒有伺服器端權限檢查。
    4. 測試共用開發用的 `database.sqlite`，`sequence.files` 無效，每支測試檔要自行建立資料；用 `vi.spyOn(fetch)` 模擬綠界。
    5. 同步 DB API，多步寫入要用 transaction；**async 處理器（目前只有綠界相關）必須 try/catch 或用 `asyncHandler`**；新增/修改 API 要同步更新 `@openapi`。
    6. 綠界：HashKey/HashIV 只放後端；`MerchantTradeNo` 不可重複；**只有 `confirmPayment()`（伺服器端 QueryTradeInfo）能把訂單改為 paid，回呼只當通知**。
    7. 功能開發用 `docs/plans/` 記錄計畫，完成後移到 `archive/`。
- `CLAUDE.md` 改成只有 `@AGENTS.md`，加一行註解說明內容在 AGENTS.md。

#### 2. 逐檔重讀原始碼，校正 docs
做法：每份文件的每個說法（數字、預設值、錯誤碼、訊息字串、流程）都回到原始碼核對。範圍是 `app.js`、`server.js`、`src/**`（含 `services/ecpay.js`）、`public/js/**`、`views/**`、`tests/**`、`package.json`、`vitest.config.js`、`.env.example`、`.gitignore`、`swagger-config.js`、`generate-openapi.js`，約 50 個檔案。不對就改，缺的就補。

已知必須修正的地方：
| 文件 | 位置 | 修正 |
|------|------|------|
| `ARCHITECTURE.md` | §1「所有路由處理器都是同步函式」 | 改為「DB 為同步；只有綠界相關的 3 個處理器是 async，需自行處理錯誤」 |
| `ARCHITECTURE.md` | §2 目錄樹 `ecpay.js` 註解 | 加上 `confirmPayment` |
| `ARCHITECTURE.md` | §8.2 流程圖與說明 | 改為「回呼 → `confirmPayment()` → QueryTradeInfo（`TradeStatus=1` 且金額相符）→ 更新」；`RtnCode≠1` 只記錄失敗；notify 回 `0\|Not Paid Yet` / `0\|QueryTradeInfo Error` 讓綠界重送；result 可能導向 `?payment=pending`；前端重試 5 次、每次間隔 3 秒 |
| `FEATURES.md` | §4.5 回應表與業務規則 | 同上；補上「查詢回應不是同一筆交易 → 502」 |
| `DEVELOPMENT.md` | §3「路由處理器為同步函式」 | 補上 async 處理器的實際寫法（`asyncHandler`、try/catch + `next(err)`），並指向 `ecpayRoutes.js` / `orderRoutes.js` |
| `TESTING.md` | §1 測試類型與資料庫列 | 「沒有單元測試、無 mock」改為：ecpay 有 CheckMacValue 單元測試，並用 `vi.spyOn(global.fetch)` 模擬綠界 |
| `TESTING.md` | §3 檔案表、合計數 | ecpay 改為 19 個，合計 51 個；說明 `mockQueryTradeInfo()`、`signedCallback()` |
| `TESTING.md` | §5 | 新增「如何測試第三方 HTTP 呼叫」範例（mock fetch、每次回傳新的 Response、`afterEach(vi.restoreAllMocks)`） |
| `CHANGELOG.md` | [Unreleased] | ecpay 測試數改為 19；新增 **Security**：付款改由伺服器端 QueryTradeInfo 確認；`Docs`：新增 AGENTS.md |
| `README.md` | 文件索引表 | 第一列改為 `AGENTS.md`（CLAUDE.md 匯入它）；技術棧補上「綠界 ECPay AIO（測試環境）」 |
| `DEVELOPMENT.md` | §10 Git | `openapi.json` 目前未列入 `.gitignore` 的提醒保留（已確認仍為未追蹤） |
| `plans/archive/2026-10-15-ecpay-integration.md` | 文末 | 補「後續：伺服器端 QueryTradeInfo 驗證」小節（User Story / Spec / Tasks） |

#### 3. 確認需求列出的每一項都有涵蓋
| 文件 | 必備內容 | 現況 → 處理 |
|------|---------|-------------|
| ARCHITECTURE | 目錄結構（每個檔案用途）、啟動流程、API 路由總覽表、回應格式範例、認證授權（middleware、JWT 參數、有效期）、DB schema、金流流程 | 都有 → 依上表校正 |
| FEATURES | 每個功能都有行為描述、查詢參數預設值、body 必填/選填、業務邏輯、錯誤碼、非標準機制 | 都有 → 校正 §4.5，並核對每個訊息字串 |
| DEVELOPMENT | 命名規則表、模組系統、新增 API/middleware/DB 的步驟、環境變數表、JSDoc 格式範例、**計畫歸檔流程**（4 個步驟照需求原文） | 都有 → 補 async 寫法，並核對歸檔流程的文字與需求一致 |
| TESTING | 測試檔案表、執行順序與依賴、輔助函式、撰寫新測試的步驟與範例、常見陷阱 | 都有 → 依上表校正 |
| README | 技術棧、可直接複製的快速開始指令、常用指令表、文件索引表 | 都有 → 改索引表 |

### 三、驗證方式
1. **結構檢查**：`ls AGENTS.md docs/{README,ARCHITECTURE,DEVELOPMENT,FEATURES,TESTING,CHANGELOG}.md docs/plans/archive` 全部都存在；`CLAUDE.md` 的內容是 `@AGENTS.md`。
2. **範本對照**：`AGENTS.md` 的標題順序與需求範本一致，`## 詳細文件` 有 6 行描述，結尾有 6 行 `@docs/...`。
3. **過時說法清零**：`grep -n "都是同步函式\|沒有單元測試\|無 mock\|48 個\|16 個測試\|驗 CheckMacValue → applyPaymentResult"` 在 `docs/` 與 `AGENTS.md` 應為 0 筆。
4. **數字與程式碼一致**：
   - `npx vitest run` 的實際測試數 = TESTING.md 合計 = 檔案表各列加總（預期 7 個檔案、51 個測試）。
   - ARCHITECTURE 路由表的列數 = `grep -c "router\.\(get\|post\|put\|patch\|delete\)" src/routes/*.js` 的 API 路由數。
   - schema 表的欄位與 `src/database.js` 的 CREATE TABLE 逐欄相符（6 張表）。
   - 環境變數表與 `grep -rho "process\.env\.[A-Z_]*" app.js server.js src` 的結果一致。
5. **抽查行為描述**：隨機挑 5 個錯誤訊息字串（例如「訂單狀態不是 pending，無法付款」「無法連線綠界查詢付款狀態」），用 grep 確認原始碼裡有完全相同的字串。
6. **連結與引用**：文件內的相對連結（`./ARCHITECTURE.md`、`../AGENTS.md`）都指向存在的檔案；`npm run openapi` 仍成功（確認文件裡寫的指令正確）。
7. **不動程式碼**：這次只改文件。最後用 `git status` 確認變更只在 `AGENTS.md`、`CLAUDE.md`、`docs/**`；`npm test` 仍是 51/51。

## Tasks
- [x] 建立 `AGENTS.md`，把 `CLAUDE.md` 改為 `@AGENTS.md`
- [x] 逐檔重讀原始碼並校正 6 份 docs（含二-2 的已知問題）
- [x] 補寫綠界計畫歸檔的後續小節
- [x] 執行驗證 1–7

## 結果
- 驗證 1–7 全部通過：結構齊全、`CLAUDE.md` 為 `@AGENTS.md`；過時說法 0 筆；API 路由 23 = 文件 23；環境變數 11 = 11；6 張表欄位全數記錄；抽查 7 個訊息字串與程式碼一致；相對連結無失效；`npm run openapi` 成功；`npm test` 51/51。
- 稽核時發現的程式行為（僅記錄於文件，未修改程式）：前端運費 NT$150 未計入訂單與綠界扣款；`PATCH /api/orders/:id/pay` 的 `actionMap` 可被繼承屬性繞過造成 500；註冊/後台 PUT 缺型別檢查會造成 500；未設定綠界帳號時會自動使用公開測試帳號。
