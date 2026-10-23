import { useEffect, useId, useState } from 'react';
import { PUBLIC_TEST_SENTENCE, remainingCooldownSeconds, type FreeTestResult } from './client';

interface FreeSetupProps {
  ready: boolean;
  enabled: boolean;
  enabling: boolean;
  testing: boolean;
  notice: string;
  error: string;
  testResult?: FreeTestResult;
  cooldownUntil: number;
  onEnable: () => void;
  onTest: () => void;
  compact?: boolean;
}

export function FreeSetup(props: FreeSetupProps) {
  const id = useId();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (props.cooldownUntil <= Date.now()) return;
    const timer = setInterval(() => {
      const current = Date.now(); setNow(current);
      if (current >= props.cooldownUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [props.cooldownUntil]);
  const remaining = remainingCooldownSeconds(props.cooldownUntil, now);
  const busy = props.enabling || props.testing;
  return <section id="free-setup" className={`free-setup${props.compact ? ' free-setup-compact' : ''}`} aria-label="免费翻译入门">
    <div className="free-setup-heading"><span className="free-setup-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h10M9 3v3M6 6c.5 4 2.5 7 6 9M12 6c-.5 4-3 8-7 10M13 21l4-10 4 10M14.5 18h5"/></svg></span><div>
      <h2>{props.enabled ? '免费翻译已就绪' : '不填 Key，也能开始翻译'}</h2><p>DeepL 免费服务 · 无需登录或 Key</p>
    </div></div>
    {!props.compact && <p className="free-setup-description">一次启用网页与翻译服务访问权限。仅在你点击翻译时发送相应文字；已有大模型配置和 Key 会保留。</p>}
    <div className="free-setup-actions">
      <button type="button" className={props.enabled ? 'free-setup-enabled' : 'primary'} aria-label="启用免费翻译" disabled={!props.ready || busy || props.enabled} onClick={props.onEnable}>{props.enabling ? '正在启用…' : props.enabled ? '免费翻译已启用' : '启用免费翻译'}</button>
      <button type="button" aria-label="测试免费翻译" aria-describedby={`${id}-sample${remaining > 0 ? ` ${id}-cooldown` : ''}`} disabled={!props.ready || !props.enabled || busy || remaining > 0} onClick={props.onTest}>{props.testing ? '正在测试…' : '测试免费翻译'}</button>
    </div>
    <p className="free-test-summary" id={`${id}-sample`}>测试仅发送固定公开示例句，不读取当前文章。</p>
    <details className="free-test-explanation"><summary>连接测试会发送什么？</summary><p>仅点击“测试免费翻译”时，发送这句固定公开英文：</p><blockquote lang="en">{PUBLIC_TEST_SENTENCE}</blockquote><p>示例固定译为简体中文，不读取当前文章，不收费，无需登录或 Key。</p></details>
    {remaining > 0 && <p className="free-cooldown" id={`${id}-cooldown`} role="timer" aria-live="off" aria-label="免费服务冷却倒计时">免费服务正在冷却，约 {remaining} 秒后可手动重试。已完成译文会保留，不会自动重试。</p>}
    <div className="free-setup-feedback" aria-live="polite">
      {props.notice && <p className="success">{props.notice}</p>}
      {props.error && <p className="free-setup-error">{props.error}</p>}
      {props.testResult && <div className="free-test-result" aria-label="公开示例句测试结果"><p>{props.testResult.translation}</p><small>测试成功 · {(props.testResult.elapsedMs / 1000).toFixed(2)} 秒 · 仅代表本次连接</small></div>}
    </div>
    {!props.compact && <p className="free-setup-footnote">免费服务可能限流或暂时不可用；本地阅读始终可用。启用不会自动翻译当前文章。</p>}
  </section>;
}
