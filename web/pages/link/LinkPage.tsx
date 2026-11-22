import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api } from "../../api.ts";
import { useMe, useSiteName } from "../../data/session.ts";
import { errMsg } from "../../format.ts";
import { isLocalAddress } from "../../link-address.ts";
import { tokensQuery } from "../settings-system/ConnectedApps.tsx";
import { Button, ButtonLink } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import type { IconName } from "../../ui/icons.ts";
import { BrandMark } from "../../ui/Panel.tsx";
import { Spinner } from "../../ui/states.tsx";

type View = "approved" | "denied" | "expired" | "used";

function Frame({ children }: { children: ReactNode }) {
  const siteName = useSiteName();
  return (
    <main className="auth link-page">
      <div className="brand">
        <BrandMark />
        <span>{siteName}</span>
      </div>
      <section className="card auth-card link-card">{children}</section>
    </main>
  );
}

function Outcome({ tone, icon, title, body }: { tone: "ok" | "bad" | "muted"; icon: IconName; title: string; body: string }) {
  const { t } = useLingui();
  return (
    <Frame>
      <div className="link-outcome" data-tone={tone} role="status">
        <span className="link-outcome-ico">
          <Icon name={icon} size={26} />
        </span>
        <h1 className="auth-title">{title}</h1>
        <p>{body}</p>
      </div>
      <ButtonLink to="/cameras">{t`Go to CookieNVR`}</ButtonLink>
    </Frame>
  );
}

function CodeEntry({ error }: { error?: string }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState(error ?? "");
  useEffect(() => setErr(error ?? ""), [error]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = input.current!.value.toUpperCase().replace(/[^A-Z]/g, "");
    if (code.length !== 8) return setErr(t`The code is 8 letters`);
    void navigate({
      to: "/link/$code",
      params: { code: `${code.slice(0, 4)}-${code.slice(4)}` },
    });
  };
  return (
    <Frame>
      <header>
        <h1 className="auth-title">{t`Enter the connection code`}</h1>
        <p>{t`The code is shown on the screen of the app you want to connect, such as Home Assistant.`}</p>
      </header>
      <form className="form" noValidate onSubmit={submit}>
        <input
          ref={input}
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={12}
          placeholder="XXXX-XXXX"
          className="link-code-input"
          aria-label={t`Connection code`}
          autoFocus
        />
        <p className="form-error" role="alert">
          {err}
        </p>
        <Button variant="primary" type="submit">
          {t`Continue`}
        </Button>
      </form>
    </Frame>
  );
}

function minutesLeft(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s >= 60) {
    const minutes = Math.ceil(s / 60);
    return plural(minutes, {
      one: "Valid for # minute",
      other: "Valid for # minutes",
    });
  }
  return plural(s, { one: "Valid for # second", other: "Valid for # seconds" });
}

function Ask({ code, app, ip, expiresIn, onDone }: { code: string; app: string; ip: string; expiresIn: number; onDone: (v: View) => void }) {
  const { t } = useLingui();
  const me = useMe();
  // 用 NVR 給的剩餘秒數在本機倒數，瀏覽器時鐘不準也不影響
  const [deadline] = useState(() => Date.now() + expiresIn * 1000);
  const [left, setLeft] = useState(expiresIn);
  const [error, setError] = useState("");
  // 頁面剛出現時先停用按鈕一下，避免被誘導連點時第二下剛好落在「允許」
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 600);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      const s = Math.round((deadline - Date.now()) / 1000);
      if (s <= 0) onDone("expired");
      else setLeft(s);
    }, 1000);
    return () => clearInterval(t);
  }, [deadline, onDone]);

  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (d: "approve" | "deny") => api.decideLink(code, d).then(() => d),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: tokensQuery.queryKey });
      onDone(d === "approve" ? "approved" : "denied");
    },
    meta: { handlesError: true },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 410) return onDone("expired");
      if (e instanceof ApiError && e.status === 409) return onDone("used");
      setError(errMsg(e));
    },
  });
  const spelledCode = code.split("").join(" ");
  const username = me.username;
  const disabled = !armed || decide.isPending;
  const act = (d: "approve" | "deny") => {
    setError("");
    decide.mutate(d);
  };
  return (
    <Frame>
      <header>
        <h1 className="auth-title">{t`Allow ${app} to connect?`}</h1>
      </header>
      <div className="link-code">
        <p>{t`Make sure this matches the code on the ${app} screen`}</p>
        <output className="link-code-value" translate="no" aria-label={t`Code ${spelledCode}`}>
          {code}
        </output>
      </div>
      <div className="link-grants">
        <p>{t`If you allow it, ${app} will act as ${username} and can:`}</p>
        <ul>
          <li>
            <Icon name="camera" size={16} />
            {t`See the picture and recordings of every camera`}
          </li>
          <li>
            <Icon name="activity" size={16} />
            {t`Get notified when something moves`}
          </li>
          <li>
            <Icon name="crosshair" size={16} />
            {t`Move cameras that can pan and tilt`}
          </li>
          <li>
            <Icon name="settings" size={16} />
            {t`Turn recording and detection on or off, and change every setting (the same as your admin account)`}
          </li>
        </ul>
      </div>
      <p className="link-source">
        <Icon name="globe" size={16} />
        <span>
          <Trans>
            Request from <b translate="no">{ip}</b>
          </Trans>
        </span>
      </p>
      {isLocalAddress(ip) ? null : (
        <div className="callout warn">
          <Icon name="alert" />
          <p>{t`This request didn't come from your home network. Unless you're sure about it, choose Deny.`}</p>
        </div>
      )}
      <p className="form-error" role="alert">
        {error}
      </p>
      <div className="link-actions">
        <Button disabled={disabled} onClick={() => act("deny")}>
          {t`Deny`}
        </Button>
        <Button variant="primary" disabled={disabled} onClick={() => act("approve")}>
          {t`Allow`}
        </Button>
      </div>
      <p className="link-meta">
        <span>{minutesLeft(left)}</span>
        <br />
        {t`If you didn't just start this in ${app}, choose Deny.`}
      </p>
    </Frame>
  );
}

function Request({ code }: { code: string }) {
  const { t } = useLingui();
  const me = useMe();
  const q = useQuery({
    queryKey: ["link", code],
    queryFn: () => api.linkRequest(code),
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [view, setView] = useState<View | null>(null);
  if (q.isPending)
    return (
      <Frame>
        <Spinner />
      </Frame>
    );
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) return <CodeEntry error={t`We couldn't find that code. It may have been mistyped or expired.`} />;
    return (
      <Frame>
        <div className="link-outcome" data-tone="bad" role="alert">
          <h1 className="auth-title">{t`Can't open this right now`}</h1>
          <p>{errMsg(q.error)}</p>
        </div>
        <Button icon="refresh" onClick={() => void q.refetch()}>
          {t`Reload`}
        </Button>
      </Frame>
    );
  }
  const req = q.data;
  const app = req.app;
  const state: View | "ask" = view ?? (req.status === "pending" ? "ask" : req.status === "denied" ? "denied" : req.status === "expired" ? "expired" : "used");
  switch (state) {
    case "ask":
      if (me.role !== "admin")
        return (
          <Outcome
            tone="muted"
            icon="lock"
            title={t`Admin account required`}
            body={t`Only admins can allow ${app} to connect. Sign in with an admin account, then open this page again.`}
          />
        );
      return <Ask code={code} app={req.app} ip={req.ip} expiresIn={req.expiresIn} onDone={setView} />;
    case "approved":
      return (
        <Outcome
          tone="ok"
          icon="check"
          title={t`Allowed`}
          body={t`Go back to ${app} and it will finish setting up on its own. You can revoke access at any time in Settings → General → Connect other apps.`}
        />
      );
    case "denied":
      return <Outcome tone="muted" icon="x" title={t`Denied`} body={t`${app} won't connect to CookieNVR.`} />;
    case "used":
      return <Outcome tone="ok" icon="check" title={t`This request is already done`} body={t`${app} is already connected. There's nothing more to do.`} />;
    case "expired":
      return <Outcome tone="muted" icon="clock" title={t`This request has expired`} body={t`Go back to ${app} and start again to get a new code.`} />;
  }
}

/** 核准頁：其他 App（例如 Home Assistant）要求連線時，使用者在這裡對照代碼後允許或拒絕 */
export function LinkPage({ code }: { code?: string }) {
  const { t } = useLingui();
  // 被其他網站用 iframe 嵌入時不顯示按鈕，避免點擊劫持
  if (window.top !== window.self)
    return (
      <Frame>
        <header>
          <h1 className="auth-title">{t`Open this page directly`}</h1>
          <p>{t`For security, connection requests can only be approved in CookieNVR's own tab.`}</p>
        </header>
        <a className="btn primary" href={location.href} target="_blank" rel="noopener">
          {t`Open in a new tab`}
        </a>
      </Frame>
    );
  return code ? <Request key={code} code={code} /> : <CodeEntry />;
}
