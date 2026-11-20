import { Tooltip as Base } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { Kbd } from "./Kbd.tsx";

/**
 * 滑鼠停留或鍵盤聚焦時浮出的短提示。只補充看得到的東西（例如收合側欄後的頁名），
 * 觸發元素自己要有可讀的名稱，提示不負責無障礙名稱。
 */
export function Tooltip({ trigger, label, keys, side = "right", disabled }: { trigger: ReactElement; label: ReactNode; keys?: string[]; side?: "right" | "bottom" | "top"; disabled?: boolean }) {
  // Base UI 的 disabled 從 true 改回 false 後不會再響應滑鼠停留，停用時直接不包
  if (disabled) return trigger;
  return (
    <Base.Root>
      <Base.Trigger render={trigger} delay={350} closeDelay={0} />
      <Base.Portal>
        <Base.Positioner className="tip-pos" side={side} sideOffset={10} collisionPadding={8}>
          <Base.Popup className="tip">
            {label}
            {keys ? (
              <span className="tip-keys">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            ) : null}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

/** 一組相鄰的提示：移到下一個時不再等延遲，直接換過去 */
export const TooltipGroup = ({ children }: { children: ReactNode }) => (
  <Base.Provider delay={350} closeDelay={0}>
    {children}
  </Base.Provider>
);
