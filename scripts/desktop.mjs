import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, ['dist/desktop.js'], { stdio: 'inherit', windowsHide: true, env: { ...process.env, AGILEDEV_NODE_PATH: process.execPath } });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
