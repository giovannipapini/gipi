import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { Job } from './types.js'

function base(): string {
  return join(getAgentDir(), 'bash-async')
}

export function sessionDir(sessionId: string): string {
  return join(base(), sessionId)
}

export function jobsFile(sessionId: string): string {
  return join(sessionDir(sessionId), 'jobs.json')
}

export function ensureSessionDir(sessionId: string): void {
  mkdirSync(sessionDir(sessionId), { recursive: true })
}

export function loadJobs(sessionId: string): Job[] {
  const path = jobsFile(sessionId)
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveJobs(sessionId: string, jobs: Job[]): void {
  ensureSessionDir(sessionId)
  const path = jobsFile(sessionId)
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(jobs), 'utf8')
  renameSync(tmp, path)
}

export function purgeSessionDir(sessionId: string): void {
  const dir = sessionDir(sessionId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
