import { t as msgT } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.ts";
import type { SessionDto } from "../../../src/api-types.ts";
import { formatAgo } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { confirmDialog } from "../../ui/Dialog.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Panel } from "../../ui/Panel.tsx";
import { ErrorBox, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";

export const sessionsQuery = queryOptions({ queryKey: ["me", "sessions"], queryFn: api.sessions });

function describeUa(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  if (os && br) return msgT`${br} on ${os}`;
  return os || br || msgT`Unknown browser`;
}

function List({ sessions }: { sessions: SessionDto[] }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSession(id),
    onSuccess: () => {
      toast(t`Signed out that device`);
      return qc.invalidateQueries({ queryKey: sessionsQuery.queryKey });
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e), "error"),
  });
  // 目前這台置頂；其他裝置用瀏覽器與系統命名，同名時在副標題補上來源位址分辨
  const list = sessions.slice().sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
  const names = list.map((s) => describeUa(s.userAgent));
  const dup = (n: string) => names.filter((x) => x === n).length > 1;
  const lastUsed = (at: number) => {
    const ago = formatAgo(at);
    return t`Last used ${ago}`;
  };
  const from = (ip: string) => t`From ${ip}`;
  return (
    <div className="row-list">
      {list.map((s, i) => (
        <div className="row-item cam-row" key={s.id}>
          <div className="row-main">
            <span className="row-ico">
              <Icon name="monitor" size={18} />
            </span>
            <div className="row-text">
              <b className="truncate">{s.current ? t`This device` : names[i]}</b>
              <small className="truncate">{s.current ? names[i] : [lastUsed(s.lastSeenAt), dup(names[i]!) ? from(s.ip) : null].filter(Boolean).join(" · ")}</small>
            </div>
          </div>
          {s.current ? null : (
            <Button
              small
              icon="logout"
              iconSize={15}
              onClick={async () => {
                const name = names[i];
                if (!(await confirmDialog(t`Sign out “${name}”?`, t`This device will need to sign in again next time it opens.`, { confirmLabel: t`Sign out`, danger: true }))) return;
                revoke.mutate(s.id);
              }}
            >
              <Trans>Sign out</Trans>
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function SessionsPanel() {
  const { t } = useLingui();
  const q = useQuery(sessionsQuery);
  return (
    <Panel title={t`Signed-in devices`}>
      {q.isPending ? <Spinner /> : q.isError ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <List sessions={q.data} />}
    </Panel>
  );
}
