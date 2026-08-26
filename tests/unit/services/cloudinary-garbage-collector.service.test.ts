import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCloudinaryClientMock } = vi.hoisted(() => ({
  getCloudinaryClientMock: vi.fn(),
}));
//la chiamata originale configura la Search API Cloudinary mentre
//questa configura un client mock
vi.mock('../../../src/services/cloudinary.service.js', () => ({
  CLOUDINARY_TEMP_INSTAGRAM_TAG: 'temp_instagram',
  getCloudinaryClient: getCloudinaryClientMock,
}));

import { CloudinaryGarbageCollectorService } from '../../../src/services/cloudinary-garbage-collector.service.js';

describe('CloudinaryGarbageCollectorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  /**
   * Verifica l'eliminazione di tutti i file con public_id valido 
   * flusso: runceOnce -> deleteExpiredInstagramImages -> search
   */
  it('searches every page and deletes only resources with a valid public_id', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        next_cursor: 'next-page',
        resources: [{ public_id: 'instagram/first' }, { public_id: '' }, {}],
      })
      .mockResolvedValueOnce({
        resources: [{ public_id: 'instagram/second' }, { public_id: 'instagram/third' }],
      });
    const search = {
      expression: vi.fn().mockReturnThis(),
      max_results: vi.fn().mockReturnThis(),
      next_cursor: vi.fn().mockReturnThis(),
      sort_by: vi.fn().mockReturnThis(),
      execute,
    };
    const deleteResources = vi.fn().mockResolvedValue({ deleted: {} });
    getCloudinaryClientMock.mockReturnValue({ api: { delete_resources: deleteResources }, search });

    await expect(new CloudinaryGarbageCollectorService().runOnce()).resolves.toBe(3);

    expect(search.expression).toHaveBeenCalledWith('tags:temp_instagram AND created_at < 1d');
    expect(search.next_cursor).toHaveBeenCalledWith('next-page');
    expect(deleteResources).toHaveBeenNthCalledWith(1, ['instagram/first'], {
      resource_type: 'image',
      invalidate: true,
    });
    expect(deleteResources).toHaveBeenNthCalledWith(2, ['instagram/second', 'instagram/third'], {
      resource_type: 'image',
      invalidate: true,
    });
  });
  /**
   * Verifica il flusso di runceOnce in caso di errore
   */
  it('logs a Search API failure and resolves without interrupting the application', async () => {
    //Sostituisce temporaneamente console.error con una funzione finta che
    //evita di stampare un errore rumoroso nel terminale durante il test.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getCloudinaryClientMock.mockReturnValue({
      search: { expression: vi.fn(() => { throw new Error('Search unavailable'); }) },
    });
    //Questa asserzione verifica che il metodo runOnce() non rilanci l’errore, ma risolva con 0
    await expect(new CloudinaryGarbageCollectorService().runOnce()).resolves.toBe(0);
    //Questa asserzione controlla il corretto log nel  blocco catch del runOnce
    expect(errorSpy).toHaveBeenCalledWith('Garbage collector Cloudinary non completato:', expect.any(Error));

    errorSpy.mockRestore();
  });
});
