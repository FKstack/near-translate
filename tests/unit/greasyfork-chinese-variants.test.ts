import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { normalizeChineseVariant as bundled } from '../../src/core/chinese-variants';
import { OPENCC_REQUIRE_URL } from '../../scripts/lib/userscript-build.mjs';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('Greasy Fork pinned OpenCC adapter', () => {
  it('uses exact pinned UMD content and preserves the bundled generic Chinese conversion', async () => {
    const bytes = await readFile('node_modules/opencc-js/dist/umd/full.js');
    expect(OPENCC_REQUIRE_URL.endsWith(createHash('sha256').update(bytes).digest('hex'))).toBe(true);
    const sandbox = createContext({});
    runInContext(bytes.toString('utf8'), sandbox);
    vi.stubGlobal('OpenCC', sandbox.OpenCC);
    const { normalizeChineseVariant: external } = await import('../../src/userscript/greasyfork-chinese-variants');
    for (const source of [
      '軟體與網路應用程式', '后台开发、数据处理和文件下载', '頭髮發展與乾燥幹部',
      '鼠标、字节与计算机网络', '「繁體」與“简体” English 123',
      '面條和麵包，裏面的消息', '一目瞭然，地圖數據', '乾杯与干净，复习与回复',
      '简体中文，繁體中文。', '',
    ]) {
      expect(external(source, 'zh-Hans')).toBe(bundled(source, 'zh-Hans'));
      expect(external(source, 'zh-Hant')).toBe(bundled(source, 'zh-Hant'));
      expect(external(source, 'ja')).toBe(source);
    }
  });

  it('fails clearly when the manager has not supplied the required library', async () => {
    vi.stubGlobal('OpenCC', undefined);
    const { normalizeChineseVariant } = await import('../../src/userscript/greasyfork-chinese-variants');
    expect(normalizeChineseVariant('Unchanged English', 'en')).toBe('Unchanged English');
    expect(() => normalizeChineseVariant('繁體', 'zh-Hans')).toThrow('OpenCC');
  });
});
