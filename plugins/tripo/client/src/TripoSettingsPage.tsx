import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AuraPluginPageProps } from '@aura/plugin-ui';
import type {
  BudgetSettings,
  ConnectionSettings,
  TripoBudget,
  TripoSettings,
} from '../../shared/settings.ts';
import { errorMessage, saveConnection } from './settings-api.ts';

const budgetFields = [
  { id: 'maxCredits', label: '总额度', required: true },
  { id: 'maxScopeCredits', label: '单组上限', required: false },
  { id: 'modelStageCredits', label: '每个模型阶段', required: true },
  { id: 'imageStageCredits', label: '每个视图阶段', required: true },
  { id: 'cloudStageCredits', label: '每个云图片阶段', required: false },
] as const;
type BudgetDraft = {
  mode: 'limited' | 'unlimited';
  values: Record<(typeof budgetFields)[number]['id'], string>;
};
type Notice = { kind: 'success' | 'error'; text: string };
type Operation = 'load' | 'connection' | 'check' | 'budget';

function toDraft(budget: TripoBudget | null | undefined): BudgetDraft {
  const limited = budget?.unlimited === false ? budget : undefined;
  return {
    mode: budget?.unlimited ? 'unlimited' : 'limited',
    values: {
      maxCredits: String(limited?.maxCredits ?? ''),
      maxScopeCredits: String(limited?.maxScopeCredits ?? ''),
      modelStageCredits: String(limited?.modelStageCredits ?? ''),
      imageStageCredits: String(limited?.imageStageCredits ?? ''),
      cloudStageCredits: String(limited?.cloudStageCredits ?? ''),
    },
  };
}

function toBudget({ mode, values }: BudgetDraft): TripoBudget {
  if (mode === 'unlimited') return { unlimited: true };
  return {
    unlimited: false,
    maxCredits: Number(values.maxCredits),
    modelStageCredits: Number(values.modelStageCredits),
    imageStageCredits: Number(values.imageStageCredits),
    ...(values.maxScopeCredits
      ? { maxScopeCredits: Number(values.maxScopeCredits) }
      : {}),
    ...(values.cloudStageCredits
      ? { cloudStageCredits: Number(values.cloudStageCredits) }
      : {}),
  };
}

function Feedback({ notice }: { notice?: Notice }) {
  return notice ? (
    <p
      className="tripo-settings-feedback"
      data-tone={notice.kind}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {notice.text}
    </p>
  ) : null;
}

export function TripoSettingsPage({
  endpoint,
  invoke,
  onDirtyChange,
}: AuraPluginPageProps) {
  const [snapshot, setSnapshot] = useState<TripoSettings>();
  const [regionDraft, setRegionDraft] =
    useState<ConnectionSettings['region']>();
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft>();
  const [hasKeyDraft, setHasKeyDraft] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [operation, setOperation] = useState<Operation>('load');
  const [busy, setBusy] = useState(true);
  const [loadError, setLoadError] = useState<Notice>();
  const [connectionNotice, setConnectionNotice] = useState<Notice>();
  const [budgetNotice, setBudgetNotice] = useState<Notice>();
  const [loadVersion, reload] = useState(0);
  const keyInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);

  const region = regionDraft ?? snapshot?.connection.region;
  const savedBudget = toDraft(snapshot?.budget?.budget);
  const draft = budgetDraft ?? savedBudget;
  const connectionDirty = Boolean(
    snapshot &&
    (region !== snapshot.connection.region || hasKeyDraft || clearKey),
  );
  const budgetDirty = Boolean(
    snapshot?.budget && JSON.stringify(draft) !== JSON.stringify(savedBudget),
  );
  const dirty = connectionDirty || budgetDirty;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void invoke('settings', null, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setSnapshot(value as TripoSettings);
        setRegionDraft(undefined);
        setBudgetDraft(undefined);
        setHasKeyDraft(false);
        setClearKey(false);
        if (keyInput.current) keyInput.current.value = '';
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError({ kind: 'error', text: errorMessage(error) });
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          request.current = null;
          setBusy(false);
        }
      });
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [invoke, loadVersion]);

  async function run(
    next: Operation,
    work: (signal: AbortSignal) => Promise<void>,
    report: (notice: Notice | undefined) => void,
  ) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    report(undefined);
    setOperation(next);
    setBusy(true);
    try {
      await work(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        report({ kind: 'error', text: errorMessage(error) });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  function reloadSettings() {
    if (request.current) return;
    setLoadError(undefined);
    setConnectionNotice(undefined);
    setBudgetNotice(undefined);
    setOperation('load');
    setBusy(true);
    reload((version) => version + 1);
  }

  function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !snapshot?.localConfiguration ||
      snapshot.connection.readOnly ||
      !region ||
      !connectionDirty
    )
      return;
    const key = keyInput.current?.value.trim();
    void run(
      'connection',
      async (signal) => {
        const connection = await saveConnection(
          endpoint,
          {
            revision: snapshot.connection.revision,
            region,
            ...(key ? { key } : {}),
            ...(clearKey ? { clearKey } : {}),
          },
          signal,
        );
        if (signal.aborted) return;
        setSnapshot({ ...snapshot, connection });
        setRegionDraft(undefined);
        setHasKeyDraft(false);
        setClearKey(false);
        if (keyInput.current) keyInput.current.value = '';
        setConnectionNotice({ kind: 'success', text: '连接设置已保存。' });
      },
      setConnectionNotice,
    );
  }

  function testConnection() {
    if (
      !snapshot?.localConfiguration ||
      !snapshot.connection.configured ||
      connectionDirty
    )
      return;
    void run(
      'check',
      async (signal) => {
        await invoke('check', null, signal);
        if (!signal.aborted)
          setConnectionNotice({
            kind: 'success',
            text: '连接成功，已验证账户访问。',
          });
      },
      setConnectionNotice,
    );
  }

  function submitBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot?.localConfiguration || !snapshot.budget || !budgetDirty)
      return;
    const budget = toBudget(draft);
    const revision = snapshot.budget.revision;
    void run(
      'budget',
      async (signal) => {
        const saved = (await invoke(
          'save-budget',
          { revision, budget },
          signal,
        )) as BudgetSettings;
        if (signal.aborted) return;
        setSnapshot({ ...snapshot, budget: saved });
        setBudgetDraft(undefined);
        setBudgetNotice({ kind: 'success', text: '预算已保存。' });
      },
      setBudgetNotice,
    );
  }

  const editableConnection =
    snapshot?.localConfiguration && !snapshot.connection.readOnly;
  const working = (action: Operation) => busy && operation === action;

  return (
    <div className="tripo-settings">
      <div className="tripo-settings-content">
        <header className="tripo-settings-header">
          <div>
            <h1>Tripo 设置</h1>
            <p>管理 3D 生成服务的连接和付费额度。</p>
          </div>
          <button
            className="tripo-settings-button"
            type="button"
            disabled={busy}
            onClick={reloadSettings}
          >
            重新读取
          </button>
        </header>
        <Feedback notice={loadError} />
        {!snapshot && busy && <p role="status">正在读取 Tripo 设置…</p>}
        {snapshot && (
          <>
            {!snapshot.localConfiguration && (
              <p className="tripo-settings-note">
                请从本机 Aura 打开此页以修改设置和测试连接。
              </p>
            )}
            <section
              className="tripo-settings-section"
              aria-labelledby="tripo-connection"
            >
              <div className="tripo-settings-section-title">
                <h2 id="tripo-connection">服务连接</h2>
                <p>地区应与 Tripo 账户和 Key 所属站点一致。</p>
              </div>
              <form
                className="tripo-settings-form"
                onSubmit={submitConnection}
                aria-busy={working('connection') || working('check')}
              >
                <fieldset disabled={!editableConnection || busy}>
                  <label className="tripo-settings-field">
                    <span>地区</span>
                    <select
                      value={region}
                      onChange={(event) => {
                        setRegionDraft(
                          event.target.value as ConnectionSettings['region'],
                        );
                        setConnectionNotice(undefined);
                      }}
                    >
                      <option value="global">海外站</option>
                      <option value="china">国内站</option>
                    </select>
                  </label>
                  <label className="tripo-settings-field">
                    <span>
                      API Key{' '}
                      <small data-ready={snapshot.connection.configured}>
                        {snapshot.connection.configured ? '已配置' : '未配置'}
                      </small>
                    </span>
                    <input
                      ref={keyInput}
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      maxLength={256}
                      disabled={clearKey}
                      placeholder={
                        snapshot.connection.configured
                          ? '输入新 Key 以替换'
                          : '输入 Tripo API Key'
                      }
                      onChange={(event) => {
                        setHasKeyDraft(Boolean(event.target.value.trim()));
                        setConnectionNotice(undefined);
                      }}
                    />
                  </label>
                  {snapshot.connection.configured &&
                    !snapshot.connection.readOnly && (
                      <label className="tripo-settings-checkbox">
                        <input
                          type="checkbox"
                          checked={clearKey}
                          onChange={(event) => {
                            if (keyInput.current) keyInput.current.value = '';
                            setHasKeyDraft(false);
                            setClearKey(event.target.checked);
                            setConnectionNotice(undefined);
                          }}
                        />
                        保存时移除已存的 Key
                      </label>
                    )}
                </fieldset>
                {snapshot.connection.readOnly && (
                  <p className="tripo-settings-note">
                    Key 由运行环境提供，连接设置为只读。
                  </p>
                )}
                <div className="tripo-settings-actions">
                  <button
                    className="tripo-settings-button"
                    type="submit"
                    disabled={!editableConnection || busy || !connectionDirty}
                  >
                    {working('connection') ? '正在保存…' : '保存连接'}
                  </button>
                  <button
                    className="tripo-settings-button"
                    type="button"
                    onClick={testConnection}
                    disabled={
                      !snapshot.localConfiguration ||
                      !snapshot.connection.configured ||
                      connectionDirty ||
                      busy
                    }
                  >
                    {working('check') ? '正在测试…' : '测试连接'}
                  </button>
                </div>
                {connectionDirty && (
                  <p className="tripo-settings-note">
                    保存连接设置后即可测试。
                  </p>
                )}
                <Feedback notice={connectionNotice} />
              </form>
            </section>
            <section
              className="tripo-settings-section"
              aria-labelledby="tripo-budget"
            >
              <div className="tripo-settings-section-title">
                <h2 id="tripo-budget">付费预算</h2>
                <p>以 Tripo 积分计量。每个付费阶段先预留额度，再提交任务。</p>
              </div>
              <form
                className="tripo-settings-form"
                onSubmit={submitBudget}
                aria-busy={working('budget')}
              >
                {snapshot.budget ? (
                  <>
                    {snapshot.budget.invalid && (
                      <p className="tripo-settings-note">
                        当前预算配置无效。填写并保存新的额度即可修复。
                      </p>
                    )}
                    <fieldset disabled={busy}>
                      <label className="tripo-settings-field">
                        <span>预算模式</span>
                        <select
                          value={draft.mode}
                          onChange={(event) => {
                            setBudgetDraft({
                              ...draft,
                              mode: event.target.value as BudgetDraft['mode'],
                            });
                            setBudgetNotice(undefined);
                          }}
                        >
                          <option value="limited">设置额度上限</option>
                          <option value="unlimited">不限额度，继续记账</option>
                        </select>
                      </label>
                      {draft.mode === 'limited' && (
                        <>
                          {budgetFields.map(({ id, label, required }) => (
                            <label key={id} className="tripo-settings-field">
                              <span>
                                {label}
                                {!required && <small>选填</small>}
                              </span>
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                max="1000000"
                                step="any"
                                required={required}
                                placeholder="积分"
                                value={draft.values[id]}
                                onChange={(event) => {
                                  setBudgetDraft({
                                    ...draft,
                                    values: {
                                      ...draft.values,
                                      [id]: event.target.value,
                                    },
                                  });
                                  setBudgetNotice(undefined);
                                }}
                              />
                            </label>
                          ))}
                        </>
                      )}
                    </fieldset>
                    <p className="tripo-settings-note">
                      {draft.mode === 'limited'
                        ? '单组或云图片上限留空时，对应的付费请求会被拒绝。'
                        : '不限额模式仍记录每个阶段，费用按 Tripo 实际用量结算。'}
                    </p>
                    <div className="tripo-settings-actions">
                      <button
                        className="tripo-settings-button"
                        type="submit"
                        disabled={busy || !budgetDirty}
                      >
                        {working('budget') ? '正在保存…' : '保存预算'}
                      </button>
                    </div>
                    <Feedback notice={budgetNotice} />
                  </>
                ) : (
                  <p className="tripo-settings-note">预算管理仅供本机使用。</p>
                )}
              </form>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
