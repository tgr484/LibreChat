import { OCRStrategy } from 'librechat-data-provider';
import { loadOCRConfig } from './ocr';

describe('loadOCRConfig', () => {
  it('returns undefined when no config is provided', () => {
    expect(loadOCRConfig(undefined)).toBeUndefined();
  });

  it('preserves explicit progress support and defaults it off', () => {
    expect(loadOCRConfig({ progressEnabled: true })?.progressEnabled).toBe(true);
    expect(loadOCRConfig({})?.progressEnabled).toBe(false);
  });

  it('preserves allowedAddresses so the exemption survives config load', () => {
    const loaded = loadOCRConfig({
      apiKey: '${OCR_API_KEY}',
      baseURL: 'https://ocr.internal:8080',
      strategy: OCRStrategy.MISTRAL_OCR,
      allowedAddresses: ['ocr.internal:8080'],
    });
    expect(loaded?.allowedAddresses).toEqual(['ocr.internal:8080']);
  });

  it('leaves allowedAddresses undefined when it is not configured', () => {
    const loaded = loadOCRConfig({
      apiKey: 'key',
      baseURL: 'https://api.mistral.ai',
      strategy: OCRStrategy.MISTRAL_OCR,
    });
    expect(loaded?.allowedAddresses).toBeUndefined();
  });
});
