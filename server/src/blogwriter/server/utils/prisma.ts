/**
 * Ports of the blog-writer engine are plain modules (not Nest providers), so
 * they reach Prisma through this accessor instead of DI. BlogwriterModule sets
 * the client at bootstrap (setBlogPrisma), and store.ts / settings read it.
 */
import type { PrismaClient } from '@prisma/client'

let client: PrismaClient | null = null

export function setBlogPrisma(c: PrismaClient): void {
  client = c
}

export function blogPrisma(): PrismaClient {
  if (!client) throw new Error('blogwriter: prisma not initialized (call setBlogPrisma at bootstrap)')
  return client
}
