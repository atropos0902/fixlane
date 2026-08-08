import { readFileSync } from 'node:fs'
import { type GitHost, GitHub, GitLab } from '@fixlane/hosts'
import { z } from 'zod'
import { Db } from './db.ts'
import { SyncServer } from './server.ts'
import { Service } from './service.ts'

const Host = z.object({ url: z.string(), token: z.string(), hookSecret: z.string() })
const Config = z.object({
  port: z.number().default(7700),
  hostname: z.string().default('127.0.0.1'),
  database: z.string(),
  users: z.record(z.string(), z.string().min(16)),
  github: Host.optional(),
  gitlab: Host.optional(),
})

const path = process.argv[2]
if (!path) throw new Error('usage: node packages/sync/src/main.ts config.json')
const c = Config.parse(JSON.parse(readFileSync(path, 'utf8')))
const hosts: Partial<Record<string, GitHost>> = {}
if (c.github) hosts.github = new GitHub(c.github)
if (c.gitlab) hosts.gitlab = new GitLab(c.gitlab)

const server = new SyncServer({
  service: new Service(new Db(c.database), hosts),
  users: c.users,
  port: c.port,
  hostname: c.hostname,
})
await server.start()
console.log(`sync server on ${server.origin}`)
for (const s of ['SIGINT', 'SIGTERM'] as const)
  process.once(s, () => void server.close().then(() => process.exit(0)))
