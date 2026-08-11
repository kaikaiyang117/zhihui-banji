import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { getDb } from '../services/context.js';
import { deleteSettings, readSecret, writeSecret } from '../services/secretStore.js';

export const MODEL_SETTING_KEYS = ['model_base_url', 'model_name', 'model_api_key', 'model_thinking'] as const;
const MODEL_SECRET_FILE = 'agent-model.json';
const MODEL_STORE_VERSION = 2;
const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_PROFILE_NAME = '默认配置';

export class ModelConfigError extends Error {}

export interface ModelConfigOptions {
  api_key: string;
  base_url: string;
  model: string;
  timeout_seconds?: number;
  thinking?: string;
  temperature?: number;
  profile_id?: string;
  profile_name?: string;
}

interface StoredProfile {
  name: string;
  model_base_url: string;
  model_name: string;
  model_api_key: string;
  model_thinking: string;
}

interface StoredProfileStore {
  version: 2;
  active_profile_id: string;
  profiles: Record<string, StoredProfile>;
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

function apiKeyText(value: unknown): string {
  const normalized = text(value);
  return normalized === 'null' || normalized === 'undefined' ? '' : normalized;
}

function emptyProfile(name = DEFAULT_PROFILE_NAME): StoredProfile {
  return {
    name,
    model_base_url: '',
    model_name: '',
    model_api_key: '',
    model_thinking: 'disabled',
  };
}

function normalizeProfile(value: unknown, fallbackName = DEFAULT_PROFILE_NAME): StoredProfile {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const thinking = text(source.model_thinking).toLowerCase();
  return {
    name: text(source.name) || fallbackName,
    model_base_url: text(source.model_base_url),
    model_name: text(source.model_name),
    model_api_key: apiKeyText(source.model_api_key),
    model_thinking: thinking === 'enabled' ? 'enabled' : 'disabled',
  };
}

function emptyStore(): StoredProfileStore {
  return {
    version: MODEL_STORE_VERSION,
    active_profile_id: DEFAULT_PROFILE_ID,
    profiles: { [DEFAULT_PROFILE_ID]: emptyProfile() },
  };
}

function storeFromLegacy(value: unknown): StoredProfileStore {
  const store = emptyStore();
  store.profiles[DEFAULT_PROFILE_ID] = normalizeProfile({
    ...(value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}),
    name: DEFAULT_PROFILE_NAME,
  });
  return store;
}

function isProfileStore(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Number((value as Record<string, unknown>).version) === MODEL_STORE_VERSION
    && (value as Record<string, unknown>).profiles
    && typeof (value as Record<string, unknown>).profiles === 'object');
}

function activeProfile(store: StoredProfileStore): { id: string; profile: StoredProfile } {
  if (store.profiles[store.active_profile_id]) {
    return { id: store.active_profile_id, profile: store.profiles[store.active_profile_id] };
  }
  const first = Object.entries(store.profiles)[0];
  if (first) {
    store.active_profile_id = first[0];
    return { id: first[0], profile: first[1] };
  }
  const fallback = emptyProfile();
  store.profiles[DEFAULT_PROFILE_ID] = fallback;
  store.active_profile_id = DEFAULT_PROFILE_ID;
  return { id: DEFAULT_PROFILE_ID, profile: fallback };
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

function persistStore(store: StoredProfileStore): void {
  writeSecret(MODEL_SECRET_FILE, store as unknown as Record<string, unknown>);
}

function loadStore(db: Database): StoredProfileStore {
  const file = readSecret<Record<string, unknown>>(MODEL_SECRET_FILE);
  if (isProfileStore(file)) {
    const rawProfiles = file.profiles as Record<string, unknown>;
    const profiles = Object.fromEntries(Object.entries(rawProfiles).map(([id, value]) => [
      id,
      normalizeProfile(value, id === DEFAULT_PROFILE_ID ? DEFAULT_PROFILE_NAME : '模型配置'),
    ]));
    const store: StoredProfileStore = {
      version: MODEL_STORE_VERSION,
      active_profile_id: text(file.active_profile_id),
      profiles,
    };
    activeProfile(store);
    return store;
  }
  if (file) {
    const store = storeFromLegacy(file);
    persistStore(store);
    return store;
  }

  const stored = loadStoredFromDb(db);
  if (Object.values(stored).some(Boolean)) {
    const store = storeFromLegacy(stored);
    persistStore(store);
    deleteSettings(db, MODEL_SETTING_KEYS);
    return store;
  }
  return emptyStore();
}

export function migrateStoredConfig(conn?: Database): void {
  const db = conn ?? getDb().connInstance;
  loadStore(db);
  deleteSettings(db, MODEL_SETTING_KEYS);
}

export function listProfiles(conn?: Database): { active_profile_id: string; profiles: Array<Record<string, unknown>> } {
  const store = loadStore(connOf(conn));
  const active = activeProfile(store);
  return {
    active_profile_id: active.id,
    profiles: Object.entries(store.profiles).map(([id, profile]) => publicProfile(id, profile)),
  };
}

export function loadConfig(conn?: Database): ModelConfigOptions {
  const store = loadStore(connOf(conn));
  const active = activeProfile(store);
  const profile = active.profile;
  const env = (name: string): string => String(process.env[name] ?? '');
  const apiKey = apiKeyText(env('MEIMEI_MODEL_API_KEY'))
    || apiKeyText(env('OPENAI_API_KEY'))
    || apiKeyText(profile.model_api_key);
  const baseUrl = (env('MEIMEI_MODEL_BASE_URL') || profile.model_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = (env('MEIMEI_MODEL_NAME') || profile.model_name || '').trim();
  let thinking = (env('MEIMEI_MODEL_THINKING') || profile.model_thinking || 'disabled').trim().toLowerCase();
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
  return {
    api_key: apiKey,
    base_url: baseUrl,
    model,
    thinking,
    timeout_seconds: timeout,
    temperature,
    profile_id: active.id,
    profile_name: profile.name,
  };
}

function validateConfig(input: { base_url: string; model: string; thinking: string }): { baseUrl: string; model: string; thinking: string } {
  const thinking = text(input.thinking) || 'disabled';
  if (thinking !== 'disabled' && thinking !== 'enabled') {
    throw new ModelConfigError('thinking 只能是 disabled 或 enabled');
  }
  const baseUrl = text(input.base_url).replace(/\/+$/, '');
  const model = text(input.model);
  if (!baseUrl) throw new ModelConfigError('base_url 必填');
  if (!model) throw new ModelConfigError('model 必填');
  return { baseUrl, model, thinking };
}

export function saveConfig(
  input: {
    api_key?: string | null;
    base_url: string;
    model: string;
    thinking: string;
    clear_api_key?: boolean;
    profile_id?: string;
    profile_name?: string;
  },
  conn?: Database,
): Record<string, unknown> {
  const db = connOf(conn);
  const validated = validateConfig(input);
  const store = loadStore(db);
  const active = activeProfile(store);
  const profileId = text(input.profile_id) || active.id;
  const current = store.profiles[profileId];
  if (!current) throw new ModelConfigError('配置档案不存在');
  const profile: StoredProfile = {
    ...current,
    name: text(input.profile_name) || current.name,
    model_base_url: validated.baseUrl,
    model_name: validated.model,
    model_thinking: validated.thinking,
  };
  if (input.clear_api_key) {
    profile.model_api_key = '';
  } else {
    const apiKey = apiKeyText(input.api_key);
    if (apiKey) profile.model_api_key = apiKey;
  }
  store.profiles[profileId] = profile;
  persistStore(store);
  deleteSettings(db, MODEL_SETTING_KEYS);
  return publicProfile(profileId, profile);
}

export function createProfile(
  input: { name: string; api_key?: string | null; base_url: string; model: string; thinking: string },
  conn?: Database,
): Record<string, unknown> {
  const validated = validateConfig(input);
  const name = text(input.name);
  if (!name) throw new ModelConfigError('配置名称必填');
  const db = connOf(conn);
  const store = loadStore(db);
  const profileId = `profile-${randomUUID()}`;
  const profile: StoredProfile = {
    name,
    model_base_url: validated.baseUrl,
    model_name: validated.model,
    model_api_key: apiKeyText(input.api_key),
    model_thinking: validated.thinking,
  };
  store.profiles[profileId] = profile;
  store.active_profile_id = profileId;
  persistStore(store);
  deleteSettings(db, MODEL_SETTING_KEYS);
  return publicProfile(profileId, profile);
}

export function duplicateProfile(
  profileId: string,
  name?: string,
  conn?: Database,
): Record<string, unknown> {
  const db = connOf(conn);
  const store = loadStore(db);
  const source = store.profiles[text(profileId)];
  if (!source) throw new ModelConfigError('配置档案不存在');
  const profileIdNew = `profile-${randomUUID()}`;
  const profile: StoredProfile = {
    ...source,
    name: text(name) || `${source.name} 副本`,
  };
  store.profiles[profileIdNew] = profile;
  store.active_profile_id = profileIdNew;
  persistStore(store);
  deleteSettings(db, MODEL_SETTING_KEYS);
  return publicProfile(profileIdNew, profile);
}

export function selectProfile(profileId: string, conn?: Database): Record<string, unknown> {
  const db = connOf(conn);
  const store = loadStore(db);
  if (!store.profiles[text(profileId)]) throw new ModelConfigError('配置档案不存在');
  store.active_profile_id = text(profileId);
  persistStore(store);
  return publicProfile(store.active_profile_id, store.profiles[store.active_profile_id]);
}

/** 仅供本机配置页在用户显式点击“显示 Key”时调用。 */
export function revealProfileKey(profileId: string, conn?: Database): { api_key: string } {
  const store = loadStore(connOf(conn));
  const profile = store.profiles[text(profileId)];
  if (!profile) throw new ModelConfigError('配置档案不存在');
  return { api_key: profile.model_api_key };
}

export function deleteProfile(profileId: string, conn?: Database): { active_profile_id: string; profiles: Array<Record<string, unknown>> } {
  const db = connOf(conn);
  const store = loadStore(db);
  const id = text(profileId);
  if (!store.profiles[id]) throw new ModelConfigError('配置档案不存在');
  if (Object.keys(store.profiles).length <= 1) throw new ModelConfigError('至少保留一个配置档案');
  delete store.profiles[id];
  if (store.active_profile_id === id) store.active_profile_id = Object.keys(store.profiles)[0];
  persistStore(store);
  return listProfiles(db);
}

export function publicConfig(values: Record<string, unknown>): Record<string, unknown> {
  const apiKey = apiKeyText(values.api_key);
  const result: Record<string, unknown> = {
    api_key_set: Boolean(apiKey),
    api_key_masked: mask(apiKey),
    base_url: text(values.base_url),
    model: text(values.model),
    thinking: text(values.thinking) || 'disabled',
  };
  if (values.profile_id !== undefined) result.profile_id = text(values.profile_id);
  if (values.profile_name !== undefined) result.profile_name = text(values.profile_name);
  return result;
}

function publicProfile(id: string, profile: StoredProfile): Record<string, unknown> {
  return {
    ...publicConfig({
      api_key: profile.model_api_key,
      base_url: profile.model_base_url,
      model: profile.model_name,
      thinking: profile.model_thinking,
    }),
    profile_id: id,
    profile_name: profile.name,
  };
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
