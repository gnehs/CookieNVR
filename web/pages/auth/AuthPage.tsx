import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import type { MeDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { infoQuery, meQuery, useSiteName } from "../../data/session.ts";
import { errMsg } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { BrandMark } from "../../ui/Panel.tsx";

function AuthForm(props: { title: string; intro?: string; submitLabel: string; confirm: boolean; onSubmit: (username: string, password: string) => Promise<void> }) {
  const { t } = useLingui();
  const siteName = useSiteName();
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
    if (!u || !p) return setError(t`Enter a username and password`);
    if (props.confirm) {
      if (p.length < 8) {
        setError(t`Password must be at least 8 characters`);
        return password.current!.focus();
      }
      if (p !== confirm.current!.value) {
        setError(t`The two passwords don't match`);
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
          <Field label={t`Username`}>
            <input ref={username} type="text" autoComplete="username" required autoCapitalize="off" spellCheck={false} autoFocus />
          </Field>
          <Field label={t`Password`} hint={props.confirm ? t`At least 8 characters` : undefined}>
            <input ref={password} type="password" autoComplete={props.confirm ? "new-password" : "current-password"} required minLength={props.confirm ? 8 : undefined} />
          </Field>
          {props.confirm ? (
            <Field label={t`Confirm password`}>
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
  const { t } = useLingui();
  const { next } = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const target = next ?? "/cameras";
  return (
    <AuthForm
      title={t`Sign in`}
      intro={target.startsWith("/link") ? t`Sign in to approve the connection request.` : undefined}
      submitLabel={t`Sign in`}
      confirm={false}
      onSubmit={async (u, p) => {
        signedIn(await api.login(u, p));
        await navigate({ href: target });
      }}
    />
  );
}

export function SetupPage() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  return (
    <AuthForm
      title={t`Welcome`}
      intro={t`First time here? Create an admin account, then you can add cameras.`}
      submitLabel={t`Create account`}
      confirm
      onSubmit={async (u, p) => {
        signedIn(await api.setup(u, p));
        await qc.fetchQuery({ ...infoQuery, staleTime: 0 });
        await navigate({ to: "/welcome" });
      }}
    />
  );
}
