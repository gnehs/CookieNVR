import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CameraDto, HomekitDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { errMsg } from "../../format.ts";
import { encodeQr, qrSvgPath } from "../../homekit/qr.ts";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { SwitchRow } from "../../ui/controls.tsx";
import { toast } from "../../ui/toast.tsx";

const POLL_MS = 3_000;

/** 開啟了但還沒配對好（或還在啟動）時每 3 秒重抓，等家庭 App 加入 */
export const homekitQuery = (id: string) =>
  queryOptions({
    queryKey: ["cameras", id, "homekit"],
    queryFn: () => api.homekit(id),
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && d.enabled && d.systemEnabled && !(d.pairing?.paired && d.status === "ready") ? POLL_MS : false;
    },
  });

/** "57725799" → "5772 5799", the grouping Apple prints on HomeKit labels. */
export function formatCode(code: string): string {
  const digits = code.replaceAll("-", "");
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}

function codecName(codec: string | null): string {
  if (codec === "hevc") return "H.265";
  return codec ? codec.toUpperCase() : "不支援的格式";
}

function blockedReason(dto: HomekitDto): string | null {
  if (!dto.systemEnabled) return null;
  if (dto.check.state === "blocked") {
    return dto.check.reason === "not-h264"
      ? `這台攝影機的主畫面是 ${codecName(dto.check.videoCodec)}，家庭 App 只支援 H.264。在攝影機的 App 裡把主畫面改成 H.264 後，就可以開啟。`
      : "讀到的主畫面沒有影像，無法加入。";
  }
  if (dto.check.state === "unknown") return "目前讀不到這台的畫面，等它連上後再開啟。";
  return null;
}

/** 收合的卡片上的一句話：已加入、等待配對、未開啟… */
export function homekitSummary(dto: HomekitDto | undefined): string {
  if (!dto) return "正在檢查…";
  if (!dto.systemEnabled) return "未開啟（要先在「設定 → 一般」開啟）";
  if (!dto.enabled) return blockedReason(dto) && dto.check.state === "blocked" ? "無法加入：畫面格式不支援" : "未開啟";
  if (dto.pairing?.paired) return "已加入";
  return dto.status === "failed" ? "無法啟動，請重設配對" : "等待在「家庭」App 加入";
}

function QrCode({ payload }: { payload: string }) {
  const matrix = encodeQr(payload, "M");
  const n = matrix.length;
  return (
    <svg className="hk-qr" viewBox={`-4 -4 ${n + 8} ${n + 8}`} role="img" aria-label="加入 Apple 家庭用的 QR code" shapeRendering="crispEdges">
      <rect x={-4} y={-4} width={n + 8} height={n + 8} className="hk-qr-bg" />
      <path d={qrSvgPath(matrix)} className="hk-qr-fg" />
    </svg>
  );
}

function StatusLine({ d }: { d: HomekitDto }) {
  if (d.status === "failed") {
    return (
      <div className="callout bad">
        <Icon name="alert" size={16} />
        <p>沒辦法讓家庭 App 找到這台攝影機。到「設定 → 狀態」按「複製診斷資訊」，可以看到原因。</p>
      </div>
    );
  }
  if (d.pairing?.paired) {
    return (
      <p className="hk-state ok">
        <Icon name="check" size={16} />
        <span>
          <b>已加入家庭</b>可以在家庭 App 裡看畫面，也會收到動作通知。
        </span>
      </p>
    );
  }
  if (d.status === "starting") {
    return (
      <p className="hk-state">
        <span className="spin" aria-hidden="true" />
        <span>正在準備，幾秒後就能加入…</span>
      </p>
    );
  }
  return (
    <p className="hk-state wait">
      <span className="hk-dot" aria-hidden="true" />
      <span>
        <b>等待加入</b>用 iPhone 掃描下面的 QR code。
      </span>
    </p>
  );
}

function Requirements() {
  return (
    <details className="more">
      <summary>需要準備什麼？</summary>
      <ul className="hk-needs">
        <li>
          <b>家庭中樞：</b>家裡要有一台當作家庭中樞的 Apple TV、HomePod 或 iPad，才會在偵測到動作時通知你、在外面也能看。
        </li>
        <li>
          <b>iCloud+：</b>想讓 Apple 幫你保存動作片段（安全錄影），要訂閱含這項服務的 iCloud+ 方案。不訂閱也能看即時畫面。
        </li>
        <li>
          <b>網路設定：</b>iPhone 是在家裡的網路上「找」到攝影機的，所以 CookieNVR 的容器要用 host 網路（或給它自己的區網 IP）。
        </li>
        <li>CookieNVR 自己的全天候錄影不受影響，家庭 App 裡的錄影設定只管 Apple 那邊。</li>
      </ul>
    </details>
  );
}

/** 攝影機表單裡的「Apple 家庭」：開關、配對用的 QR code 與配對碼、重設配對。開關與重設直接生效，不經過表單的儲存 */
export function HomekitSection({ camera }: { camera: CameraDto }) {
  const qc = useQueryClient();
  const q = useQuery(homekitQuery(camera.id));
  const act = useMutation({
    mutationFn: (action: "enable" | "disable" | "reset") => api.homekitAction(camera.id, action),
    onSuccess: (dto, action) => {
      qc.setQueryData(homekitQuery(camera.id).queryKey, dto);
      if (action === "reset") toast("已重設配對，請用新的配對碼重新加入");
    },
  });
  const busy = act.isPending;

  let body: React.ReactNode;
  if (q.isError) {
    body = (
      <div className="callout bad">
        <Icon name="alert" size={16} />
        <p>{errMsg(q.error)}</p>
      </div>
    );
  } else if (!q.data) {
    body = (
      <p className="hk-muted">
        <span className="spin" aria-hidden="true" /> 正在檢查這台攝影機…
      </p>
    );
  } else {
    const d = q.data;
    const on = d.enabled && d.systemEnabled;
    const blocked = !d.enabled ? blockedReason(d) : null;
    body = (
      <>
        <SwitchRow title="加入 Apple 家庭" desc={on ? undefined : "開啟後會顯示配對用的 QR code。"} checked={on} disabled={busy || !d.systemEnabled || (!d.enabled && blocked !== null)} onChange={(v) => act.mutate(v ? "enable" : "disable")} />
        {!d.systemEnabled ? (
          <p className="hk-muted">
            要先到{" "}
            <Link className="text-link" to="/settings/system">
              設定 → 一般
            </Link>{" "}
            開啟「Apple 家庭」，這裡才能使用。
          </p>
        ) : blocked ? (
          <div className="callout">
            <Icon name="info" size={16} />
            <p>{blocked}</p>
          </div>
        ) : null}
        {d.systemEnabled && d.check.state === "ok" && d.check.warning === "keyframe-interval" ? (
          <div className="callout warn">
            <Icon name="alert" size={16} />
            <p>
              {d.check.keyframeIntervalSec
                ? `這台每 ${d.check.keyframeIntervalSec} 秒才有一張完整畫面（關鍵幀），超過 Apple 要求的 4 秒，安全錄影可能失敗。建議在攝影機設定裡把關鍵幀間隔（I-frame）調到 4 秒以內。`
                : "這台的完整畫面（關鍵幀）間隔超過 4 秒，安全錄影可能失敗。建議在攝影機設定裡把關鍵幀間隔（I-frame）調到 4 秒以內。"}
            </p>
          </div>
        ) : null}
        {on ? <StatusLine d={d} /> : null}
        {on && d.pairing && !d.pairing.paired && d.status !== "failed" ? (
          <div className="hk-pair">
            <div className="hk-qr-wrap">
              <QrCode payload={d.pairing.setupUri} />
            </div>
            <div className="hk-pair-text">
              <p className="hk-code-label">配對碼</p>
              <p className="hk-code" aria-label={`配對碼 ${d.pairing.code.replaceAll("-", "").split("").join(" ")}`}>
                {formatCode(d.pairing.code)}
              </p>
              <ol className="hk-steps">
                <li>打開「家庭」App，點右上角的 ＋，選「加入配件」。</li>
                <li>掃描這個 QR code。用同一支手機開這一頁時，改選「更多選項」，點這台攝影機，再輸入配對碼。</li>
                <li>出現「未認證的配件」時選「仍要加入」。</li>
              </ol>
            </div>
          </div>
        ) : null}
        {on && d.pairing && (d.pairing.paired || d.status === "failed") ? (
          <div className="hk-actions">
            <button
              className="btn small"
              type="button"
              disabled={busy}
              onClick={async () => {
                const ok = await confirmDialog("重設配對？", "家庭 App 裡的這台攝影機會失效，請先在家庭 App 移除它，再用新的配對碼重新加入。已錄在 CookieNVR 的影片不受影響。", { confirmLabel: "重設配對", danger: true });
                if (ok) act.mutate("reset");
              }}
            >
              <Icon name="refresh" size={15} />
              重設配對
            </button>
          </div>
        ) : null}
        <Requirements />
      </>
    );
  }

  return (
    <div className="panel-section">
      <header className="hk-head">
        <h3>
          Apple 家庭<span className="badge plain hk-beta">實驗性</span>
        </h3>
        <p>在 iPhone、iPad 或 Mac 的「家庭」App 裡看這台攝影機，有動作時收到通知。</p>
      </header>
      <div className="hk-body">{body}</div>
    </div>
  );
}
