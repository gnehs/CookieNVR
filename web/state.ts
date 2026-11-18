import type { InfoDto, MeDto } from "../src/api-types.ts";

export const state: { me: MeDto | null; info: InfoDto | null; siteName: string } = {
  me: null,
  info: null,
  siteName: "CookieNVR",
};

export function browserTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
