import { createHash } from 'node:crypto';

const PASSWORD_PADDING = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');

function paddedPassword(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, 'latin1'), PASSWORD_PADDING]).subarray(0, 32);
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  let i = 0; j = 0;
  return Buffer.from(data.map(byte => {
    i = (i + 1) & 255; j = (j + state[i]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
    return byte ^ state[(state[i]! + state[j]!) & 255]!;
  }));
}

function md5(data: Buffer): Buffer { return createHash('md5').update(data).digest(); }

/** Small valid PDF fixtures with explicit byte offsets; no binary assets or PDF library needed. */
export function pdfFixture(options: { blank?: boolean; password?: string } = {}): Buffer {
  const pages = options.blank || options.password ? 1 : 2;
  const objects: Buffer[] = [];
  const add = (content: string | Buffer) => objects.push(typeof content === 'string' ? Buffer.from(content, 'latin1') : content);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const identifier = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  let encryptionKey: Buffer | undefined;
  let owner: Buffer | undefined;
  let user: Buffer | undefined;
  if (options.password) {
    owner = rc4(md5(paddedPassword('fixture-owner')).subarray(0, 5), paddedPassword(options.password));
    const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
    encryptionKey = md5(Buffer.concat([paddedPassword(options.password), owner, permissions, identifier])).subarray(0, 5);
    user = rc4(encryptionKey, PASSWORD_PADDING);
  }
  for (let page = 0; page < pages; page++) {
    const contentObject = 5 + page * 2;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`);
    const lines = page === 0
      ? ['The bank approved the technical report.', 'Concurrency does not imply parallelism.', 'Accuracy improved by 12% with 95% confidence.']
      : ['The result is not statistically significant.', 'Scientific evidence requires reproducible experiments.', 'Second page paragraph for translation.'];
    const source = options.blank ? '0.9 0.9 0.9 rg 50 600 400 100 re f' : `BT /F1 16 Tf 50 720 Td ${lines.map((line, index) => `${index ? '0 -28 Td ' : ''}(${line}) Tj`).join('\n')} ET`;
    let stream: Buffer = Buffer.from(source, 'latin1');
    if (encryptionKey) {
      const objectBytes = Buffer.from([contentObject & 255, (contentObject >> 8) & 255, (contentObject >> 16) & 255, 0, 0]);
      stream = rc4(md5(Buffer.concat([encryptionKey, objectBytes])).subarray(0, 10), stream);
    }
    add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]));
  }
  const encryptionObject = objects.length + 1;
  if (owner && user) add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`);
  const chunks = [Buffer.from('%PDF-1.4\n%NearTranslateFixture\n')];
  const offsets = [0];
  let length = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    chunks.push(chunk); length += chunk.length;
  });
  const xref = length;
  const idHex = identifier.toString('hex');
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptionKey ? ` /Encrypt ${encryptionObject} 0 R /ID [<${idHex}><${idHex}>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
