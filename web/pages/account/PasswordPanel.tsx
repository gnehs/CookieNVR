import { useMutation } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api } from "../../api.ts";
import { errMsg } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { Panel, PanelSection } from "../../ui/Panel.tsx";
import { toast } from "../../ui/toast.tsx";

export function PasswordPanel() {
  const form = useRef<HTMLFormElement>(null);
  const cur = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLInputElement>(null);
  const again = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const change = useMutation({
    mutationFn: (v: { current: string; next: string }) => api.changePassword(v.current, v.next),
    onSuccess: () => {
      form.current?.reset();
      toast("已變更密碼");
    },
    onError: (e) => setError(errMsg(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const c = cur.current!.value;
    const n = next.current!.value;
    if (!c) return setError("請輸入目前密碼");
    if (n.length < 8) return setError("新密碼至少要 8 個字元");
    if (n !== again.current!.value) return setError("兩次輸入的新密碼不一致");
    change.mutate({ current: c, next: n });
  };

  return (
    <form ref={form} onSubmit={submit}>
      <Panel
        title="變更密碼"
        foot={
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <Button variant="primary" type="submit" disabled={change.isPending}>
              更新密碼
            </Button>
          </>
        }
      >
        <PanelSection>
          <div className="form narrow">
            <Field label="目前密碼">
              <input ref={cur} type="password" autoComplete="current-password" required />
            </Field>
            <Field label="新密碼" hint="至少 8 個字元。變更後，其他裝置需要重新登入。">
              <input ref={next} type="password" autoComplete="new-password" required minLength={8} />
            </Field>
            <Field label="再次輸入新密碼">
              <input ref={again} type="password" autoComplete="new-password" required />
            </Field>
          </div>
        </PanelSection>
      </Panel>
    </form>
  );
}
