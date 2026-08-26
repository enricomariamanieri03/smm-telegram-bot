import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstagramPublicationError, InstagramService } from '../../../src/services/instagram.service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('InstagramService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: InstagramService;

  beforeEach(() => {
    process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = 'instagram-account-id';
    process.env.META_ACCESS_TOKEN = 'meta-token';
    process.env.IG_GRAPH_API_VERSION = 'v26.0';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    service = new InstagramService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  //Verifica in caso i server Meta restituiscono un errore 4xx la variavile cleanupSafe sia true 
  //in modo tale da permettere il cleanup degli asset Cloudinary
  it('classifies a Meta 4xx response as safe for Cloudinary cleanup', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Aspect ratio not supported' } }, 400));

    await expect(service.publishImage({ caption: 'Caption', imageUrl: 'https://example.com/photo.jpg' }))
      .rejects.toMatchObject({
        name: 'InstagramPublicationError',
        cleanupSafe: true,
      });
  });
  //Verifica  in caso i server Meta restituiscono un errore 5xx la variabile cleanupSafe sia false 
  it('keeps cleanup unsafe after an ambiguous Meta 5xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Internal error' } }, 500));

    await expect(service.publishImage({ caption: 'Caption', imageUrl: 'https://example.com/photo.jpg' }))
      .rejects.toMatchObject({
        name: 'InstagramPublicationError',
        cleanupSafe: false,
      });
  });
  /**Verifica  che la funzione getContainerStatus() nel caso in cui Meta trova il container 
   * e restituisce 200 con stato ERROR/EXPIRED, restituisca il cleanUp uguale a true
   * in modo da ripulire gli asset Cloudinary 
   * anche se qualcosa nel processing degli asset nel container Meta è andato storto
   */
  it.each(['ERROR', 'EXPIRED'] as const)(
    'marks container status %s as safe for cleanup',
    async (statusCode) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 'container-id' }))
        .mockResolvedValueOnce(jsonResponse({ status: 'Media rejected', status_code: statusCode }));

      await expect(service.publishImage({ caption: 'Caption', imageUrl: 'https://example.com/photo.jpg' }))
        .rejects.toMatchObject({
          name: 'InstagramPublicationError',
          cleanupSafe: true,
        });
    },
  );
  //Verifica che il flusso ideale di publicazione di una foto singola ritorna l'id prepopolato nel mock:
  //-createImageContainer() -> restuisce id:string -> container-id
  //-waitForContainer() -> getContainerStatus(): InstagramContainerStatusResponse -> { status: 'Ready', status_code: 'FINISHED' }
  //-publishContainer(): InstagramPublishResponse -> id:string -> published-media-id
  it('publishes only after the container reaches FINISHED', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'container-id' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'Ready', status_code: 'FINISHED' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'published-media-id' }));

    await expect(service.publishImage({ caption: 'Caption', imageUrl: 'https://example.com/photo.jpg' }))
      .resolves.toEqual({ id: 'published-media-id' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain('/media_publish');
  });
  /**Verifica una corretta gestione del flusso e un corretto polling (richiesta ai server Meta
   * inerente al tracciamento dello stato di preparazione del container) tramite l'ausilio di dati mock
   * --> A 0s ha effettuato due chiamate createImageContainer, getCointainerStatus in waitForContainer
   * --> a 2s ne dovrebbe aver effettuate 4 
   * --> L'ultima chiamata conterrà nell' endPoint il media_publish 
  */
  it('keeps polling an IN_PROGRESS container before publishing it', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'container-id' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'Downloading', status_code: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'Ready', status_code: 'FINISHED' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'published-media-id' }));

    const publication = service.publishImage({ caption: 'Caption', imageUrl: 'https://example.com/photo.jpg' });
    const publicationExpectation = expect(publication).resolves.toEqual({ id: 'published-media-id' });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    await publicationExpectation;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3][0])).toContain('/media_publish');
  });
  /**Verifica l'aborto della fetchWithTimeOut in getContainerStatus  dopo 15s
   * Se Meta non risponde il test si aspetta che venga lanciato un errore di timeout
   */
  it('aborts a request that remains pending for more than fifteen seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_endpoint: string, init?: RequestInit) => new Promise((_, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('Request aborted')));
    }));

    const publication = service.publishImage({ caption: 'Caption', imageUrl: 'https://example.com/photo.jpg' });
    const timeoutExpectation = expect(publication)
      .rejects.toThrow('La richiesta a Instagram ha superato il timeout di 15 secondi.');
    //porta il timer a 15s
    await vi.advanceTimersByTimeAsync(15_000);
  
    await timeoutExpectation;
  });
});
