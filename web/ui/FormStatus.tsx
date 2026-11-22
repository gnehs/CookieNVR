import { useLingui } from "@lingui/react/macro";
import { CopyButton } from "./Button.tsx";

/** 表單底部左邊的狀態區：一行錯誤摘要，有可貼給別人的診斷文字時多一顆複製鈕 */
export function FormStatus({ error }: { error: { summary: string; copy?: string } | null | undefined }) {
  const { t } = useLingui();
  return (
    <div className="foot-status">
      <p className="form-error" role="alert">
        {error?.summary}
      </p>
      <span className="copy-slot">{error?.copy ? <CopyButton label={t`Copy error`} className="small ghost" done={t`Error copied. You can paste it to an AI or a technician.`} getText={() => error.copy!} /> : null}</span>
    </div>
  );
}
