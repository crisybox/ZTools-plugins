import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import {
  createGif,
  mergeImages,
  mergePdfs,
  processImages
} from "../src/preload/processor";
import type { ImageJobSettings } from "../src/shared/types";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "image-batch-studio-"));
}

async function makeImage(filePath: string, width: number, height: number, color: string) {
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color
    }
  })
    .png()
    .toFile(filePath);
}

async function makePdf(filePath: string, text: string) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([240, 120]);
  page.drawText(text, { x: 24, y: 64, size: 18 });
  await fs.writeFile(filePath, await doc.save());
}

describe("offline processing engine", () => {
  it("converts, resizes, crops, adds border, and rounds corners", async () => {
    const dir = await makeTempDir();
    const input = path.join(dir, "source.png");
    const outputDir = path.join(dir, "out");
    await makeImage(input, 120, 90, "#2b7a78");

    const settings: ImageJobSettings = {
      output: { directory: outputDir, namingPattern: "{name}-processed.{ext}", overwrite: false },
      format: { type: "webp", quality: 82 },
      resize: { mode: "exact", width: 80, height: 60, withoutEnlargement: true },
      crop: { left: 10, top: 5, width: 70, height: 50 },
      border: { enabled: true, width: 4, color: "#efc46a" },
      rounded: { enabled: true, radius: 10 }
    };

    const [result] = await processImages([input], settings);

    expect(result.ok).toBe(true);
    expect(result.outputPath.endsWith("source-processed.webp")).toBe(true);
    const metadata = await sharp(result.outputPath).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(78);
    expect(metadata.height).toBe(58);
  });

  it("adds text watermarks and keeps output readable by sharp", async () => {
    const dir = await makeTempDir();
    const input = path.join(dir, "watermark.png");
    const outputDir = path.join(dir, "out");
    await makeImage(input, 100, 80, "#183a37");

    const [result] = await processImages([input], {
      output: { directory: outputDir, namingPattern: "{name}-wm.{ext}", overwrite: false },
      format: { type: "png" },
      watermark: {
        enabled: true,
        kind: "text",
        text: "ZTools",
        position: "center",
        opacity: 0.72,
        fontSize: 22,
        color: "#ffffff",
        margin: 12,
        rotation: -12
      }
    });

    expect(result.ok).toBe(true);
    const metadata = await sharp(result.outputPath).metadata();
    expect(metadata.width).toBe(100);
    expect(metadata.height).toBe(80);
  });

  it("adds image watermarks without changing canvas size", async () => {
    const dir = await makeTempDir();
    const input = path.join(dir, "base.png");
    const watermark = path.join(dir, "mark.png");
    const outputDir = path.join(dir, "out");
    await makeImage(input, 120, 80, "#000000");
    await makeImage(watermark, 20, 20, "#ff0000");

    const [result] = await processImages([input], {
      output: { directory: outputDir, namingPattern: "{name}-image-wm.{ext}", overwrite: false },
      format: { type: "png" },
      watermark: {
        enabled: true,
        kind: "image",
        imagePath: watermark,
        position: "center",
        opacity: 1,
        fontSize: 16,
        color: "#ffffff",
        margin: 0,
        rotation: 0
      }
    });

    expect(result.ok).toBe(true);
    const metadata = await sharp(result.outputPath).metadata();
    expect(metadata.width).toBe(120);
    expect(metadata.height).toBe(80);
    const centerPixel = await sharp(result.outputPath).extract({ left: 60, top: 40, width: 1, height: 1 }).raw().toBuffer();
    expect(centerPixel[0]).toBeGreaterThan(180);
    expect(centerPixel[1]).toBeLessThan(80);
    expect(centerPixel[2]).toBeLessThan(80);
  });

  it("rotates and flips images while preserving readable output", async () => {
    const dir = await makeTempDir();
    const input = path.join(dir, "rotate.png");
    const outputDir = path.join(dir, "out");
    await makeImage(input, 40, 20, "#335f9d");

    const [result] = await processImages([input], {
      output: { directory: outputDir, namingPattern: "{name}-rotated.{ext}", overwrite: false },
      format: { type: "png" },
      rotate: 90,
      flip: "horizontal"
    });

    expect(result.ok).toBe(true);
    const metadata = await sharp(result.outputPath).metadata();
    expect(metadata.width).toBe(20);
    expect(metadata.height).toBe(40);
  });

  it("ignores resize settings when both dimensions are empty", async () => {
    const dir = await makeTempDir();
    const input = path.join(dir, "no-resize.png");
    const outputDir = path.join(dir, "out");
    await makeImage(input, 48, 36, "#446a9d");

    const [result] = await processImages([input], {
      output: { directory: outputDir, namingPattern: "{name}-same.{ext}", overwrite: false },
      format: { type: "png" },
      resize: { mode: "fit", withoutEnlargement: true }
    });

    expect(result.ok).toBe(true);
    const metadata = await sharp(result.outputPath).metadata();
    expect(metadata.width).toBe(48);
    expect(metadata.height).toBe(36);
  });

  it("merges PDFs in input order", async () => {
    const dir = await makeTempDir();
    const first = path.join(dir, "a.pdf");
    const second = path.join(dir, "b.pdf");
    const output = path.join(dir, "merged.pdf");
    await makePdf(first, "A");
    await makePdf(second, "B");

    await mergePdfs([first, second], output);

    const merged = await PDFDocument.load(await fs.readFile(output));
    expect(merged.getPageCount()).toBe(2);
  });

  it("merges images vertically with stable dimensions", async () => {
    const dir = await makeTempDir();
    const first = path.join(dir, "one.png");
    const second = path.join(dir, "two.png");
    const output = path.join(dir, "joined.png");
    await makeImage(first, 40, 20, "#b4483f");
    await makeImage(second, 40, 30, "#1f6f68");

    await mergeImages([first, second], output, {
      layout: "vertical",
      gap: 6,
      background: "#f6f0df"
    });

    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(40);
    expect(metadata.height).toBe(56);
  });

  it("merges images horizontally and in a grid with stable dimensions", async () => {
    const dir = await makeTempDir();
    const first = path.join(dir, "one.png");
    const second = path.join(dir, "two.png");
    const third = path.join(dir, "three.png");
    const horizontal = path.join(dir, "horizontal.png");
    const grid = path.join(dir, "grid.png");
    await makeImage(first, 40, 20, "#b4483f");
    await makeImage(second, 30, 30, "#1f6f68");
    await makeImage(third, 20, 10, "#d49b3d");

    await mergeImages([first, second], horizontal, {
      layout: "horizontal",
      gap: 6,
      background: "#ffffff"
    });
    await mergeImages([first, second, third], grid, {
      layout: "grid",
      columns: 2,
      gap: 5,
      background: "#ffffff"
    });

    const horizontalMeta = await sharp(horizontal).metadata();
    expect(horizontalMeta.width).toBe(76);
    expect(horizontalMeta.height).toBe(30);
    const gridMeta = await sharp(grid).metadata();
    expect(gridMeta.width).toBe(85);
    expect(gridMeta.height).toBe(65);
  });

  it("rejects unsafe merge gaps before creating a huge canvas", async () => {
    const dir = await makeTempDir();
    const first = path.join(dir, "one.png");
    const second = path.join(dir, "two.png");
    const output = path.join(dir, "unsafe-gap.png");
    await makeImage(first, 40, 20, "#b4483f");
    await makeImage(second, 40, 30, "#1f6f68");

    await expect(
      mergeImages([first, second], output, {
        layout: "vertical",
        gap: 5000,
        background: "#ffffff"
      })
    ).rejects.toThrow("拼图间距不能超过");
    await expect(fs.stat(output)).rejects.toThrow();
  });

  it("creates an animated GIF from local images", async () => {
    const dir = await makeTempDir();
    const first = path.join(dir, "one.png");
    const second = path.join(dir, "two.png");
    const output = path.join(dir, "motion.gif");
    await makeImage(first, 32, 24, "#d49b3d");
    await makeImage(second, 32, 24, "#1f6f68");

    await createGif([first, second], output, {
      width: 32,
      height: 24,
      delayMs: 120,
      loop: 0
    });

    const metadata = await sharp(output, { animated: true }).metadata();
    expect(metadata.format).toBe("gif");
    expect(metadata.pages).toBe(2);
  });
});
