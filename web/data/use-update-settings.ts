import { useMutation, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import type { SettingsDto } from "../../src/api-types.ts";
import { api } from "../api.ts";
import { settingsQuery } from "./queries.ts";

export type SettingsPatch = Parameters<typeof api.updateSettings>[0];

/** `PUT /api/settings`，成功後把伺服器回的完整設定寫進 `settingsQuery`；其他的（通知、關聯查詢、錯誤顯示）由呼叫端的 options 補上 */
export function useUpdateSettings(options: Omit<UseMutationOptions<SettingsDto, Error, SettingsPatch>, "mutationFn"> = {}) {
  const qc = useQueryClient();
  return useMutation({
    ...options,
    mutationFn: api.updateSettings,
    onSuccess: (res, ...rest) => {
      qc.setQueryData(settingsQuery.queryKey, res);
      return options.onSuccess?.(res, ...rest);
    },
  });
}
