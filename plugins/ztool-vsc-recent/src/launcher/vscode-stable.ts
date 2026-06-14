import { spawn } from 'child_process';
import type { OpenResult, RecentItem } from '../types';

/**
 * 用 PATH 上的 `code` 命令打开项目。
 * Windows 下 PATH 中的 code 是 code.cmd，所以必须 shell: true。
 */
export function openInVSCode(item: RecentItem): Promise<OpenResult> {
  const args = item.kind === 'remote'
    ? ['--folder-uri', item.rawPath]
    : [quoteIfNeeded(item.rawPath)];

  return new Promise<OpenResult>(resolve => {
    let settled = false;
    const settle = (r: OpenResult) => { if (!settled) { settled = true; resolve(r); } };

    try {
      const child = spawn('code', args, { detached: true, stdio: 'ignore', shell: true });
      child.on('error', e => settle({ ok: false, reason: e.message }));
      child.unref();
      // 给 spawn 一个 tick 触发同步错误（如 ENOENT），再 resolve ok
      setTimeout(() => settle({ ok: true }), 50);
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      settle({ ok: false, reason });
    }
  });
}

/**
 * shell:true 下含空格的路径需要带双引号。
 */
function quoteIfNeeded(p: string): string {
  if (p.includes('"')) return p;          // 不重复加
  if (/[\s&()]/.test(p)) return `"${p}"`;
  return p;
}
