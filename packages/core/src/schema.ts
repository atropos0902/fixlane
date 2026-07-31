import { z } from 'zod'

export const SESSION_STATES = [
  'queued',
  'cloning',
  'running',
  'checking',
  'proposing',
  'in_review',
  'done',
  'stopped',
] as const
export const SessionState = z.enum(SESSION_STATES)
export type SessionState = z.infer<typeof SessionState>

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)

export const Advisory = z.object({
  id: z.string().max(64),
  package: z.string().max(214),
  /** semver range of the affected versions */
  affected: z.string().max(200),
  text: z.string().max(20_000),
})
export type Advisory = z.infer<typeof Advisory>

/** A leaked key is named by its hash, so the key itself is never copied into a ticket. */
export const KeyPrint = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  length: z.number().int().min(8).max(512),
})
export type KeyPrint = z.infer<typeof KeyPrint>

export const Ticket = z.object({
  id: slug,
  repo: slug,
  kind: z.enum(['code', 'dependency', 'secret']),
  title: z.string().min(1).max(200),
  body: z.string().max(20_000),
  advisory: Advisory.optional(),
  key: KeyPrint.optional(),
})
export type Ticket = z.infer<typeof Ticket>

export const RepoMode = z.enum(['branch', 'pr'])
export type RepoMode = z.infer<typeof RepoMode>

export const Repo = z.object({
  name: slug,
  host: z.enum(['github', 'gitlab']),
  /** owner/name on the host */
  project: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  base: z.string().default('main'),
  mode: RepoMode.default('branch'),
})
export type Repo = z.infer<typeof Repo>

export const Pull = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  head: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
})
export type Pull = z.infer<typeof Pull>

const base = { ticket: slug, clientId: z.string().min(8).max(64) }

/** What a desktop may append to a ticket's log. The server adds seq and actor. */
export const Draft = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('ticket.filed'), data: Ticket }),
  z.object({
    ...base,
    type: z.literal('ticket.commented'),
    data: z.object({ text: z.string().min(1).max(4000) }),
  }),
  z.object({
    ...base,
    type: z.literal('session.moved'),
    data: z.object({
      session: z.string().max(64),
      epoch: z.number().int().positive(),
      state: SessionState,
      note: z.string().max(2000).optional(),
    }),
  }),
])
export type Draft = z.infer<typeof Draft>

/** Server-made entries. Nobody can append these. */
export const ServerNote = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('lease.taken'),
    ticket: slug,
    data: z.object({ holder: z.string(), session: z.string(), epoch: z.number().int() }),
  }),
  z.object({ type: z.literal('lease.released'), ticket: slug, data: z.object({ epoch: z.number().int() }) }),
  z.object({ type: z.literal('pull.opened'), ticket: slug, data: Pull.extend({ epoch: z.number().int() }) }),
  z.object({ type: z.literal('pull.changed'), ticket: slug, data: Pull }),
  z.object({
    type: z.literal('repo.mode'),
    ticket: z.null(),
    data: z.object({ repo: slug, mode: RepoMode }),
  }),
  z.object({ type: z.literal('repo.added'), ticket: z.null(), data: Repo }),
])
export type ServerNote = z.infer<typeof ServerNote>

const stamp = { seq: z.number().int().positive(), actor: z.string() }
export const LogEntry = z.union([
  z.intersection(Draft, z.object(stamp)),
  z.intersection(ServerNote, z.object(stamp)),
])
export type LogEntry = z.infer<typeof LogEntry>

export const ToServer = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), after: z.number().int().min(0) }),
  z.object({ t: z.literal('append'), draft: Draft }),
])
export type ToServer = z.infer<typeof ToServer>

export const ToClient = z.discriminatedUnion('t', [
  z.object({ t: z.literal('entries'), entries: z.array(LogEntry) }),
  z.object({ t: z.literal('ack'), clientId: z.string(), seq: z.number().int() }),
  z.object({ t: z.literal('refused'), clientId: z.string(), reason: z.string() }),
])
export type ToClient = z.infer<typeof ToClient>

/** Lines the runner prints inside the container. Untrusted: the agent could print them too. */
export const RunnerLine = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), text: z.string() }),
  z.object({ t: z.literal('tool'), name: z.string(), input: z.string() }),
  z.object({ t: z.literal('output'), text: z.string() }),
  z.object({ t: z.literal('stop'), reason: z.string() }),
  z.object({ t: z.literal('end'), ok: z.boolean(), error: z.string().optional() }),
])
export type RunnerLine = z.infer<typeof RunnerLine>

/** What a daemon asks for when a branch is ready. */
export const Proposal = z.object({
  ticket: slug,
  repo: slug,
  epoch: z.number().int().positive(),
  head: z.string().max(200),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  title: z.string().max(200),
  body: z.string().max(20_000),
})
export type Proposal = z.infer<typeof Proposal>
export type Proposed = { kind: 'opened'; pull: Pull } | { kind: 'stale' } | { kind: 'branch-only' }
