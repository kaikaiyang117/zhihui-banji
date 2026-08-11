import type { Database } from 'better-sqlite3';

import { getDb } from '../services/context.js';
import { deleteSettings, readSecret, writeSecret } from '../services/secretStore.js';

export const MODEL_SETTING_KEYS = ['model_base_url', 'model_name', 'model_api_key', 'model_thinking'] as const;
const MODEL_SECRET_FILE = 'agent-model.json';

export class ModelConfigError extends Error {}

export interface ModelConfigOptions {
  api_key: string;
  base_url: string;
  model: string;
  timeout_seconds?: number;
  thinking?: string;
  temperature?: number;
}

export class ModelConfig {
  readonly api_key: string;
  readonly base_url: string;
  readonly model: string;
  readonly timeout_seconds: number;
  readonly thinking: string;
  readonly temperature: number;

  constructor(options: ModelConfigOptions) {
    this.api_key = options.api_key;
    this.base_url = options.base_url;
    this.model = options.model;
    this.timeout_seconds = options.timeout_seconds ?? 45;
    this.thinking = options.thinking ?? 'disabled';
    this.temperature = options.temperature ?? 0.2;
  }

  static fromEnv(): ModelConfig {
    return new ModelConfig(loadConfig());
  }

  get configured(): boolean {
    return Boolean(this.api_key && this.model && this.base_url);
  }
}

function connOf(conn?: Database): Database {
  return conn ?? getDb().connInstance;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function loadStoredFromDb(db: Database): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of db.prepare(
    `SELECT key, value FROM agent_settings WHERE key IN (${MODEL_SETTING_KEYS.map(() => '?').join(',')})`,
  ).all(...MODEL_SETTING_KEYS) as Array<{ key: string; value: string }>) {
    result[row.key] = row.value;
  }
  return result;
}

function loadStored(db: Database): Record<string, string> {
  const file = readSecret<Record<string, unknown>>(MODEL_SECRET_FILE);
  if (file) {
    return Object.fromEntries(MODEL_SETTING_KEYS.map((key) => [key, String(file[key] ?? '')]));
  }
  const stored = loadStoredFromDb(db);
  if (Object.values(stored).some(Boolean)) {
    writeSecret(MODEL_SECRET_FILE, stored);
    deleteSettings(db, MODEL_SETTING_KEYS);
  }
  return stored;
}

export function migrateStoredConfig(conn?: Database): void {
  const db = conn ?? getDb().connInstance;
  const file = readSecret<Record<string, unknown>>(MODEL_SECRET_FILE);
  const stored = loadStoredFromDb(db);
  if (!file && Object.values(stored).some(Boolean)) writeSecret(MODEL_SECRET_FILE, stored);
  if (Object.keys(stored).length > 0) deleteSettings(db, MODEL_SETTING_KEYS);
}

export function loadConfig(conn?: Database): ModelConfigOptions {
  const stored = loadStored(connOf(conn));
  const env = (name: string): string => String(process.env[name] ?? '');
  const apiKey = env('MEIMEI_MODEL_API_KEY') || env('OPENAI_API_KEY') || stored['model_api_key'] || '';
  const baseUrl = (env('MEIMEI_MODEL_BASE_URL') || stored['model_base_url'] || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = (env('MEIMEI_MODEL_NAME') || stored['model_name'] || '').trim();
  let thinking = (env('MEIMEI_MODEL_THINKING') || stored['model_thinking'] || 'disabled').trim().toLowerCase();
  if (thinking !== 'disabled' && thinking !== 'enabled') {
    thinking = 'disabled';
  }
  let timeout = 45;
  const parsed = Number(env('MEIMEI_MODEL_TIMEOUT') || '45');
  if (Number.isFinite(parsed)) {
    timeout = Math.max(5, Math.min(parsed, 180));
  }
  let temperature = 0.2;
  const parsedTemperature = Number(env('MEIMEI_MODEL_TEMPERATURE'));
  if (Number.isFinite(parsedTemperature) && String(env('MEIMEI_MODEL_TEMPERATURE')).trim() !== '') {
    temperature = Math.max(0, Math.min(parsedTemperature, 2));
  }
  return { api_key: apiKey, base_url: baseUrl, model, thinking, timeout_seconds: timeout, temperature };
}

export function saveConfig(
  input: {
    api_key?: string | null;
    base_url: string;
    model: string;
    thinking: string;
    clear_api_key?: boolean;
  },
  conn?: Database,
): Record<string, unknown> {
  const db = connOf(conn);
  const thinking = text(input.thinking) || 'disabled';
  if (thinking !== 'disabled' && thinking !== 'enabled') {
    throw new ModelConfigError('thinking 只能是 disabled 或 enabled');
  }
  const baseUrl = text(input.base_url).replace(/\/+$/, '');
  const model = text(input.model);
  if (!baseUrl) throw new ModelConfigError('base_url 必填');
  if (!model) throw new ModelConfigError('model 必填');
  const current = loadStored(db);
  const values: Record<string, string> = { ...current };
  if (input.clear_api_key) {
    values['model_api_key'] = '';
  } else if (input.api_key) {
    values['model_api_key'] = text(input.api_key);
  }
  values['model_base_url'] = baseUrl;
  values['model_name'] = model;
  values['model_thinking'] = thinking;
  writeSecret(MODEL_SECRET_FILE, values);
  deleteSettings(db, MODEL_SETTING_KEYS);
  return publicConfig({
    api_key: values['model_api_key'],
    base_url: values['model_base_url'],
    model: values['model_name'],
    thinking: values['model_thinking'],
  });
}

export function publicConfig(values: Record<string, unknown>): Record<string, unknown> {
  const apiKey = text(values.api_key);
  return {
    api_key_set: Boolean(apiKey),
    api_key_masked: mask(apiKey),
    base_url: text(values.base_url),
    model: text(values.model),
    thinking: text(values.thinking) || 'disabled',
  };
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
