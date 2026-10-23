import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '近译 · 阅读与翻译',
    description: '本地阅读模式、双语网页与划词翻译、PDF 文字选择翻译，也支持自定义模型 API。',
    permissions: ['storage', 'scripting', 'activeTab'],
    // Optional metadata-only connection acceleration, also used for legacy rule cleanup.
    optional_permissions: ['declarativeNetRequestWithHostAccess'],
    host_permissions: ['https://api.deepseek.com/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
    },
  },
});
