import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-Hant", "ja"],
  catalogs: [
    {
      path: "<rootDir>/web/locales/{locale}",
      include: ["<rootDir>/web"],
      exclude: ["**/node_modules/**", "**/*.test.ts", "<rootDir>/web/dev-mock*.ts", "<rootDir>/web/routeTree.gen.ts"],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
