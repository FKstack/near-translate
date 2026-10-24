export const USERSCRIPT_NAME = 'near-translate';
export const USERSCRIPT_BASE_URL = 'https://fkstack.github.io/near-translate/userscript';
export const USERSCRIPT_REPOSITORY = 'https://github.com/FKstack/near-translate';
// The Greasy Fork build uses the official UMD library through @require instead
// of embedding its dictionaries. Fixed content + SRI make the dependency auditable.
export const OPENCC_REQUIRE_URL = 'https://cdn.jsdelivr.net/npm/opencc-js@1.4.2/dist/umd/full.js#sha256=95b04abf136d9c28263773bb7d357eac80b7954d101efd23c4d09c737d3d379e';
export const READABILITY_REQUIRE_URL = 'https://cdn.jsdelivr.net/npm/@mozilla/readability@0.6.0/Readability.js#sha256=34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174';
export const GREASY_FORK_MAX_BYTES = 2_000_000;

const grants = [
  'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues',
  'GM_addValueChangeListener', 'GM_removeValueChangeListener', 'GM_xmlhttpRequest',
  'GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'GM_openInTab', 'GM_info',
];
const connections = [
  'oneshot-free.www.deepl.com', 'api.deepseek.com', 'api.openai.com',
  'generativelanguage.googleapis.com', 'dashscope.aliyuncs.com', 'api.moonshot.ai',
  'api.siliconflow.cn', 'openrouter.ai', 'localhost', '127.0.0.1', '*',
];

export function userscriptMetadata(version, distribution = 'github') {
  if (!/^\d+\.\d+\.\d+(?:[.-][\w.-]+)?$/.test(version)) throw new Error('Invalid userscript version.');
  if (!['github', 'greasyfork'].includes(distribution)) throw new Error('Unknown userscript distribution.');
  const fields = [
    ['name', '近译 · 网页阅读与翻译'],
    ...(distribution === 'greasyfork' ? [['name:zh-CN', '近译 · 网页阅读与翻译']] : []),
    ['namespace', USERSCRIPT_REPOSITORY],
    ['version', version],
    ['description', '网页双语翻译、划词与专注阅读；可配置自己的模型 API。'],
    ...(distribution === 'greasyfork' ? [['description:zh-CN', '网页双语翻译、划词与专注阅读；可配置自己的模型 API。']] : []),
    ['author', 'FKstack'], ['license', 'MIT'],
    ['homepageURL', USERSCRIPT_REPOSITORY], ['supportURL', `${USERSCRIPT_REPOSITORY}/issues`],
    ['match', 'http://*/*'], ['match', 'https://*/*'],
    ['noframes', ''], ['run-at', 'document-idle'], ['sandbox', 'DOM'],
    ...grants.map(grant => ['grant', grant]),
    ...connections.map(connection => ['connect', connection]),
    ...(distribution === 'greasyfork' ? [['require', OPENCC_REQUIRE_URL], ['require', READABILITY_REQUIRE_URL]] : [
      ['updateURL', `${USERSCRIPT_BASE_URL}/${USERSCRIPT_NAME}.meta.js`],
      ['downloadURL', `${USERSCRIPT_BASE_URL}/${USERSCRIPT_NAME}.user.js`],
    ]),
  ];
  return ['// ==UserScript==', ...fields.map(([key, value]) => `// @${key}${value ? ` ${value}` : ''}`), '// ==/UserScript==', ''].join('\n');
}

// Fail the build if the browser bundle would depend on a CDN, split chunk,
// worker, document tool or extension runtime that Tampermonkey cannot provide.
export function assembleUserscript(output, version, notices = '', distribution = 'github') {
  const chunks = output.filter(entry => entry.type === 'chunk');
  const assets = output.filter(entry => entry.type === 'asset');
  if (chunks.length !== 1 || !chunks[0].isEntry) throw new Error('Userscript must contain one standalone entry chunk.');
  const chunk = chunks[0];
  if (chunk.imports.length || chunk.dynamicImports.length) throw new Error('Userscript must not load external or split JavaScript.');
  const unexpected = assets.filter(asset => !asset.fileName.endsWith('.css'));
  if (unexpected.length) throw new Error(`Unexpected userscript assets: ${unexpected.map(asset => asset.fileName).join(', ')}`);
  const forbidden = Object.keys(chunk.modules).find(id => /(?:\/src\/(?:pdf|conversion)\/|\/node_modules\/(?:pdfjs-dist|pdf-lib|@pdf-lib)\/|\/node_modules\/wxt\/)/.test(id.replaceAll('\\', '/')));
  if (forbidden) throw new Error(`Unsupported userscript dependency: ${forbidden}`);
  const css = assets.map(asset => typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source)).join('\n');
  const style = css ? `(() => { const style = document.createElement('style'); style.dataset.nearUserscript = ''; style.textContent = ${JSON.stringify(css)}; (document.head || document.documentElement).append(style); })();\n` : '';
  const metadata = userscriptMetadata(version, distribution);
  const licenses = notices ? `\n/* Bundled third-party license notices\n${notices.replaceAll('*/', '* /')}\n*/\n` : '';
  const userScript = `${metadata}${licenses}\n${style}${chunk.code}\n`;
  if (distribution === 'greasyfork' && new TextEncoder().encode(userScript).byteLength > GREASY_FORK_MAX_BYTES) {
    throw new Error('Greasy Fork script exceeds the 2 MB limit.');
  }
  // Parse as a classic script, rather than silently shipping import/export syntax.
  new Function(userScript);
  return { userScript, metadata };
}

const pageStyle = 'body{font:16px/1.7 system-ui,sans-serif;max-width:760px;margin:64px auto;padding:0 24px;color:#21312d;background:#f8faf8}a{color:#12694d;overflow-wrap:anywhere}h1{line-height:1.3}li{margin:.7em 0}code{background:#e9efeb;padding:.15em .4em;border-radius:4px}pre{overflow-x:auto;padding:1em;background:#e9efeb;border-radius:6px}pre code{padding:0}table{border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid #cbd7ce;padding:.5em .75em;text-align:left}';
const pageHead = title => `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; object-src 'none'; form-action 'none'"><title>${title}</title><style>${pageStyle}</style></head>`;

export function userscriptInstallPage(version) {
  return `${pageHead('近译 · 篡改猴版')}<body><h1>近译 · 篡改猴版</h1><p>网页双语翻译、划词与专注阅读。当前版本：${version}。</p><ol><li>先安装 <a href="https://www.tampermonkey.net/">Tampermonkey（篡改猴）</a>，按其提示允许运行用户脚本。</li><li><a href="./${USERSCRIPT_NAME}.user.js">安装近译 ${version}</a>，在篡改猴页面核对权限并确认安装。</li><li>刷新文章页，从近译浮动入口翻译或阅读；选中文字后可划词翻译。不要同时启用近译扩展。</li></ol><p><a href="./settings.html">打开翻译设置</a>，或使用篡改猴菜单。模型 Key 加密保存，每个文章页需要从菜单单独解锁；免费翻译不需要 Key。</p><p>篡改猴按自己的更新周期检查并安装新版；也可在其管理面板手动检查更新。自定义 API 首次连接时请核对并授权目标域名。</p><p>本版仅处理网页，不含 PDF 阅读器和文档转换。</p><p><a href="${USERSCRIPT_BASE_URL}/guide.html">完整安装与发布说明</a> · <a href="${USERSCRIPT_REPOSITORY}/issues">反馈问题</a> · <a href="${USERSCRIPT_REPOSITORY}">源代码与许可证</a></p></body></html>\n`;
}

export function userscriptSettingsPage() {
  return `${pageHead('近译 · 翻译设置')}<body><main id="near-userscript-settings-placeholder"><h1>近译 · 翻译设置</h1><p>安装并启用近译篡改猴脚本后，刷新此页即可显示设置界面。</p><p>如果仍看不到设置，请在篡改猴中确认近译已启用，并允许此网站运行用户脚本。</p><p><a href="./index.html">返回安装说明</a></p></main></body></html>\n`;
}

/** The repository guide is rendered at build time; the published page runs no JavaScript. */
export function userscriptGuidePage(content) {
  return `${pageHead('近译 · 篡改猴安装与使用指南')}<body><nav><a href="${USERSCRIPT_BASE_URL}/">返回安装页</a> · <a href="${USERSCRIPT_BASE_URL}/settings.html">打开翻译设置</a></nav><main>${content}</main></body></html>\n`;
}
