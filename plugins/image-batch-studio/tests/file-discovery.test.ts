import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { discoverFiles } from "../src/preload/file-discovery";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "image-batch-discovery-"));
}

async function makeImage(filePath: string) {
  await sharp({
    create: {
      width: 12,
      height: 8,
      channels: 4,
      background: "#48a5d8"
    }
  })
    .png()
    .toFile(filePath);
}

describe("file discovery", () => {
  it("continues scanning when a child directory cannot be read", async () => {
    const dir = await makeTempDir();
    const readable = path.join(dir, "readable.png");
    const blocked = path.join(dir, "blocked");
    const blockedImage = path.join(blocked, "hidden.png");
    await fs.mkdir(blocked);
    await makeImage(readable);

    const originalReaddir = fs.readdir;
    const readdir = vi.spyOn(fs, "readdir");
    readdir.mockImplementation(async (targetPath, options) => {
      if (String(targetPath) === blocked) {
        throw new Error("permission denied");
      }
      return originalReaddir(targetPath, options as never) as unknown as ReturnType<typeof fs.readdir>;
    });

    try {
      const files = await discoverFiles([dir]);

      expect(files.map((file) => file.path)).toEqual([readable]);
      expect(files.some((file) => file.path === blockedImage)).toBe(false);
    } finally {
      readdir.mockRestore();
    }
  });
});
