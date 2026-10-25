import { useEffect, useState } from 'react';
import type { TranslationError, TranslationServiceStatus } from '../../shared/contracts';

export interface TranslationRecovery {
  action: 'retry' | 'settings' | 'none';
  blocked: boolean;
  remainingSeconds: number;
  message?: string;
}

function deadline(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000 ? value : 0;
}

export function recoveryDeadline(error?: TranslationError, serviceStatus?: TranslationServiceStatus): number {
  return Math.max(error?.code === 'RATE_LIMIT' ? deadline(error.retryAt) : 0, deadline(serviceStatus?.cooldownUntil));
}

/** Presentation only: a deadline enables a manual action, never schedules a request. */
export function translationRecovery(error?: TranslationError, serviceStatus?: TranslationServiceStatus, now = Date.now()): TranslationRecovery {
  const until = recoveryDeadline(error, serviceStatus);
  const remainingSeconds = Math.max(0, Math.ceil((until - now) / 1_000));
  const blocked = remainingSeconds > 0;
  const settings = error?.code === 'CONFIG' || error?.code === 'AUTH';
  const retry = blocked || error?.code === 'RATE_LIMIT' || error?.code === 'NETWORK' || error?.code === 'TIMEOUT' || error?.retryable === true;
  const rateMessage = error?.code === 'RATE_LIMIT' && error.message.includes('DeepL') ? 'DeepL 请求受限' : '翻译服务暂时受限';
  return {
    action: settings ? 'settings' : retry ? 'retry' : 'none', blocked, remainingSeconds,
    message: blocked ? `${settings && error ? `${error.message} ` : ''}${rateMessage}，${remainingSeconds} 秒后可手动重试。`
      : error?.code === 'RATE_LIMIT' ? `${rateMessage}，${until ? '现在可以' : '请稍后'}手动重试。` : error?.message,
  };
}

/** One local clock per view, shared by its message and all recovery controls. */
export function useTranslationRecovery(error?: TranslationError, serviceStatus?: TranslationServiceStatus): TranslationRecovery {
  const until = recoveryDeadline(error, serviceStatus);
  const [clock, setClock] = useState(() => ({ until, now: Date.now() }));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const current = Date.now(); setClock({ until, now: current });
      if (until > current) timer = setTimeout(tick, Math.min(1_000, until - current));
    };
    tick();
    return () => { clearTimeout(timer); };
  }, [until]);
  // A new deadline can arrive after a long idle period with no ticking clock.
  // Its first render must not show a countdown based on the previous deadline.
  return translationRecovery(error, serviceStatus, clock.until === until ? clock.now : Date.now());
}

export function RecoveryAction({ recovery, onRetry, onSettings, retryLabel = '重试', className, disabled = false }: {
  recovery: TranslationRecovery;
  onRetry?: () => void;
  onSettings?: () => void;
  retryLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const settings = recovery.action === 'settings';
  const action = settings ? onSettings : onRetry;
  if (!action) return null;
  const blocked = disabled || (!settings && recovery.blocked);
  return <button type="button" className={className} disabled={blocked}
    onClick={() => { if (!blocked) action(); }}>{settings ? '打开设置' : retryLabel}</button>;
}
