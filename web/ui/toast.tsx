import { Toast } from "@base-ui/react/toast";
import { Icon } from "./Icon.tsx";

type Kind = "ok" | "error";

/** 全站共用一個通知管理器，React 以外（例如 mutation 的錯誤處理）也能直接呼叫 `toast()` */
const manager = Toast.createToastManager<{ kind: Kind }>();

export function toast(message: string, kind: Kind = "ok"): void {
  manager.add({ description: message, timeout: kind === "error" ? 6000 : 3200, priority: kind === "error" ? "high" : "low", data: { kind } });
}

function Toasts() {
  const { toasts } = Toast.useToastManager<{ kind: Kind }>();
  // 新的通知排在最下面，跟舊版一樣
  return [...toasts].reverse().map((t) => {
    const kind = t.data?.kind ?? "ok";
    return (
      <Toast.Root key={t.id} toast={t} className={`toast ${kind}`}>
        <Icon name={kind === "ok" ? "check" : "alert"} />
        <Toast.Description render={<span />} />
      </Toast.Root>
    );
  });
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider toastManager={manager} limit={4}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="toasts">
          <Toasts />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
