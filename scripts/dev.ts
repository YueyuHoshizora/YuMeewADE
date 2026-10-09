// 開發模式：tsc watch＋vite build watch＋核心 node --watch，三個子行程一起起、一起收（跨平台，不靠 shell 的 &）。
// 用法：npm run dev（需 Node 24 的原生型別剝離執行本檔）。

import { spawn, type ChildProcess } from 'node:child_process';

const bin = (name: string) => (process.platform === 'win32' ? `${name}.cmd` : name);
const procs: ChildProcess[] = [
  spawn(bin('npx'), ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(bin('npx'), ['vite', 'build', '--watch'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(process.execPath, ['--watch', 'dist/server/main.js'], { stdio: 'inherit' }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code !== null && code !== 0 && process.stderr.write(`子行程結束（${code}）\n`));
