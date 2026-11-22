import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api } from "../../api.ts";
import { errMsg } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { Panel, PanelSection } from "../../ui/Panel.tsx";
import { toast } from "../../ui/toast.tsx";

export function PasswordPanel() {
  const { t } = useLingui();
  const form = useRef<HTMLFormElement>(null);
  const cur = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLInputElement>(null);
  const again = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const change = useMutation({
    mutationFn: (v: { current: string; next: string }) => api.changePassword(v.current, v.next),
    onSuccess: () => {
      form.current?.reset();
      toast(t`Password changed`);
    },
    meta: { handlesError: true },
    onError: (e) => setError(errMsg(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const c = cur.current!.value;
    const n = next.current!.value;
    if (!c) return setError(t`Enter your current password`);
    if (n.length < 8) return setError(t`The new password must be at least 8 characters`);
    if (n !== again.current!.value) return setError(t`The two new passwords don't match`);
    change.mutate({ current: c, next: n });
  };

  return (
    <form ref={form} onSubmit={submit}>
      <Panel
        title={t`Change password`}
        foot={
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <Button variant="primary" type="submit" disabled={change.isPending}>
              {t`Update password`}
            </Button>
          </>
        }
      >
        <PanelSection>
          <div className="form narrow">
            <Field label={t`Current password`}>
              <input ref={cur} type="password" autoComplete="current-password" required />
            </Field>
            <Field label={t`New password`} hint={t`At least 8 characters. Other devices will need to sign in again after you change it.`}>
              <input ref={next} type="password" autoComplete="new-password" required minLength={8} />
            </Field>
            <Field label={t`Confirm new password`}>
              <input ref={again} type="password" autoComplete="new-password" required />
            </Field>
          </div>
        </PanelSection>
      </Panel>
    </form>
  );
}
