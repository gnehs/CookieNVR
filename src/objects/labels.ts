/**
 * 物件類別的鍵與顯示名稱。
 *
 * 鍵是小寫英文、數字與底線（模型的類別名稱經 `labelKey` 轉換，例如 "traffic light" → traffic_light），
 * 攝影機設定的 `detect.labels`、事件的 `labels`、`GET /api/objects/labels` 都用同一套鍵。
 * 相機事件（ONVIF）另外會寫入 person、vehicle、pet：person 與 YOLO 的 person 同一個鍵、意思相同，
 * 會合併；vehicle、pet 是相機自己的分類，和 YOLO 的 car、truck、dog、cat 各自獨立，不互相換算。
 */

/** 內建模型（COCO 80 類）的鍵與中文，依模型的類別順序 */
export const COCO_LABELS: readonly (readonly [key: string, zh: string, en: string])[] = [
  ["person", "人", "Person"], ["bicycle", "腳踏車", "Bicycle"], ["car", "汽車", "Car"], ["motorcycle", "機車", "Motorcycle"],
  ["airplane", "飛機", "Airplane"], ["bus", "公車", "Bus"], ["train", "火車", "Train"], ["truck", "卡車", "Truck"], ["boat", "船", "Boat"],
  ["traffic_light", "紅綠燈", "Traffic light"], ["fire_hydrant", "消防栓", "Fire hydrant"], ["stop_sign", "停車標誌", "Stop sign"],
  ["parking_meter", "停車計時器", "Parking meter"], ["bench", "長椅", "Bench"], ["bird", "鳥", "Bird"], ["cat", "貓", "Cat"], ["dog", "狗", "Dog"],
  ["horse", "馬", "Horse"], ["sheep", "羊", "Sheep"], ["cow", "牛", "Cow"], ["elephant", "大象", "Elephant"], ["bear", "熊", "Bear"],
  ["zebra", "斑馬", "Zebra"], ["giraffe", "長頸鹿", "Giraffe"], ["backpack", "背包", "Backpack"], ["umbrella", "雨傘", "Umbrella"],
  ["handbag", "手提包", "Handbag"], ["tie", "領帶", "Tie"], ["suitcase", "行李箱", "Suitcase"], ["frisbee", "飛盤", "Frisbee"],
  ["skis", "滑雪板", "Skis"], ["snowboard", "單板滑雪板", "Snowboard"], ["sports_ball", "球", "Sports ball"], ["kite", "風箏", "Kite"],
  ["baseball_bat", "球棒", "Baseball bat"], ["baseball_glove", "棒球手套", "Baseball glove"], ["skateboard", "滑板", "Skateboard"],
  ["surfboard", "衝浪板", "Surfboard"], ["tennis_racket", "網球拍", "Tennis racket"], ["bottle", "瓶子", "Bottle"],
  ["wine_glass", "酒杯", "Wine glass"], ["cup", "杯子", "Cup"], ["fork", "叉子", "Fork"], ["knife", "刀子", "Knife"], ["spoon", "湯匙", "Spoon"],
  ["bowl", "碗", "Bowl"], ["banana", "香蕉", "Banana"], ["apple", "蘋果", "Apple"], ["sandwich", "三明治", "Sandwich"], ["orange", "柳橙", "Orange"],
  ["broccoli", "花椰菜", "Broccoli"], ["carrot", "紅蘿蔔", "Carrot"], ["hot_dog", "熱狗", "Hot dog"], ["pizza", "披薩", "Pizza"],
  ["donut", "甜甜圈", "Donut"], ["cake", "蛋糕", "Cake"], ["chair", "椅子", "Chair"], ["couch", "沙發", "Couch"], ["potted_plant", "盆栽", "Potted plant"],
  ["bed", "床", "Bed"], ["dining_table", "餐桌", "Dining table"], ["toilet", "馬桶", "Toilet"], ["tv", "電視", "TV"], ["laptop", "筆電", "Laptop"],
  ["mouse", "滑鼠", "Mouse"], ["remote", "遙控器", "Remote"], ["keyboard", "鍵盤", "Keyboard"], ["cell_phone", "手機", "Cell phone"],
  ["microwave", "微波爐", "Microwave"], ["oven", "烤箱", "Oven"], ["toaster", "烤麵包機", "Toaster"], ["sink", "水槽", "Sink"],
  ["refrigerator", "冰箱", "Refrigerator"], ["book", "書", "Book"], ["clock", "時鐘", "Clock"], ["vase", "花瓶", "Vase"], ["scissors", "剪刀", "Scissors"],
  ["teddy_bear", "泰迪熊", "Teddy bear"], ["hair_drier", "吹風機", "Hair drier"], ["toothbrush", "牙刷", "Toothbrush"],
];

/** 前端預設列出的常用類別，依常用程度排序；其餘收在「更多類別」 */
export const COMMON_LABELS = ["person", "car", "motorcycle", "bicycle", "truck", "bus", "cat", "dog", "bird"] as const;

/** 常見的自備模型類別，有翻譯就顯示中文 */
const EXTRA_ZH: Record<string, string> = { package: "包裹", parcel: "包裹", face: "人臉", license_plate: "車牌", vehicle: "車輛", pet: "寵物", animal: "動物" };

const ZH: Record<string, string> = { ...Object.fromEntries(COCO_LABELS.map(([k, zh]) => [k, zh])), ...EXTRA_ZH };

/** 合法的鍵 */
export const LABEL_KEY = /^[a-z0-9_]{1,40}$/;

/** 與 detector/yolo.py 的 label_key 相同 */
export function labelKey(name: string, index = 0): string {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return key || `class_${index}`;
}

/** 鍵 → 中文；沒有翻譯就用原名（底線換空白） */
export const labelName = (key: string): string => ZH[key] ?? key.replace(/_/g, " ");

