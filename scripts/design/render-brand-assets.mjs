import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Manual design export; uses existing development dependencies only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const design = path.join(root, 'docs/design/near-translate');
const scratch = path.join(root, '.output/brand-design');
const icons = path.join(root, 'public/icon');
for (const directory of [design, scratch, icons]) await mkdir(directory, { recursive: true });
const svg = await readFile(path.join(root, 'public/brand/near-translate.svg'), 'utf8');
const source = await readFile(path.join(root, 'src/page/Bar.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const previewModule = path.join(scratch, 'Bar.preview.mjs');
await writeFile(previewModule, compiled.outputText);
const { PageBar, pageBarStyles } = await import(pathToFileURL(previewModule).href);
const state = { status: 'idle', total: 0, completed: 0, failed: 0, pending: 0, skipped: 0, limitReached: false };
const callbacks = { onTranslate() {}, onStop() {}, onRestore() {}, onRetry() {}, onSettings() {} };
const variants = [
  { title: '安静待命', state, hasTranslations: false },
  { title: '正在翻译', state: { ...state, status: 'running', total: 24, completed: 8, pending: 16 }, hasTranslations: true },
  { title: '译文就绪', state: { ...state, status: 'done', total: 24, completed: 24 }, hasTranslations: true },
  { title: '可重试提示', state: { ...state, status: 'done', total: 24, completed: 23, failed: 1 }, hasTranslations: true },
];
const bars = variants.map(variant => renderToStaticMarkup(createElement(PageBar, { ...variant, ...callbacks })));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const imageSource = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  for (const size of [16, 32, 48, 128, 512, 1024]) {
    const data = await page.evaluate(async ({ imageSource, size }) => {
      const image = new Image();
      image.src = imageSource;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, size, size);
      const pixels = context.getImageData(0, 0, size, size).data;
      let hasInk = false;
      let hasTransparency = false;
      for (let index = 3; index < pixels.length; index += 4) {
        hasInk ||= pixels[index] === 255;
        hasTransparency ||= pixels[index] === 0;
      }
      if (!hasInk || !hasTransparency) throw new Error(`Invalid icon alpha at ${size}px`);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { imageSource, size });
    const bytes = Buffer.from(data, 'base64');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
    const filename = size <= 128 ? path.join(icons, `${size}.png`) : path.join(design, `near-translate-${size}.png`);
    await writeFile(filename, bytes);
  }
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>近译 · 双叶对话与阅读书签</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f2f5ed;color:#244c42;font:15px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}.sheet{width:1280px;min-height:820px;padding:40px 48px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:30px}.eyebrow{font-size:11px;letter-spacing:3px;color:#7e9483}h1{font-size:30px;letter-spacing:2px;font-weight:500;margin:5px 0 0}header p{color:#6b8475;font-size:13px}.main{display:grid;grid-template-columns:280px 1fr;gap:32px}.identity{padding:25px 24px;background:#fcfdf9;border:1px solid #dce7df;border-radius:20px}.mark{display:block;width:190px;height:190px;margin:0 auto 16px}.identity h2{font-size:19px;font-weight:500;margin:0}.identity p{font-size:13px;color:#6b8475;margin:7px 0 24px}.swatches{display:flex;gap:16px;font-size:11px;color:#6b8475}.swatches i{display:block;width:40px;height:10px;border-radius:8px;margin-bottom:5px}.sizes{display:flex;align-items:flex-end;justify-content:space-between;border-top:1px solid #e2ebe3;padding-top:20px;margin-top:22px}.sizes figure{margin:0;text-align:center}.sizes img{display:block;margin:auto}.sizes figcaption{font-size:10px;color:#7e9483;margin-top:8px}.browser{border:1px solid #dce7df;border-radius:20px;overflow:hidden;background:#fff}.chrome{height:38px;display:flex;align-items:center;gap:5px;background:#eef2eb;padding:0 16px;font-size:11px;color:#809184}.chrome i{width:6px;height:6px;border-radius:50%;background:#c5d1c3}.chrome span{margin-left:16px}.viewport{position:relative;transform:translateZ(0);height:378px;overflow:hidden}.article{max-width:470px;margin:48px 110px 0 50px}.article small{font-size:10px;letter-spacing:2px;color:#91a08c}.article h2{font-size:27px;line-height:1.3;color:#30473c;font-family:Georgia,serif;font-weight:400;margin:10px 0 18px}.article p{font:14px/1.9 Georgia,serif;color:#819080}.article .line{height:7px;background:#edf1e9;border-radius:3px;margin-top:14px}.line:nth-of-type(2){width:90%}.line:nth-of-type(3){width:75%}.caption{font-size:12px;color:#738b79;margin:12px 4px 0}.states{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:26px}.state{height:184px;position:relative;transform:translateZ(0);background:#fcfdf9;border:1px solid #dce7df;border-radius:16px;overflow:hidden}.state>span{position:absolute;left:16px;bottom:12px;font-size:11px;color:#7c927f}.state-title{font-size:12px;margin:0 0 10px;color:#637b6d}.footer{display:flex;justify-content:space-between;font-size:11px;color:#7e9483;margin-top:24px}.dark{background:#243d35}.dark>span{color:#d3dfd2}
  </style><main class="sheet"><header><div><div class="eyebrow">NEAR TRANSLATE / 近译</div><h1>双叶对话 · 阅读书签</h1></div><p>让语言靠近，让阅读轻一点。</p></header><div class="main"><section class="identity"><img class="mark" src="${imageSource}" alt="双叶对话图标"><h2>两片叶子，两种语言。</h2><p>叶片的自然轮廓，接住对话气泡的含义。留白连接原文与译文。</p><div class="swatches"><div><i style="background:#087f83"></i>#087F83</div><div><i style="background:#66cc9e"></i>#66CC9E</div></div><div class="sizes">${[16, 32, 48].map(size => `<figure><img src="../../../public/icon/${size}.png" width="${size}" height="${size}" alt="${size}像素图标"><figcaption>${size} px</figcaption></figure>`).join('')}</div></section><section><div class="browser"><div class="chrome"><i></i><i></i><i></i><span>一页安静的阅读空间</span></div><div class="viewport"><article class="article"><small>NOTES ON A QUIETER WEB</small><h2>A little space for<br>reading and understanding.</h2><p>Words bring ideas closer. Take your time, follow a thought, and let each sentence unfold naturally.</p><div class="line"></div><div class="line"></div><div class="line"></div></article><near-preview data-variant="0"></near-preview></div></div><p class="caption">完整面板悬离边缘 16 px · 双叶主按钮 · 原文与设置常驻 · 柔和浅色提示</p></section></div><div class="states">${[1, 2, 3].map((index) => `<section class="state${index === 2 ? ' dark' : ''}"><span>${variants[index].title}${index === 2 ? ' / 深色背景' : ''}</span><near-preview data-variant="${index}"></near-preview></section>`).join('')}</div><footer class="footer"><span>原创图标与浮栏方案 · 平面双色 / 透明底 / 可编辑 SVG</span><span>状态示例使用实际 PageBar 组件渲染</span></footer></main><script>
  const styles = ${JSON.stringify(pageBarStyles)};
  const bars = ${JSON.stringify(bars)};
  document.querySelectorAll('near-preview').forEach(host => { const shadow=host.attachShadow({mode:'open'}); shadow.innerHTML='<style>'+styles+'</style>'+bars[Number(host.dataset.variant)]; });
  </script></html>`;
  const preview = path.join(design, 'preview.html');
  await writeFile(preview, html);
  await page.goto(pathToFileURL(preview).href);
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  await page.screenshot({ path: path.join(design, 'preview.png'), fullPage: true });
  const idle = page.locator('.viewport near-preview');
  await idle.getByRole('button', { name: '翻译整个页面', exact: true }).hover();
  await expect(idle.locator('.np-info')).toHaveCSS('opacity', '1');
  await idle.getByRole('button', { name: '翻译设置', exact: true }).focus();
  await expect(idle.locator('.np-info')).toHaveCSS('opacity', '1');
  console.log('Exported transparent icons: 16, 32, 48, 128, 512, 1024 px; actual-component preview; hover and keyboard checks passed.');
} finally {
  await browser.close();
}
