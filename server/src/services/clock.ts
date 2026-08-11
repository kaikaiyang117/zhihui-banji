/* MIG-04 业务时钟：开发/测试可覆盖业务日期，审计与系统时间仍使用真实时钟。
 * 审计与系统时间仍使用真实时钟。 */
export const ENV_NAME = 'WORKBENCH_BUSINESS_DATE';

export function todayString(): string {
  const configured = (process.env[ENV_NAME] ?? '').trim();
  if (!configured) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(configured);
  if (!match) throw new Error(`${ENV_NAME} 必须是 YYYY-MM-DD`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${ENV_NAME} 必须是 YYYY-MM-DD`);
  }
  return configured;
}

export function runtime(): Record<string, unknown> {
  return {
    business_date: todayString(),
    business_date_overridden: Boolean((process.env[ENV_NAME] ?? '').trim()),
    business_date_env: ENV_NAME,
  };
}
