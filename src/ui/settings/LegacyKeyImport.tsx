import { useState, type FormEvent } from 'react';
import type { ConnectionSettings } from '@/shared/contracts';

type ImportMessage = { type: 'import-legacy-keys'; passphrase: string };
type Props = {
  available?: boolean;
  disabled?: boolean;
  sendMessage(message: ImportMessage): Promise<unknown>;
  onChanged(settings: ConnectionSettings): void;
  onBusyChange?(busy: boolean): void;
};
type ImportReply = { ok?: boolean; settings?: ConnectionSettings; error?: string };

/** Optional recovery for old encrypted records; never part of normal Key setup. */
export function LegacyKeyImport({ available, disabled, sendMessage, onChanged, onBusyChange }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!available) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    setError('');
    if (!passphrase) { setError('请输入旧版口令，或直接重新填写 API Key。'); return; }
    setBusy(true); onBusyChange?.(true);
    try {
      const reply = await sendMessage({ type: 'import-legacy-keys', passphrase }) as ImportReply;
      if (!reply?.ok || !reply.settings?.profiles) throw new Error(reply?.error || '导入失败，旧版数据仍保留。');
      onChanged(reply.settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入失败，旧版数据仍保留。');
    } finally {
      setPassphrase(''); setBusy(false); onBusyChange?.(false);
    }
  }

  return <details className="connection-details">
    <summary>导入旧版 Key（可选）</summary>
    <p className="muted">旧版保存的 Key 仍保留。可以直接重新填写，也可以用原口令一次性导入，之后无需解锁。</p>
    <form onSubmit={submit}>
      <fieldset disabled={disabled || busy}>
        <div className="field"><label htmlFor="legacy-key-passphrase">旧版口令</label>
          <input id="legacy-key-passphrase" type="password" autoComplete="off" spellCheck={false} value={passphrase}
            onChange={event => setPassphrase(event.target.value)} maxLength={128} required /></div>
        <button type="submit">{busy ? '正在导入…' : '导入旧版 Key'}</button>
      </fieldset>
    </form>
    {error && <p role="alert" className="status notice error">{error}</p>}
  </details>;
}
