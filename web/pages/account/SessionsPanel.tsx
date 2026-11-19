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
  return [os, br].filter(Boolean).join(" 上的 ") || "不明的瀏覽器";
}

function List({ sessions }: { sessions: SessionDto[] }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSession(id),
    onSuccess: () => {
      toast("已登出那台裝置");
      return qc.invalidateQueries({ queryKey: sessionsQuery.queryKey });
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e), "error"),
  });
  // 目前這台置頂；其他裝置用瀏覽器與系統命名，同名時在副標題補上來源位址分辨
  const list = sessions.slice().sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
  const names = list.map((s) => describeUa(s.userAgent));
  const dup = (n: string) => names.filter((x) => x === n).length > 1;
  return (
    <div className="row-list">
      {list.map((s, i) => (
        <div className="row-item cam-row" key={s.id}>
          <div className="row-main">
            <span className="row-ico">
              <Icon name="monitor" size={18} />
            </span>
            <div className="row-text">
              <b className="truncate">{s.current ? "這台裝置" : names[i]}</b>
              <small className="truncate">{s.current ? names[i] : [`上次使用 ${formatAgo(s.lastSeenAt)}`, dup(names[i]!) ? `來自 ${s.ip}` : null].filter(Boolean).join("・")}</small>
            </div>
          </div>
          {s.current ? null : (
            <Button
              small
              icon="logout"
              iconSize={15}
              onClick={async () => {
                if (!(await confirmDialog(`登出「${names[i]}」？`, "這台裝置下次開啟時需要重新登入。", { confirmLabel: "登出", danger: true }))) return;
                revoke.mutate(s.id);
              }}
            >
              登出
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function SessionsPanel() {
  const q = useQuery(sessionsQuery);
  return (
    <Panel title="登入中的裝置">
      {q.isPending ? <Spinner /> : q.isError ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <List sessions={q.data} />}
    </Panel>
  );
}
