import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '近译 · 整页与划词翻译',
    description: '网页中英对照、划词与 PDF 翻译。支持 DeepSeek、OpenAI、Gemini、通义千问、Ollama 及自定义兼容 API。',
    permissions: ['storage', 'scripting', 'activeTab'],
    host_permissions: ['https://api.deepseek.com/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
    },
  },
});
