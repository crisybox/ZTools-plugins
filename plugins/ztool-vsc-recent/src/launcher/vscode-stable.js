"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openInVSCode = openInVSCode;
const child_process_1 = require("child_process");
/**
 * 用 PATH 上的 `code` 命令打开项目。
 * Windows 下 PATH 中的 code 是 code.cmd，所以必须 shell: true。
 */
function openInVSCode(item) {
    const args = item.kind === 'remote'
        ? ['--folder-uri', item.rawPath]
        : [quoteIfNeeded(item.rawPath)];
    return new Promise(resolve => {
        let settled = false;
        const settle = (r) => { if (!settled) {
            settled = true;
            resolve(r);
        } };
        try {
            const child = (0, child_process_1.spawn)('code', args, { detached: true, stdio: 'ignore', shell: true });
            child.on('error', e => settle({ ok: false, reason: e.message }));
            child.unref();
            // 给 spawn 一个 tick 触发同步错误（如 ENOENT），再 resolve ok
            setTimeout(() => settle({ ok: true }), 50);
        }
        catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            settle({ ok: false, reason });
        }
    });
}
/**
 * shell:true 下含空格的路径需要带双引号。
 */
function quoteIfNeeded(p) {
    if (p.includes('"'))
        return p; // 不重复加
    if (/[\s&()]/.test(p))
        return `"${p}"`;
    return p;
}
