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

export function DebugPage(): JSX.Element {
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
  const unitInputTouchedRef = useRef(false)

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
    }
  }

  const startTrack = async () => {
    if (!trackTaskId.trim()) return
    setRunError(null)
    try {
      const result = await trackBehaviorDebugTask({ task_id: trackTaskId.trim() })
      await refreshRuns()
      setSelectedRunId(result.run_id)
    } catch (e: any) {
      setRunError(e?.message || 'Failed to track task')
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
    }
  }

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
        <div className="debug-grid">
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
              <button onClick={startBehavior}>Create Trace Run</button>
              <button onClick={() => refreshRuns()} className="debug-secondary">Refresh Runs</button>
            </div>
            <hr />
            <label>Track Existing Task ID</label>
            <div className="debug-row">
              <input value={trackTaskId} onChange={(e) => setTrackTaskId(e.target.value)} placeholder="task_id" />
              <button onClick={startTrack}>Track Task</button>
            </div>
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

          <section className="debug-panel debug-panel-wide">
            <div className="debug-panel-title-row">
              <h2>Trace Viewer</h2>
              <div className="debug-row">
                {config?.llm_explain_enabled && selectedRunId && (
                  <button onClick={runExplain} disabled={explainLoading}>
                    {explainLoading ? 'Explaining...' : 'NL Explain + Suggestions'}
                  </button>
                )}
              </div>
            </div>
            {runLoading && <div className="debug-muted">Loading trace...</div>}
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

          <section className="debug-panel debug-panel-wide">
            <div className="debug-panel-title-row">
              <h2>Interactive Unit Testbench</h2>
              <div className="debug-row">
                <button className="debug-secondary" onClick={() => refreshUnits()}>Refresh Units</button>
              </div>
            </div>
            <div className="debug-unit-grid">
              <div>
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
              </div>

              <div>
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
                  <button onClick={onRunUnit} disabled={!selectedUnit}>Run Unit</button>
                </div>
                {unitError && <div className="debug-error">{unitError}</div>}
              </div>
            </div>
            <div className="debug-unit-result">
              <h3>Result</h3>
              <pre>{unitRunResult ? pretty(unitRunResult) : 'No unit run yet.'}</pre>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default DebugPage
