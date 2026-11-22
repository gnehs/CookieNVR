import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { Settings } from "../../../src/types.ts";
import type { InfoDto } from "../../../src/api-types.ts";
import { settingsQuery } from "../../data/queries.ts";
import { infoQuery } from "../../data/session.ts";
import { useUpdateSettings } from "../../data/use-update-settings.ts";
import { errMsg } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { SettingRow, SettingsGroup } from "../../ui/SettingRow.tsx";
import { ErrorBox, Spinner } from "../../ui/states.tsx";
import { Switch } from "../../ui/controls.tsx";
import { toast } from "../../ui/toast.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";
import { ConnectedApps } from "./ConnectedApps.tsx";
import { DecodeRow } from "./DecodeRow.tsx";

function More({ label, children }: { label: string; children: string }) {
  return (
    <details className="more">
      <summary>{label}</summary>
      <p>{children}</p>
    </details>
  );
}

function GeneralForm({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const saved = { name: settings.siteName, rtsp: settings.rtsp.externalEnabled, homekit: settings.homekit.enabled };
  const [name, setName] = useState(saved.name);
  const [rtsp, setRtsp] = useState(saved.rtsp);
  const [homekit, setHomekit] = useState(saved.homekit);
  const [error, setError] = useState("");
  const dirty = name.trim() !== saved.name || rtsp !== saved.rtsp || homekit !== saved.homekit;

  const save = useUpdateSettings({
    meta: { handlesError: true },
    onError: (e) => setError(errMsg(e)),
    onSuccess: (res) => {
      qc.setQueryData(infoQuery.queryKey, (i: InfoDto | undefined) => (i ? { ...i, siteName: res.siteName } : i));
      setName(res.siteName);
      toast(t`General settings saved`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!name.trim()) return setError(t`Enter a site name`);
    save.mutate({ siteName: name.trim(), rtsp: { externalEnabled: rtsp }, homekit: { ...settings.homekit, enabled: homekit } });
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
              {t`Save changes`}
            </Button>
          </>
        }
      >
        <SettingRow
          title={t`Site name`}
          desc={t`Shown on the sign-in page, in the sidebar and in the browser tab title.`}
          wide
          control={(a) => <input {...a} type="text" name="siteName" required maxLength={40} autoComplete="off" value={name} onChange={(e) => setName(e.currentTarget.value)} />}
        />
        <SettingRow
          title={t`Let other apps read camera video`}
          toggle
          desc={
            <>
              {t`Once on, media and smart home apps on other devices at home can also see the live picture. Recording is not affected.`}
              <More label={t`How do I use it?`}>
                {t`Each camera's stream URL can be copied under "Cameras → Edit → Advanced". When an app such as VLC, Home Assistant or another NVR connects, use your username and password, or create a key (API token) for it under "Settings → General → Connect other apps".`}
              </More>
            </>
          }
          control={(a) => <Switch {...a} checked={rtsp} onChange={setRtsp} />}
        />
        <SettingRow
          title={t`Apple Home (experimental)`}
          toggle
          desc={
            <>
              {t`Lets cameras join the Home app on iPhone. After turning it on, add each camera in its own settings.`}
              <More label={t`Before you use it`}>
                {t`iPhone finds cameras on your home network, so the CookieNVR container needs host networking (or its own LAN IP). To get motion notifications and watch away from home, you need an Apple TV, HomePod or iPad acting as a home hub; to have Apple store motion clips, you also need an iCloud+ plan with HomeKit Secure Video. This is an experimental feature, so video quality and whether recording works depend on real-world use.`}
              </More>
            </>
          }
          control={(a) => <Switch {...a} checked={homekit} onChange={setHomekit} />}
        />
      </SettingsGroup>
    </form>
  );
}

/** 設定 → 一般：站點名稱、其他 App 與 Apple 家庭的開關、連接其他 App 與影像解碼 */
export function SystemPage() {
  const settings = useQuery(settingsQuery);
  let body;
  if (settings.isPending) body = <Spinner />;
  else if (settings.isError) body = <ErrorBox error={settings.error} onRetry={() => settings.refetch()} />;
  else
    body = (
      <div className="stack">
        <GeneralForm settings={settings.data} />
        <ConnectedApps />
        <DecodeRow settings={settings.data} />
      </div>
    );
  return <SettingsLayout active="system">{body}</SettingsLayout>;
}
