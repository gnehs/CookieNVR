import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import type { MeDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { infoQuery, meQuery } from "../../data/session.ts";
import { errMsg } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { BrandMark } from "../../ui/Panel.tsx";

function AuthForm(props: { title: string; intro?: string; submitLabel: string; confirm: boolean; onSubmit: (username: string, password: string) => Promise<void> }) {
  const siteName = useQuery(infoQuery).data?.siteName ?? "CookieNVR";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const u = username.current!.value.trim();
    const p = password.current!.value;
    if (!u || !p) return setError("請輸入帳號與密碼");
    if (props.confirm) {
      if (p.length < 8) {
        setError("密碼至少 8 個字元");
        return password.current!.focus();
      }
      if (p !== confirm.current!.value) {
        setError("兩次輸入的密碼不一致");
        return confirm.current!.focus();
      }
    }
    setBusy(true);
    try {
      await props.onSubmit(u, p);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <div className="brand">
        <BrandMark />
        <span>{siteName}</span>
      </div>
      <section className="card auth-card">
        <header>
          <h1 className="auth-title">{props.title}</h1>
          {props.intro ? <p>{props.intro}</p> : null}
        </header>
        <form className="form" noValidate onSubmit={submit}>
          <Field label="帳號">
            <input ref={username} type="text" autoComplete="username" required autoCapitalize="off" spellCheck={false} autoFocus />
          </Field>
          <Field label="密碼" hint={props.confirm ? "至少 8 個字元" : undefined}>
            <input ref={password} type="password" autoComplete={props.confirm ? "new-password" : "current-password"} required minLength={props.confirm ? 8 : undefined} />
          </Field>
          {props.confirm ? (
            <Field label="再次輸入密碼">
              <input ref={confirm} type="password" autoComplete="new-password" required />
            </Field>
          ) : null}
          <p className="form-error" role="alert">
            {error}
          </p>
          <Button variant="primary" type="submit" disabled={busy}>
            {props.submitLabel}
          </Button>
        </form>
      </section>
    </main>
  );
}

function useSignedIn() {
  const qc = useQueryClient();
  return (me: MeDto) => qc.setQueryData(meQuery.queryKey, me);
}

export function LoginPage() {
  const { next } = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const target = next ?? "/cameras";
  return (
    <AuthForm
      title="登入"
      intro={target.startsWith("/link") ? "登入後就能核准連線請求。" : undefined}
      submitLabel="登入"
      confirm={false}
      onSubmit={async (u, p) => {
        signedIn(await api.login(u, p));
        await navigate({ href: target });
      }}
    />
  );
}

export function SetupPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  return (
    <AuthForm
      title="歡迎"
      intro="第一次使用，先建立管理員帳號，接著就能加入攝影機。"
      submitLabel="建立帳號"
      confirm
      onSubmit={async (u, p) => {
        signedIn(await api.setup(u, p));
        await qc.fetchQuery({ ...infoQuery, staleTime: 0 });
        await navigate({ to: "/welcome" });
      }}
    />
  );
}
