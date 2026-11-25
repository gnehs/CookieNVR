import type { MsgTable } from "./index.ts";

/** 狀態辨識：感應器設定驗證、問題提示、背景工作結果，以及 detector/classify.py 回報的訊息（Python 端送同樣的 code） */
export const states = {
  // 設定驗證
  "states.classNameNotString": ({ renamed }: { renamed: boolean }) => `${renamed ? "新的類別名稱" : "類別名稱"}必須是字串`,
  "states.classNameLength": ({ renamed }: { renamed: boolean }) => `${renamed ? "新的類別名稱" : "類別名稱"}要 1 到 32 字`,
  "states.classNameChars": ({ renamed }: { renamed: boolean }) => `${renamed ? "新的類別名稱" : "類別名稱"}不可含 / 或 \\，也不可以 . 開頭`,
  "states.cropInvalid": () => "區域必須是 4 個 0 到 1 的數字 [x1, y1, x2, y2]",
  "states.cropTooSmall": () => "區域太小，或左上角不在右下角的左上方",
  "states.thresholdRange": ({ min, max }: { min: number; max: number }) => `信心門檻必須是 ${min} 到 ${max} 的數字`,
  "states.intervalRange": ({ min, max }: { min: number; max: number }) => `辨識間隔必須是 ${min} 到 ${max} 的整數`,
  "states.flagNotBool": ({ field }: { field: string }) => `${field}必須是 true 或 false`,
  "states.configNotObject": () => "config 必須是物件",
  "states.nameLength": () => "名稱要 1 到 40 字",
  "states.classCount": ({ min, max }: { min: number; max: number }) => `類別要 ${min} 到 ${max} 個`,
  "states.classDuplicate": () => "類別名稱不可重複",
  "states.yamlParseFailed": ({ detail }: { detail: string }) => `看不懂這段 YAML：${detail}`,
  "states.frigateConfigNotFound": () => "找不到狀態辨識的設定（classification.custom.<名稱>.state_config.cameras.<攝影機>.crop）",
  "states.yamlNotString": () => "yaml 必須是字串",
  "states.cameraNotFound": () => "找不到這台攝影機",

  // 請求錯誤
  "states.sensorNotFound": () => "找不到這個狀態感應器",
  "states.imageNotFound": () => "找不到這張圖片",
  "states.noThumb": () => "沒有縮圖",
  "states.jobBusy": () => "這個感應器正在進行其他工作，請等它完成",
  "states.classNotFound": ({ name }: { name: string }) => `沒有「${name}」這個類別`,
  "states.classExists": ({ name }: { name: string }) => `已經有「${name}」這個類別`,
  "states.idsInvalid": () => "ids 必須是 1 到 1000 個圖片 id",
  "states.fileTooLarge": () => "檔案太大，上限 100 MB",
  "states.noFile": () => "沒有收到檔案",
  "states.notZip": () => "這不是 zip 檔",
  "states.notTrainable": ({ min }: { min: number }) => `每一類至少要有 ${min} 張已標記的圖片才能訓練`,

  // 感應器目前沒在辨識的原因
  "states.problemDisabled": () => "已暫停辨識",
  "states.problemUntrained": () => "還沒訓練：標記每一類的畫面後按「訓練」",
  "states.problemStaleModel": () => "類別改過了，要重新訓練才會繼續辨識",
  "states.problemBackboneFailed": () => "狀態辨識程序無法啟動：無法載入狀態辨識用的影像特徵模型",
  "states.problemWorkerFailed": ({ text }: { text: string }) => `狀態辨識程序無法啟動：${text}`,
  "states.problemWorkerStarting": () => "狀態辨識程序啟動中",
  "states.problemCameraOff": () => "攝影機沒有畫面",
  "states.problemPaused": () => "鏡頭移動中或畫面亮度突變，暫停辨識",

  // 背景工作結果
  "states.workerStartFailed": () => "狀態辨識程序無法啟動",
  "states.workerRestarted": () => "狀態辨識程序重新啟動，工作中斷，請再試一次",
  "states.trainDone": ({ accuracy }: { accuracy: number }) => `訓練完成，用標記的畫面驗證答對 ${accuracy}%`,
  "states.trainDoneNoValidation": () => "訓練完成（每一類至少要 2 張才能估計準確度）",
  "states.modelMissing": () => "訓練完成但讀不到模型檔",
  "states.collectDone": ({ count }: { count: number }) => `從錄影挑了 ${count} 張畫面放進待標記`,
  "states.collectUnsureDone": ({ count, sure }: { count: number; sure: number }) =>
    count ? `從錄影挑了 ${count} 張辨識沒把握的畫面放進待標記${sure ? `，另外 ${sure} 張辨識有把握，略過` : ""}` : `抽樣的 ${sure} 張畫面辨識都有把握，沒有要標記的`,
  "states.collectNoFrames": () => "從錄影抽不到畫面，錄影檔可能還沒寫完或已被清除",
  "states.collectNoRecordings": () => "這台還沒有錄影可以抽樣；等錄一段時間後再試，或匯入資料集",
  "states.importNoImages": () => "zip 裡找不到可以用的圖片（需要 <名稱>/dataset/<類別>/ 或 <名稱>/train/ 底下的 png、jpg、webp）",
  "states.importDone": ({ labeled, pending, added, skipped }: { labeled: number; pending: number; added: string[]; skipped: number }) => {
    const parts = [`匯入 ${labeled} 張已標記、${pending} 張待標記的圖片`];
    if (added.length) parts.push(`新增類別：${added.join("、")}`);
    if (skipped) parts.push(`${skipped} 張無法讀取已略過`);
    return parts.join("；");
  },

  // detector/statecls.py、classify.py 回報
  "states.backboneLoadFailed": () => "無法載入狀態辨識用的影像特徵模型",
  "states.classesWithoutImages": ({ classes }: { classes: string[] }) => `這些類別沒有可用的圖片：${classes.join("、")}`,
  "states.modelBackboneChanged": () => "模型是用不同版本的骨幹訓練的，需要重新訓練",
  "states.zipTooManyFiles": ({ count, max }: { count: number; max: number }) => `zip 裡的檔案太多（${count} 個，上限 ${max}）`,
} satisfies MsgTable;
