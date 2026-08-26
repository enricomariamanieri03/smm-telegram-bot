import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FacebookService } from '../../../src/services/facebook.service.js';

/**Helper: crea l'oggetto Response nativo delle Web API
 * Converte la stringa e aggiunge lo stato e il Content-Type(intestazione)
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
/**Helper: genera un fake blob */
function createImage(): Blob {
  return new Blob(['image-data'], { type: 'image/jpeg' });
}

describe('FacebookService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: FacebookService;

  beforeEach(() => {
    process.env.FB_PAGE_ID = 'page-id';
    process.env.META_ACCESS_TOKEN = 'meta-token';
    process.env.FB_GRAPH_API_VERSION = 'v19.0';
    fetchMock = vi.fn();
    //sovrascrive temporaneamente l'oggetto globale globalThis.fetch
    vi.stubGlobal('fetch', fetchMock);
    service = new FacebookService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
  //Test on publishPhoto (Singol photo)
  //publishPhoto -> uploadPhoto -> postFormData -> fetchWithTimeOut
  it('uploads and publishes one photo with the Graph API response ID', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'photo-id', post_id: 'page_post-id' }));
    //Verifica se la funzione ritorna un oggetto di tipo FacebookPublishResponse ({id, page_post-id})
    await expect(service.publishPhoto({ caption: 'Caption', image: createImage() }))
      .resolves.toEqual({ id: 'photo-id', post_id: 'page_post-id' });
    //Primo argomento passato alla fetch -> Endpoint
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v19.0/page-id/photos');
    //Secondo argometo passato alla fetch -> formData con metodo
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
  });
  //Verifica che se la fetch va in errore raccoglie tutti i dettagli Meta
  it('includes Meta diagnostic details when Graph API returns an error payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: { code: 200, fbtrace_id: 'trace-id', message: 'Permission denied', type: 'OAuthException' },
    }, 403));

    await expect(service.publishPhoto({ caption: 'Caption', image: createImage() }))
      .rejects.toThrow('HTTP 403, OAuthException, code 200, fbtrace_id trace-id');
  });
  //Verifica che se la fetch del publishAlbum va in errore il metodo elimini le foto in bozza 
  //e restuisca i giusti messaggi di errore (uploadPhoto -> postFormData ->
  // -> getFacebookGraphApiError(data) -> creatFacebookApiError) 
  // o di successo in caso di Delete (cleanupUnpublishedPhotos-> deleteUnpublishedPhoto)
  it('rolls back successfully uploaded unpublished photos when an album upload fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'unpublished-photo-id' }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Upload failed' } }, 400))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(service.publishAlbum({
      caption: 'Caption',
      images: [{ image: createImage() }, { image: createImage() }],
    })).rejects.toThrow('Upload failed');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain('/v19.0/unpublished-photo-id');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'DELETE' });
  });
});
