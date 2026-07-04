export type JobStatus = 'running' | 'exited' | 'killed' | 'failed'

export interface Job {
  id: string
  pid: number
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  status: JobStatus
  stdoutPath: string
  stderrPath: string
  stdoutOffset: number
  stderrOffset: number
  timeoutSeconds?: number
}
