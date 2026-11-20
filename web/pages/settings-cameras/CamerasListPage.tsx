import { useQuery } from "@tanstack/react-query";
import { camerasQuery } from "../../data/queries.ts";
import { ButtonLink } from "../../ui/Button.tsx";
import { EmptyState, ErrorBox, Spinner } from "../../ui/states.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";
import { CameraLayoutEditor } from "./CameraLayoutEditor.tsx";
import { useDeleteCamera } from "./useDeleteCamera.tsx";

/** 設定 → 攝影機：清單跟著全站的攝影機快取（SSE 更新），不另外輪詢；分區與排序在 CameraLayoutEditor */
export function CamerasListPage() {
  const cams = useQuery(camerasQuery);
  const del = useDeleteCamera();
  const list = cams.data;
  return (
    <SettingsLayout active="cameras">
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
            <CameraLayoutEditor cams={list!} onRemove={(cam) => void del.remove(cam)} />
          )}
      </div>
      {del.dialog}
    </SettingsLayout>
  );
}
