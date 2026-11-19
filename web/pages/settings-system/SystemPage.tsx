import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { Settings } from "../../../src/types.ts";
import type { InfoDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { settingsQuery } from "../../data/queries.ts";
import { infoQuery } from "../../data/session.ts";
import { errMsg } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { SettingRow, SettingsGroup } from "../../ui/SettingRow.tsx";
import { ErrorBox, Spinner } from "../../ui/states.tsx";
import { Switch } from "../../ui/controls.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";
import { DecodeRow } from "./DecodeRow.tsx";
import { ObjectsGroup } from "./ObjectsGroup.tsx";

function More({ label, children }: { label: string; children: string }) {
  return (
    <details className="more">
      <summary>{label}</summary>
      <p>{children}</p>
    </details>
  );
}

function GeneralForm({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const saved = { name: settings.siteName, rtsp: settings.rtsp.externalEnabled, homekit: settings.homekit.enabled };
  const [name, setName] = useState(saved.name);
  const [rtsp, setRtsp] = useState(saved.rtsp);
  const [homekit, setHomekit] = useState(saved.homekit);
  const [error, setError] = useState("");
  const dirty = name.trim() !== saved.name || rtsp !== saved.rtsp || homekit !== saved.homekit;

  const save = useMutation({
    mutationFn: () => api.updateSettings({ siteName: name.trim(), rtsp: { externalEnabled: rtsp }, homekit: { ...settings.homekit, enabled: homekit } }),
    onError: (e) => setError(errMsg(e)),
    onSuccess: (res) => {
      qc.setQueryData(settingsQuery.queryKey, res);
      qc.setQueryData(infoQuery.queryKey, (i: InfoDto | undefined) => (i ? { ...i, siteName: res.siteName } : i));
      setName(res.siteName);
      toast("已儲存一般設定");
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!name.trim()) return setError("請填寫站點名稱");
    save.mutate();
  };

  return (
    <form className="set-form" noValidate onSubmit={submit}>
      <SettingsGroup
        foot={
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <Button variant="primary" type="submit" disabled={!dirty || save.isPending}>
              儲存變更
            </Button>
          </>
        }
      >
        <SettingRow
          title="站點名稱"
          desc="顯示在登入頁、側欄與瀏覽器分頁標題。"
          wide
          control={(a) => <input {...a} type="text" name="siteName" required maxLength={40} autoComplete="off" value={name} onChange={(e) => setName(e.currentTarget.value)} />}
        />
        <SettingRow
          title="讓其他 App 讀取攝影機畫面"
          toggle
          desc={
            <>
              開啟後，家裡其他裝置上的影音或智慧家庭 App 也能看到即時畫面。不影響錄影。
              <More label="怎麼使用？">
                每台攝影機的串流網址在「攝影機 → 編輯 → 進階設定」裡可以複製。像 VLC、Home Assistant 或另一套 NVR 這類 App 連線時，用你的帳號密碼，或在「帳號 → 連接其他 App」為它建立一組密鑰（API Token）。
              </More>
            </>
          }
          control={(a) => <Switch {...a} checked={rtsp} onChange={setRtsp} />}
        />
        <SettingRow
          title="Apple 家庭（實驗性）"
          toggle
          desc={
            <>
              讓攝影機加入 iPhone 的「家庭」App。開啟後，到每台攝影機的設定裡加入。
              <More label="使用前要知道">
                iPhone 是在家裡的網路上找到攝影機的，所以 CookieNVR 的容器要用 host 網路（或給它自己的區網 IP）。要收到動作通知、在外面看畫面，家裡要有當作家庭中樞的 Apple TV、HomePod 或 iPad；想讓 Apple 保存動作片段，還要有含安全錄影的 iCloud+ 方案。這是實驗性功能，畫質與錄影是否成功以實際使用為準。
              </More>
            </>
          }
          control={(a) => <Switch {...a} checked={homekit} onChange={setHomekit} />}
        />
      </SettingsGroup>
    </form>
  );
}

/** 設定 → 一般：站點名稱、其他 App 與 Apple 家庭的開關，下面是物件辨識與影像解碼 */
export function SystemPage() {
  const settings = useQuery(settingsQuery);
  let body;
  if (settings.isPending) body = <Spinner />;
  else if (settings.isError) body = <ErrorBox error={settings.error} onRetry={() => settings.refetch()} />;
  else
    body = (
      <div className="stack">
        <GeneralForm settings={settings.data} />
        <div>
          <ObjectsGroup settings={settings.data} />
          <DecodeRow settings={settings.data} />
        </div>
      </div>
    );
  return <SettingsLayout active="system">{body}</SettingsLayout>;
}
