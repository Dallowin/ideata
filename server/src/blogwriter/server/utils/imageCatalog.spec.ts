import { isTextToImage, parseImagePrice } from './imageCatalog';
import { creditsForUsd } from '../../../credits/credits.service';

describe('imageCatalog', () => {
  describe('isTextToImage', () => {
    it('passes text-to-image generators', () => {
      for (const id of [
        'google/nano-banana',
        'nano-banana-pro',
        'google/imagen4-ultra',
        'seedream/4.5-text-to-image',
        'flux-2/pro-text-to-image',
        'qwen/text-to-image',
        'gpt-image/1.5-text-to-image',
        'z-image',
      ]) {
        expect(isTextToImage(id)).toBe(true);
      }
    });

    it('excludes everything that needs an input image, and non-images', () => {
      for (const id of [
        'google/nano-banana-edit',
        'seedream/4.5-edit',
        'flux-2/pro-image-to-image',
        'qwen/image-edit',
        'recraft-crisp-upscale',
        'recraft-remove-background',
        'ideogram/character',
        'kling/v2-1-video',
        'elevenlabs/text-to-dialogue-v3',
      ]) {
        expect(isTextToImage(id)).toBe(false);
      }
    });
  });

  describe('parseImagePrice', () => {
    it('reads all three kie price formats', () => {
      expect(parseImagePrice('Nano Banana API costs 4 credits per image (~$0.02).'))
        .toEqual({ usdPerImage: 0.02, kieCredits: 4 });
      expect(parseImagePrice('6.5 credits per image (=$0.0325), a smooth 19 % below the official price.'))
        .toEqual({ usdPerImage: 0.0325, kieCredits: 6.5 });
      expect(parseImagePrice('flat 0.8 Kie credits per image (≈ $0.004) — simple, all-inclusive pricing.'))
        .toEqual({ usdPerImage: 0.004, kieCredits: 0.8 });
    });

    it('does not crash on a price with no digits', () => {
      expect(parseImagePrice('contact us')).toEqual({ usdPerImage: null, kieCredits: null });
    });
  });

  describe('price in our own credits', () => {
    it('1 credit = 1 ₽ of cost, rounded up', () => {
      expect(creditsForUsd(0.004)).toBe(1); // z-image ≈ 0.36 ₽ → minimum 1
      expect(creditsForUsd(0.02)).toBe(2); // nano-banana 1.8 ₽
      expect(creditsForUsd(0.06)).toBe(6); // imagen4-ultra 5.4 ₽
      expect(creditsForUsd(0.09)).toBe(9); // nano-banana-pro 8.1 ₽
    });
  });
});
