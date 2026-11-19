import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import type { CreatedTokenDto } from "../../../src/api-types.ts";
import { api } from "../../api.ts";
import { errMsg, formatAgo } from "../../format.ts";
import { Button, CopyButton } from "../../ui/Button.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { Field } from "../../ui/Field.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { ErrorBox, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";

export const tokensQuery = queryOptions({ queryKey: ["tokens"], queryFn: api.tokens });

function TokenList() {
  const qc = useQueryClient();
  const q = useQuery(tokensQuery);
  const revoke = useMutation({
    mutationFn: (t: { id: number; name: string }) => api.revokeToken(t.id).then(() => t.name),
    onSuccess: (name) => {
      toast(`已撤銷「${name}」`);
      return qc.invalidateQueries({ queryKey: tokensQuery.queryKey });
    },
    onError: (e) => toast(errMsg(e), "error"),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.length === 0)
    return (
      <p className="muted" style={{ padding: "16px 22px" }}>
        還沒有連接任何 App。
      </p>
    );
  return (
    <div className="row-list">
      {q.data.map((t) => (
        <div className="row-item" key={t.id}>
          <div className="row-main">
            <span className="row-ico">
              <Icon name="key" size={18} />
            </span>
            <div className="row-text">
              <b>{t.name}</b>
              <small>{t.lastUsedAt ? `上次使用 ${formatAgo(t.lastUsedAt)}` : `${formatAgo(t.createdAt)}建立，還沒用過`}</small>
            </div>
          </div>
          <Button
            small
            variant="danger"
            icon="trash"
            iconSize={15}
            onClick={async () => {
              if (!(await confirmDialog(`撤銷「${t.name}」？`, "用這組密鑰連線的 App 會立刻無法存取。", { confirmLabel: "撤銷", danger: true }))) return;
              revoke.mutate({ id: t.id, name: t.name });
            }}
          >
            撤銷
          </Button>
        </div>
      ))}
    </div>
  );
}

// 大多數人用不到，預設收合；技術名稱（API Token）只出現在說明的最後
export function ConnectedApps() {
  const qc = useQueryClient();
  const name = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedTokenDto | null>(null);
  const create = useMutation({
    mutationFn: (n: string) => api.createToken(n),
    onSuccess: (t) => {
      name.current!.value = "";
      setCreated(t);
      return qc.invalidateQueries({ queryKey: tokensQuery.queryKey });
    },
    onError: (e) => setError(errMsg(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const n = name.current!.value.trim();
    if (!n) {
      name.current!.focus();
      return setError("請寫下要連接的 App 名稱");
    }
    create.mutate(n);
  };

  return (
    <details className="card disclosure connect-apps">
      <summary>
        <Icon name="chevron" size={16} />
        連接其他 App
        <small>例如 Home Assistant</small>
      </summary>
      <div className="disclosure-body">
        <p className="hint">
          Home Assistant 會自己找到 CookieNVR，在它那邊按「增加」後回到這裡按「允許」就好。其他 App 可以在這裡建立一組專用的密鑰，權限和你的帳號相同。下面列出所有連線中的 App，不用時可以隨時撤銷。（技術上稱為 API Token）
        </p>
        <div aria-live="polite">
          {created ? (
            <div className="callout warn">
              <Icon name="key" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>「{created.name}」的密鑰只會顯示這一次</b>
                <p>現在複製起來，貼到那個 App 的設定裡。離開這頁後就看不到完整內容了。</p>
                <div className="secret-box" style={{ marginTop: 8 }}>
                  <code translate="no">{created.token}</code>
                  <CopyButton label="複製" getText={() => created.token} done="已複製密鑰" className="small" />
                  <Button small onClick={() => setCreated(null)}>
                    我已經存好了
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <form className="form" noValidate onSubmit={submit}>
          <div className="form-actions" style={{ alignItems: "end" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <Field label="App 名稱">
                <input ref={name} type="text" name="tokenName" maxLength={60} placeholder="例如：Home Assistant" autoComplete="off" />
              </Field>
            </div>
            <Button variant="primary" type="submit" icon="plus" disabled={create.isPending}>
              建立連線密鑰
            </Button>
          </div>
          <p className="form-error" role="alert">
            {error}
          </p>
        </form>
        <div className="card-inset">
          <TokenList />
        </div>
      </div>
    </details>
  );
}
