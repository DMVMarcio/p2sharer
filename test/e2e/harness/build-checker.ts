/**
 * Build & Compiler Integrity Checker Harness
 * Authoritative source: ORIGINAL_REQUEST.md Verification Resources
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const TAURI_ROOT = resolve(PROJECT_ROOT, 'src-tauri');

export interface BuildCheckResult {
  passed: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export function checkTypeScriptCompilation(): BuildCheckResult {
  try {
    const stdout = execSync('pnpm exec tsc --noEmit', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, stdout, stderr: '' };
  } catch (err: any) {
    return {
      passed: false,
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
      error: err.message,
    };
  }
}

function resolveCargoPath(): string {
  const userProfile = process.env.USERPROFILE || '';
  const candidate = resolve(userProfile, '.cargo', 'bin', 'cargo.exe');
  if (existsSync(candidate)) {
    return `"${candidate}"`;
  }
  return 'cargo';
}

export function checkCargoCompilation(): BuildCheckResult {
  try {
    const cargoCmd = resolveCargoPath();
    const stdout = execSync(`${cargoCmd} check`, {
      cwd: TAURI_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, stdout, stderr: '' };
  } catch (err: any) {
    return {
      passed: false,
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
      error: err.message,
    };
  }
}

export function verifyConfigFileIntegrity(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const checkJson = (path: string, name: string) => {
    if (!existsSync(path)) {
      errors.push(`Missing config file: ${name} (${path})`);
      return;
    }
    try {
      let raw = readFileSync(path, 'utf-8');
      // Strip comments for JSONC files like tsconfig.json
      raw = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1');
      JSON.parse(raw);
    } catch (e: any) {
      errors.push(`Invalid JSON in ${name}: ${e.message}`);
    }
  };

  checkJson(resolve(PROJECT_ROOT, 'package.json'), 'package.json');
  checkJson(resolve(PROJECT_ROOT, 'tsconfig.json'), 'tsconfig.json');
  checkJson(resolve(TAURI_ROOT, 'tauri.conf.json'), 'src-tauri/tauri.conf.json');

  const cargoTomlPath = resolve(TAURI_ROOT, 'Cargo.toml');
  if (!existsSync(cargoTomlPath)) {
    errors.push(`Missing Cargo.toml at ${cargoTomlPath}`);
  } else {
    const rawCargo = readFileSync(cargoTomlPath, 'utf-8');
    if (!rawCargo.includes('[package]') || !rawCargo.includes('name = "p2sharer"')) {
      errors.push('Cargo.toml missing required package definition');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
