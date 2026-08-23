import { describe, expect, it } from 'vitest';

import { filenamePart } from '../../src/services/filename.js';

describe('文件名片段', () => {
  it('替换非法字符并限制长度', () => {
    expect(filenamePart('  七一/映秀:中学?  ')).toBe('七一-映秀-中学');
    expect(filenamePart('a'.repeat(100))).toHaveLength(80);
  });

  it('空值使用可读的默认名称', () => {
    expect(filenamePart('', '报告')).toBe('报告');
  });
});
