import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '近译 · 英文划词翻译',
    description: '双击英文单词或拖选句段，点击附近的译按钮。支持网页和自带 PDF 阅读器，使用 DeepSeek 翻译。',
    permissions: ['storage', 'scripting', 'activeTab'],
    host_permissions: ['https://api.deepseek.com/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
    },
  },
});
