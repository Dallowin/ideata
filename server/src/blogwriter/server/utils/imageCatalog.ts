/**
 * Catalog of Google text→image models with per-image pricing.
 *
 * A constant, not a fetched list: the family is small, the official price per
 * image is published, and `id` is exactly the model slug that goes into the API
 * URL (see googleImage — gemini-*-image on :generateContent, imagen-* on :predict).
 *
 * We keep only generation FROM TEXT: edit/i2i/upscale variants need an image
 * input and are useless in the cover constructor.
 */

export interface ImageModel {
  /** model slug for the API URL (`gemini-2.5-flash-image`, `imagen-4.0-generate-001`) */
  id: string
  label: string
  /** $ per single image (official price) */
  usdPerImage: number | null
}

export const IMAGE_MODELS: ImageModel[] = [
  { id: 'gemini-2.5-flash-image', label: 'Nano Banana', usdPerImage: 0.039 },
  { id: 'gemini-3-pro-image', label: 'Nano Banana Pro', usdPerImage: 0.12 },
  { id: 'imagen-4.0-generate-001', label: 'Imagen 4', usdPerImage: 0.04 },
  { id: 'imagen-4.0-fast-generate-001', label: 'Imagen 4 Fast', usdPerImage: 0.02 },
  { id: 'imagen-4.0-ultra-generate-001', label: 'Imagen 4 Ultra', usdPerImage: 0.06 },
]

/** Default model: cheap, fast, and proven on our pipeline. */
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image'

/** Catalog for the UI. The list is a constant, so it's never stale. */
export async function getImageCatalog(): Promise<{ models: ImageModel[]; scrapedAt: string; stale: boolean }> {
  return { models: IMAGE_MODELS, scrapedAt: 'static', stale: false }
}

/** Model by slug. */
export async function findImageModel(id: string): Promise<ImageModel | null> {
  return IMAGE_MODELS.find((m) => m.id === id) || null
}
