import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import type { UserDto } from "../../../src/api-types.ts";
import type { Role } from "../../../src/types.ts";
import { api } from "../../api.ts";
import { useMe } from "../../data/session.ts";
import { errMsg, formatAgo } from "../../format.ts";
import { Button } from "../../ui/Button.tsx";
import { Dialog, confirmDialog } from "../../ui/Dialog.tsx";
import { Field } from "../../ui/Field.tsx";
import { MenuButton } from "../../ui/Menu.tsx";
import { ErrorBox, Spinner } from "../../ui/states.tsx";
import { toast } from "../../ui/toast.tsx";
import { Tiles } from "../../ui/controls.tsx";
import { SettingsLayout } from "../settings/SettingsLayout.tsx";

const ROLE_LABEL: Record<Role, string> = { admin: "管理員", user: "一般使用者" };

const usersQuery = queryOptions({ queryKey: ["users"], queryFn: api.users });

type Target = { kind: "create" } | { kind: "reset"; user: UserDto };

interface Submitted {
  username: string;
  password: string;
  role: Role;
}

function PasswordForm({ withUsername, onClose, onSubmit }: { withUsername: boolean; onClose: () => void; onSubmit: (v: Submitted) => Promise<void> }) {
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const [role, setRole] = useState<Role>("user");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = username.current?.value.trim() ?? "";
    const pw = password.current!.value;
    if (withUsername && !name) {
      username.current?.focus();
      return setError("請填寫帳號");
    }
    if (pw.length < 8) {
      password.current!.focus();
      return setError("密碼至少要 8 個字元");
    }
    setError("");
    setBusy(true);
    try {
      await onSubmit({ username: name, password: pw, role });
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <form className="form" noValidate onSubmit={submit}>
      {withUsername ? (
        <Field label="帳號">
          <input ref={username} type="text" name="username" autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus />
        </Field>
      ) : null}
      <Field label="密碼" hint="至少 8 個字元">
        <input ref={password} type="password" name="password" autoComplete="new-password" minLength={8} autoFocus={!withUsername} />
      </Field>
      {withUsername ? (
        <div className="field">
          <span className="legend">角色</span>
          <Tiles
            label="角色"
            value={role}
            onChange={setRole}
            options={[
              { value: "user", label: ROLE_LABEL.user, desc: "可以看畫面與錄影" },
              { value: "admin", label: ROLE_LABEL.admin, desc: "還可以變更所有設定" },
            ]}
          />
        </div>
      ) : null}
      <p className="form-error" role="alert">
        {error}
      </p>
      <div className="dlg-actions">
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {withUsername ? "新增使用者" : "重設密碼"}
        </Button>
      </div>
    </form>
  );
}

function UserRow({ user, self, onReset, onRole, onDelete }: { user: UserDto; self: boolean; onReset: () => void; onRole: (role: Role) => void; onDelete: () => void }) {
  const other: Role = user.role === "admin" ? "user" : "admin";
  const sub = [self ? "你" : null, ROLE_LABEL[user.role], user.lastLoginAt ? `上次登入 ${formatAgo(user.lastLoginAt)}` : "還沒登入過"].filter(Boolean).join("・");
  return (
    <div className="row-item cam-row" role="listitem">
      <div className="row-main">
        <span className="avatar" aria-hidden="true">
          {user.username.slice(0, 1)}
        </span>
        <div className="row-text">
          <b className="truncate">{user.username}</b>
          <small className="truncate">{sub}</small>
        </div>
      </div>
      <div className="row-actions">
        <MenuButton
          label={`「${user.username}」的更多動作`}
          items={[
            { label: "重設密碼", icon: "key", onSelect: onReset },
            !self && { label: other === "admin" ? "改成管理員" : "改成一般使用者", icon: "user", onSelect: () => onRole(other) },
            !self && { label: "刪除", icon: "trash", danger: true, onSelect: onDelete },
          ]}
        />
      </div>
    </div>
  );
}

/** 設定 → 使用者：新增、刪除、改角色與重設密碼 */
export function UsersPage() {
  const qc = useQueryClient();
  const me = useMe();
  const users = useQuery(usersQuery);
  const [target, setTarget] = useState<Target | null>(null);
  // 關閉動畫期間保留對話框內容
  const [shown, setShown] = useState<Target | null>(null);
  const [round, setRound] = useState(0);
  const open = (t: Target) => {
    setRound((n) => n + 1);
    setShown(t);
    setTarget(t);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: usersQuery.queryKey });

  const create = useMutation({
    mutationFn: (v: Submitted) => api.createUser(v.username, v.password, v.role),
    // 錯誤由對話框自己顯示
    onError: () => {},
    onSuccess: (_u, v) => {
      toast(`已新增「${v.username}」`);
      return refresh();
    },
  });
  const reset = useMutation({
    mutationFn: ({ user, password }: { user: UserDto; password: string }) => api.updateUser(user.id, { password }),
    onError: () => {},
    onSuccess: (_r, { user }) => toast(`已重設「${user.username}」的密碼`),
  });
  const setRole = useMutation({
    mutationFn: ({ user, role }: { user: UserDto; role: Role }) => api.updateUser(user.id, { role }),
    onSuccess: (_r, { user, role }) => toast(`「${user.username}」現在是${ROLE_LABEL[role]}`),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (user: UserDto) => api.deleteUser(user.id),
    onSuccess: (_r, user) => {
      toast(`已刪除「${user.username}」`);
      return refresh();
    },
  });

  const confirmRemove = async (u: UserDto) => {
    if (await confirmDialog(`刪除「${u.username}」？`, "這個帳號會立刻無法登入，它建立的 API Token 也會失效。無法復原。", { confirmLabel: "刪除", danger: true })) remove.mutate(u);
  };

  let body;
  if (users.isPending) body = <Spinner />;
  else if (users.isError) body = <ErrorBox error={users.error} onRetry={() => users.refetch()} />;
  else {
    body = (
      <>
        <div className="list-toolbar">
          <span className="hint">共 {users.data.length} 位</span>
          <Button variant="primary" small icon="plus" iconSize={15} onClick={() => open({ kind: "create" })}>
            新增使用者
          </Button>
        </div>
        <div className="card row-list" role="list">
          {users.data.map((u) => (
            <UserRow key={u.id} user={u} self={u.id === me.id} onReset={() => open({ kind: "reset", user: u })} onRole={(role) => setRole.mutate({ user: u, role })} onDelete={() => void confirmRemove(u)} />
          ))}
        </div>
      </>
    );
  }

  const close = () => setTarget(null);
  return (
    <SettingsLayout active="users">
      <div>{body}</div>
      <Dialog open={target !== null} onOpenChange={(o) => !o && close()} title={shown?.kind === "reset" ? `重設「${shown.user.username}」的密碼` : "新增使用者"} onClosed={() => setShown(null)}>
        {shown ? (
          <PasswordForm
            key={round}
            withUsername={shown.kind === "create"}
            onClose={close}
            onSubmit={async (v) => {
              if (shown.kind === "create") await create.mutateAsync(v);
              else await reset.mutateAsync({ user: shown.user, password: v.password });
              close();
            }}
          />
        ) : null}
      </Dialog>
    </SettingsLayout>
  );
}
