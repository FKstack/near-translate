import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { assembleUserscript, OPENCC_REQUIRE_URL, READABILITY_REQUIRE_URL, GREASY_FORK_MAX_BYTES, userscriptGuidePage, userscriptInstallPage, userscriptMetadata, userscriptSettingsPage,
  type UserscriptBundleEntry } from '../../scripts/lib/userscript-build.mjs';

function entry(overrides = {}): UserscriptBundleEntry {
  return { type: 'chunk', isEntry: true, imports: [], dynamicImports: [], modules: {},
    code: '(() => { document.body.dataset.executed = "yes"; })();', ...overrides };
}

describe('standalone userscript distribution', () => {
  it('gives Greasy Fork its own update ownership and a pinned library dependency', () => {
    const metadata = userscriptMetadata('0.11.2', 'greasyfork');
    expect(metadata).toContain('// @require ' + OPENCC_REQUIRE_URL);
    expect(metadata).toContain('// @require ' + READABILITY_REQUIRE_URL);
    expect(OPENCC_REQUIRE_URL).toMatch(/opencc-js@1\.4\.2\/dist\/umd\/full\.js#sha256=[a-f0-9]{64}$/);
    expect(metadata).toContain('// @name:zh-CN 近译');
    expect(metadata).toContain('// @description:zh-CN ');
    expect(metadata).not.toMatch(/@(?:updateURL|downloadURL|installURL)/);
    expect(metadata).toContain('// @namespace https://github.com/FKstack/near-translate');
    const { userScript } = assembleUserscript([entry({ code: 'function readableApplicationName() { return "hello"; }' })], '0.11.2', 'Original library source', 'greasyfork');
    expect(userScript).toContain('function readableApplicationName()');
    expect(userScript).toContain('Original library source');
    expect(() => assembleUserscript([entry({ code: '/*' + 'x'.repeat(GREASY_FORK_MAX_BYTES) + '*/' })], '0.11.2', '', 'greasyfork'))
      .toThrow('2 MB');
  });

  it('uses the same stable identity and update paths across versions', () => {
    const oldMetadata = userscriptMetadata('0.11.2');
    const newMetadata = userscriptMetadata('0.12.0');
    expect(newMetadata.replace('// @version 0.12.0', '// @version 0.11.2')).toBe(oldMetadata);
    expect(newMetadata).toContain('// @updateURL https://fkstack.github.io/near-translate/userscript/near-translate.meta.js');
    expect(newMetadata).toContain('// @downloadURL https://fkstack.github.io/near-translate/userscript/near-translate.user.js');
    expect(newMetadata).toContain('// @sandbox DOM');
    expect(newMetadata).toContain('// @grant GM_xmlhttpRequest');
    expect(newMetadata).toContain('// @grant GM_openInTab');
    expect(newMetadata).not.toMatch(/@(?:require|resource)|unsafeWindow|@grant none/);
  });

  it('ships executable classic JavaScript with safely inlined CSS and the exact metadata header', () => {
    const css = 'body::after{content:"</style><script>throw 1</script>"}';
    const { userScript, metadata } = assembleUserscript([entry(), { type: 'asset', fileName: 'style.css', source: css }], '0.12.0', 'Example license */ text');
    expect(userScript.startsWith(metadata)).toBe(true);
    expect(metadata.trimEnd().endsWith('// ==/UserScript==')).toBe(true);
    const dom = new JSDOM('<html><head></head><body></body></html>');
    new Function('document', userScript)(dom.window.document);
    expect(dom.window.document.querySelector('style')?.textContent).toBe(css);
    expect(dom.window.document.body.dataset.executed).toBe('yes');
    expect(dom.window.document.querySelector('script')).toBe(null);
    dom.window.close();
  });

  it('rejects split bundles, external imports, document assets and extension runtime modules', () => {
    expect(() => assembleUserscript([entry(), entry()], '0.12.0')).toThrow('one standalone');
    expect(() => assembleUserscript([entry({ imports: ['https://cdn.example/react.js'] })], '0.12.0')).toThrow('external or split');
    expect(() => assembleUserscript([entry({ dynamicImports: ['reader.js'] })], '0.12.0')).toThrow('external or split');
    expect(() => assembleUserscript([entry(), { type: 'asset', fileName: 'pdf.worker.js', source: '' }], '0.12.0')).toThrow('Unexpected');
    for (const module of ['D:/repo/src/pdf/main.ts', 'D:/repo/src/conversion/pdf.ts', 'D:/repo/node_modules/wxt/dist/browser.mjs', 'D:/repo/node_modules/pdfjs-dist/build/pdf.mjs']) {
      expect(() => assembleUserscript([entry({ modules: { [module]: {} } })], '0.12.0')).toThrow('Unsupported');
    }
    expect(() => assembleUserscript([entry({ code: 'export const unsupported = true;' })], '0.12.0')).toThrow(SyntaxError);
  });

  it('serves a settings shell without page scripts, forms, or external assets', () => {
    for (const html of [userscriptSettingsPage(), userscriptInstallPage('0.12.0'), userscriptGuidePage('<h1>安装与使用</h1><p>静态指南。</p>')]) {
      const dom = new JSDOM(html);
      expect(dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'none'");
      expect(dom.window.document.querySelector('script, form, iframe, img, link[rel="stylesheet"]')).toBe(null);
      dom.window.close();
    }
    expect(userscriptSettingsPage()).toContain('near-userscript-settings-placeholder');
  });

  it('links published installation and documentation without depending on the default branch', () => {
    const install = new JSDOM(userscriptInstallPage('0.12.0'));
    const guide = new JSDOM(userscriptGuidePage('<h1>完整指南</h1><p>使用自己的翻译配置。</p>'));
    expect([...install.window.document.querySelectorAll('a')].find(link => link.textContent === '完整安装与发布说明')?.href)
      .toBe('https://fkstack.github.io/near-translate/userscript/guide.html');
    expect(guide.window.document.querySelector('main h1')?.textContent).toBe('完整指南');
    expect([...guide.window.document.querySelectorAll<HTMLAnchorElement>('nav a')].map(link => link.href)).toEqual([
      'https://fkstack.github.io/near-translate/userscript/',
      'https://fkstack.github.io/near-translate/userscript/settings.html',
    ]);
    install.window.close(); guide.window.close();
  });
});
