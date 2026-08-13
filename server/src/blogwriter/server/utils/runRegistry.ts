/**
 * In-memory state of active runs + an EventEmitter for SSE.
 * Completion and pauses are persisted in SQLite (store.ts); the registry holds live progress.
 */
import { EventEmitter } from 'node:events'

export type StageStatus = 'pending' | 'running' | 'done' | 'error' | 'waiting'

export type RunLiveStatus = 'running' | 'done' | 'error' | 'awaiting_sources' | 'awaiting_outline'

export interface StageState {
  stage: string
  status: StageStatus
  detail: string
}

export interface RunUpdate {
  type: 'stage' | 'done' | 'error' | 'paused'
  runId: string
  stage?: string
  status?: StageStatus | RunLiveStatus
  detail?: string
  slop?: number
  wordCount?: number
  error?: string
}

export interface RunState {
  id: string
  topic: string
  status: RunLiveStatus
  stages: StageState[]
  emitter: EventEmitter
  error: string
  startedAt: number
}

export const PIPELINE_STAGES = ['research', 'sources', 'outline', 'draft', 'antislop', 'eeat', 'factcheck'] as const

const registry = new Map<string, RunState>()

/** Registers a run; doneStages — stages completed in previous phases (for continue/retry). */
export function registerRun(id: string, topic: string, doneStages: string[] = []): RunState {
  const existing = registry.get(id)
  const emitter = existing?.emitter ?? new EventEmitter()
  emitter.setMaxListeners(50)
  const state: RunState = {
    id,
    topic,
    status: 'running',
    stages: PIPELINE_STAGES.map(stage => ({
      stage,
      status: doneStages.includes(stage) ? 'done' : 'pending',
      detail: '',
    })),
    emitter,
    error: '',
    startedAt: Date.now(),
  }
  registry.set(id, state)
  return state
}

export function getRunState(id: string): RunState | undefined {
  return registry.get(id)
}

export function emitStage(
  id: string,
  stage: string,
  status: StageStatus,
  detail: string,
  extra: { slop?: number, wordCount?: number } = {},
): void {
  const state = registry.get(id)
  if (!state) return
  const st = state.stages.find(s => s.stage === stage)
  if (st) {
    st.status = status
    st.detail = detail
  }
  const update: RunUpdate = { type: 'stage', runId: id, stage, status, detail, ...extra }
  state.emitter.emit('update', update)
}

export function finishRun(id: string, status: 'done' | 'error', error = ''): void {
  const state = registry.get(id)
  if (!state) return
  state.status = status
  state.error = error
  const update: RunUpdate = { type: status, runId: id, error: error || undefined }
  state.emitter.emit('update', update)
  // clean up the registry once all listeners have detached
  setTimeout(() => registry.delete(id), 5 * 60_000).unref?.()
}

/** Pause: the phase finished, waiting on the user's decision (choice of sources/outline). */
export function pauseRun(id: string, status: 'awaiting_sources' | 'awaiting_outline'): void {
  const state = registry.get(id)
  if (!state) return
  state.status = status
  const update: RunUpdate = { type: 'paused', runId: id, status }
  state.emitter.emit('update', update)
}
