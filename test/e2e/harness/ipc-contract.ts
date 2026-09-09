/**
 * Tauri IPC Contract Definitions & Schema Validator
 * Authoritative source: src-tauri/src/lib.rs, audio_loopback.rs, screen_sources.rs, process_manager.rs
 */

export interface IpcCommandDef {
  name: string;
  requiredArgs: string[];
  optionalArgs: string[];
  argTypes: Record<string, string>;
  returnType: string;
}

export const TAURI_IPC_COMMANDS: Record<string, IpcCommandDef> = {
  list_audio_processes: {
    name: 'list_audio_processes',
    requiredArgs: [],
    optionalArgs: [],
    argTypes: {},
    returnType: 'array',
  },
  list_screen_sources: {
    name: 'list_screen_sources',
    requiredArgs: [],
    optionalArgs: [],
    argTypes: {},
    returnType: 'object', // ScreenSourcesResponse { monitors, windows }
  },
  start_native_screen_capture: {
    name: 'start_native_screen_capture',
    requiredArgs: ['sourceId'],
    optionalArgs: ['targetFps', 'targetWidth', 'targetHeight', 'captureMouse', 'quality'],
    argTypes: {
      sourceId: 'string',
      targetFps: 'number',
      targetWidth: 'number',
      targetHeight: 'number',
      captureMouse: 'boolean',
      quality: 'number',
    },
    returnType: 'boolean',
  },
  stop_native_screen_capture: {
    name: 'stop_native_screen_capture',
    requiredArgs: [],
    optionalArgs: [],
    argTypes: {},
    returnType: 'boolean',
  },
  start_audio_capture: {
    name: 'start_audio_capture',
    requiredArgs: [],
    optionalArgs: ['config'],
    argTypes: {
      config: 'object',
    },
    returnType: 'boolean',
  },
  stop_audio_capture: {
    name: 'stop_audio_capture',
    requiredArgs: [],
    optionalArgs: [],
    argTypes: {},
    returnType: 'boolean',
  },
  get_video_ws_port: {
    name: 'get_video_ws_port',
    requiredArgs: [],
    optionalArgs: [],
    argTypes: {},
    returnType: 'number',
  },
  write_frontend_log: {
    name: 'write_frontend_log',
    requiredArgs: ['level', 'message'],
    optionalArgs: ['context'],
    argTypes: {
      level: 'string',
      message: 'string',
      context: 'string',
    },
    returnType: 'void',
  },
  get_log_file_path: {
    name: 'get_log_file_path',
    requiredArgs: [],
    optionalArgs: [],
    argTypes: {},
    returnType: 'string',
  },
  open_log_folder: {
    name: 'open_log_folder',
    requiredArgs: [],
    optionalArgs: [],
    argTypes: {},
    returnType: 'boolean',
  },
  open_latest_log: {
    name: 'open_latest_log',
    requiredArgs: [],
    optionalArgs: [],
    argTypes: {},
    returnType: 'boolean',
  },
  clear_log_file: {
    name: 'clear_log_file',
    requiredArgs: [],
    optionalArgs: [],
    argTypes: {},
    returnType: 'boolean',
  },
};

export interface AudioConfigSchema {
  mode: string;
  target_pids: number[];
  target_names: string[];
  sample_rate: number;
}

export function validateAudioConfig(cfg: any): { valid: boolean; error?: string } {
  if (typeof cfg !== 'object' || cfg === null) {
    return { valid: false, error: 'AudioConfig must be a non-null object' };
  }
  if ('mode' in cfg && typeof cfg.mode !== 'string') {
    return { valid: false, error: 'AudioConfig.mode must be a string' };
  }
  if ('mode' in cfg && !['full', 'exclude', 'include'].includes(cfg.mode)) {
    return { valid: false, error: `Invalid AudioConfig.mode: ${cfg.mode}. Allowed: full, exclude, include` };
  }
  if ('target_pids' in cfg && !Array.isArray(cfg.target_pids)) {
    return { valid: false, error: 'AudioConfig.target_pids must be an array of numbers' };
  }
  if ('target_names' in cfg && !Array.isArray(cfg.target_names)) {
    return { valid: false, error: 'AudioConfig.target_names must be an array of strings' };
  }
  if ('sample_rate' in cfg && (typeof cfg.sample_rate !== 'number' || cfg.sample_rate <= 0)) {
    return { valid: false, error: 'AudioConfig.sample_rate must be a positive number' };
  }
  return { valid: true };
}

export function validateAudioStreamPayload(payload: any): { valid: boolean; error?: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, error: 'AudioStreamPayload must be a non-null object' };
  }
  if (typeof payload.pcm_base64 !== 'string') {
    return { valid: false, error: 'pcm_base64 must be a string' };
  }
  if (typeof payload.sample_rate !== 'number' || payload.sample_rate <= 0) {
    return { valid: false, error: 'sample_rate must be a positive number' };
  }
  if (typeof payload.channels !== 'number' || payload.channels < 1 || payload.channels > 8) {
    return { valid: false, error: 'channels must be a valid channel count (1-8)' };
  }
  if (typeof payload.rms_level !== 'number' || payload.rms_level < 0 || payload.rms_level > 1.0) {
    return { valid: false, error: 'rms_level must be between 0.0 and 1.0' };
  }
  return { valid: true };
}

export function validateIpcInvoke(cmd: string, args: Record<string, any> = {}): { valid: boolean; error?: string } {
  const def = TAURI_IPC_COMMANDS[cmd];
  if (!def) {
    return { valid: false, error: `Unknown Tauri command: "${cmd}"` };
  }

  for (const req of def.requiredArgs) {
    if (!(req in args) || args[req] === undefined || args[req] === null) {
      return { valid: false, error: `Missing required argument "${req}" for command "${cmd}"` };
    }
  }

  for (const [key, val] of Object.entries(args)) {
    const expectedType = def.argTypes[key];
    if (expectedType && val !== undefined && val !== null) {
      const actualType = Array.isArray(val) ? 'array' : typeof val;
      if (actualType !== expectedType) {
        return {
          valid: false,
          error: `Argument "${key}" for command "${cmd}" expected type ${expectedType}, got ${actualType}`,
        };
      }
    }
  }

  if (cmd === 'start_audio_capture' && args.config) {
    const configValidation = validateAudioConfig(args.config);
    if (!configValidation.valid) return configValidation;
  }

  return { valid: true };
}
