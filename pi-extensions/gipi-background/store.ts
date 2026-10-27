import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { Job, Schedule } from './types.js'

function base(): string {
  return join(getAgentDir(), 'gipi-background')
}

export function sessionDir(sessionId: string): string {
  return join(base(), sessionId)
}

export function jobsFile(sessionId: string): string {
  return join(sessionDir(sessionId), 'jobs.json')
}

export function schedulesFile(sessionId: string): string {
  return join(sessionDir(sessionId), 'schedules.json')
}

export function ensureSessionDir(sessionId: string): void {
  mkdirSync(sessionDir(sessionId), { recursive: true })
}

export function loadJobs(sessionId: string): Job[] {
  return readJsonArray<Job>(jobsFile(sessionId))
}

export function saveJobs(sessionId: string, jobs: Job[]): void {
  writeJsonAtomic(jobsFile(sessionId), jobs)
}

/**
 * Schedules live in their own file so the existing `jobs.json` array format
 * never needs a migration, and a corrupt schedule list cannot take the job
 * registry down with it.
 */
export function loadSchedules(sessionId: string): Schedule[] {
  return readJsonArray<Schedule>(schedulesFile(sessionId))
}

export function saveSchedules(sessionId: string, schedules: Schedule[]): void {
  writeJsonAtomic(schedulesFile(sessionId), schedules)
}

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  ensureDirFor(path)
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, JSON.stringify(value), 'utf8')
  renameSync(tempPath, path)
}

function ensureDirFor(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

export function purgeSessionDir(sessionId: string): void {
  const dir = sessionDir(sessionId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}
