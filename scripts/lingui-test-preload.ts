// bun test 不經過 Vite：用 Vite 外掛同一個原生轉換器展開 Lingui macro，並以英文原文啟用，測試斷言寫英文
import { plugin } from "bun";
import { i18n } from "@lingui/core";
import { getConfig } from "@lingui/conf";
import { mapMacroOptions, transform } from "@lingui/native-tools";

const config = getConfig();

plugin({
  name: "lingui-macro",
  setup(build) {
    build.onLoad({ filter: /\/web\/.*\.tsx?$/ }, async ({ path }) => {
      const code = await Bun.file(path).text();
      const loader = path.endsWith("x") ? "tsx" : "ts";
      if (!code.includes("/macro\"")) return { contents: code, loader };
      const out = await transform(code, path.split("/").pop()!, { macro: { descriptorFields: "all", ...mapMacroOptions(config) } } as never);
      return { contents: out.code, loader };
    });
  },
});

i18n.loadAndActivate({ locale: "en", messages: {} });
