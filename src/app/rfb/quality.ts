import type { RFBQualityMode } from "./client.ts";

const qualityModes = new Set<RFBQualityMode>(["auto", "sharp", "smooth"]);

interface QualityStorageReader {
  getItem(key: string): string | null;
}

interface QualityStorageWriter {
  setItem(key: string, value: string): void;
}

export function qualityStorageKey(hostID: string): string {
  return `crabfleet.desktop.quality.${hostID}`;
}

export function loadViewerQuality(storage: QualityStorageReader, hostID: string): RFBQualityMode {
  const value = storage.getItem(qualityStorageKey(hostID));
  return value && qualityModes.has(value as RFBQualityMode) ? (value as RFBQualityMode) : "auto";
}

export function saveViewerQuality(
  storage: QualityStorageWriter,
  hostID: string,
  mode: RFBQualityMode,
): void {
  storage.setItem(qualityStorageKey(hostID), mode);
}
