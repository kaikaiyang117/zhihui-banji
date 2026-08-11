/* 将旧版 agent_settings 中的敏感配置迁移到独立、权限受限的本地文件。 */
import { getDb } from './context.js';
import { migrateStoredConfig } from '../agent/modelConfig.js';
import { migrateStoredCredentials } from '../wechat/credentialStore.js';
import { migrateStoredConfig as migrateStoredWechatConfig } from '../wechat/config.js';
import { migrateStoredGithubToken } from './update.js';

export function migrateStoredSecrets(): void {
  // 两个迁移函数都保持幂等；启动时执行可覆盖“用户未打开 Agent 页面就导出迁移包”的路径。
  migrateStoredConfig(getDb().connInstance);
  migrateStoredCredentials(getDb().connInstance);
  migrateStoredWechatConfig(getDb().connInstance);
  migrateStoredGithubToken(getDb().connInstance);
}
