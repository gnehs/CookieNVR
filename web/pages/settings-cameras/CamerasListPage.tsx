import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CameraDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { camerasQuery } from "../../data/queries.ts";
import { errMsg } from "../../format.ts";
import { cameraStatus } from "../../health.ts";
import { ButtonLink } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { MenuButton } from "../../ui/Menu.tsx";
import { Badge } from "../../ui/Panel.tsx";
import { EmptyState, ErrorBox, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";
import { useDeleteCamera } from "./useDeleteCamera.tsx";

/** 存檔後馬上換掉快取裡的這台（SSE 之後也會推同樣的內容），首頁、側欄與清單不用等 */
export function putCamera(qc: QueryClient, cam: CameraDto): void {
  qc.setQueryData(camerasQuery.queryKey, (list) => (!list ? list : list.some((c) => c.id === cam.id) ? list.map((c) => (c.id === cam.id ? cam : c)) : [...list, cam]));
}

function Row({ cam, onRemove }: { cam: CameraDto; onRemove: (cam: CameraDto) => void }) {
  const qc = useQueryClient();
  const c = cam.config;
  const st = cameraStatus(cam);
  const toggle = async () => {
    try {
      putCamera(qc, await api.updateCamera(cam.id, { ...c, enabled: !c.enabled }));
      toast(c.enabled ? `已停用「${c.name}」` : `已啟用「${c.name}」`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  return (
    <div className="row-item cam-row" role="listitem">
      {/* 整列都能點進編輯：連結的 ::after 蓋住整列，選單按鈕疊在上面 */}
      <Link className="row-main row-link stretch" to="/settings/cameras/$id" params={{ id: cam.id }}>
        <span className="row-ico">
          <Icon name={c.connection.type === "tapo" ? "tapo" : "link"} size={18} />
        </span>
        <span className="row-text">
          <b className="truncate">{c.name}</b>
        </span>
      </Link>
      <Badge kind={st.tone}>{st.label}</Badge>
      <div className="row-actions">
        <MenuButton
          label={`「${c.name}」的更多動作`}
          items={[
            { label: c.enabled ? "停用" : "啟用", icon: "power", onSelect: () => void toggle() },
            { label: "刪除", icon: "trash", danger: true, onSelect: () => onRemove(cam) },
          ]}
        />
      </div>
    </div>
  );
}

/** 設定 → 攝影機：清單跟著全站的攝影機快取（SSE 更新），不另外輪詢 */
export function CamerasListPage() {
  const cams = useQuery(camerasQuery);
  const del = useDeleteCamera();
  const list = cams.data;
  return (
    <SettingsLayout active="cameras">
      <div>
        <div className="list-toolbar" hidden={!list || list.length === 0}>
          <span className="hint num">{list?.length ? `共 ${list.length} 台` : ""}</span>
          <ButtonLink to="/settings/cameras/new" variant="primary" small icon="plus" iconSize={15}>
            新增攝影機
          </ButtonLink>
        </div>
        <div>
          {cams.isPending ? (
            <Spinner />
          ) : cams.isError ? (
            <ErrorBox error={cams.error} onRetry={() => void cams.refetch()} />
          ) : list!.length === 0 ? (
            <EmptyState
              title="還沒有攝影機"
              body="支援 Tapo 與任何有 RTSP 的攝影機，加入後就會自動開始錄影。"
              icon="camera"
              action={
                <ButtonLink to="/settings/cameras/new" variant="primary" icon="plus">
                  新增攝影機
                </ButtonLink>
              }
            />
          ) : (
            <div className="card row-list" role="list">
              {list!.map((c) => (
                <Row key={c.id} cam={c} onRemove={(cam) => void del.remove(cam)} />
              ))}
            </div>
          )}
        </div>
      </div>
      {del.dialog}
    </SettingsLayout>
  );
}
