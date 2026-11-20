/*
 * CookieNVR 自己的圖示。24×24 格子，主體留 2px 邊，線寬 1.7、圓端點圓轉角（由 Icon 的 <svg> 統一設定）。
 * class="duo" 是主體的淡色填色（不描邊），顏色由 CSS 混出來；fill="currentColor" 的是實心的點與控制鍵。
 * 新增時照同一套規則畫：線條盡量落在 0.5 的格線上，圓角 2–3，同一類形狀用同樣的大小。
 */
export const ICONS = {
  // 槍型監視器：機身微微朝下、鏡頭在左，尾端一支彎臂接到牆上
  camera:
    '<g transform="rotate(-14 15 9)"><path class="duo" d="M3 7.5A2.5 2.5 0 0 1 5.5 5H15a2.5 2.5 0 0 1 2.5 2.5v2A2.5 2.5 0 0 1 15 12H5.5A2.5 2.5 0 0 1 3 9.5z"/><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H15a2.5 2.5 0 0 1 2.5 2.5v2A2.5 2.5 0 0 1 15 12H5.5A2.5 2.5 0 0 1 3 9.5z"/><circle cx="6.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/></g><path d="M14 13.3V16a1 1 0 0 0 1 1h4.5M20.5 14.5v5"/>',
  // 底片：中間是畫格，兩側是齒孔
  film: '<path class="duo" d="M7 4h10v16H7z"/><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M3 8.5h4M3 12h4M3 15.5h4M17 8.5h4M17 12h4M17 15.5h4"/>',
  settings:
    '<path class="duo" d="M9.69 5.29L9.89 2.84L14.11 2.84L14.31 5.29L15.11 5.62L16.98 4.03L19.97 7.02L18.38 8.89L18.71 9.69L21.16 9.89L21.16 14.11L18.71 14.31L18.38 15.11L19.97 16.98L16.98 19.97L15.11 18.38L14.31 18.71L14.11 21.16L9.89 21.16L9.69 18.71L8.89 18.38L7.02 19.97L4.03 16.98L5.62 15.11L5.29 14.31L2.84 14.11L2.84 9.89L5.29 9.69L5.62 8.89L4.03 7.02L7.02 4.03L8.89 5.62Z"/><path d="M9.69 5.29L9.89 2.84L14.11 2.84L14.31 5.29L15.11 5.62L16.98 4.03L19.97 7.02L18.38 8.89L18.71 9.69L21.16 9.89L21.16 14.11L18.71 14.31L18.38 15.11L19.97 16.98L16.98 19.97L15.11 18.38L14.31 18.71L14.11 21.16L9.89 21.16L9.69 18.71L8.89 18.38L7.02 19.97L4.03 16.98L5.62 15.11L5.29 14.31L2.84 14.11L2.84 9.89L5.29 9.69L5.62 8.89L4.03 7.02L7.02 4.03L8.89 5.62Z"/><circle cx="12" cy="12" r="3"/>',
  user: '<path class="duo" d="M5 20a7 7 0 0 1 14 0z"/><circle class="duo" cx="12" cy="8.5" r="3.5"/><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  users:
    '<path class="duo" d="M3 19.5a6 6 0 0 1 12 0z"/><circle class="duo" cx="9" cy="8.5" r="3.2"/><circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5a6 6 0 0 1 12 0M15.5 5.4a3.2 3.2 0 0 1 0 6.2M17 14.3a5.6 5.6 0 0 1 4 5.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  trash:
    '<path class="duo" d="M6 7l.83 11.17A2 2 0 0 0 8.83 20h6.34a2 2 0 0 0 2-1.83L18 7z"/><path d="M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6 7l.83 11.17A2 2 0 0 0 8.83 20h6.34a2 2 0 0 0 2-1.83L18 7M10 11v5M14 11v5"/>',
  edit: '<path class="duo" d="M15.5 4.5l4 4L9 19l-5 1 1-5z"/><path d="M15.5 4.5l4 4L9 19l-5 1 1-5zM13 7l4 4"/>',
  copy: '<rect class="duo" x="9" y="9" width="11" height="11" rx="2.5"/><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9M19.5 4.5V9H15"/>',
  play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.4-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="3.5" height="14" rx="1.2" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>',
  "skip-end": '<path d="M5.5 6.6v10.8a1 1 0 0 0 1.55.83l7.8-5.4a1 1 0 0 0 0-1.66l-7.8-5.4A1 1 0 0 0 5.5 6.6z" fill="currentColor"/><path d="M18.5 6v12"/>',
  rec: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  logout: '<path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10M14.5 8l4 4-4 4M18.5 12H9.5"/>',
  alert:
    '<path class="duo" d="M10.27 4.6L3 17.5A2 2 0 0 0 4.73 20.5h14.54A2 2 0 0 0 21 17.5L13.73 4.6a2 2 0 0 0-3.46 0z"/><path d="M10.27 4.6L3 17.5A2 2 0 0 0 4.73 20.5h14.54A2 2 0 0 0 21 17.5L13.73 4.6a2 2 0 0 0-3.46 0zM12 9.5v4"/><circle cx="12" cy="16.9" r="1" fill="currentColor" stroke="none"/>',
  info: '<circle class="duo" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/>',
  "check-circle": '<circle class="duo" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16 9.5"/>',
  "alert-circle": '<circle class="duo" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.3" r="1" fill="currentColor" stroke="none"/>',
  key: '<circle class="duo" cx="8" cy="15.5" r="4.5"/><circle cx="8" cy="15.5" r="4.5"/><path d="M11.2 12.3L19.5 4M16.5 7l2.5 2.5M14.3 9.2l2 2"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  right: '<path d="M9.5 6l6 6-6 6"/>',
  left: '<path d="M14.5 6l-6 6 6 6"/>',
  up: '<path d="M6 14.5l6-6 6 6"/>',
  down: '<path d="M6 9.5l6 6 6-6"/>',
  selector: '<path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4"/>',
  "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
  // 事件：閃電
  activity: '<path class="duo" d="M13.5 3L5.5 13.5h6L10.5 21l8-10.5h-6z"/><path d="M13.5 3L5.5 13.5h6L10.5 21l8-10.5h-6z"/>',
  hdd: '<rect class="duo" x="3" y="6" width="18" height="12" rx="3"/><rect x="3" y="6" width="18" height="12" rx="3"/><path d="M6.5 14h6"/><circle cx="17" cy="14" r="1" fill="currentColor" stroke="none"/>',
  server:
    '<rect class="duo" x="3.5" y="4" width="17" height="7" rx="2.5"/><rect class="duo" x="3.5" y="13" width="17" height="7" rx="2.5"/><rect x="3.5" y="4" width="17" height="7" rx="2.5"/><rect x="3.5" y="13" width="17" height="7" rx="2.5"/><circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7.5" cy="16.5" r="1" fill="currentColor" stroke="none"/>',
  sun: '<circle class="duo" cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="4"/><path d="M12 5.4V3.4M16.67 7.33l1.41-1.41M18.6 12h2M16.67 16.67l1.41 1.41M12 18.6v2M7.33 16.67l-1.41 1.41M5.4 12h-2M7.33 7.33L5.92 5.92"/>',
  palette:
    '<path class="duo" d="M12 3.5a8.5 8.5 0 0 0 0 17c1.3 0 2-.9 2-1.9 0-.6-.3-1-.3-1.6 0-1 .8-1.7 1.8-1.7H17a3.5 3.5 0 0 0 3.5-3.5c0-4.6-3.8-8.3-8.5-8.3z"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.3 0 2-.9 2-1.9 0-.6-.3-1-.3-1.6 0-1 .8-1.7 1.8-1.7H17a3.5 3.5 0 0 0 3.5-3.5c0-4.6-3.8-8.3-8.5-8.3z"/><g fill="currentColor" stroke="none"><circle cx="7.8" cy="11" r="1.1"/><circle cx="10" cy="7.6" r="1.1"/><circle cx="14.2" cy="7.6" r="1.1"/><circle cx="16.6" cy="10.8" r="1.1"/></g>',
  lock: '<rect class="duo" x="5" y="10.5" width="14" height="10" rx="2.5"/><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2"/>',
  monitor: '<rect class="duo" x="3" y="4" width="18" height="12.5" rx="2.5"/><rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M12 16.5v3.5M8.5 20h7"/>',
  mic: '<rect class="duo" x="9" y="3" width="6" height="11" rx="3"/><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  "mic-off": '<rect class="duo" x="9" y="3" width="6" height="11" rx="3"/><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16"/>',
  "wifi-off": '<path d="M2.5 8.8a14 14 0 0 1 19 0M5.5 12.2a9.5 9.5 0 0 1 13 0M8.6 15.6a5 5 0 0 1 6.8 0M4 4l16 16"/><circle cx="12" cy="19" r="1.1" fill="currentColor" stroke="none"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3A4 4 0 0 0 13 5.34l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3A4 4 0 0 0 11 18.66l1-1"/>',
  route: '<circle class="duo" cx="6" cy="18" r="2.2"/><circle class="duo" cx="18" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18h7.3a3 3 0 0 0 0-6h-7a3 3 0 0 1 0-6h7.3"/>',
  clock: '<circle class="duo" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<path class="duo" d="M6 5h12a2.5 2.5 0 0 1 2.5 2.5V10h-17V7.5A2.5 2.5 0 0 1 6 5z"/><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  globe: '<circle class="duo" cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="9"/><path d="M12 3c-2.4 2.5-3.5 5.5-3.5 9s1.1 6.5 3.5 9c2.4-2.5 3.5-5.5 3.5-9S14.4 5.5 12 3zM3 12h18"/>',
  // Tapo 這類室內雲台機：圓潤的機頭、鏡頭，下面一根支架
  tapo: '<rect class="duo" x="6" y="3" width="12" height="13" rx="6"/><rect x="6" y="3" width="12" height="13" rx="6"/><circle cx="12" cy="9.5" r="2.5"/><path d="M12 16v4.5M8.5 20.5h7"/>',
  volume: '<path class="duo" d="M4 9.5v5a1 1 0 0 0 1 1h2.5l4.5 4v-15l-4.5 4H5a1 1 0 0 0-1 1z"/><path d="M4 9.5v5a1 1 0 0 0 1 1h2.5l4.5 4v-15l-4.5 4H5a1 1 0 0 0-1 1zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  "volume-off": '<path class="duo" d="M4 9.5v5a1 1 0 0 0 1 1h2.5l4.5 4v-15l-4.5 4H5a1 1 0 0 0-1 1z"/><path d="M4 9.5v5a1 1 0 0 0 1 1h2.5l4.5 4v-15l-4.5 4H5a1 1 0 0 0-1 1zM16 9.5l5 5M21 9.5l-5 5"/>',
  expand: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  crosshair: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  more: '<g fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></g>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/></g>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  power: '<path d="M12 3.5v8M7 6.3a7.5 7.5 0 1 0 10 0"/>',
  tag: '<path class="duo" d="M3.5 12.6V5A1.5 1.5 0 0 1 5 3.5h7.6a1.5 1.5 0 0 1 1.06.44l7.4 7.4a1.5 1.5 0 0 1 0 2.12l-7.6 7.6a1.5 1.5 0 0 1-2.12 0l-7.4-7.4a1.5 1.5 0 0 1-.44-1.06z"/><path d="M3.5 12.6V5A1.5 1.5 0 0 1 5 3.5h7.6a1.5 1.5 0 0 1 1.06.44l7.4 7.4a1.5 1.5 0 0 1 0 2.12l-7.6 7.6a1.5 1.5 0 0 1-2.12 0l-7.4-7.4a1.5 1.5 0 0 1-.44-1.06z"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>',
  toggle: '<rect class="duo" x="2.5" y="7" width="19" height="10" rx="5"/><rect x="2.5" y="7" width="19" height="10" rx="5"/><circle cx="16.5" cy="12" r="2.6" fill="currentColor" stroke="none"/>',
  home: '<path class="duo" d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15V15H9v5.5H5.5A1.5 1.5 0 0 1 4 19z"/><path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15V15H9v5.5H5.5A1.5 1.5 0 0 1 4 19z"/>',
  sidebar: '<path class="duo" d="M6 4.5h3.5v15H6A3 3 0 0 1 3 16.5v-9a3 3 0 0 1 3-3z"/><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  folder: '<path class="duo" d="M3.5 7.5a2 2 0 0 1 2-2h3.8a2 2 0 0 1 1.42.59l1.3 1.32a2 2 0 0 0 1.41.59h5.07a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 7.5a2 2 0 0 1 2-2h3.8a2 2 0 0 1 1.42.59l1.3 1.32a2 2 0 0 0 1.41.59h5.07a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
} satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;

/** 包住圖示的 <svg> 屬性；React 的 Icon 與 dom.ts 的 icon() 都照這一份 */
export const ICON_SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
