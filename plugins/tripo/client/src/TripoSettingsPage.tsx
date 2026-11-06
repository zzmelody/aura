import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  messageText,
  type AuraPluginPageProps,
  type MessageReference,
} from '@aura/plugin-ui';
import type {
  BudgetSettings,
  ConnectionSettings,
  TripoBudget,
  TripoSettings,
} from '../../shared/settings.ts';
import { errorMessage, saveConnection } from './settings-api.ts';
import { useTripoMessages } from './messages.ts';

const budgetFields = [
  { id: 'maxCredits', required: true },
  { id: 'maxScopeCredits', required: false },
  { id: 'modelStageCredits', required: true },
  { id: 'imageStageCredits', required: true },
  { id: 'cloudStageCredits', required: false },
] as const;
type BudgetDraft = {
  mode: 'limited' | 'unlimited';
  values: Record<(typeof budgetFields)[number]['id'], string>;
};
type Notice = { kind: 'success' | 'error'; text: string | MessageReference };
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
  const { t, i18n } = useTripoMessages();
  return notice ? (
    <p
      className="tripo-settings-feedback"
      data-tone={notice.kind}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {typeof notice.text === 'string'
        ? t(notice.text, { defaultValue: notice.text })
        : messageText(notice.text, i18n)}
    </p>
  ) : null;
}

export function TripoSettingsPage({
  endpoint,
  invoke,
  onDirtyChange,
}: AuraPluginPageProps) {
  const { t } = useTripoMessages();
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
        setConnectionNotice({ kind: 'success', text: 'connectionSaved' });
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
            text: 'connectionVerified',
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
        setBudgetNotice({ kind: 'success', text: 'budgetSaved' });
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
            <h1>{t('title')}</h1>
            <p>{t('subtitle')}</p>
          </div>
          <button
            className="tripo-settings-button"
            type="button"
            disabled={busy}
            onClick={reloadSettings}
          >
            {t('reload')}
          </button>
        </header>
        <Feedback notice={loadError} />
        {!snapshot && busy && <p role="status">{t('loading')}</p>}
        {snapshot && (
          <>
            {!snapshot.localConfiguration && (
              <p className="tripo-settings-note">{t('localOnly')}</p>
            )}
            <section
              className="tripo-settings-section"
              aria-labelledby="tripo-connection"
            >
              <div className="tripo-settings-section-title">
                <h2 id="tripo-connection">{t('connection')}</h2>
                <p>{t('regionHint')}</p>
              </div>
              <form
                className="tripo-settings-form"
                onSubmit={submitConnection}
                aria-busy={working('connection') || working('check')}
              >
                <fieldset disabled={!editableConnection || busy}>
                  <label className="tripo-settings-field">
                    <span>{t('region')}</span>
                    <select
                      value={region}
                      onChange={(event) => {
                        setRegionDraft(
                          event.target.value as ConnectionSettings['region'],
                        );
                        setConnectionNotice(undefined);
                      }}
                    >
                      <option value="global">{t('global')}</option>
                      <option value="china">{t('china')}</option>
                    </select>
                  </label>
                  <label className="tripo-settings-field">
                    <span>
                      API Key{' '}
                      <small data-ready={snapshot.connection.configured}>
                        {snapshot.connection.configured
                          ? t('configured')
                          : t('notConfigured')}
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
                          ? t('replaceKey')
                          : t('enterKey')
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
                        {t('removeKey')}
                      </label>
                    )}
                </fieldset>
                {snapshot.connection.readOnly && (
                  <p className="tripo-settings-note">{t('environmentKey')}</p>
                )}
                <div className="tripo-settings-actions">
                  <button
                    className="tripo-settings-button"
                    type="submit"
                    disabled={!editableConnection || busy || !connectionDirty}
                  >
                    {working('connection') ? t('saving') : t('saveConnection')}
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
                    {working('check') ? t('testing') : t('testConnection')}
                  </button>
                </div>
                {connectionDirty && (
                  <p className="tripo-settings-note">{t('saveFirst')}</p>
                )}
                <Feedback notice={connectionNotice} />
              </form>
            </section>
            <section
              className="tripo-settings-section"
              aria-labelledby="tripo-budget"
            >
              <div className="tripo-settings-section-title">
                <h2 id="tripo-budget">{t('budget')}</h2>
                <p>{t('budgetHint')}</p>
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
                        {t('invalidBudget')}
                      </p>
                    )}
                    <fieldset disabled={busy}>
                      <label className="tripo-settings-field">
                        <span>{t('budgetMode')}</span>
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
                          <option value="limited">{t('limited')}</option>
                          <option value="unlimited">{t('unlimited')}</option>
                        </select>
                      </label>
                      {draft.mode === 'limited' && (
                        <>
                          {budgetFields.map(({ id, required }) => (
                            <label key={id} className="tripo-settings-field">
                              <span>
                                {t(id)}
                                {!required && <small>{t('optional')}</small>}
                              </span>
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                max="1000000"
                                step="any"
                                required={required}
                                placeholder={t('credits')}
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
                        ? t('limitedHint')
                        : t('unlimitedHint')}
                    </p>
                    <div className="tripo-settings-actions">
                      <button
                        className="tripo-settings-button"
                        type="submit"
                        disabled={busy || !budgetDirty}
                      >
                        {working('budget') ? t('saving') : t('saveBudget')}
                      </button>
                    </div>
                    <Feedback notice={budgetNotice} />
                  </>
                ) : (
                  <p className="tripo-settings-note">{t('budgetLocalOnly')}</p>
                )}
              </form>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
