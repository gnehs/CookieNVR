import type { MetricsDto } from "../../../src/api-types.ts";
import { formatBytes } from "../../format.ts";
import type { Health, Issue } from "../../health.ts";
import type { IconName } from "../../ui/icons.ts";
import { CATEGORY_LABEL } from "./ResourcesCard.tsx";

export type IssueTarget =
  | { to: "/settings/system" | "/settings/storage" | "/settings/cameras" }
  | { to: "/settings/cameras/$id"; params: { id: string } }
  | { to: "/settings/cameras/$id/states/$sensorId"; params: { id: string; sensorId: string } };

export interface Restart {
  ids: string[];
  title: string;
  message: string;
  done: string;
}

export type Action = { label: string; restart: Restart } | ({ label: string } & IssueTarget);

export interface Explained {
  /** 這一列的主角：攝影機名稱或「影像服務」「儲存空間」 */
  who: string;
  pill: { label: string; tone: "bad" | "warn" };
  /** 一句下一步 */
  next: string;
  /** 較長的可能原因，收在「可能的原因」裡 */
  why: string;
  action?: Action;
}

export interface Snapshot {
  health: Health;
  metrics: MetricsDto | null;
}

/** 「目前最花處理器的是錄影」；還沒算出各類用量時是空字串 */
function topUser(snap: Snapshot, by: "cpuPct" | "memBytes"): string {
  const top = [...(snap.metrics?.usage ?? [])].sort((a, b) => b[by] - a[by])[0];
  return top && top[by] > 0 ? `目前用最多的是「${CATEGORY_LABEL[top.category]}」。` : "";
}

export const SYSTEM_ICON: Partial<Record<Issue["kind"], IconName>> = { restream: "server", objects: "server", objectsLoad: "server", decode: "server", stateWorker: "server", cpuBusy: "activity", memoryHigh: "activity" };

/** 每一類問題只寫一次：一句下一步、收起來的原因、一個最可能有用的動作 */
export function explain(issue: Issue, snap: Snapshot): Explained {
  const one = issue.cameras.length === 1;
  const names = issue.cameras.map((c) => c.name).join("、");
  const sensors = issue.sensors ?? [];
  const camOf = (id: string) => issue.cameras.find((c) => c.id === id)?.name ?? "";
  const sensorWho = sensors.map((s) => `${camOf(s.cameraId)}的「${s.name}」`).join("、");
  const sensorAction = (label: string): Action =>
    sensors.length === 1
      ? { label, to: "/settings/cameras/$id/states/$sensorId", params: { id: sensors[0]!.cameraId, sensorId: sensors[0]!.id } }
      : issue.cameras.length === 1
        ? { label, to: "/settings/cameras/$id", params: { id: issue.cameras[0]!.id } }
        : { label, to: "/settings/cameras" };
  switch (issue.kind) {
    case "stateUntrained":
      return {
        who: sensorWho,
        pill: { label: "還沒訓練", tone: "warn" },
        next: "標記每一類的畫面後按「開始訓練」",
        why: "狀態感應器要先看過每一種樣子（例如門開著、關著的畫面）才會判斷。標記好之後訓練只要幾秒到幾十秒。不需要了也可以直接刪除它。",
        action: sensorAction("去標記"),
      };
    case "stateStale":
      return {
        who: sensorWho,
        pill: { label: "要重新訓練", tone: "warn" },
        next: "類別改過了，重新訓練後才會繼續辨識",
        why: "新增或刪除類別後，之前學到的已經對不上新的類別，所以暫停判斷。新增的類別要先標記幾張畫面，再按「重新訓練」。",
        action: sensorAction("重新訓練"),
      };
    case "stateNoFrames":
      return {
        who: sensorWho,
        pill: { label: "看不到畫面", tone: "warn" },
        next: "攝影機有連上，但狀態辨識收不到畫面",
        why: "狀態辨識跟動作偵測用同一份畫面；這台的偵測畫面中斷時就沒辦法判斷。到攝影機設定確認「偵測」有開啟，仍然不行時，用頁面下方的「複製診斷資訊」找原因。",
        action: issue.cameras.length === 1 ? { label: "檢查設定", to: "/settings/cameras/$id", params: { id: issue.cameras[0]!.id } } : { label: "檢查設定", to: "/settings/cameras" },
      };
    case "stateWorker":
      return {
        who: "狀態辨識",
        pill: { label: "已停止", tone: "warn" },
        next: issue.detail ?? "重新啟動，通常就會恢復",
        why: "負責判斷畫面狀態的程序沒有在運作，所有狀態感應器都會停在「未知」。錄影與動作偵測不受影響。剛開機時會先啟動一下子；一直沒有恢復時重新啟動它，仍然不行請用頁面下方的「複製診斷資訊」找原因。",
        action: { label: "重新啟動", restart: { ids: ["classifier"], title: "重新啟動狀態辨識？", message: "狀態會先變成未知，幾秒後重新確認。錄影不受影響。", done: "已重新啟動狀態辨識" } },
      };
    case "restream":
      if (issue.detail)
        return {
          who: "影像服務",
          pill: { label: "port 被佔用", tone: "bad" },
          next: issue.detail,
          why: "通常是同一台主機上還跑著其他監視器軟體（例如 Frigate、go2rtc 也用 8554）。容器用 Host 網路時，設定環境變數 RTSP_PORT 換一個沒人用的 port；用 bridge 網路時，把 RTSP_PORT 和主機、容器兩側的 port 改成同一個數字。改完重新啟動容器。",
        };
      return {
        who: "影像服務",
        pill: { label: "已停止", tone: "bad" },
        next: "重新啟動就會恢復畫面與錄影",
        why: "所有攝影機的畫面都會經過這個服務，它停下來時畫面與錄影都會中斷。重新啟動期間會中斷幾秒。",
        action: { label: "重新啟動", restart: { ids: ["restream"], title: "重新啟動影像服務？", message: "所有攝影機的畫面與錄影會中斷幾秒鐘。", done: "已重新啟動影像服務" } },
      };
    case "objects":
      return {
        who: "物件辨識",
        pill: { label: "已停止", tone: "warn" },
        next: "重新啟動，通常就會恢復辨識",
        why: "物件辨識停下來時，錄影與動作偵測不受影響，只是事件不會標上看到的東西；設成「過濾」的攝影機會改成照一般動作建立事件。重新啟動後仍然停止，請用頁面下方的「複製診斷資訊」找原因，也可以到「設定 → 一般」換一個辨識模型或推論裝置。",
        action: { label: "重新啟動", restart: { ids: ["detector"], title: "重新啟動物件辨識？", message: "辨識會中斷幾秒鐘，錄影不受影響。", done: "已重新啟動物件辨識" } },
      };
    case "objectsLoad":
      return {
        who: "物件辨識",
        pill: { label: "跟不上", tone: "warn" },
        next: issue.title,
        why: "辨識跟不上時，多出來的畫面會被略過。錄影與動作偵測不受影響，但事件可能漏標上看到的東西。降低辨識頻率、改用更快的裝置，或到設定裡測速看看這台機器的能力，都能改善。",
        action: { label: "調整設定", to: "/settings/system" },
      };
    case "decode":
      return {
        who: "影像解碼",
        pill: { label: "改用處理器", tone: "warn" },
        next: issue.detail ?? issue.title,
        why: "顯示卡無法解碼時，影像會改由處理器解碼，錄影與動作偵測仍然正常，只是會多吃一些處理器。可以到「設定 → 一般」換一張顯示卡，或改回自動；原因寫在「複製診斷資訊」裡。",
        action: { label: "調整設定", to: "/settings/system" },
      };
    case "offline":
      return {
        who: names,
        pill: { label: "連不上", tone: "bad" },
        next: "確認相機有開機並連上網路",
        why: "收不到畫面，所以也沒辦法錄影。常見原因是相機斷電、Wi-Fi 斷線，或 IP 位址變了；如果最近換過路由器，到攝影機設定更新 IP。相機能同時提供的串流連線很少，Frigate 等其他軟體也在直接連這台相機時，名額可能被佔滿，請讓它們改接 CookieNVR 的串流網址。",
        action: one ? { label: "檢查設定", to: "/settings/cameras/$id", params: { id: issue.cameras[0]!.id } } : { label: "檢查設定", to: "/settings/cameras" },
      };
    case "notRecording":
      if (issue.detail)
        return {
          who: names,
          pill: { label: "沒有寫入權限", tone: "bad" },
          next: "錄影寫不進儲存位置，重新啟動容器通常會自動修正",
          why: "CookieNVR 以 PUID／PGID 設定的使用者執行，錄影資料夾裡卻有它不能寫的資料夾，多半是之前以 root 執行（沒設 PUID）時建立的。重新啟動容器時會自動把資料夾交給這個使用者；仍然不行時，在主機上把錄影與 appdata 的資料夾交給 PUID:PGID（例如 chown -R 99:100 <主機上的路徑>），再重新啟動容器。",
        };
      return {
        who: names,
        pill: { label: "沒在錄影", tone: "bad" },
        next: "重新開始錄影，通常就會恢復",
        why: "畫面正常，但錄影一直無法開始，常見原因是儲存空間不足或寫不進儲存位置。重新開始後仍然沒有錄影，請用頁面下方的「複製診斷資訊」找原因。",
        action: {
          label: "重新開始",
          restart: {
            ids: issue.cameras.map((c) => `record:${c.id}`),
            title: one ? `重新開始「${issue.cameras[0]!.name}」的錄影？` : `重新開始 ${issue.cameras.length} 台的錄影？`,
            message: "錄影會中斷幾秒鐘。",
            done: "已重新開始錄影",
          },
        },
      };
    case "unstable":
      return {
        who: names,
        pill: { label: "錄影不穩定", tone: "warn" },
        next: "把相機移近路由器或改用有線",
        why: "最近 10 分鐘內錄影中斷又自動恢復了很多次，常見原因是網路訊號不穩。",
      };
    case "diskLow":
      return {
        who: "儲存空間",
        pill: { label: "空間不足", tone: "bad" },
        next: "縮短保留天數或換更大的硬碟",
        why: `剩下 ${formatBytes(snap.health.disk.free)}，低於設定的最低剩餘空間，系統正在刪除最舊的錄影來騰出空間。`,
        action: { label: "調整保留", to: "/settings/storage" },
      };
    case "diskFull":
      return {
        who: "儲存空間",
        pill: { label: "快滿了", tone: "warn" },
        next: "可以先縮短保留天數",
        why: `已用 ${snap.health.disk.usedPct.toFixed(0)}%。空間用完前會自動刪除最舊的錄影，縮短保留天數可以避免重要片段被刪掉。`,
        action: { label: "調整保留", to: "/settings/storage" },
      };
    case "dataDiskLow":
      return {
        who: "appdata 硬碟",
        pill: issue.tone === "bad" ? { label: "空間不足", tone: "bad" } : { label: "快滿了", tone: "warn" },
        next: "清出 appdata 那顆硬碟的空間",
        why: `資料庫、事件縮圖與匯出的影片放在這顆，只剩 ${formatBytes(snap.health.dataDisk?.free ?? 0)}。這裡不會自動清理，空間用完時匯出會失敗，事件與設定也可能存不進去。刪掉同一顆上其他用不到的檔案（例如其他容器的資料），或把 /data 換到空間較大的硬碟。`,
      };
    case "cpuBusy":
      return {
        who: "處理器",
        pill: { label: "長時間忙碌", tone: "warn" },
        next: "減少同時進行的工作，或換效能更好的主機",
        why: `過去 5 分鐘處理器幾乎一直在 90% 以上，畫面可能延遲、錄影可能掉格。${topUser(snap, "cpuPct")}可以關掉不需要的動作偵測、少開幾個即時畫面，或讓攝影機改用解析度較低的子碼流偵測。`,
      };
    case "memoryHigh":
      return {
        who: "記憶體",
        pill: { label: "快不夠了", tone: "warn" },
        next: "減少攝影機的工作，或增加記憶體",
        why: `過去 5 分鐘記憶體幾乎一直用到 90% 以上；用完時系統會強制結束程式，錄影可能中斷。${topUser(snap, "memBytes")}如果 CookieNVR 跑在 Docker 裡並設了記憶體上限，可以把上限調高。`,
      };
  }
}
