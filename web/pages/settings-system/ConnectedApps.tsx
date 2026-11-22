import { t as msgT } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
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

const lastUsed = (ago: string): string => msgT`Last used ${ago}`;
const createdUnused = (ago: string): string => msgT`Created ${ago}, never used`;
const revokeTitle = (name: string): string => msgT`Revoke "${name}"?`;
const shownOnce = (name: string): string => msgT`The key for "${name}" is shown only once`;

export const tokensQuery = queryOptions({ queryKey: ["tokens"], queryFn: api.tokens });

function TokenList() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const q = useQuery(tokensQuery);
  const revoke = useMutation({
    mutationFn: (tok: { id: number; name: string }) => api.revokeToken(tok.id).then(() => tok.name),
    onSuccess: (name) => {
      toast(t`Revoked "${name}"`);
      return qc.invalidateQueries({ queryKey: tokensQuery.queryKey });
    },
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (q.data.length === 0)
    return (
      <p className="muted" style={{ padding: "16px 22px" }}>
        {t`No apps are connected yet.`}
      </p>
    );
  return (
    <div className="row-list">
      {q.data.map((tok) => (
        <div className="row-item" key={tok.id}>
          <div className="row-main">
            <span className="row-ico">
              <Icon name="key" size={18} />
            </span>
            <div className="row-text">
              <b>{tok.name}</b>
              <small>{tok.lastUsedAt ? lastUsed(formatAgo(tok.lastUsedAt)) : createdUnused(formatAgo(tok.createdAt))}</small>
            </div>
          </div>
          <Button
            small
            variant="danger"
            icon="trash"
            iconSize={15}
            onClick={async () => {
              if (!(await confirmDialog(revokeTitle(tok.name), t`Apps connected with this key lose access immediately.`, { confirmLabel: t`Revoke`, danger: true }))) return;
              revoke.mutate({ id: tok.id, name: tok.name });
            }}
          >
            {t`Revoke`}
          </Button>
        </div>
      ))}
    </div>
  );
}

// 大多數人用不到，預設收合；技術名稱（API Token）只出現在說明的最後
export function ConnectedApps() {
  const { t } = useLingui();
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
    meta: { handlesError: true },
    onError: (e) => setError(errMsg(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const n = name.current!.value.trim();
    if (!n) {
      name.current!.focus();
      return setError(t`Enter a name for the app you want to connect`);
    }
    create.mutate(n);
  };

  return (
    <details className="card disclosure connect-apps">
      <summary>
        <Icon name="chevron" size={16} />
        {t`Connect other apps`}
        <small>{t`For example, Home Assistant`}</small>
      </summary>
      <div className="disclosure-body">
        <p className="hint">
          <Trans>
            Home Assistant finds CookieNVR on its own: press "Add" there, then come back here and press "Allow". For other apps, you can create a dedicated key here with the same permissions as your account. All connected apps are listed below, and you can revoke one at any time. (Technically this is called an API token.)
          </Trans>
        </p>
        <div aria-live="polite">
          {created ? (
            <div className="callout warn">
              <Icon name="key" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{shownOnce(created.name)}</b>
                <p>{t`Copy it now and paste it into that app's settings. You won't be able to see the full key after leaving this page.`}</p>
                <div className="secret-box" style={{ marginTop: 8 }}>
                  <code translate="no">{created.token}</code>
                  <CopyButton label={t`Copy`} getText={() => created.token} done={t`Key copied`} className="small" />
                  <Button small onClick={() => setCreated(null)}>
                    {t`I've saved it`}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <form className="form" noValidate onSubmit={submit}>
          <div className="form-actions" style={{ alignItems: "end" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <Field label={t`App name`}>
                <input ref={name} type="text" name="tokenName" maxLength={60} placeholder={t`For example: Home Assistant`} autoComplete="off" />
              </Field>
            </div>
            <Button variant="primary" type="submit" icon="plus" disabled={create.isPending}>
              {t`Create connection key`}
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
