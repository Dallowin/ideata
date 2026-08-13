/**
 * Storage for cover studio images and templates in Postgres.
 *
 * Why in the DB and not on disk: images used to live on disk, i.e. inside the
 * deploy directory — they only survived a rollout by happy accident (CI unpacks
 * the archive on top), and would be lost on a server move. Studio templates
 * lived in localStorage — lost on a browser switch.
 *
 * All functions are resilient to the tables being absent (first deploy ahead
 * of the migration): reads return empty, writes are silently skipped — the
 * image still gets written to disk, so the product doesn't break.
 */
import { blogPrisma } from './prisma'

export interface StoredImage {
  id: number
  mime: string
  bytes: Buffer
}

export interface SaveImageInput {
  userId?: number | null
  brandId?: number | null
  runId?: string | null
  kind?: 'bg' | 'cover'
  model?: string | null
  prompt?: string | null
  aspect?: string | null
  credits?: number | null
  mime?: string
  bytes: Buffer
  /** file name in the old disk storage — for the legacy URL /blogwriter/covers/<file> */
  fileName?: string | null
}

/** Save an image. Returns the row id, or null if the table doesn't exist yet. */
export async function saveImage(input: SaveImageInput): Promise<number | null> {
  try {
    const rows = await blogPrisma().$queryRawUnsafe<{ id: bigint }[]>(
      `INSERT INTO preview_images
         (user_id, brand_id, run_id, kind, model, prompt, aspect, credits, mime, bytes, size_bytes, file_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (file_name) WHERE file_name IS NOT NULL
         DO UPDATE SET bytes = EXCLUDED.bytes, size_bytes = EXCLUDED.size_bytes, created_at = now()
       RETURNING id`,
      input.userId ?? null,
      input.brandId ?? null,
      input.runId ?? null,
      input.kind ?? 'bg',
      input.model ?? null,
      input.prompt ? input.prompt.slice(0, 2000) : null,
      input.aspect ?? null,
      input.credits ?? null,
      input.mime ?? 'image/jpeg',
      input.bytes,
      input.bytes.length,
      input.fileName ?? null,
    )
    return rows?.[0]?.id != null ? Number(rows[0].id) : null
  } catch {
    return null
  }
}

/** Image by id. */
export async function getImage(id: number): Promise<StoredImage | null> {
  if (!Number.isFinite(id) || id <= 0) return null
  try {
    const rows = await blogPrisma().$queryRawUnsafe<{ id: bigint; mime: string; bytes: Buffer }[]>(
      'SELECT id, mime, bytes FROM preview_images WHERE id = $1', id)
    const r = rows?.[0]
    return r ? { id: Number(r.id), mime: r.mime, bytes: r.bytes } : null
  } catch {
    return null
  }
}

/** Image by legacy file name (URL /blogwriter/covers/<file>). */
export async function getImageByFile(file: string): Promise<StoredImage | null> {
  if (!file) return null
  try {
    const rows = await blogPrisma().$queryRawUnsafe<{ id: bigint; mime: string; bytes: Buffer }[]>(
      'SELECT id, mime, bytes FROM preview_images WHERE file_name = $1', file)
    const r = rows?.[0]
    return r ? { id: Number(r.id), mime: r.mime, bytes: r.bytes } : null
  } catch {
    return null
  }
}

/**
 * A user's generation history — for the "already generated backgrounds" gallery:
 * reusing an existing image is free, only a new one costs credits.
 * kind='bg' — studio backgrounds, 'cover' — finished article covers.
 */
export async function listImages(userId: number, kind?: string, limit = 60): Promise<any[]> {
  try {
    const rows = await blogPrisma().$queryRawUnsafe<any[]>(
      `SELECT id, kind, model, prompt, aspect, credits, size_bytes, file_name, created_at
         FROM preview_images
        WHERE user_id = $1
          AND ($2::text IS NULL OR kind = $2)
          AND file_name IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $3`,
      userId, kind || null, Math.min(Math.max(1, limit), 200))
    return (rows || []).map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      model: r.model,
      prompt: r.prompt,
      aspect: r.aspect,
      credits: r.credits,
      sizeBytes: r.size_bytes,
      // served by the same public route as covers (disk → DB)
      url: `/blogwriter/covers/${r.file_name}`,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }))
  } catch {
    return []
  }
}

/* --------------------------------------------------------------- templates */

export interface SavedScene {
  id: number
  name: string
  scene: any
  updatedAt: string
}

export async function listScenes(userId: number): Promise<SavedScene[]> {
  try {
    const rows = await blogPrisma().$queryRawUnsafe<any[]>(
      `SELECT id, name, scene, updated_at FROM preview_scenes
        WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200`, userId)
    return (rows || []).map((r) => ({
      id: Number(r.id), name: r.name, scene: r.scene,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    }))
  } catch {
    return []
  }
}

export async function saveScene(
  userId: number, name: string, scene: any, brandId?: number | null,
): Promise<SavedScene | null> {
  try {
    const rows = await blogPrisma().$queryRawUnsafe<any[]>(
      `INSERT INTO preview_scenes (user_id, brand_id, name, scene)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING id, name, scene, updated_at`,
      userId, brandId ?? null, (name || 'Мой шаблон').slice(0, 120), JSON.stringify(scene))
    const r = rows?.[0]
    return r
      ? { id: Number(r.id), name: r.name, scene: r.scene, updatedAt: new Date(r.updated_at).toISOString() }
      : null
  } catch {
    return null
  }
}

/** Only delete your own templates — user_id is part of the condition, not just id. */
export async function deleteScene(userId: number, id: number): Promise<boolean> {
  try {
    const n = await blogPrisma().$executeRawUnsafe(
      'DELETE FROM preview_scenes WHERE id = $1 AND user_id = $2', id, userId)
    return Number(n) > 0
  } catch {
    return false
  }
}
