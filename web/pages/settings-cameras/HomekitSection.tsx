import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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
  return codec ? codec.toUpperCase() : t`Unsupported format`;
}

function blockedReason(dto: HomekitDto): string | null {
  if (!dto.systemEnabled) return null;
  if (dto.check.state === "blocked") {
    const codec = codecName(dto.check.videoCodec);
    return dto.check.reason === "not-h264"
      ? t`This camera's main stream is ${codec}, but the Home app only supports H.264. Change the main stream to H.264 in the camera's app, then you can turn this on.`
      : t`The main stream has no video, so it can't be added.`;
  }
  if (dto.check.state === "unknown") return t`Can't read this camera's video right now. Turn this on after it connects.`;
  return null;
}

/** 設定列上的一句話：已加入、等待配對、未開啟… */
export function homekitSummary(dto: HomekitDto | undefined): string {
  if (!dto) return t`Checking…`;
  if (!dto.systemEnabled) return t`Off (turn it on first under Settings → General)`;
  if (!dto.enabled) return blockedReason(dto) && dto.check.state === "blocked" ? t`Can't add: video format not supported` : t`Off`;
  if (dto.pairing?.paired) return t`Added`;
  return dto.status === "failed" ? t`Couldn't start, reset pairing` : t`Waiting to be added in the Home app`;
}

function QrCode({ payload }: { payload: string }) {
  const { t } = useLingui();
  const matrix = encodeQr(payload, "M");
  const n = matrix.length;
  return (
    <svg className="hk-qr" viewBox={`-4 -4 ${n + 8} ${n + 8}`} role="img" aria-label={t`QR code for adding to Apple Home`} shapeRendering="crispEdges">
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
        <p>
          <Trans>The Home app couldn't find this camera. Go to Settings → Status and press "Copy diagnostics" to see why.</Trans>
        </p>
      </div>
    );
  }
  if (d.pairing?.paired) {
    return (
      <p className="hk-state ok">
        <Icon name="check" size={16} />
        <span>
          <Trans>
            <b>Added to Home.</b> You can watch video in the Home app and get motion notifications.
          </Trans>
        </span>
      </p>
    );
  }
  if (d.status === "starting") {
    return (
      <p className="hk-state">
        <span className="spin" aria-hidden="true" />
        <span>
          <Trans>Getting ready. You can add it in a few seconds…</Trans>
        </span>
      </p>
    );
  }
  return (
    <p className="hk-state wait">
      <span className="hk-dot" aria-hidden="true" />
      <span>
        <Trans>
          <b>Waiting to be added.</b> Scan the QR code below with your iPhone.
        </Trans>
      </span>
    </p>
  );
}

function Requirements() {
  const { t } = useLingui();
  return (
    <details className="more">
      <summary>{t`What do I need?`}</summary>
      <ul className="hk-needs">
        <li>
          <Trans>
            <b>Home hub:</b> You need an Apple TV, HomePod, or iPad at home acting as a home hub to get notified when motion is detected and to watch away from home.
          </Trans>
        </li>
        <li>
          <Trans>
            <b>iCloud+:</b> To have Apple store motion clips (Secure Video), you need an iCloud+ plan that includes it. Live video works without a subscription.
          </Trans>
        </li>
        <li>
          <Trans>
            <b>Network setup:</b> Your iPhone finds the camera on your home network, so the CookieNVR container needs host networking (or its own LAN IP).
          </Trans>
        </li>
        <li>{t`CookieNVR's own 24/7 recording is unaffected. Recording settings in the Home app only apply on Apple's side.`}</li>
      </ul>
    </details>
  );
}

/** 攝影機設定裡的「Apple 家庭」：開關、配對用的 QR code 與配對碼、重設配對。開關與重設直接生效，沒有另外的儲存 */
export function HomekitSection({ camera }: { camera: CameraDto }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const q = useQuery(homekitQuery(camera.id));
  const act = useMutation({
    mutationFn: (action: "enable" | "disable" | "reset") => api.homekitAction(camera.id, action),
    onSuccess: (dto, action) => {
      qc.setQueryData(homekitQuery(camera.id).queryKey, dto);
      if (action === "reset") toast(t`Pairing reset. Add it again with the new pairing code.`);
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
        <span className="spin" aria-hidden="true" /> {t`Checking this camera…`}
      </p>
    );
  } else {
    const d = q.data;
    const on = d.enabled && d.systemEnabled;
    const blocked = !d.enabled ? blockedReason(d) : null;
    const keyframeSec = d.check.state === "ok" ? d.check.keyframeIntervalSec : undefined;
    const spokenCode = d.pairing?.code.replaceAll("-", "").split("").join(" ") ?? "";
    body = (
      <>
        <SwitchRow title={t`Add to Apple Home`} desc={on ? undefined : t`Turning this on shows a QR code for pairing.`} checked={on} disabled={busy || !d.systemEnabled || (!d.enabled && blocked !== null)} onChange={(v) => act.mutate(v ? "enable" : "disable")} />
        {!d.systemEnabled ? (
          <p className="hk-muted">
            <Trans>
              Turn on "Apple Home" in{" "}
              <Link className="text-link" to="/settings/system">
                Settings → General
              </Link>{" "}
              first to use it here.
            </Trans>
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
                ? t`This camera sends a full frame (keyframe) only every ${keyframeSec} seconds, longer than the 4 seconds Apple requires, so Secure Video may fail. Set the keyframe interval (I-frame) to 4 seconds or less in the camera's settings.`
                : t`This camera's full-frame (keyframe) interval is longer than 4 seconds, so Secure Video may fail. Set the keyframe interval (I-frame) to 4 seconds or less in the camera's settings.`}
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
              <p className="hk-code-label">{t`Pairing code`}</p>
              <p className="hk-code" aria-label={t`Pairing code ${spokenCode}`}>
                {formatCode(d.pairing.code)}
              </p>
              <ol className="hk-steps">
                <li>{t`Open the Home app, tap + in the top right, and choose "Add Accessory".`}</li>
                <li>{t`Scan this QR code. If you opened this page on the same phone, choose "More Options", tap this camera, and enter the pairing code.`}</li>
                <li>{t`If "Uncertified Accessory" appears, choose "Add Anyway".`}</li>
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
                const ok = await confirmDialog(t`Reset pairing?`, t`This camera will stop working in the Home app. Remove it in the Home app first, then add it again with the new pairing code. Video already recorded in CookieNVR is not affected.`, { confirmLabel: t`Reset pairing`, danger: true });
                if (ok) act.mutate("reset");
              }}
            >
              <Icon name="refresh" size={15} />
              {t`Reset pairing`}
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
          Apple Home<span className="badge plain hk-beta">{t`Experimental`}</span>
        </h3>
        <p>{t`Watch this camera in the Home app on iPhone, iPad, or Mac, and get notified when there is motion.`}</p>
      </header>
      <div className="hk-body">{body}</div>
    </div>
  );
}
