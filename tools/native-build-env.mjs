import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function configureNativeBuildEnvironment() {
  // Visual Studio bundles CMake without necessarily exposing it to ordinary terminals.
  if (process.platform === 'win32' && !process.env.CMAKE &&
      spawnSync('cmake', ['--version'], { stdio: 'ignore' }).status !== 0) {
    const standalone = join(process.env.ProgramFiles || 'C:\\Program Files', 'CMake', 'bin', 'cmake.exe');
    const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const bundled = existsSync(vswhere) ? spawnSync(vswhere,
      ['-products', '*', '-sort', '-find', 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'],
      { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/).find((path) => path && existsSync(path)) : undefined;
    const cmake = existsSync(standalone) ? standalone : bundled;
    if (cmake) {
      process.env.CMAKE = cmake;
      const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
      process.env[pathKey] = `${dirname(cmake)};${process.env[pathKey] || ''}`;
      console.log(`[Build] Using CMake: ${cmake}`);
    }
  }
}
