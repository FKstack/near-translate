import { useState, type FormEvent } from 'react';
import type { ConnectionSettings } from '@/shared/contracts';
import type { KeyVaultStatus } from '@/shared/key-vault';
import './key-vault.css';

export type KeyVaultMessage = { type: 'create-key-vault' | 'unlock-key-vault'; passphrase: string }
  | { type: 'lock-key-vault' }
  | { type: 'change-key-vault-passphrase'; currentPassphrase: string; newPassphrase: string };
type Props = {
  status?: KeyVaultStatus;
  disabled?: boolean;
  sendMessage(message: KeyVaultMessage): Promise<unknown>;
  onChanged(settings: ConnectionSettings): void;
  onBusyChange?(busy: boolean): void;
};
type VaultResponse = { ok?: boolean; status?: KeyVaultStatus; settings?: ConnectionSettings; error?: string };

export function KeyVaultPanel({ status, disabled, sendMessage, onChanged, onBusyChange }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const creating = !status?.configured;
  const locked = status?.locked === true;
  const editing = creating || locked || changing;
  const blocked = disabled || !status || busy;
  const clearSecrets = () => { setPassphrase(''); setConfirmation(''); setNewPassphrase(''); };

  async function perform(message: KeyVaultMessage, success: string) {
    setBusy(true); onBusyChange?.(true); setError(''); setNotice('');
    try {
      const result = await sendMessage(message) as VaultResponse;
      if (result?.status && result.settings?.profiles) {
        onChanged({ ...result.settings, vault: result.status });
        if (result.status.locked || !result.status.configured) setChanging(false);
      }
      if (!result?.ok || !result.status || !result.settings?.profiles) throw new Error(typeof result?.error === 'string' ? result.error : '密钥库操作失败，请重试。');
      setChanging(false); setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '密钥库操作失败，请重试。');
    } finally {
      clearSecrets(); setBusy(false); onBusyChange?.(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    const candidate = changing ? newPassphrase : passphrase;
    if (candidate.length < 12 || candidate.length > 128) { setError('口令长度应为 12–128 个字符；空格也计入长度。'); return; }
    if ((creating || changing) && candidate !== confirmation) { setError('两次输入的口令不一致。'); return; }
    if (changing) void perform({ type: 'change-key-vault-passphrase', currentPassphrase: passphrase, newPassphrase }, '口令已更新，密钥库保持解锁。');
    else if (creating) void perform({ type: 'create-key-vault', passphrase }, status?.migrationRequired ? '已有 Key 已加密迁移，密钥库已解锁。' : '密钥库已创建并解锁，可以保存 API Key。');
    else void perform({ type: 'unlock-key-vault', passphrase }, '密钥库已解锁，可以使用已保存的 API Key。');
  }

  return <section className="key-vault" aria-labelledby="key-vault-heading" aria-busy={busy}>
    <div className="key-vault-title"><h3 id="key-vault-heading">API Key 保护</h3><span className="key-vault-badge">{!status ? '读取中' : creating ? status.migrationRequired ? '需要加密迁移' : '尚未设置口令' : locked ? '已锁定' : '已解锁'}</span></div>
    <p className="muted">用你自己的口令加密保存在本机的 API Key。口令不会保存，也不会发送给翻译服务。DeepL 免费翻译和本地阅读无需解锁。</p>
    {creating ? <p>{status?.migrationRequired ? '检测到旧版保存的 Key。请设置口令，将所有服务的已有 Key 加密迁移后再使用模型翻译。' : '首次保存 API Key 前，请先设置密钥库口令。'}</p>
      : locked ? <p>请输入口令解锁。已保存的 Key 仍在密钥库中，无需重新填写。</p>
        : <p>本次浏览器会话已解锁，后台休眠后仍可使用；重新启动浏览器后需要再次解锁。可随时手动锁定。</p>}
    {editing && <form onSubmit={submit} className="key-vault-form">
      <fieldset disabled={blocked}>
        <div className="field"><label htmlFor="vault-passphrase">{changing ? '当前口令' : creating ? '设置密钥库口令' : '密钥库口令'}</label>
          <input id="vault-passphrase" type="password" autoComplete="off" spellCheck={false} value={passphrase} onChange={event => setPassphrase(event.target.value)} required minLength={12} maxLength={128} aria-describedby="vault-passphrase-help" /></div>
        {changing && <div className="field"><label htmlFor="vault-new-passphrase">新口令</label><input id="vault-new-passphrase" type="password" autoComplete="off" spellCheck={false} value={newPassphrase} onChange={event => setNewPassphrase(event.target.value)} required minLength={12} maxLength={128} /></div>}
        {(creating || changing) && <div className="field"><label htmlFor="vault-confirmation">确认{changing ? '新' : ''}口令</label><input id="vault-confirmation" type="password" autoComplete="off" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} required minLength={12} maxLength={128} /></div>}
        <p className="muted" id="vault-passphrase-help">12–128 个字符，空格会保留。请使用独立口令，不要把 API Key 填作口令。口令无法找回；请妥善保管，遗失后无法解密已有 Key。</p>
        <div className="actions"><button type="submit" className="primary">{busy ? '正在处理…' : changing ? '更新口令' : creating ? status?.migrationRequired ? '加密迁移已有 Key' : '创建密钥库' : '解锁密钥库'}</button>
          {changing && <button type="button" onClick={() => { setChanging(false); clearSecrets(); setError(''); }}>取消更改</button>}</div>
      </fieldset>
    </form>}
    {!creating && !locked && !changing && <div className="actions"><button type="button" disabled={blocked} onClick={() => void perform({ type: 'lock-key-vault' }, '密钥库已锁定，已停止正在进行的模型翻译。')}>锁定密钥库</button><button type="button" disabled={blocked} onClick={() => { setChanging(true); clearSecrets(); setError(''); setNotice(''); }}>更改口令</button></div>}
    {notice && <p role="status" className="key-vault-notice">{notice}</p>}
    {error && <p role="alert" className="key-vault-error">{error}</p>}
  </section>;
}
