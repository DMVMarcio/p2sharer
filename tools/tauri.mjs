import { configureNativeBuildEnvironment } from './native-build-env.mjs';

configureNativeBuildEnvironment();

// Delegate all arguments to the installed CLI; keep Cargo's normal target directory.
await import('@tauri-apps/cli/tauri.js');
