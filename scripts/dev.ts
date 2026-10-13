// 開發模式：tsc watch＋vite build watch＋核心 node --watch，三個子行程一起起、一起收（跨平台，不靠 shell 的 &）。
// 用法：npm run dev（需 Node 24 的原生型別剝離執行本檔）。

import { spawn, type ChildProcess } from 'node:child_process';

const bin = (name: string) => (process.platform === 'win32' ? `${name}.cmd` : name);
const shell = process.platform === 'win32';
let procs: ChildProcess[] = [];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// node --watch 若一開始找不到 dist/server/main.js 會停在「等待檔案變更」，之後 tsc 產出也不會啟動；先完整編譯一次。
const initial = spawn(bin('npx'), ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit', shell });
procs = [initial];
await new Promise<void>((resolve) => initial.on('exit', () => resolve()));

procs = [
  spawn(bin('npx'), ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit', shell }),
  spawn(bin('npx'), ['vite', 'build', '--watch'], { stdio: 'inherit', shell }),
  spawn(process.execPath, ['--watch', 'dist/server/main.js'], { stdio: 'inherit' }),
];
for (const p of procs) p.on('exit', (code) => code !== null && code !== 0 && process.stderr.write(`子行程結束（${code}）\n`));
