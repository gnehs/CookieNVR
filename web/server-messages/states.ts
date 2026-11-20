import { t } from "@lingui/core/macro";
import type { states as zh } from "../../src/messages/states.ts";
import { joinList } from "../format.ts";
import type { Translations } from "../server-text.ts";

export const states: Translations<typeof zh> = {
  "states.classNameNotString": ({ renamed }) => (renamed ? t`New class name must be a string` : t`Class name must be a string`),
  "states.classNameLength": ({ renamed }) => (renamed ? t`New class name must be 1 to 32 characters` : t`Class name must be 1 to 32 characters`),
  "states.classNameChars": ({ renamed }) =>
    renamed ? t`New class name can't contain / or a backslash, or start with a dot` : t`Class name can't contain / or a backslash, or start with a dot`,
  "states.cropInvalid": () => t`The region must be 4 numbers from 0 to 1: [x1, y1, x2, y2]`,
  "states.cropTooSmall": () => t`The region is too small, or its top-left corner isn't above and left of the bottom-right`,
  "states.thresholdRange": ({ min, max }) => t`Confidence threshold must be a number from ${min} to ${max}`,
  "states.intervalRange": ({ min, max }) => t`Detection interval must be an integer from ${min} to ${max}`,
  "states.flagNotBool": ({ field }) => t`${field} must be true or false`,
  "states.configNotObject": () => t`config must be an object`,
  "states.nameLength": () => t`Name must be 1 to 40 characters`,
  "states.classCount": ({ min, max }) => t`Provide ${min} to ${max} classes`,
  "states.classDuplicate": () => t`Class names must be unique`,
  "states.yamlParseFailed": ({ detail }) => t`Couldn't parse this YAML: ${detail}`,
  "states.frigateConfigNotFound": () => t`No state classification config found (classification.custom.<name>.state_config.cameras.<camera>.crop)`,
  "states.yamlNotString": () => t`yaml must be a string`,
  "states.cameraNotFound": () => t`Camera not found`,

  "states.sensorNotFound": () => t`State sensor not found`,
  "states.imageNotFound": () => t`Image not found`,
  "states.noThumb": () => t`No thumbnail`,
  "states.jobBusy": () => t`This sensor is busy with another task. Wait for it to finish`,
  "states.classNotFound": ({ name }) => t`There is no class "${name}"`,
  "states.classExists": ({ name }) => t`The class "${name}" already exists`,
  "states.idsInvalid": () => t`ids must be 1 to 1000 image ids`,
  "states.fileTooLarge": () => t`File too large. The limit is 100 MB`,
  "states.noFile": () => t`No file received`,
  "states.notZip": () => t`This isn't a zip file`,
  "states.notTrainable": ({ min }) => t`Each class needs at least ${min} labeled images before training`,

  "states.problemDisabled": () => t`Detection paused`,
  "states.problemUntrained": () => t`Not trained yet: label frames for every class, then press Train`,
  "states.problemStaleModel": () => t`The classes changed. Retrain to resume detection`,
  "states.problemBackboneFailed": () => t`The classifier couldn't start: failed to load the image feature model`,
  "states.problemWorkerFailed": ({ text }) => t`The classifier couldn't start: ${text}`,
  "states.problemWorkerStarting": () => t`The classifier is starting`,
  "states.problemCameraOff": () => t`The camera has no picture`,
  "states.problemPaused": () => t`Detection paused: the camera is moving or the brightness changed suddenly`,

  "states.workerStartFailed": () => t`The classifier couldn't start`,
  "states.workerRestarted": () => t`The classifier restarted and the task was interrupted. Try again`,
  "states.trainDone": ({ accuracy }) => t`Training finished. ${accuracy}% correct on the labeled frames`,
  "states.trainDoneNoValidation": () => t`Training finished (each class needs at least 2 images to estimate accuracy)`,
  "states.modelMissing": () => t`Training finished but the model file couldn't be read`,
  "states.collectDone": ({ count }) => t`Picked ${count} frames from recordings and added them to unlabeled`,
  "states.collectNoFrames": () => t`Couldn't get any frames from recordings. The files may still be writing or already removed`,
  "states.collectNoRecordings": () => t`This camera has no recordings to sample yet. Try again after it has recorded for a while, or import a dataset`,
  "states.importNoImages": () => t`No usable images found in the zip (expected png, jpg or webp under <name>/dataset/<class>/ or <name>/train/)`,
  "states.importDone": ({ labeled, pending, added, skipped }) => {
    const parts = [t`Imported ${labeled} labeled and ${pending} unlabeled images`];
    if (added.length) {
      const list = joinList(added);
      parts.push(t`Added classes: ${list}`);
    }
    if (skipped) parts.push(t`${skipped} unreadable images skipped`);
    return parts.join(t`; `);
  },

  "states.backboneLoadFailed": () => t`Couldn't load the image feature model for state classification`,
  "states.classesWithoutImages": ({ classes }) => {
    const list = joinList(classes);
    return t`These classes have no usable images: ${list}`;
  },
  "states.modelBackboneChanged": () => t`The model was trained with a different backbone version. Retrain it`,
  "states.zipTooManyFiles": ({ count, max }) => t`The zip has too many files (${count}, limit ${max})`,
};
