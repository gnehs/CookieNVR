# 把舊頁面轉成 React

給接手轉頁面的人。範例：登入／初始設定（`pages/auth/AuthPage.tsx`）與攝影機首頁（`pages/cameras/CamerasPage.tsx`）。這次是換技術，不是改版：畫面、文字、class 名稱都照舊版。

## 目錄

| 位置 | 內容 |
| --- | --- |
| `routes/` | 檔案式路由（TanStack Router）。全部路由都已經建好，`routeTree.gen.ts` 由 Vite 外掛產生並且要 commit |
| `pages/<頁面>/` | 頁面元件與只有這頁用的元件、查詢 |
| `ui/` | 設計系統元件（Base UI 包裝）與它們的 CSS |
| `data/` | 共用的查詢（`queries.ts`）、登入狀態（`session.ts`）、SSE（`status-stream.ts`）、健康狀態（`use-health.ts`） |
| `app/` | 外殼（側欄、使用者選單）與「尚未轉換」佔位 |
| `legacy/` | 還沒轉的舊頁面，只當轉換依據，不進建置與型別檢查。轉完就刪掉對應的檔案 |
| `live/`、`playback/`、`timeline/`、`detect/`、`ptz/`、`*-logic.ts`、`health.ts`、`format.ts`、`api.ts` | 純邏輯與命令式物件，直接 import |

## 轉一頁要動的檔案

1. 新增 `pages/<頁面>/<Name>Page.tsx`（可以再拆檔，都放在同一個目錄）。
2. 把對應的路由檔裡的 `component: () => <NotConverted … />` 換成新頁面。網址參數用路由檔的 `validateSearch` 解析（範例：`routes/login.tsx`）。
3. 刪掉 `legacy/` 裡已經轉好的檔案。

不要新增、改名或搬動 `routes/` 底下的檔案，`routeTree.gen.ts` 才不會互相衝突。真的需要新路由時寫在回報裡。

## 取資料

- 用 `useQuery`。共用的查詢在 `data/queries.ts`：`camerasQuery`、`settingsQuery`、`systemQuery`、`metricsQuery()`、`workersQuery`、`activeEventsQuery`。登入的人用 `useMe()`（只能在需要登入的頁面用）。
- 只有一頁用的查詢寫在那頁的目錄裡，用 `queryOptions` 定義。**key 的規則**：API 路徑的各段，參數放最後一個物件。`GET /api/cameras/:id/days?tz=` 是 `["cameras", id, "days", { tz }]`，`GET /api/events?camera=&start=&end=` 是 `["events", { camera, start, end }]`。
- 攝影機、worker 與進行中的事件由全站唯一一條 SSE 寫進快取，頁面不要自己開 `EventSource`，也不要再輪詢這三樣。
- 需要定時更新的用 `refetchInterval`（分頁在背景時自動暫停）。舊版的 `ctx.every(ms, fn)` 都換成這個。
- 載入中、錯誤：`if (q.isPending) return <Spinner />`、`if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />`。找不到資料這類已知錯誤丟 `PageError`（`ui/states.tsx`），會顯示標題與主要動作。

## 送出變更

- 用 `useMutation`，成功後 `queryClient.invalidateQueries({ queryKey: [...] })` 或 `setQueryData`。舊版呼叫 `refreshHealth()` 的地方改成 invalidate `["system"]`。
- 沒寫 `onError` 的 mutation 失敗時會自動跳出錯誤通知；要把錯誤顯示在表單裡就自己寫 `onError`。
- 成功的提示用 `toast("已儲存")`（`ui/toast.tsx`），確認用 `if (await confirmDialog(標題, 內容, { danger: true, confirmLabel: "刪除" }))`（`ui/Dialog.tsx`）。
- 改了站台名稱要更新 `infoQuery` 的快取（外殼與分頁標題跟著它）。

## 舊工具對照

| 舊（`dom.ts`、`ui/*.ts`） | 新 |
| --- | --- |
| `h(...)`、`icon(name)` | JSX、`<Icon name size>` |
| `select({...})` | `<Select label entries value onChange …>`，選項格式一樣 |
| `datePicker({...})` | `<DatePicker label value onChange min max marked stepper …>` |
| `settingsGroup`、`settingRow`、`settingsDisclosure`、`presetPicker` | `<SettingsGroup>`、`<SettingRow title desc control toggle wide error>`、`<SettingsDisclosure>`、`<PresetPicker>`（`ui/SettingRow.tsx`）。`control` 給函式時拿到 `id` 與 `aria-describedby`，標題會變成指向它的 label |
| `formCard(...)` + `setSummary`、`setFlags` | `<FormCard title icon summary error dirty defaultOpen>` |
| `openDialog`、`confirmDialog` | `<Dialog open onOpenChange title>`、`confirmDialog()` |
| `attachMenu`、`menuButton` | `<Menu trigger label entries>`、`<MenuButton label items>`；連結項目用 `to` |
| `toast`、`copyButton`、`copyWithToast` | `toast`、`<CopyButton>`、`copyWithToast`（`ui/Button.tsx`） |
| `field`、`switchInput`、`switchRow`、`tiles`、`segmented`、`choice` | `<Field>`、`<Switch>`、`<SwitchRow>`、`<Tiles>`、`<Segmented>`、`<Choice>`（`ui/controls.tsx`、`ui/Field.tsx`） |
| `panel`、`panelSection`、`pageHeader`、`badge`、`emptyState`、`errorBox`、`spinner`、`brandMark` | `ui/Panel.tsx`、`ui/states.tsx` |
| 按鈕 `h("button", { class: "btn primary" })`、按鈕樣式的連結 | `<Button variant="primary" icon="plus">`、`<ButtonLink to=…>` |
| `settingsLayout`、`settingsSubpage` | `pages/settings/SettingsLayout.tsx` |
| `liveFrame(cam)` | `<LiveFrame cam onTarget onState>`（`live/LiveFrame.tsx`） |
| `formatBytes`、`formatDuration`…、`browserTz` | `format.ts` |
| `state.me`、`state.info`、`state.siteName` | `useMe()`、`useQuery(infoQuery)` |
| `#/path` 連結、`navigate()` | `<Link to>`、`useNavigate()` |

缺什麼共用元件或屬性，先在自己的頁面目錄裡做，回報時列出來，不要直接改 `ui/` 裡現有的檔案（好幾個人同時在轉）。

## 命令式物件（canvas、MSE 播放器、即時影像）

在 effect 裡建立、在 cleanup 裡銷毀，物件放 ref。開發模式是 StrictMode，effect 會「建立、銷毀、再建立」一次，cleanup 必須真的關掉連線與計時器，否則會多一條連線。範例是 `CamerasPage.tsx` 的多宮格：

```tsx
useEffect(() => {
  if (!gridKey) return;
  return playGrid(ids, "sd", targets); // 回傳 stop：中斷 fetch、銷毀 LiveVideo
}, [gridKey]);
```

- 依賴陣列只放「變了就要重開」的值（例如啟用中的攝影機 id 串成的字串），不要放每次重畫都會變的陣列或物件。
- 子元件把 DOM（例如 `<video>`）交給父元件時，用穩定的回呼（`useCallback`）。子元件的 effect 先跑，父元件開連線時已經拿得到。
- 時間軸（`timeline/timeline.ts`）與遮罩編輯器（`detect/mask-editor.ts`）還是用 `dom.ts` 的 `h()` 自己建 DOM，這沒問題；React 元件本身不要用 `dom.ts`。
- 驗證方法：開發模式下來回切換頁面，`/api/live`、`/api/stream` 同時只會有一條（DevTools 的 Network，或在 `window.fetch` 上計數）。

## 開發環境與截圖對照

- `bun run dev:mock`：假後端（純 API，`web/dev-mock.ts`）加 Vite，開 http://localhost:48765。`WEB_PORT`、`MOCK_API_PORT` 可以換埠，`MOCK_FRESH=1` 從初始設定開始。
- `bun run dev` 加 `bun run dev:web`：真的主程序（8765）加 Vite（5173）。`API_URL` 改後端網址。
- `bun run build` 後主程序直接提供 `dist/web`，深層路徑重新整理也能用。
- 舊版畫面：`git archive react-integration | tar -x -C <暫存目錄>`，在那裡 `bun install` 後 `PORT=<埠> bun web/dev-mock.ts`（舊版網址是 `#/路徑`）。新舊各截桌面 1280 與手機 375、淺色與深色，用 `magick compare -metric AE -fuzz 2%` 比。假後端的事件是隨機的，事件標記的差異不算。
- `bun run typecheck`（後端與前端兩份 tsconfig）與 `bun test`。

## 尚未轉換的頁面

| 路由檔（`routes/`） | 網址 | 舊檔（`legacy/`） |
| --- | --- | --- |
| `_authed/_shell/cameras/$id.tsx` | `/cameras/:id` | `pages/camera.ts`、`ptz/panel.ts`、`ptz/presets.ts` |
| `_authed/_shell/recordings.tsx` | `/recordings` | `pages/recordings.ts`、`pages/export-panel.ts` |
| `_authed/_shell/events.tsx` | `/events` | `pages/events.ts` |
| `_authed/_shell/account.tsx` | `/account` | `pages/account.ts` |
| `_authed/link/index.tsx`、`_authed/link/$code.tsx` | `/link`、`/link/:code` | `pages/link.ts` |
| `_authed/_shell/settings/cameras/index.tsx` | `/settings/cameras` | `pages/settings-cameras.ts`（清單） |
| `_authed/_shell/settings/cameras/new.tsx`、`$id.tsx`、`_authed/welcome.tsx` | `/settings/cameras/new`、`/settings/cameras/:id`、`/welcome` | `pages/settings-cameras.ts`（`cameraFormPage`）、`pages/detect-settings.ts`、`pages/homekit-settings.ts`、`detect/object-settings.ts`、`detect/slider.ts`、`detect/score-meter.ts`、`ptz/prefs-field.ts` |
| `_authed/_shell/settings/storage.tsx` | `/settings/storage` | `pages/settings-storage.ts` |
| `_authed/_shell/settings/system.tsx` | `/settings/system` | `pages/settings-system.ts`、`pages/settings-objects.ts`、`pages/objects-benchmark.ts` |
| `_authed/_shell/settings/users.tsx` | `/settings/users` | `pages/settings-users.ts` |
| `_authed/_shell/settings/status.tsx` | `/settings/status` | `pages/settings-status.ts`、`resources.ts` |

轉換時一併要做的新功能（舊版沒有，後端已經提供）：

- 設定 → 一般（`/settings/system`）：新增「影像解碼」設定列，選項來自 `GET /api/video-devices`，儲存用 `PUT /api/settings`（`{ devices: { decode } }`）。
- 狀態頁（`/settings/status`）：`/api/system` 的 `decode.warning` 有值時要顯示出來。
