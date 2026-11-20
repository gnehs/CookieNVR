import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { camerasQuery } from "../../data/queries.ts";
import { ButtonLink } from "../../ui/Button.tsx";
import { EmptyState, ErrorBox, Spinner } from "../../ui/states.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";
import { CameraLayoutEditor } from "./CameraLayoutEditor.tsx";
import { useDeleteCamera } from "./useDeleteCamera.tsx";

/** 設定 → 攝影機：清單跟著全站的攝影機快取（SSE 更新），不另外輪詢；分區與排序在 CameraLayoutEditor */
export function CamerasListPage() {
  const { t } = useLingui();
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
              title={t`No cameras yet`}
              body={t`Works with Tapo and any camera that supports RTSP. Once added, it starts recording automatically.`}
              icon="camera"
              action={
                <ButtonLink to="/settings/cameras/new" variant="primary" icon="plus">
                  {t`Add camera`}
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
