import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, findImageModel, getImageCatalog } from './imageCatalog';
import { creditsForUsd } from '../../../credits/credits.service';

describe('imageCatalog', () => {
  describe('the list', () => {
    it('ids are API slugs of the two generation families', () => {
      for (const m of IMAGE_MODELS) {
        expect(m.id).toMatch(/^(gemini-[\w.-]+-image|imagen-[\w.-]+)$/);
      }
    });

    it('every model has a price per image', () => {
      for (const m of IMAGE_MODELS) {
        expect(typeof m.usdPerImage).toBe('number');
        expect(m.usdPerImage).toBeGreaterThan(0);
      }
    });

    it('the default model is in the list', () => {
      expect(IMAGE_MODELS.some((m) => m.id === DEFAULT_IMAGE_MODEL)).toBe(true);
    });
  });

  describe('getImageCatalog', () => {
    it('returns the whole static list and is never stale', async () => {
      const { models, scrapedAt, stale } = await getImageCatalog();
      expect(models).toEqual(IMAGE_MODELS);
      expect(scrapedAt).toBe('static');
      expect(stale).toBe(false);
    });
  });

  describe('findImageModel', () => {
    it('finds by slug', async () => {
      expect(await findImageModel('imagen-4.0-ultra-generate-001')).toEqual(
        { id: 'imagen-4.0-ultra-generate-001', label: 'Imagen 4 Ultra', usdPerImage: 0.06 },
      );
    });

    it('returns null for an unknown slug — an arbitrary one must not reach the API', async () => {
      expect(await findImageModel('some/other-model')).toBeNull();
    });
  });

  describe('price in our own credits', () => {
    it('1 credit = 1 ₽ of cost, rounded up', () => {
      expect(creditsForUsd(0.02)).toBe(2); // imagen-4.0-fast 1.8 ₽
      expect(creditsForUsd(0.039)).toBe(4); // gemini-2.5-flash-image 3.51 ₽
      expect(creditsForUsd(0.06)).toBe(6); // imagen-4.0-ultra 5.4 ₽
      expect(creditsForUsd(0.12)).toBe(11); // gemini-3-pro-image 10.8 ₽
    });
  });
});
