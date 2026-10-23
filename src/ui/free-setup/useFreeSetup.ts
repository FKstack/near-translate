import { useEffect, useRef, useState } from 'react';
import type { ConnectionSettings } from '../../shared/contracts';
import { enableFreeTranslation, FreeSetupError, readFreeTranslationStatus, testFreeTranslation, type FreeSetupClient, type FreeTestResult } from './client';

/** UI request state only; the background retains settings, service cancellation and cooldown ownership. */
export function useFreeSetup(client: FreeSetupClient, onEnabled: (settings: ConnectionSettings) => void) {
  const [enabling, setEnabling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<FreeTestResult>();
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const alive = useRef(false);
  const activeAction = useRef(false);
  const refreshStatus = () => readFreeTranslationStatus(client).then(status => {
    if (alive.current) setCooldownUntil(status.cooldownUntil);
  }).catch(() => { /* A status read must not prevent local reading or replace an explicit action's result. */ });

  useEffect(() => {
    alive.current = true;
    void refreshStatus();
    return () => { alive.current = false; };
  }, [client]);

  const failure = (reason: unknown, fallback: string) => {
    if (!alive.current) return;
    setError(reason instanceof Error ? reason.message : fallback);
    if (reason instanceof FreeSetupError && reason.translationError?.retryAt) setCooldownUntil(reason.translationError.retryAt);
  };
  const enable = () => {
    if (activeAction.current) return;
    activeAction.current = true;
    setEnabling(true); setError(''); setNotice(''); setTestResult(undefined);
    // Calling this before any await preserves the browser's permission user gesture.
    void enableFreeTranslation(client).then(settings => {
      if (!alive.current) return;
      onEnabled(settings);
      setNotice('免费翻译已启用。回到文章点击“翻译正文”，或选择文字后点击“译”。');
      void refreshStatus();
    }).catch(reason => failure(reason, '启用失败，你仍可使用本地阅读。')).finally(() => {
      activeAction.current = false;
      if (alive.current) setEnabling(false);
    });
  };
  const test = () => {
    if (activeAction.current) return;
    activeAction.current = true;
    setTesting(true); setError(''); setNotice(''); setTestResult(undefined);
    void testFreeTranslation(client).then(result => {
      if (alive.current) setTestResult(result);
    }).catch(reason => failure(reason, '连接测试失败，请稍后手动重试。')).finally(() => {
      activeAction.current = false;
      if (alive.current) { setTesting(false); void refreshStatus(); }
    });
  };
  return { enable, test, enabling, testing, notice, error, testResult, cooldownUntil };
}
