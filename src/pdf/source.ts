export interface RemotePdfSource {
  url: string;
  originPattern: string;
  filename: string;
}

export function parseRemotePdfSource(value: string): RemotePdfSource {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入完整的 http:// 或 https:// PDF 地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('在线 PDF 仅支持不含账号密码的 HTTP(S) 地址；本地文件请使用“打开本地 PDF”。');
  }
  // Chrome match patterns do not include a port. Keep it in the fetch URL.
  const originPattern = `${url.protocol}//${url.hostname}/*`;
  const lastPath = url.pathname.split('/').filter(Boolean).at(-1);
  let filename = lastPath || '在线 PDF';
  try {
    filename = decodeURIComponent(filename);
  } catch {
    // Keep malformed URL encodings as a readable source label.
  }
  url.hash = '';
  return { url: url.href, originPattern, filename };
}

export function pdfErrorMessage(error: unknown, remote: boolean): string {
  const name = error instanceof Error ? error.name : '';
  const detail = error instanceof Error ? error.message : '';
  if (name === 'InvalidPDFException') return '这个文件无法解析为有效 PDF，请检查文件是否损坏。';
  if (name === 'PasswordException') return '未能解锁 PDF，请重新打开并输入正确密码。';
  if (remote) return `在线 PDF 加载失败${detail ? `：${detail}` : '。'}。请下载 PDF 后使用“打开本地 PDF”。`;
  return `PDF 加载失败${detail ? `：${detail}` : '。'}。请检查文件后重新打开。`;
}
