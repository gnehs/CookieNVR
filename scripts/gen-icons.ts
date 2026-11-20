// 從 @phosphor-icons/core（MIT）的 duotone SVG 產生 web/ui/icons.ts。改對照表後執行：bun scripts/gen-icons.ts
// duotone 的淡色層原本是 opacity="0.2"，換成 class="duo"，由 CSS 填不透明的混色（圖示不用透明度，見 Icon.tsx）。
// 純符號（加減、叉勾、箭頭、三點）的淡色層是一整塊方底，放在按鈕裡很怪，這些用 regular 單色線條
const REGULAR = new Set(["plus", "minus", "x", "check", "chevron", "left", "right", "up", "down", "selector", "more", "grip", "arrow-right", "refresh", "expand", "download"]);
const MAP: Record<string, string> = {
  camera: "security-camera",
  film: "film-strip",
  settings: "gear-six",
  user: "user",
  plus: "plus",
  trash: "trash",
  edit: "pencil-simple",
  copy: "copy",
  refresh: "arrow-clockwise",
  play: "play",
  check: "check",
  x: "x",
  logout: "sign-out",
  alert: "warning",
  info: "info",
  key: "key",
  chevron: "caret-right",
  left: "caret-left",
  right: "caret-right",
  activity: "lightning",
  hdd: "hard-drive",
  users: "users",
  minus: "minus",
  sun: "sun",
  palette: "palette",
  lock: "lock",
  monitor: "monitor",
  mic: "microphone",
  "mic-off": "microphone-slash",
  "wifi-off": "wifi-slash",
  pause: "pause",
  link: "link",
  route: "path",
  clock: "clock",
  calendar: "calendar-blank",
  server: "hard-drives",
  globe: "globe",
  tapo: "webcam",
  volume: "speaker-high",
  "volume-off": "speaker-slash",
  expand: "arrows-out",
  crosshair: "crosshair",
  "skip-end": "skip-forward",
  rec: "record",
  more: "dots-three",
  "check-circle": "check-circle",
  "alert-circle": "warning-circle",
  "arrow-right": "arrow-right",
  selector: "caret-up-down",
  download: "download-simple",
  power: "power",
  up: "caret-up",
  down: "caret-down",
  stop: "stop",
  tag: "tag",
  toggle: "toggle-right",
  home: "house",
  sidebar: "sidebar-simple",
  grip: "dots-six-vertical",
  folder: "folder-simple",
};

const root = new URL("..", import.meta.url).pathname;
const lines: string[] = [];
for (const [name, source] of Object.entries(MAP)) {
  const weight = REGULAR.has(name) ? "regular" : "duotone";
  const svg = await Bun.file(`${root}node_modules/@phosphor-icons/core/assets/${weight}/${source}${weight === "regular" ? "" : "-duotone"}.svg`).text();
  const inner = svg
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replaceAll(' opacity="0.2"', ' class="duo"');
  lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(inner)},`);
}
await Bun.write(
  `${root}web/ui/icons.ts`,
  `// 由 scripts/gen-icons.ts 產生，不要手改。圖示來自 Phosphor Icons（MIT，https://phosphoricons.com），duotone 與 regular 樣式，viewBox 0 0 256 256
export const ICONS = {
${lines.join("\n")}
} satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;
`,
);
console.log(`wrote ${lines.length} icons`);
