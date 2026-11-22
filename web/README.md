# 前端

React 19 + TanStack Router（檔案式路由）+ TanStack Query + Base UI，Vite 打包。

## 目錄

| 位置 | 內容 |
| --- | --- |
| `routes/` | 檔案式路由。`routeTree.gen.ts` 由 Vite 外掛產生，要 commit。網址參數在路由檔的 `validateSearch` 解析，不合法的值回 `undefined` |
| `pages/<頁面>/` | 頁面元件，以及只有這頁用的元件與查詢 |
| `ui/` | 設計系統元件（Base UI 包裝）與它們的 CSS |
| `data/` | 共用查詢（`queries.ts`）、登入狀態與站台名稱（`session.ts`）、SSE（`status-stream.ts`）、健康狀態（`use-health.ts`）、快取清單的寫入（`cache.ts`）、更新設定（`use-update-settings.ts`）、QueryClient 與 mutation 的錯誤通知規則（`query-client.ts`） |
| `app/` | 外殼（側欄、底部導覽、使用者選單） |
| `live/`、`playback/`、`timeline/`、`detect/`、`ptz/`、`*-logic.ts`、`health.ts`、`format.ts`、`api.ts` | 純邏輯與命令式物件 |

## 取資料

- 用 `useQuery`。兩頁以上用到的查詢放 `data/queries.ts`，只有一頁用的放那頁的目錄。key 是 API 路徑的各段，參數放最後一個物件：`GET /api/cameras/:id/days?tz=` 是 `["cameras", id, "days", { tz }]`。
- 攝影機、worker 與進行中的事件由全站唯一一條 SSE 寫進快取。頁面不要自己開 `EventSource`，也不要輪詢這三樣。其他要定時更新的用 `refetchInterval`。
- 變更一律用 `useMutation`，不在事件處理函式裡自己 `await api.x()` 再手寫 busy、error 與 try/catch。多步驟的流程（先測試連線再儲存、建立後上傳）整段放進 `mutationFn`；處理函式只做驗證與確認對話框，再呼叫 `mutate`。忙碌用 `isPending`，送出期間先照新值畫用 `variables`（範本：`ObjectsGroup.tsx`、`DecodeRow.tsx`）。目前停在 reducer 管階段文字的兩個攝影機表單（`CameraFormPage`、`CameraEditPage`）與標記圖片（`LabelBoard`）沒有改。
- mutation 失敗時預設跳出錯誤通知（`data/query-client.ts`）。錯誤要顯示在欄位旁、對話框裡或狀態列的，加 `meta: { handlesError: true }` 關掉通知，再用 `onError` 自己顯示。不要寫空的 `onError`。
- 成功後把結果寫進快取：清單用 `data/cache.ts` 的 `putItem` / `dropItem`（純函式版是 `upsert` / `without`），不要每個地方自己寫 `list.map`、`filter`。更新設定一律用 `data/use-update-settings.ts` 的 `useUpdateSettings`，它成功後自己寫 `settingsQuery`，要額外做的事用 options 補。invalidate 與 `setQueryData` 用 `xxxQuery.queryKey`，不寫字面值的 key。
- 站台名稱用 `data/session.ts` 的 `useSiteName()`。
- 載入中用 `<Spinner />`，錯誤用 `<ErrorBox error onRetry />`，找不到資料這類已知錯誤丟 `PageError`（`ui/states.tsx`）。

## 共用的畫面零件

先找 `ui/` 有沒有，不要在頁面裡手刻。

- 送出鈕：`<Button busy={isPending}>`。轉圈、`aria-busy`、停用都由它處理，要換字（「測試連線…」「儲存中…」）由呼叫端換 children。沒有轉圈的場合（對話框的小按鈕）維持原樣，不要為了套用而加轉圈。
- 表單底部：`FormStatus` 是左邊的錯誤摘要加複製錯誤鈕，錯誤物件是 `{ summary, copy? }`。只在有這個複製鈕的地方使用，其他表單單行錯誤直接寫 `<p className="form-error" role="alert">`。
- 收合：設定頁卡片裡的進階用 `SettingsDisclosure`（`defaultOpen` 只在第一次畫出來時生效）；表單的卡片用 `FormCard`（`error` 標紅、`dirty` 顯示「未儲存」）。
- 常用值加自訂：`Choice`（分段控制）與 `PresetPicker`（下拉）共用 `ui/use-preset-choice.ts` 的狀態，新的樣式也用它。
- 對話框關閉動畫期間要保留最後的內容：`ui/use-retained.ts` 的 `useRetained(value)`，不要手寫 `if (x && x !== shown) setShown(x)`。

## 命令式物件

canvas 時間軸、MSE 播放器、即時影像在 effect 裡建立、在 cleanup 裡銷毀，物件放 ref。開發模式是 StrictMode，cleanup 必須真的關掉連線與計時器。依賴陣列只放「變了就要重開」的值。時間軸與遮罩編輯器用 `dom.ts` 的 `h()` 自己建 DOM，React 元件不要用它。

驗證方法：來回切換頁面，`/api/live`、`/api/stream` 同時只會有一條。

## 多國語言

Lingui，原始語言是英文，另有繁體中文（`zh-Hant`）與日文（`ja`）。語言預設跟瀏覽器，帳號頁可以改，存在這個瀏覽器（`web/i18n.ts`）。

- 程式裡的介面文字一律寫英文。元件裡用 `useLingui()` 的 ``t`…` `` 或 `<Trans>`（`@lingui/react/macro`）；模組外層的表格、選項清單用 `msg`（`@lingui/core/macro`），用的地方再 `i18n._()`；一般函式在函式內呼叫 `@lingui/core/macro` 的 `t`，不要放在模組最外層（那時語言還沒載入）。
- 英文需要單複數時用 `plural` / `<Plural>`。同一個英文在不同地方意思不同（例如事件的「動作」與偵測方式的「畫面變化」都是 Motion）時加 `context`。
- 名稱清單用 `format.ts` 的 `joinList`（英文「, 」、中日文「、」），句子片段用 `joinClauses`。日期與數字用 `Intl` 並帶 `i18n.locale`。
- 物件類別名稱在 `detect/label-names.ts`，自備模型的類別表裡沒有時顯示模型原名。
- 改完文字跑 `bun run i18n:extract` 更新 `web/locales/*.po`，再補上繁中與日文的 `msgstr`。可以寫成 `{ "英文": "譯文" }` 的 JSON，用 `bun scripts/i18n-fill.ts <locale> <檔案>` 填空白的項目。`.po` 由 Vite 外掛直接載入，不用另外編譯。
- 換語言時整個路由樹重掛，所以命令式物件（時間軸、遮罩編輯器）的文字也會跟著換。
- 伺服器送到畫面上的文字（錯誤回應、狀態欄位）帶穩定的 code 與 params：中文在 `src/messages/<區>.ts`，翻譯在 `web/server-messages/<區>.ts`，顯示時用 `server-text.ts` 的 `serverText(msg, 中文後備)`；`api.ts` 已經替 API 錯誤換好。DTO 保留原本的中文欄位給舊用戶端，旁邊的 Msg 版本命名為 `message` → `msg`、`x` → `xMsg`。新增訊息時兩邊都要加，型別會檢查缺漏。
- `bun test` 會先展開 macro 並啟用英文（`scripts/lingui-test-preload.ts`），測試斷言寫英文。

## 開發

- `bun run dev:mock`：假後端（`web/dev-mock.ts`）加 Vite。`WEB_PORT`、`MOCK_API_PORT` 換埠，`MOCK_FRESH=1` 從初始設定開始。
- `bun run dev` 加 `bun run dev:web`：真的主程序加 Vite，`API_URL` 改後端網址。
- `bun run build` 輸出 `dist/web`（含預先壓縮的 `.gz`、`.br`），主程序直接提供，深層路徑重新整理也能用。
- 改畫面時截桌面 1280 與手機 375、淺色與深色。圖示與次要文字不用 opacity，淡化用 `color-mix()` 對背景混合。
