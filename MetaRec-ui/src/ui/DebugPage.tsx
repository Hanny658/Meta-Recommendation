import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { DebugConfig, DebugRunDetail, DebugRunSummary, DebugUnitSpec } from '../utils/types'
import './DebugPage.css'
import {
  debugLogin,
  debugLogout,
  explainBehaviorDebugRun,
  generateDebugUnitInput,
  getBehaviorDebugRun,
  getDebugConfig,
  getDebugSession,
  listDebugRuns,
  listDebugUnits,
  runDebugUnit,
  startBehaviorDebugRun,
  trackBehaviorDebugTask,
} from '../utils/debugApi'

function pretty(value: any): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatMs(ms?: number | null): string {
  if (typeof ms !== 'number') return '-'
  return `${ms} ms`
}

function describeValue(value: any): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `Array(${value.length})`
  if (typeof value === 'object') return `Object(${Object.keys(value).length} keys)`
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}...` : value
  return String(value)
}

function renderStructuredValue(value: any, depth = 0): JSX.Element {
  if (value === null || value === undefined || typeof value !== 'object') {
    return <span className="debug-json-leaf">{describeValue(value)}</span>
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="debug-json-leaf">[]</span>
    return (
      <div className="debug-json-tree">
        {value.slice(0, 8).map((item, idx) => (
          <div key={idx} className="debug-json-row">
            <span className="debug-json-key">[{idx}]</span>
            <div className="debug-json-value">{renderStructuredValue(item, depth + 1)}</div>
          </div>
        ))}
        {value.length > 8 && (
          <div className="debug-json-row">
            <span className="debug-json-key">...</span>
            <span className="debug-json-leaf">{value.length - 8} more items</span>
          </div>
        )}
      </div>
    )
  }

  const entries = Object.entries(value)
  if (!entries.length) return <span className="debug-json-leaf">{'{}'}</span>

  return (
    <div className={`debug-json-tree ${depth > 0 ? 'nested' : ''}`}>
      {entries.map(([key, val]) => (
        <div key={key} className="debug-json-row">
          <span className="debug-json-key">{key}</span>
          <div className="debug-json-value">
            {depth >= 2 || val === null || typeof val !== 'object'
              ? <span className="debug-json-leaf">{describeValue(val)}</span>
              : renderStructuredValue(val, depth + 1)}
          </div>
        </div>
      ))}
    </div>
  )
}

export function DebugPage(): JSX.Element {
  const [toast, setToast] = useState<{ message: string; kind: 'info' | 'success' | 'warning' | 'error' } | null>(null)
  const [activeTab, setActiveTab] = useState<'task' | 'unit'>('task')
  const [unitTestType, setUnitTestType] = useState<'function_harness'>('function_harness')
  const [config, setConfig] = useState<DebugConfig | null>(null)
  const [sessionReady, setSessionReady] = useState(false)
  const [authed, setAuthed] = useState(false)
  const [token, setToken] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)

  const [runs, setRuns] = useState<DebugRunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string>('')
  const [selectedRun, setSelectedRun] = useState<DebugRunDetail | null>(null)
  const [runLoading, setRunLoading] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [behaviorActionLoading, setBehaviorActionLoading] = useState<'create' | 'track' | null>(null)
  const [behaviorQuery, setBehaviorQuery] = useState('Find spicy Sichuan food for friends in Chinatown, budget 20 to 60 SGD')
  const [behaviorUseOnline, setBehaviorUseOnline] = useState(false)
  const [behaviorAutoConfirm, setBehaviorAutoConfirm] = useState(true)
  const [trackTaskId, setTrackTaskId] = useState('')
  const [explainLoading, setExplainLoading] = useState(false)

  const [units, setUnits] = useState<DebugUnitSpec[]>([])
  const [selectedUnitName, setSelectedUnitName] = useState('')
  const selectedUnit = useMemo(
    () => units.find(u => u.name === selectedUnitName) || null,
    [units, selectedUnitName]
  )
  const [unitInputMode, setUnitInputMode] = useState<'manual' | 'sample' | 'schema' | 'llm'>('manual')
  const [unitInputText, setUnitInputText] = useState('{}')
  const [unitRunResult, setUnitRunResult] = useState<any>(null)
  const [unitError, setUnitError] = useState<string | null>(null)
  const [unitRunning, setUnitRunning] = useState(false)
  const unitInputTouchedRef = useRef(false)

  const unitHarness = unitRunResult && typeof unitRunResult === 'object' ? unitRunResult : null
  const unitExecution = unitHarness?.result && typeof unitHarness.result === 'object' ? unitHarness.result : null
  const unitFunctionOutput = unitExecution?.ok ? unitExecution.output : null
  const unitFunctionError = unitExecution?.ok ? null : unitExecution?.error
  const unitValidationWarnings = Array.isArray(unitHarness?.validation_errors) ? unitHarness.validation_errors : []

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const c = await getDebugConfig()
        if (cancelled) return
        setConfig(c)
        if (c.enabled) {
          try {
            await getDebugSession()
            if (cancelled) return
            setAuthed(true)
          } catch {
            if (cancelled) return
            setAuthed(false)
          }
        }
      } catch (e: any) {
        if (cancelled) return
        setAuthError(e?.message || 'Failed to load debug config')
      } finally {
        if (!cancelled) setSessionReady(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const refreshRuns = async (keepSelected = true) => {
    const data = await listDebugRuns()
    setRuns(data.runs || [])
    if (!keepSelected && data.runs?.length) {
      setSelectedRunId(data.runs[0].id)
    }
  }

  const refreshUnits = async () => {
    const data = await listDebugUnits()
    setUnits(data.units || [])
    if (!selectedUnitName && data.units?.length) {
      setSelectedUnitName(data.units[0].name)
    }
  }

  useEffect(() => {
    if (!authed) return
    refreshRuns(false).catch((e: any) => setRunError(e?.message || 'Failed to load runs'))
    refreshUnits().catch((e: any) => setUnitError(e?.message || 'Failed to load units'))
  }, [authed])

  useEffect(() => {
    if (!selectedRunId || !authed) return
    let stop = false
    const load = async () => {
      setRunLoading(true)
      try {
        const run = await getBehaviorDebugRun(selectedRunId)
        if (stop) return
        setSelectedRun(run)
        setRunError(null)
      } catch (e: any) {
        if (stop) return
        setRunError(e?.message || 'Failed to load run')
      } finally {
        if (!stop) setRunLoading(false)
      }
    }
    load()
    const interval = setInterval(() => {
      if (selectedRun?.job_running || ['queued', 'running'].includes(selectedRun?.status || '')) {
        load().catch(() => {})
      }
    }, 1500)
    return () => {
      stop = true
      clearInterval(interval)
    }
  }, [selectedRunId, authed, selectedRun?.job_running, selectedRun?.status])

  useEffect(() => {
    if (!selectedUnit) return
    if (unitInputTouchedRef.current) return
    setUnitInputText(pretty(selectedUnit.sample_input || {}))
  }, [selectedUnit])

  const onLogin = async () => {
    setAuthError(null)
    try {
      await debugLogin(token)
      setAuthed(true)
      await refreshRuns(false)
      await refreshUnits()
    } catch (e: any) {
      setAuthError(e?.message || 'Login failed')
    }
  }

  const onLogout = async () => {
    try {
      await debugLogout()
    } finally {
      setAuthed(false)
      setSelectedRun(null)
      setRuns([])
      setUnits([])
    }
  }

  const startBehavior = async () => {
    setRunError(null)
    setBehaviorActionLoading('create')
    try {
      const result = await startBehaviorDebugRun({
        query: behaviorQuery,
        use_online_agent: behaviorUseOnline,
        auto_confirm: behaviorAutoConfirm,
      })
      await refreshRuns()
      setSelectedRunId(result.run_id)
    } catch (e: any) {
      setRunError(e?.message || 'Failed to start behavior run')
    } finally {
      setBehaviorActionLoading(null)
    }
  }

  const startTrack = async () => {
    if (!trackTaskId.trim()) return
    setRunError(null)
    setBehaviorActionLoading('track')
    try {
      const result = await trackBehaviorDebugTask({ task_id: trackTaskId.trim() })
      await refreshRuns()
      setSelectedRunId(result.run_id)
    } catch (e: any) {
      const message = e?.message || 'Failed to track task'
      setRunError(message)
      if (message.toLowerCase().includes('task id not found') || message.toLowerCase().includes('task not found')) {
        setToast({
          kind: 'warning',
          message: `Task not found: "${trackTaskId.trim()}". No tracking run was created.`,
        })
      }
    } finally {
      setBehaviorActionLoading(null)
    }
  }

  const runExplain = async () => {
    if (!selectedRunId) return
    setExplainLoading(true)
    try {
      await explainBehaviorDebugRun(selectedRunId)
      const refreshed = await getBehaviorDebugRun(selectedRunId)
      setSelectedRun(refreshed)
    } catch (e: any) {
      setRunError(e?.message || 'LLM explanation failed')
    } finally {
      setExplainLoading(false)
    }
  }

  const onGenerateUnitInput = async (mode: 'sample' | 'schema' | 'llm') => {
    // refers to backend DebugRoute's private function _generate_unit_input()
    if (!selectedUnit) return
    setUnitError(null)
    try {
      const result = await generateDebugUnitInput(selectedUnit.name, mode)
      unitInputTouchedRef.current = true
      setUnitInputText(pretty(result.input_data || {}))
      if (result.validation_errors?.length) {
        setUnitError(`Validation warnings: ${result.validation_errors.join('; ')}`)
      }
    } catch (e: any) {
      setUnitError(e?.message || 'Failed to generate input')
    }
  }

  const onRunUnit = async () => {
    if (!selectedUnit) return
    setUnitError(null)
    setUnitRunResult(null)
    setUnitRunning(true)
    try {
      const inputData = unitInputMode === 'manual'
        ? JSON.parse(unitInputText || '{}')
        : undefined
      const result = await runDebugUnit({
        unit_name: selectedUnit.name,
        input_mode: unitInputMode,
        input_data: inputData,
        use_llm_generation: unitInputMode === 'llm',
      })
      setUnitRunResult(result)
      if (result?.input_data) {
        unitInputTouchedRef.current = true
        setUnitInputText(pretty(result.input_data))
      }
    } catch (e: any) {
      setUnitError(e?.message || 'Failed to run unit')
    } finally {
      setUnitRunning(false)
    }
  }

  const isBehaviorRunning = behaviorActionLoading !== null || Boolean(selectedRun?.job_running)

  if (!sessionReady) {
    return <div className="debug-page"><div className="debug-panel">Loading debug system...</div></div>
  }

  if (config && !config.enabled) {
    return (
      <div className="debug-page">
        <div className="debug-panel">
          <h1>Internal Debug</h1>
          <p>Debug UI is disabled (`DEBUG_UI_ENABLED=false`).</p>
          <Link to="/MetaRec">Back to MetaRec</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="debug-page">
      {toast && (
        <div className={`debug-toast ${toast.kind}`} role="status" aria-live="polite">
          <div className="debug-toast-content">
            <strong>{toast.kind === 'warning' ? 'Notice' : 'Debug'}</strong>
            <span>{toast.message}</span>
          </div>
          <button className="debug-toast-close" onClick={() => setToast(null)} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      )}
      <header className="debug-header">
        <div>
          <h1>MetaRec Internal Debug / Testbench</h1>
          <p>Separate diagnostics layer for behavior tracing, explanation, and interactive unit testing.</p>
        </div>
        <div className="debug-header-actions">
          <Link to="/MetaRec" className="debug-link-btn">Back to MetaRec</Link>
          {authed && <button className="debug-link-btn" onClick={onLogout}>Logout</button>}
        </div>
      </header>

      {!authed ? (
        <section className="debug-panel">
          <h2>Debug Login</h2>
          <p>Sign in with the internal debug admin token. A short-lived cookie session will be created.</p>
          <div className="debug-row">
            <input
              type="password"
              placeholder="Debug admin token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onLogin() }}
            />
            <button onClick={onLogin}>Login</button>
          </div>
          {authError && <div className="debug-error">{authError}</div>}
        </section>
      ) : (
        <>
          <div className="debug-tabs" role="tablist" aria-label="Debug page tabs">
            <button
              role="tab"
              aria-selected={activeTab === 'task'}
              className={`debug-tab ${activeTab === 'task' ? 'active' : ''}`}
              onClick={() => setActiveTab('task')}
            >
              Task Process Tracker
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'unit'}
              className={`debug-tab ${activeTab === 'unit' ? 'active' : ''}`}
              onClick={() => setActiveTab('unit')}
            >
              Unit Test Bench
            </button>
          </div>

          {activeTab === 'task' ? (
            <div className="debug-grid debug-tab-panel" role="tabpanel" aria-label="Task Process Tracker">
              <section className="debug-panel">
                <h2>System Behaviour Test</h2>
                <label>Query</label>
                <textarea
                  rows={4}
                  value={behaviorQuery}
                  onChange={(e) => setBehaviorQuery(e.target.value)}
                />
                <div className="debug-inline-options">
                  <label><input type="checkbox" checked={behaviorUseOnline} onChange={(e) => setBehaviorUseOnline(e.target.checked)} /> Use online agent</label>
                  <label><input type="checkbox" checked={behaviorAutoConfirm} onChange={(e) => setBehaviorAutoConfirm(e.target.checked)} /> Auto-confirm if needed</label>
                </div>
                <div className="debug-row">
                  <button onClick={startBehavior} disabled={behaviorActionLoading !== null}>
                    {behaviorActionLoading === 'create' ? (
                      <span className="debug-btn-content"><span className="debug-spinner" /> Creating Run...</span>
                    ) : (
                      'Create Trace Run'
                    )}
                  </button>
                  <button onClick={() => refreshRuns()} className="debug-secondary">Refresh Runs</button>
                </div>
                <hr />
                <label>Track Existing Task ID</label>
                <div className="debug-row">
                  <input value={trackTaskId} onChange={(e) => setTrackTaskId(e.target.value)} placeholder="task_id" />
                  <button onClick={startTrack} disabled={behaviorActionLoading !== null}>
                    {behaviorActionLoading === 'track' ? (
                      <span className="debug-btn-content"><span className="debug-spinner" /> Tracking...</span>
                    ) : (
                      'Track Task'
                    )}
                  </button>
                </div>
                {isBehaviorRunning && (
                  <div className="debug-loading-banner">
                    <span className="debug-spinner" />
                    <span>Test run is in progress. Trace updates will stream into the viewer.</span>
                    <span className="debug-loading-dots"><i></i><i></i><i></i></span>
                  </div>
                )}
                {runError && <div className="debug-error">{runError}</div>}

                <div className="debug-runs-list">
                  {(runs || []).map(run => (
                    <button
                      key={run.id}
                      className={`debug-run-item ${selectedRunId === run.id ? 'active' : ''}`}
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      <div className="debug-run-main">
                        <strong>{run.kind}</strong>
                        <span className={`debug-status ${run.status}`}>{run.status}</span>
                      </div>
                      <div className="debug-run-meta">{run.id.slice(0, 8)} • {run.event_count} events</div>
                    </button>
                  ))}
                  {!runs.length && <div className="debug-muted">No debug runs yet.</div>}
                </div>
              </section>

              <section className={`debug-panel debug-panel-wide ${selectedRun?.job_running ? 'debug-panel-live' : ''}`}>
                <div className="debug-panel-title-row">
                  <h2>Trace Viewer</h2>
                  <div className="debug-row">
                    {config?.llm_explain_enabled && selectedRunId && (
                      <button onClick={runExplain} disabled={explainLoading}>
                        {explainLoading ? (
                          <span className="debug-btn-content"><span className="debug-spinner" /> Explaining...</span>
                        ) : (
                          'NL Explain + Suggestions'
                        )}
                      </button>
                    )}
                  </div>
                </div>
                {runLoading && (
                  <div className="debug-loading-inline">
                    <span className="debug-spinner" />
                    <span className="debug-muted">Loading trace...</span>
                  </div>
                )}
                {selectedRun ? (
                  <>
                    <div className="debug-trace-summary">
                      <span><strong>Run:</strong> {selectedRun.id}</span>
                      <span><strong>Status:</strong> <span className={`debug-status ${selectedRun.status}`}>{selectedRun.status}</span></span>
                      <span><strong>Kind:</strong> {selectedRun.kind}</span>
                      <span><strong>Events:</strong> {selectedRun.events?.length || 0}</span>
                    </div>
                    {selectedRun.explanation?.content && (
                      <div className="debug-explanation">
                        <h3>NL Explanation</h3>
                        <pre>{selectedRun.explanation.content}</pre>
                      </div>
                    )}
                    <div className="debug-events">
                      {(selectedRun.events || []).map((ev, idx) => (
                        <details key={`${ev.timestamp}-${idx}`} open={idx >= (selectedRun.events.length - 4)}>
                          <summary>
                            <span className={`debug-status ${ev.status}`}>{ev.status}</span>
                            <strong>{ev.label}</strong>
                            <span className="debug-muted">[{ev.type}] {new Date(ev.timestamp).toLocaleTimeString()}</span>
                          </summary>
                          <pre>{pretty(ev.data)}</pre>
                        </details>
                      ))}
                      {!selectedRun.events?.length && <div className="debug-muted">No events yet.</div>}
                    </div>
                    <details>
                      <summary>Artifacts</summary>
                      <pre>{pretty(selectedRun.artifacts || {})}</pre>
                    </details>
                    <details>
                      <summary>Raw Trace JSON</summary>
                      <pre>{pretty(selectedRun)}</pre>
                    </details>
                  </>
                ) : (
                  <div className="debug-muted">Select a run to inspect details.</div>
                )}
              </section>
            </div>
          ) : (
            <section className="debug-panel debug-panel-wide debug-panel-full-span debug-tab-panel" role="tabpanel" aria-label="Unit Test Bench">
              <div className="debug-panel-title-row">
                <h2>Unit Test Bench</h2>
                <div className="debug-row">
                  <button className="debug-secondary" onClick={() => refreshUnits()}>Refresh Units</button>
                </div>
              </div>

              <div className="debug-unit-toolbar">
                <div className="debug-unit-toolbar-group">
                  <label>Test Type</label>
                  <select value={unitTestType} onChange={(e) => setUnitTestType(e.target.value as 'function_harness')}>
                    <option value="function_harness">Function Harness</option>
                  </select>
                </div>
              </div>

              {unitTestType === 'function_harness' && (
                <div className="debug-unit-layout">
                  <div className="debug-unit-left">
                    <label>Registered Units</label>
                    <select
                      value={selectedUnitName}
                      onChange={(e) => {
                        unitInputTouchedRef.current = false
                        setSelectedUnitName(e.target.value)
                        setUnitRunResult(null)
                      }}
                    >
                      {units.map(u => (
                        <option key={u.name} value={u.name}>{u.name}</option>
                      ))}
                    </select>
                    {selectedUnit && (
                      <div className="debug-unit-meta">
                        <div><strong>Function:</strong> {selectedUnit.function_name}</div>
                        <div>{selectedUnit.description}</div>
                      </div>
                    )}
                    {selectedUnit && (
                      <>
                        <details open>
                          <summary>Input Schema</summary>
                          <pre>{pretty(selectedUnit.input_schema)}</pre>
                        </details>
                        <details>
                          <summary>Expected I/O</summary>
                          <pre>{pretty(selectedUnit.expected_io)}</pre>
                        </details>
                      </>
                    )}
                    <label>Input Mode</label>
                    <select value={unitInputMode} onChange={(e) => setUnitInputMode(e.target.value as any)}>
                      <option value="manual">Manual JSON</option>
                      <option value="sample">Use Sample Input</option>
                      <option value="schema">Generate From Schema</option>
                      <option value="llm">LLM-Generated Input</option>
                    </select>
                    <div className="debug-row">
                      <button className="debug-secondary" onClick={() => onGenerateUnitInput('sample')} disabled={!selectedUnit}>Load Sample</button>
                      <button className="debug-secondary" onClick={() => onGenerateUnitInput('schema')} disabled={!selectedUnit}>Schema Generate</button>
                      <button className="debug-secondary" onClick={() => onGenerateUnitInput('llm')} disabled={!selectedUnit}>LLM Generate</button>
                    </div>
                    <label>Input JSON</label>
                    <textarea
                      rows={14}
                      value={unitInputText}
                      onChange={(e) => {
                        unitInputTouchedRef.current = true
                        setUnitInputText(e.target.value)
                      }}
                    />
                    <div className="debug-row">
                      <button onClick={onRunUnit} disabled={!selectedUnit || unitRunning}>
                        {unitRunning ? (
                          <span className="debug-btn-content"><span className="debug-spinner" /> Running...</span>
                        ) : (
                          'Run Unit'
                        )}
                      </button>
                    </div>
                    {unitError && <div className="debug-error">{unitError}</div>}
                  </div>

                  <div className="debug-unit-right">
                    <div className={`debug-unit-result ${unitRunning ? 'is-running' : ''}`}>
                      <h3>Output</h3>
                      <div className="debug-output-shell">
                        {unitRunning && (
                          <div className="debug-output-overlay" aria-live="polite">
                            <span className="debug-spinner" />
                            <span>Executing function harness...</span>
                          </div>
                        )}
                        {!unitHarness ? (
                          <pre>{'No unit run yet.'}</pre>
                        ) : (
                          <div className="debug-rendered-output">
                            <div className="debug-result-grid">
                              <div className="debug-result-card">
                                <div className="debug-result-card-title">Harness Status</div>
                                <div className="debug-result-card-value">
                                  <span className={`debug-status ${unitHarness.ok ? 'completed' : 'error'}`}>
                                    {unitHarness.ok ? 'ok' : 'error'}
                                  </span>
                                </div>
                                <div className="debug-result-card-meta">
                                  Wrapper route response from `/internal/debug/unit-tests/run`
                                </div>
                              </div>

                              <div className="debug-result-card">
                                <div className="debug-result-card-title">Execution Time</div>
                                <div className="debug-result-card-value">{formatMs(unitExecution?.duration_ms)}</div>
                                <div className="debug-result-card-meta">Actual unit execution duration</div>
                              </div>

                              <div className="debug-result-card">
                                <div className="debug-result-card-title">Input Source</div>
                                <div className="debug-result-card-value">{unitHarness.input_source || '-'}</div>
                                <div className="debug-result-card-meta">manual / sample / schema / llm</div>
                              </div>

                              <div className="debug-result-card">
                                <div className="debug-result-card-title">Validation Warnings</div>
                                <div className="debug-result-card-value">{unitValidationWarnings.length}</div>
                                <div className="debug-result-card-meta">
                                  {unitValidationWarnings.length ? 'Input schema warnings found' : 'Input matches schema checks'}
                                </div>
                              </div>
                            </div>

                            {unitHarness.unit && (
                              <div className="debug-result-section">
                                <div className="debug-result-section-title">Tested Unit</div>
                                <div className="debug-result-keyvals">
                                  <div><span>Name</span><strong>{unitHarness.unit.name || '-'}</strong></div>
                                  <div><span>Function</span><strong>{unitHarness.unit.function_name || '-'}</strong></div>
                                </div>
                              </div>
                            )}

                            {unitHarness.input_data !== undefined && (
                              <div className="debug-result-section">
                                <div className="debug-result-section-title">Resolved Input (structured)</div>
                                <div className="debug-result-structured">
                                  {renderStructuredValue(unitHarness.input_data)}
                                </div>
                              </div>
                            )}

                            {unitValidationWarnings.length > 0 && (
                              <div className="debug-result-section warning">
                                <div className="debug-result-section-title">Validation Warnings</div>
                                <ul className="debug-result-list">
                                  {unitValidationWarnings.map((w: string, i: number) => (
                                    <li key={`${w}-${i}`}>{w}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {unitFunctionError && (
                              <div className="debug-result-section error">
                                <div className="debug-result-section-title">Function Error</div>
                                <div className="debug-result-error-text">{String(unitFunctionError)}</div>
                                {unitExecution?.traceback && (
                                  <details>
                                    <summary>Traceback</summary>
                                    <pre>{String(unitExecution.traceback)}</pre>
                                  </details>
                                )}
                              </div>
                            )}

                            <div className="debug-result-section">
                              <div className="debug-result-section-title">Function Output (raw JSON)</div>
                              <pre>{pretty(unitFunctionOutput ?? null)}</pre>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}

export default DebugPage
