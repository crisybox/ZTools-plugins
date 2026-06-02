import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { SourceFile } from "../shared/types";

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".tif", ".tiff", ".gif"]);
const pdfExtensions = new Set([".pdf"]);
const excludedDirectories = new Set([".git", "node_modules", ".DS_Store"]);

export function isImagePath(filePath: string): boolean {
  return imageExtensions.has(path.extname(filePath).toLowerCase());
}

export function isPdfPath(filePath: string): boolean {
  return pdfExtensions.has(path.extname(filePath).toLowerCase());
}

export async function discoverFiles(paths: string[]): Promise<SourceFile[]> {
  const discovered: SourceFile[] = [];
  const seen = new Set<string>();

  for (const itemPath of paths) {
    const resolved = path.resolve(itemPath);
    const files = await walk(resolved);
    for (const file of files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      discovered.push(file);
    }
  }

  return discovered;
}

async function walk(targetPath: string): Promise<SourceFile[]> {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat) return [];

  if (stat.isDirectory()) {
    if (excludedDirectories.has(path.basename(targetPath))) return [];
    const children = await fs.readdir(targetPath).catch(() => [] as string[]);
    const all: SourceFile[] = [];
    for (const child of children) {
      all.push(...(await walk(path.join(targetPath, child))));
    }
    return all;
  }

  if (!stat.isFile()) return [];
  if (!isImagePath(targetPath) && !isPdfPath(targetPath)) return [];
  return [await inspectFile(targetPath)];
}

export async function inspectFile(filePath: string): Promise<SourceFile> {
  const stat = await fs.stat(filePath);
  const base = {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size
  };

  if (isPdfPath(filePath)) {
    return { ...base, type: "pdf" };
  }

  if (isImagePath(filePath)) {
    const metadata = await sharp(filePath, { animated: true }).metadata().catch(() => null);
    return {
      ...base,
      type: "image",
      width: metadata?.width,
      height: metadata?.height,
      format: metadata?.format
    };
  }

  return { ...base, type: "unknown" };
}
