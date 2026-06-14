import { loadRecent, loadRecentDetailed } from './src/loader/vscode-stable';
import { openInVSCode } from './src/launcher/vscode-stable';
import type { RecentItem, OpenResult } from './src/types';
import type { LoadDiagnostic } from './src/loader/vscode-stable';

// 类型补丁，前端可用
declare global {
  interface Window {
    recentApi: {
      list(): Promise<RecentItem[]>;
      open(item: RecentItem): Promise<OpenResult>;
      diagnose(): Promise<{ items: RecentItem[]; diag: LoadDiagnostic }>;
    };
    Fuse: any;
  }
}

(window as any).recentApi = {
  list: () => loadRecent(),
  open: (item: RecentItem) => openInVSCode(item),
  diagnose: () => loadRecentDetailed(),
};

// fuse.js 转发给前端（前端不能 require）。fuse.js v7 commonjs 入口暴露 default。
const FuseModule = require('fuse.js');
(window as any).Fuse = FuseModule.default ?? FuseModule;
