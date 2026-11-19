import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api } from "../../api.ts";
import { infoQuery } from "../../data/session.ts";
import { useMe } from "../../data/session.ts";
import { errMsg } from "../../format.ts";
import { isLocalAddress } from "../../link-address.ts";
import { Button, ButtonLink } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import type { IconName } from "../../ui/icons.ts";
import { BrandMark } from "../../ui/Panel.tsx";
import { Spinner } from "../../ui/states.tsx";

type View = "approved" | "denied" | "expired" | "used";

function Frame({ children }: { children: ReactNode }) {
  const siteName = useQuery(infoQuery).data?.siteName ?? "CookieNVR";
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
  return (
    <Frame>
      <div className="link-outcome" data-tone={tone} role="status">
        <span className="link-outcome-ico">
          <Icon name={icon} size={26} />
        </span>
        <h1 className="auth-title">{title}</h1>
        <p>{body}</p>
      </div>
      <ButtonLink to="/cameras">前往 CookieNVR</ButtonLink>
    </Frame>
  );
}

function CodeEntry({ error }: { error?: string }) {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState(error ?? "");
  useEffect(() => setErr(error ?? ""), [error]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = input.current!.value.toUpperCase().replace(/[^A-Z]/g, "");
    if (code.length !== 8) return setErr("代碼是 8 個英文字母");
    void navigate({ to: "/link/$code", params: { code: `${code.slice(0, 4)}-${code.slice(4)}` } });
  };
  return (
    <Frame>
      <header>
        <h1 className="auth-title">輸入連線代碼</h1>
        <p>代碼顯示在要連線的 App（例如 Home Assistant）畫面上。</p>
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
          aria-label="連線代碼"
          autoFocus
        />
        <p className="form-error" role="alert">
          {err}
        </p>
        <Button variant="primary" type="submit">
          繼續
        </Button>
      </form>
    </Frame>
  );
}

function minutesLeft(seconds: number): string {
  const s = Math.max(0, seconds);
  return s >= 60 ? `${Math.ceil(s / 60)} 分鐘內有效` : `${s} 秒內有效`;
}

function Ask({ code, app, ip, expiresIn, onDone }: { code: string; app: string; ip: string; expiresIn: number; onDone: (v: View) => void }) {
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
      void qc.invalidateQueries({ queryKey: ["tokens"] });
      onDone(d === "approve" ? "approved" : "denied");
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 410) return onDone("expired");
      if (e instanceof ApiError && e.status === 409) return onDone("used");
      setError(errMsg(e));
    },
  });
  const disabled = !armed || decide.isPending;
  const act = (d: "approve" | "deny") => {
    setError("");
    decide.mutate(d);
  };
  const isAdmin = me.role === "admin";
  return (
    <Frame>
      <header>
        <h1 className="auth-title">允許「{app}」連線？</h1>
      </header>
      <div className="link-code">
        <p>確認和 {app} 畫面上的代碼一樣</p>
        <output className="link-code-value" translate="no" aria-label={`代碼 ${code.split("").join(" ")}`}>
          {code}
        </output>
      </div>
      <div className="link-grants">
        <p>
          允許後，{app} 會以「{me.username}」的身分：
        </p>
        <ul>
          <li>
            <Icon name="camera" size={16} />
            看到所有攝影機的畫面和錄影
          </li>
          <li>
            <Icon name="activity" size={16} />
            在有動靜時收到通知
          </li>
          <li>
            <Icon name="crosshair" size={16} />
            轉動可以轉的鏡頭
          </li>
          {isAdmin ? (
            <li>
              <Icon name="settings" size={16} />
              開關錄影與偵測，也能變更所有設定（和你的管理員帳號一樣）
            </li>
          ) : (
            <li className="link-grant-no">
              <Icon name="lock" size={16} />
              錄影與偵測開關不會出現（需要管理員帳號）
            </li>
          )}
        </ul>
      </div>
      <p className="link-source">
        <Icon name="globe" size={16} />
        <span>
          請求來自 <b translate="no">{ip}</b>
        </span>
      </p>
      {isLocalAddress(ip) ? null : (
        <div className="callout warn">
          <Icon name="alert" />
          <p>這個請求不是從你家裡的網路送出的。除非你很確定，否則請按拒絕。</p>
        </div>
      )}
      <p className="form-error" role="alert">
        {error}
      </p>
      <div className="link-actions">
        <Button disabled={disabled} onClick={() => act("deny")}>
          拒絕
        </Button>
        <Button variant="primary" disabled={disabled} onClick={() => act("approve")}>
          允許
        </Button>
      </div>
      <p className="link-meta">
        <span>{minutesLeft(left)}</span>
        <br />
        如果不是你剛剛在 {app} 裡按的，請按拒絕。
      </p>
    </Frame>
  );
}

function Request({ code }: { code: string }) {
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
    if (q.error instanceof ApiError && q.error.status === 404) return <CodeEntry error="找不到這組代碼，可能打錯了或已經過期" />;
    return (
      <Frame>
        <div className="link-outcome" data-tone="bad" role="alert">
          <h1 className="auth-title">這裡暫時打不開</h1>
          <p>{errMsg(q.error)}</p>
        </div>
        <Button icon="refresh" onClick={() => void q.refetch()}>
          重新載入
        </Button>
      </Frame>
    );
  }
  const req = q.data;
  const state: View | "ask" = view ?? (req.status === "pending" ? "ask" : req.status === "denied" ? "denied" : req.status === "expired" ? "expired" : "used");
  switch (state) {
    case "ask":
      return <Ask code={code} app={req.app} ip={req.ip} expiresIn={req.expiresIn} onDone={setView} />;
    case "approved":
      return <Outcome tone="ok" icon="check" title="已允許" body={`回到 ${req.app}，它會自動完成設定。之後可以在「帳號 → 連接其他 App」隨時撤銷。`} />;
    case "denied":
      return <Outcome tone="muted" icon="x" title="已拒絕" body={`${req.app} 不會連線到 CookieNVR。`} />;
    case "used":
      return <Outcome tone="ok" icon="check" title="這個請求已經完成" body={`${req.app} 已經連線了，不需要再做什麼。`} />;
    case "expired":
      return <Outcome tone="muted" icon="clock" title="這個請求已經過期" body={`回到 ${req.app} 重新開始，會拿到一組新的代碼。`} />;
  }
}

/** 核准頁：其他 App（例如 Home Assistant）要求連線時，使用者在這裡對照代碼後允許或拒絕 */
export function LinkPage({ code }: { code?: string }) {
  // 被其他網站用 iframe 嵌入時不顯示按鈕，避免點擊劫持
  if (window.top !== window.self)
    return (
      <Frame>
        <header>
          <h1 className="auth-title">請直接開啟這個頁面</h1>
          <p>為了安全，連線請求只能在 CookieNVR 自己的分頁裡核准。</p>
        </header>
        <a className="btn primary" href={location.href} target="_blank" rel="noopener">
          在新分頁開啟
        </a>
      </Frame>
    );
  return code ? <Request key={code} code={code} /> : <CodeEntry />;
}
