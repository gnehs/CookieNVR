import { useMe } from "../../data/session.ts";
import { Appearance } from "./Appearance.tsx";
import { PasswordPanel } from "./PasswordPanel.tsx";
import { SessionsPanel } from "./SessionsPanel.tsx";

export function AccountPage() {
  const me = useMe();
  return (
    <div className="form-page">
      <header className="page-head">
        <div className="row-main" style={{ flex: "none" }}>
          <span className="avatar" style={{ width: 48, height: 48, fontSize: 20 }} aria-hidden="true">
            {me.username.slice(0, 1)}
          </span>
          <div>
            <h1>{me.username}</h1>
            <p>{me.role === "admin" ? "管理員" : "一般使用者"}</p>
          </div>
        </div>
      </header>
      <div className="stack">
        <Appearance />
        <PasswordPanel />
        <SessionsPanel />
      </div>
    </div>
  );
}
