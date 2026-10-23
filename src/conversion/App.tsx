import { useEffect, useRef, useState } from 'react';
import { renderDocument, buildPrintDocument } from './markdown';
import { htmlToPdf } from './document-pdf';
import { pdfToText, pdfToImages } from './pdf-read';
import { imagesToPdf, mergePdfs, splitPdf, validateImageFile } from './pdf-write';
import { createZip } from './zip';
import { checkFiles, ConversionError, LIMITS, safeFilename } from './types';

type Tool = 'document' | 'text' | 'images' | 'image-pdf' | 'pages' | 'split';
type Item = { id: string; file: File; pages: string };
type Result = { name: string; blob: Blob; url: string; secondary: boolean };
const tools: Array<{ id: Tool; title: string; caption: string }> = [
  { id: 'document', title: 'Markdown → PDF', caption: '也支持文本、HTML' },
  { id: 'text', title: 'PDF → Markdown', caption: '提取文字、结构与链接' },
  { id: 'images', title: 'PDF → 图片', caption: 'PNG / JPG，按页导出' },
  { id: 'image-pdf', title: '图片 → PDF', caption: '多图排序，合为一份' },
  { id: 'pages', title: '合并与整理 PDF', caption: '提取、重排、旋转页面' },
  { id: 'split', title: '拆分 PDF', caption: '每页一份，ZIP 下载' },
];
const initialMarkdown = '# 一份清晰的文档\n\n在左侧粘贴 Markdown，点击 **下载 PDF** 即可保存文档。\n\n## 表格与代码\n\n| 项目 | 说明 |\n| --- | --- |\n| 中文 | 清晰排版 |\n| 图片 | 可附加本地图片 |\n\n```js\nconst reading = "让阅读轻一点";\n```\n\n- 保留标题和列表\n- 支持表格、链接与代码块\n';

function readFile(file: File, format: 'text' | 'data', signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cancel = () => reader.abort();
    const cleanup = () => signal.removeEventListener('abort', cancel);
    reader.onload = () => { cleanup(); resolve(String(reader.result)); };
    reader.onerror = () => { cleanup(); reject(new ConversionError(`无法读取 ${file.name}。`)); };
    reader.onabort = () => { cleanup(); reject(new DOMException('已取消。', 'AbortError')); };
    if (signal.aborted) { reject(new DOMException('已取消。', 'AbortError')); return; }
    signal.addEventListener('abort', cancel, { once: true });
    if (format === 'text') reader.readAsText(file, 'UTF-8'); else reader.readAsDataURL(file);
  });
}

export function ConversionApp() {
  const [tool, setTool] = useState<Tool>('document');
  const [items, setItems] = useState<Item[]>([]);
  const [source, setSource] = useState(initialMarkdown);
  const [sourceFormat, setSourceFormat] = useState<'markdown' | 'text' | 'html'>('markdown');
  const [attachments, setAttachments] = useState<Array<{ name: string; url: string }>>([]);
  const [name, setName] = useState('近译文档');
  const [pages, setPages] = useState('');
  const [password, setPassword] = useState('');
  const [textFormat, setTextFormat] = useState<'markdown' | 'text'>('markdown');
  const [imageFormat, setImageFormat] = useState<'png' | 'jpeg'>('png');
  const [scale, setScale] = useState(1.5);
  const [pageSize, setPageSize] = useState<'a4' | 'original'>('a4');
  const [rotation, setRotation] = useState(0);
  const [paper, setPaper] = useState<'A4' | 'Letter'>('A4');
  const [landscape, setLandscape] = useState(false);
  const [margin, setMargin] = useState(18);
  const [fontSize, setFontSize] = useState(11);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const current = tools.find(value => value.id === tool)!;

  useEffect(() => () => { active.current?.abort(); generation.current++; }, []);
  useEffect(() => () => { attachments.forEach(image => URL.revokeObjectURL(image.url)); }, [attachments]);
  useEffect(() => () => { results.forEach(result => URL.revokeObjectURL(result.url)); }, [results]);

  function clearOutput() { setResults([]); setText(''); setPreview(''); setError(''); setNotice(''); setWarnings([]); }
  function chooseTool(next: Tool) {
    if (busy || next === tool) return;
    generation.current++;
    clearOutput(); setTool(next); setItems([]); setPages(''); setPassword('');
    if (input.current) input.current.value = '';
  }
  async function addFiles(files: File[]) {
    const readId = ++generation.current;
    const controller = new AbortController();
    active.current?.abort(); active.current = controller; setBusy(true);
    clearOutput();
    try {
      checkFiles(files);
      if (tool === 'document') {
        if (files.length !== 1 || !/\.(md|markdown|txt|html?|log)$/i.test(files[0]!.name)) throw new ConversionError('请选择一个 Markdown、UTF-8 文本或 HTML 文件。');
        const file = files[0]!;
        if (file.size > LIMITS.maxMarkdownBytes) throw new ConversionError('文字文档不能超过 5 MB。');
        const value = (await readFile(file, 'text', controller.signal)).replace(/^\uFEFF/, '');
        if (generation.current !== readId) return;
        setSource(value); setSourceFormat(/\.html?$/i.test(file.name) ? 'html' : /\.(txt|log)$/i.test(file.name) ? 'text' : 'markdown');
        setName(safeFilename(file.name.replace(/\.[^.]+$/, ''))); setNotice(`已载入 ${file.name}`);
        return;
      }
      const multiple = tool === 'pages' || tool === 'image-pdf';
      if (!multiple && files.length !== 1) throw new ConversionError('这个工具一次处理一个 PDF。');
      if (tool === 'image-pdf') {
        if (files.some(file => !/\.(png|jpe?g|webp)$/i.test(file.name))) throw new ConversionError('请选择 PNG、JPG 或 WebP 图片。');
      } else if (files.some(file => !/\.pdf$/i.test(file.name))) throw new ConversionError('请选择 PDF 文件。');
      const next = [...(multiple ? items : []), ...files.map(file => ({ id: crypto.randomUUID(), file, pages: '' }))];
      checkFiles(next.map(item => item.file));
      setItems(next); setName(safeFilename(files[0]!.name.replace(/\.[^.]+$/, '')));
    } catch (reason) { if (generation.current === readId) setError(reason instanceof Error ? reason.message : '载入失败。'); }
    finally { if (generation.current === readId) { setBusy(false); active.current = null; } }
  }
  async function addAttachments(files: File[]) {
    const readId = ++generation.current;
    const controller = new AbortController();
    active.current?.abort(); active.current = controller; setBusy(true);
    clearOutput();
    try {
      checkFiles(files);
      if (files.some(file => !/\.(png|jpe?g|webp)$/i.test(file.name))) throw new ConversionError('附件支持 PNG、JPG 和 WebP。');
      const names = files.map(file => file.name.toLocaleLowerCase());
      if (new Set(names).size !== names.length) throw new ConversionError('图片附件不能有重名文件。');
      if (files.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) throw new ConversionError('文档图片附件合计不能超过 32 MB。');
      const images: Array<{ name: string; url: string }> = [];
      for (const file of files) {
        await validateImageFile(file, controller.signal);
        images.push({ name: file.name, url: await readFile(file, 'data', controller.signal) });
      }
      if (generation.current !== readId) return;
      setAttachments(images);
    } catch (reason) { if (generation.current === readId) setError(reason instanceof Error ? reason.message : '图片载入失败。'); }
    finally { if (generation.current === readId) { setBusy(false); active.current = null; } }
  }
  function moveItem(index: number, step: number) {
    clearOutput();
    setItems(previous => { const next = [...previous], other = index + step; if (!next[index] || !next[other]) return previous; [next[index], next[other]] = [next[other]!, next[index]!]; return next; });
  }
  function cancel() {
    active.current?.abort(); active.current = null; generation.current++;
    setBusy(false); setProgress({ completed: 0, total: 0 }); setNotice('已取消，未生成新文件。');
  }
  function output(filename: string, blob: Blob, secondary = false): Result { return { name: filename, blob, url: URL.createObjectURL(blob), secondary }; }
  async function convert() {
    clearOutput();
    const id = ++generation.current, controller = new AbortController();
    active.current?.abort(); active.current = controller; setBusy(true); setProgress({ completed: 0, total: 0 });
    const valid = () => generation.current === id && !controller.signal.aborted;
    const onProgress = (completed: number, total: number) => { if (valid()) setProgress({ completed, total }); };
    try {
      const filename = safeFilename(name);
      if (tool === 'document') {
        if (!source.trim()) throw new ConversionError('请先粘贴文字或选择文档。');
        if (new TextEncoder().encode(source).length > LIMITS.maxMarkdownBytes) throw new ConversionError('文字文档不能超过 5 MB。');
        setNotice('正在整理文档内容…');
        const rendered = await renderDocument(source, sourceFormat, { title: filename, images: attachments });
        if (!valid()) return;
        const html = buildPrintDocument(rendered.html, { title: filename, paper, landscape, marginMm: margin, fontSize });
        if (new TextEncoder().encode(html).byteLength > LIMITS.maxOutputBytes) throw new ConversionError('排版文件过大，请减少图片或文档内容。');
        setPreview(html);
        setNotice('正在生成 PDF，完成后将自动下载。');
        const exportWarnings: string[] = [];
        const bytes = await htmlToPdf(rendered.html, {
          title: filename, paper, landscape, marginMm: margin, fontSize,
          signal: controller.signal, onProgress,
          onWarning: message => { exportWarnings.push(message); },
        });
        if (!valid()) return;
        if (!bytes.byteLength || bytes.byteLength > LIMITS.maxOutputBytes) throw new ConversionError('无法生成 PDF，文档可能过大，请减少内容后重试。');
        setWarnings([...rendered.warnings, ...exportWarnings]);
        const generated: Result[] = [];
        try {
          generated.push(output(`${filename}.pdf`, new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })));
          generated.push(output(`${filename}.html`, new Blob([html], { type: 'text/html;charset=utf-8' }), true));
        } catch (reason) {
          generated.forEach(result => URL.revokeObjectURL(result.url));
          throw reason;
        }
        setResults(generated);
        const pdf = generated[0]!;
        const download = document.createElement('a');
        download.href = pdf.url; download.download = pdf.name; download.hidden = true;
        document.body.appendChild(download);
        try {
          if (valid()) download.click();
          setNotice('PDF 已生成。如果下载没有自动开始，可使用右侧的 PDF 下载链接。');
        } catch {
          setNotice('PDF 已生成，请使用右侧的 PDF 下载链接保存。');
        } finally { download.remove(); }
      } else {
        checkFiles(items.map(item => item.file));
        if (tool === 'text') {
          const result = await pdfToText(items[0]!.file, { format: textFormat, pages, password, signal: controller.signal, onProgress });
          if (!valid()) return;
          setText(result.text); setWarnings(result.warnings);
          setResults([output(`${filename}.${textFormat === 'markdown' ? 'md' : 'txt'}`, new Blob([result.text], { type: 'text/plain;charset=utf-8' }))]);
          setNotice(`已提取 ${result.pageCount} 页的文字。请核对多栏、表格与公式的阅读顺序。`);
        } else if (tool === 'images') {
          const files = await pdfToImages(items[0]!.file, { format: imageFormat, pages, password, scale, signal: controller.signal, onProgress });
          if (!valid()) return;
          setNotice('页面图片已生成，正在打包…');
          const zip = await createZip(files, { signal: controller.signal });
          if (!valid()) return;
          setResults([output(`${filename}-页面.zip`, zip)]); setNotice(`已生成 ${files.length} 张页面图片，打包为 ZIP。`);
        } else if (tool === 'image-pdf') {
          const bytes = await imagesToPdf(items.map(item => item.file), { pageSize, margin: 24, signal: controller.signal, onProgress });
          if (!valid()) return;
          setResults([output(`${filename}.pdf`, new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))]); setNotice(`已将 ${items.length} 张图片按列表顺序合成 PDF。`);
        } else if (tool === 'pages') {
          const bytes = await mergePdfs(items.map(item => ({ file: item.file, pages: item.pages })), { rotation, signal: controller.signal, onProgress });
          if (!valid()) return;
          setResults([output(`${filename}-整理.pdf`, new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))]); setNotice('PDF 已整理，页面顺序与输入列表、页码范围一致。');
        } else {
          const files = await splitPdf(items[0]!.file, { pages, signal: controller.signal, onProgress });
          if (!valid()) return;
          setNotice('页面已拆分，正在打包…');
          const zip = await createZip(files, { signal: controller.signal });
          if (!valid()) return;
          setResults([output(`${filename}-拆页.zip`, zip)]); setNotice(`已拆分为 ${files.length} 份单页 PDF，打包为 ZIP。`);
        }
      }
    } catch (reason) {
      if (valid()) setError(reason instanceof Error ? reason.message : '转换失败，请检查文件后重试。');
    } finally { if (generation.current === id) { setBusy(false); active.current = null; } }
  }
  const accept = tool === 'document' ? '.md,.markdown,.txt,.html,.htm,.log' : tool === 'image-pdf' ? 'image/png,image/jpeg,image/webp' : 'application/pdf,.pdf';
  const singlePdf = tool === 'text' || tool === 'images' || tool === 'split';
  const progressPercent = progress.total > 0 ? Math.min(100, Math.max(0, Math.round(progress.completed / progress.total * 100))) : 0;

  return <main className="cv-app">
    <header className="cv-header"><a className="cv-brand" href="reader.html"><img src="/brand/near-translate.svg" alt="" /><span><small>近译 · 本地文档工具</small><h1>文档转换</h1></span></a><span className="cv-local">本机处理 · 无需登录或 Key</span></header>
    <nav className="cv-tools" aria-label="转换工具">{tools.map(value => <button type="button" key={value.id} aria-pressed={tool === value.id} disabled={busy} onClick={() => chooseTool(value.id)}><strong>{value.title}</strong><span>{value.caption}</span></button>)}</nav>
    <div className="cv-layout"><section className="cv-panel" aria-labelledby="cv-input-heading"><div className="cv-section-heading"><span>01</span><div><h2 id="cv-input-heading">{current.title}</h2><p>{current.caption}</p></div></div>
      <fieldset disabled={busy}>
        <div className="cv-drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) void addFiles([...event.dataTransfer.files]); }}>
          <input ref={input} id="cv-files" type="file" accept={accept} multiple={tool === 'pages' || tool === 'image-pdf'} onChange={event => { void addFiles([...event.target.files ?? []]); event.target.value = ''; }} />
          <label htmlFor="cv-files">{tool === 'document' ? '选择文档，或在下方粘贴内容' : tool === 'image-pdf' ? '选择图片，也可拖入这里' : '选择 PDF，也可拖入这里'}</label><small>{tool === 'document' ? 'Markdown / UTF-8 文本 / HTML · 最大 5 MB' : '单个文件最大 100 MB，合计最大 200 MB'}</small>
        </div>
        {tool === 'document' ? <>
          <label className="cv-field">输入格式<select value={sourceFormat} onChange={event => { clearOutput(); setSourceFormat(event.target.value as typeof sourceFormat); }}><option value="markdown">Markdown</option><option value="text">纯文本</option><option value="html">HTML</option></select></label>
          <label className="cv-field">文档内容<textarea className="cv-source" value={source} onChange={event => { clearOutput(); setSource(event.target.value); }} spellCheck={false} /></label>
          <label className="cv-field">本地图片附件<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event => { void addAttachments([...event.target.files ?? []]); event.target.value = ''; }} /><small>按 Markdown 中的图片文件名匹配，合计最多 32 MB。外链图片默认不加载。</small></label>
          {attachments.length > 0 && <p className="cv-muted">已附加 {attachments.length} 张本地图片 <button className="cv-text-button" type="button" onClick={() => { clearOutput(); setAttachments([]); }}>移除附件</button></p>}
          <div className="cv-settings"><label className="cv-field">纸张<select value={paper} onChange={event => { clearOutput(); setPaper(event.target.value as typeof paper); }}><option>A4</option><option>Letter</option></select></label><label className="cv-field">方向<select value={landscape ? 'landscape' : 'portrait'} onChange={event => { clearOutput(); setLandscape(event.target.value === 'landscape'); }}><option value="portrait">纵向</option><option value="landscape">横向</option></select></label><label className="cv-field">边距（mm）<input type="number" min="0" max="40" value={margin} onChange={event => { clearOutput(); setMargin(Number(event.target.value)); }} /></label><label className="cv-field">字号（pt）<input type="number" min="8" max="24" value={fontSize} onChange={event => { clearOutput(); setFontSize(Number(event.target.value)); }} /></label></div>
        </> : <>
          {items.length > 0 && <ol className="cv-file-list">{items.map((item, index) => <li key={item.id}><div className="cv-file-title"><strong>{index + 1}. {item.file.name}</strong><span>{(item.file.size / 1024 / 1024).toFixed(1)} MB</span></div>{tool === 'pages' && <label className="cv-field">这个文件的页码范围<input value={item.pages} placeholder="全部；或 1-3,5；重排 3,1,2" onChange={event => { clearOutput(); setItems(previous => previous.map(value => value.id === item.id ? { ...value, pages: event.target.value } : value)); }} /></label>}<div className="cv-file-actions"><button type="button" aria-label={`上移文件 ${index + 1}`} disabled={index === 0} onClick={() => moveItem(index, -1)}>上移</button><button type="button" aria-label={`下移文件 ${index + 1}`} disabled={index === items.length - 1} onClick={() => moveItem(index, 1)}>下移</button><button type="button" aria-label={`移除文件 ${index + 1}`} onClick={() => { clearOutput(); setItems(previous => previous.filter(value => value.id !== item.id)); }}>移除</button></div></li>)}</ol>}
          {singlePdf && <label className="cv-field">页码范围<input value={pages} onChange={event => { clearOutput(); setPages(event.target.value); }} placeholder="留空处理全部；例如 1-3,5,8" /><small>从 1 开始；支持逗号、范围和自定义顺序。一次最多 {tool === 'images' ? 100 : 500} 页。</small></label>}
          {(tool === 'text' || tool === 'images') && <label className="cv-field">PDF 打开密码（如有）<input type="password" value={password} autoComplete="off" onChange={event => { clearOutput(); setPassword(event.target.value); }} /><small>仅用于本次本地解锁，不会保存。</small></label>}
          {tool === 'text' && <label className="cv-field">输出格式<select value={textFormat} onChange={event => { clearOutput(); setTextFormat(event.target.value as typeof textFormat); }}><option value="markdown">Markdown (.md)</option><option value="text">纯文本 (.txt)</option></select><small>适用于有文字层的 PDF；扫描件需先做 OCR。复杂表格、公式和插图需要人工核对。</small></label>}
          {tool === 'images' && <div className="cv-settings"><label className="cv-field">图片格式<select value={imageFormat} onChange={event => { clearOutput(); setImageFormat(event.target.value as typeof imageFormat); }}><option value="png">PNG · 清晰文字</option><option value="jpeg">JPG · 较小文件</option></select></label><label className="cv-field">分辨率<select value={scale} onChange={event => { clearOutput(); setScale(Number(event.target.value)); }}><option value="1">72 DPI</option><option value="1.5">108 DPI</option><option value="2">144 DPI</option><option value="3">216 DPI</option></select></label></div>}
          {tool === 'image-pdf' && <label className="cv-field">PDF 页面<select value={pageSize} onChange={event => { clearOutput(); setPageSize(event.target.value as typeof pageSize); }}><option value="a4">A4 · 等比适配</option><option value="original">按图片尺寸</option></select><small>按列表顺序排列，每张图片一页；不拉伸图片。</small></label>}
          {tool === 'pages' && <label className="cv-field">页面旋转<select value={rotation} onChange={event => { clearOutput(); setRotation(Number(event.target.value)); }}><option value="0">保持原方向</option><option value="90">顺时针 90°</option><option value="180">旋转 180°</option><option value="270">逆时针 90°</option></select><small>一个文件可提取或重排页面；多个文件按列表顺序合并。保留原始文字和矢量内容。</small></label>}
          {(tool === 'pages' || tool === 'split') && <p className="cv-muted">加密 PDF 请先解密另存。整理页面不保证保留文档书签、交互表单或签名。</p>}
        </>}
        <label className="cv-field">导出文件名<input value={name} maxLength={100} onChange={event => { clearOutput(); setName(event.target.value); }} /></label>
      </fieldset>
      <div className="cv-run"><button className="cv-primary" type="button" disabled={busy || (tool !== 'document' && !items.length)} onClick={() => void convert()}>{busy ? tool === 'document' ? '正在生成 PDF…' : '正在处理…' : tool === 'document' ? '下载 PDF' : '开始转换'}</button>{busy && <button type="button" onClick={cancel}>取消</button>}{busy && progress.total > 0 && <span>{tool === 'document' ? `${progressPercent}%` : `${progress.completed} / ${progress.total}`}</span>}</div>
      {busy && (tool === 'document' || progress.total > 0) && <progress max={progress.total > 0 ? progress.total : undefined} value={progress.total > 0 ? progress.completed : undefined} aria-label="转换进度" />}
      <div className="cv-status" role="status" aria-live="polite">{notice}</div>{error && <p className="cv-error" role="alert">{error}</p>}
    </section>
    <section className="cv-panel cv-result" aria-labelledby="cv-output-heading"><div className="cv-section-heading"><span>02</span><div><h2 id="cv-output-heading">预览与导出</h2><p>{tool === 'document' ? 'PDF 直接下载，也可再次保存或查看预览' : '核对结果后再保存文件'}</p></div></div>
      {warnings.length > 0 && <div className="cv-warnings"><strong>需要核对</strong><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {preview && <details className="cv-document-preview"><summary>查看排版预览<span>HTML</span></summary><iframe title="文档预览" className="cv-preview" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={preview} /></details>}
      {text && <><textarea className="cv-text-result" aria-label="转换后的文字" value={text} readOnly /><button type="button" onClick={() => { void navigator.clipboard.writeText(text).then(() => setNotice('文字已复制。')).catch(() => setError('复制失败，请在预览框中手动选中复制。')); }}>复制文字</button></>}
      {results.length > 0 && <div className="cv-downloads">{results.map(result => <a key={result.url} className={`cv-download${result.secondary ? ' cv-download-secondary' : ''}`} href={result.url} download={result.name}><strong>下载 {result.name}</strong><span>{(result.blob.size / 1024).toFixed(1)} KB</span></a>)}</div>}
      {!preview && !text && !results.length && <div className="cv-empty"><img src="/brand/near-translate.svg" alt="" /><h3>在这里整理成需要的格式</h3><p>选择左侧工具与文件，转换结果会出现在这里。<br />不上传文件，不调用翻译模型。</p></div>}
    </section></div>
    <footer className="cv-footer">所有转换在此扩展页面本地完成。关闭页面将清除本次文件与密码。 <a href="reader.html">打开 PDF 阅读器</a></footer>
  </main>;
}
