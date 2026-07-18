import { describe, expect, it } from "vitest";
import { getConfig } from "./config.js";

describe("server configuration", () => {
  it("keeps JSON control bounded while exposing independent content limits", () => {
    const config = getConfig({});

    expect(config.jsonControlMaxBytes).toBe(1024 * 1024);
    expect(config.realtimeFrameMaxBytes).toBe(256 * 1024);
    expect(config.contentChunkMaxBytes).toBe(256 * 1024);
    expect(config.storageQuotaBytes).toBe(10 * 1024 * 1024 * 1024);
    expect(config.maintenanceBatchSize).toBe(100);
    expect(config.contentUploadExpiryMs).toBe(24 * 60 * 60 * 1000);
    expect(config.sessionIdleTimeoutMs).toBe(30 * 60 * 1000);
    expect(config.sessionAbsoluteTimeoutMs).toBe(24 * 60 * 60 * 1000);
  });

  it("parses explicit operational capacity without creating a per-note limit", () => {
    const config = getConfig({
      CONTENT_CHUNK_MAX_BYTES: "131072",
      CONTENT_UPLOAD_EXPIRY_MS: "3600000",
      MAINTENANCE_BATCH_SIZE: "25",
      REALTIME_FRAME_MAX_BYTES: "65536",
      SESSION_ABSOLUTE_TIMEOUT_MS: "7200000",
      STORAGE_QUOTA_BYTES: "21474836480"
    });

    expect(config.contentChunkMaxBytes).toBe(131072);
    expect(config.contentUploadExpiryMs).toBe(3600000);
    expect(config.maintenanceBatchSize).toBe(25);
    expect(config.realtimeFrameMaxBytes).toBe(65536);
    expect(config.sessionAbsoluteTimeoutMs).toBe(7200000);
    expect(config.storageQuotaBytes).toBe(21474836480);
    expect("noteMaxBytes" in config).toBe(false);
  });

  it.each([
    ["CONTENT_CHUNK_MAX_BYTES", "0"],
    ["CONTENT_UPLOAD_EXPIRY_MS", "NaN"],
    ["MAINTENANCE_BATCH_SIZE", "1.5"],
    ["REALTIME_FRAME_MAX_BYTES", "-1"],
    ["SESSION_ABSOLUTE_TIMEOUT_MS", "0"],
    ["STORAGE_QUOTA_BYTES", "9007199254740992"]
  ])("rejects unsafe %s values", (name, value) => {
    expect(() => getConfig({ [name]: value })).toThrow(`Invalid ${name}`);
  });
});
