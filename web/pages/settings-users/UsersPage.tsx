import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, plural, t as msgT } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
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

const ROLE_LABEL: Record<Role, MessageDescriptor> = { admin: msg`Administrator`, user: msg`Regular user` };
const roleLabel = (role: Role): string => i18n._(ROLE_LABEL[role]);

const lastLogin = (ago: string): string => msgT`Last signed in ${ago}`;
const moreActions = (username: string): string => msgT`More actions for "${username}"`;
const userAdded = (username: string): string => msgT`Added "${username}"`;
const passwordReset = (username: string): string => msgT`Reset the password for "${username}"`;
const roleChanged = (username: string, role: string): string => msgT`"${username}" is now ${role}`;
const userDeleted = (username: string): string => msgT`Deleted "${username}"`;
const deleteTitle = (username: string): string => msgT`Delete "${username}"?`;
const resetTitle = (username: string): string => msgT`Reset password for "${username}"`;

const usersQuery = queryOptions({ queryKey: ["users"], queryFn: api.users });

type Target = { kind: "create" } | { kind: "reset"; user: UserDto };

interface Submitted {
  username: string;
  password: string;
  role: Role;
}

function PasswordForm({ withUsername, onClose, onSubmit }: { withUsername: boolean; onClose: () => void; onSubmit: (v: Submitted) => Promise<void> }) {
  const { t } = useLingui();
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
      return setError(t`Enter a username`);
    }
    if (pw.length < 8) {
      password.current!.focus();
      return setError(t`The password must be at least 8 characters`);
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
        <Field label={t`Username`}>
          <input ref={username} type="text" name="username" autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus />
        </Field>
      ) : null}
      <Field label={t`Password`} hint={t`At least 8 characters`}>
        <input ref={password} type="password" name="password" autoComplete="new-password" minLength={8} autoFocus={!withUsername} />
      </Field>
      {withUsername ? (
        <div className="field">
          <span className="legend">{t`Role`}</span>
          <Tiles
            label={t`Role`}
            value={role}
            onChange={setRole}
            options={[
              { value: "user", label: roleLabel("user"), desc: t`Can view live video and recordings` },
              { value: "admin", label: roleLabel("admin"), desc: t`Can also change all settings` },
            ]}
          />
        </div>
      ) : null}
      <p className="form-error" role="alert">
        {error}
      </p>
      <div className="dlg-actions">
        <Button onClick={onClose}>{t`Cancel`}</Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {withUsername ? t`Add user` : t`Reset password`}
        </Button>
      </div>
    </form>
  );
}

function UserRow({ user, self, onReset, onRole, onDelete }: { user: UserDto; self: boolean; onReset: () => void; onRole: (role: Role) => void; onDelete: () => void }) {
  const { t } = useLingui();
  const other: Role = user.role === "admin" ? "user" : "admin";
  const sub = [self ? t`You` : null, roleLabel(user.role), user.lastLoginAt ? lastLogin(formatAgo(user.lastLoginAt)) : t`Never signed in`].filter(Boolean).join("・");
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
          label={moreActions(user.username)}
          items={[
            { label: t`Reset password`, icon: "key", onSelect: onReset },
            !self && { label: other === "admin" ? t`Make administrator` : t`Make regular user`, icon: "user", onSelect: () => onRole(other) },
            !self && { label: t`Delete`, icon: "trash", danger: true, onSelect: onDelete },
          ]}
        />
      </div>
    </div>
  );
}

/** 設定 → 使用者：新增、刪除、改角色與重設密碼 */
export function UsersPage() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const me = useMe();
  const users = useQuery(usersQuery);
  const [target, setTarget] = useState<Target | null>(null);
  // 關閉動畫期間保留對話框內容
  const [shown, setShown] = useState<Target | null>(null);
  const [round, setRound] = useState(0);
  const open = (next: Target) => {
    setRound((n) => n + 1);
    setShown(next);
    setTarget(next);
  };
  const refresh = () => qc.invalidateQueries({ queryKey: usersQuery.queryKey });

  const create = useMutation({
    mutationFn: (v: Submitted) => api.createUser(v.username, v.password, v.role),
    // 錯誤由對話框自己顯示
    onError: () => {},
    onSuccess: (_u, v) => {
      toast(userAdded(v.username));
      return refresh();
    },
  });
  const reset = useMutation({
    mutationFn: ({ user, password }: { user: UserDto; password: string }) => api.updateUser(user.id, { password }),
    onError: () => {},
    onSuccess: (_r, { user }) => toast(passwordReset(user.username)),
  });
  const setRole = useMutation({
    mutationFn: ({ user, role }: { user: UserDto; role: Role }) => api.updateUser(user.id, { role }),
    onSuccess: (_r, { user, role }) => toast(roleChanged(user.username, roleLabel(role))),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (user: UserDto) => api.deleteUser(user.id),
    onSuccess: (_r, user) => {
      toast(userDeleted(user.username));
      return refresh();
    },
  });

  const confirmRemove = async (u: UserDto) => {
    if (await confirmDialog(deleteTitle(u.username), t`This account can no longer sign in right away, and any API tokens it created stop working. This can't be undone.`, { confirmLabel: t`Delete`, danger: true })) remove.mutate(u);
  };

  let body;
  if (users.isPending) body = <Spinner />;
  else if (users.isError) body = <ErrorBox error={users.error} onRetry={() => users.refetch()} />;
  else {
    const count = users.data.length;
    body = (
      <>
        <div className="list-toolbar">
          <span className="hint">{plural(count, { one: "# user", other: "# users" })}</span>
          <Button variant="primary" small icon="plus" iconSize={15} onClick={() => open({ kind: "create" })}>
            {t`Add user`}
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
      <Dialog open={target !== null} onOpenChange={(o) => !o && close()} title={shown?.kind === "reset" ? resetTitle(shown.user.username) : t`Add user`} onClosed={() => setShown(null)}>
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
