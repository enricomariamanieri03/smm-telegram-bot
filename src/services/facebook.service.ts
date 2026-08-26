const DEFAULT_GRAPH_API_VERSION = 'v19.0';
const FACEBOOK_REQUEST_TIMEOUT_MS = 15_000;

/** File binario che Facebook riceve direttamente con multipart/form-data. */
export interface FacebookImage {
  image: Blob;
  fileName?: string;
}

/** Dati necessari per pubblicare una foto singola sulla Pagina Facebook. */
export interface FacebookPublishOptions extends FacebookImage {
  caption: string;
}

/** Dati necessari per pubblicare più foto in un unico post Facebook. */
export interface FacebookPublishAlbumOptions {
  caption: string;
  images: FacebookImage[];
}

/** Risposta di Meta dopo il caricamento di una foto o la creazione di un post. */
export interface FacebookPublishResponse {
  id: string;
  post_id?: string;
}

/**
 * Struttura standard dell'oggetto errore restituito dalle Graph API di Facebook.
 */
interface FacebookGraphApiError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

/**
 * Configurazione interna estratta dalle variabili d'ambiente.
 */
interface FacebookConfig {
  pageId: string;
  pageAccessToken: string;
  apiVersion: string;
}

interface ValidatedFacebookImage {
  image: Blob;
  fileName: string;
}

/**
 * Guard Type di TypeScript per verificare se un valore sconosciuto è un oggetto Record valido.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Inizializza la configurazione per le chiamate Facebook.
 * Legge l'ID Pagina, il token e la versione API, validandone il formato vNN.NN.
 */
function getFacebookConfig(): FacebookConfig {
  const pageId = process.env.FB_PAGE_ID?.trim();
  const pageAccessToken = process.env.META_ACCESS_TOKEN?.trim();
  const apiVersion = process.env.FB_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;

  if (!pageId || !pageAccessToken) {
    throw new Error('Variabili d’ambiente Facebook mancanti: FB_PAGE_ID e/o META_ACCESS_TOKEN.');
  }

  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error('FB_GRAPH_API_VERSION deve avere il formato vNN.NN, ad esempio v19.0.');
  }

  return { pageId, pageAccessToken, apiVersion };
}
//Helper per la validazione del type della caption
function validateCaption(caption: unknown): string {
  if (typeof caption !== 'string') {
    throw new Error('La didascalia Facebook deve essere una stringa.');
  }

  return caption;
}
//Helper per la validazione di tipo, dimensione e MIME dell'immagine
function validateImage(image: unknown, fileName: unknown): ValidatedFacebookImage {
  if (!(image instanceof Blob)) {
    throw new Error("L'immagine Facebook deve essere fornita come Blob.");
  }

  if (image.size === 0) {
    throw new Error("L'immagine Facebook è vuota.");
  }

  if (!image.type.startsWith('image/')) {
    throw new Error("Il Blob dell'immagine Facebook deve avere un MIME type image/*.");
  }

  const normalizedFileName = typeof fileName === 'string' ? fileName.trim() : '';

  return {
    image,
    fileName: normalizedFileName || 'photo.jpg',
  };
}
//VALIDAZIONE CAPTION E IMMAGINE PER FOTO SINGOLA
function validatePhotoOptions(options: FacebookPublishOptions): { caption: string; image: ValidatedFacebookImage } {
  if (!isRecord(options)) {
    throw new Error('I dati per la pubblicazione Facebook non sono validi.');
  }

  return {
    caption: validateCaption(options.caption),
    image: validateImage(options.image, options.fileName),
  };
}
//VALIDAZIONE CAPTION E IMMAGINE PER MULTI-PHOTO POST
function validateAlbumOptions(options: FacebookPublishAlbumOptions): { caption: string; images: ValidatedFacebookImage[] } {
  if (!isRecord(options) || !Array.isArray(options.images) || options.images.length < 2) {
    throw new Error('Un post Facebook multi-foto richiede almeno due immagini.');
  }

  return {
    caption: validateCaption(options.caption),
    images: options.images.map((item) => validateImage(item?.image, item?.fileName)),
  };
}

/**
 * Estrae l'errore formattato dal payload di risposta di Facebook, se presente.
 */
function getFacebookGraphApiError(value: unknown): FacebookGraphApiError | undefined {
  if (!isRecord(value) || !isRecord(value.error)) {
    return undefined;
  }

  return {
    message: typeof value.error.message === 'string' ? value.error.message : undefined,
    type: typeof value.error.type === 'string' ? value.error.type : undefined,
    code: typeof value.error.code === 'number' ? value.error.code : undefined,
    error_subcode: typeof value.error.error_subcode === 'number' ? value.error.error_subcode : undefined,
    fbtrace_id: typeof value.error.fbtrace_id === 'string' ? value.error.fbtrace_id : undefined,
  };
}

/**
 * Guard Type per validare che la risposta JSON contenga almeno l'ID restituito da Meta.
 */
function isFacebookPublishResponse(value: unknown): value is FacebookPublishResponse {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.post_id === undefined || typeof value.post_id === 'string')
  );
}

/**
 * Formatta in modo leggibile un errore di Meta, includendo stato HTTP, codici interni e fbtrace_id.
 */
function createFacebookApiError(error: FacebookGraphApiError, status: number): Error {
  const details = [
    `HTTP ${status}`,
    error.type,
    error.code !== undefined ? `code ${error.code}` : undefined,
    error.error_subcode !== undefined ? `subcode ${error.error_subcode}` : undefined,
    error.fbtrace_id ? `fbtrace_id ${error.fbtrace_id}` : undefined,
  ].filter(Boolean);

  return new Error(`Facebook Graph API error (${details.join(', ')}): ${error.message || 'Errore non specificato.'}`);
}

/**
 * Legge e converte la risposta HTTP grezza in un oggetto JSON valido.
 * Il controllo dello stato HTTP viene eseguito dal chiamante dopo il parsing.
 */
async function parseFacebookResponse(response: Response): Promise<unknown> {
  let body: string;

  try {
    body = await response.text();
  } catch (error) {
    throw new Error(`Impossibile leggere la risposta Facebook (HTTP ${response.status}).`, { cause: error });
  }

  if (!body) {
    throw new Error(`Facebook ha restituito una risposta vuota (HTTP ${response.status}).`);
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`Facebook ha restituito JSON non valido (HTTP ${response.status}).`, { cause: error });
  }
}

/**
 * --->     CLASSE PRINCIPALE     <---
 */
export class FacebookService {
  /**
   * Pubblicazione post con singola foto.
   */
  async publishPhoto(options: FacebookPublishOptions): Promise<FacebookPublishResponse> {
    const config = getFacebookConfig();
    const { caption, image } = validatePhotoOptions(options);

    return this.uploadPhoto(config, image, caption, true);
  }

  /**
   * Crea un unico post multi-foto. Le immagini vengono prima caricate come non pubblicate,
   * quindi associate al post finale con attached_media. Non sono creati post separati.
   */
  async publishAlbum(options: FacebookPublishAlbumOptions): Promise<FacebookPublishResponse> {
    const config = getFacebookConfig();
    const { caption, images } = validateAlbumOptions(options);
    const uploadedPhotoIds: string[] = [];

    try {
      // Upload sequenziale: al primo errore fermiamo il flusso e limitiamo i media orfani.
      for (const image of images) {
        const uploadedPhoto = await this.uploadPhoto(config, image, '', false);
        uploadedPhotoIds.push(uploadedPhoto.id);
      }
    } catch (error) {
      // La pulizia è best effort: l'errore originale di upload resta quello rilevante.
      await this.cleanupUnpublishedPhotos(config, uploadedPhotoIds);
      throw error;
    }

    // Dopo questa richiesta lo stato può essere ignoto in caso di timeout: non cancelliamo i media automaticamente.
    return this.createMultiPhotoPost(config, caption, uploadedPhotoIds);
  }
  /**
   * Carica una singola foto sulle Graph API di Facebook.
   * Gestisce sia la pubblicazione immediata che l'upload "silenzioso" in bozza (published = false)
   * necessario come primo step per la creazione dei post multi-foto.
   * Nell'upload "silenzioso" viene caricato il file sulla pagina Facebook senza essere reso publico (bozza)
   */
  private async uploadPhoto(
    config: FacebookConfig,
    image: ValidatedFacebookImage,
    caption: string,
    published: boolean,
  ): Promise<FacebookPublishResponse> {
    const formData = new FormData();
    formData.set('source', image.image, image.fileName);
    formData.set('caption', caption);
    formData.set('published', String(published));
    formData.set('access_token', config.pageAccessToken);

    return this.postFormData(
      `https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.pageId)}/photos`,
      formData,
    );
  }
  /**
   * Assembla e pubblica un unico post nel Feed della Pagina combinando foto già caricate in precedenza.
   * Utilizza il parametro 'attached_media' per agganciare l'elenco degli ID delle foto bozza.
   */
  private async createMultiPhotoPost(
    config: FacebookConfig,
    caption: string,
    photoIds: string[],
  ): Promise<FacebookPublishResponse> {
    const formData = new FormData();
    formData.set('message', caption);
    formData.set('access_token', config.pageAccessToken);

    photoIds.forEach((photoId, index) => {
      formData.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: photoId }));
    });

    return this.postFormData(
      `https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(config.pageId)}/feed`,
      formData,
    );
  }
  /**
   * Esegue una richiesta POST multipart e centralizza parsing, errori Graph API e validazione della risposta.
   * Ritorna in caso di successo un oggetto contente id (l'id della foto caricata), post_id.
   */
  private async postFormData(endpoint: string, formData: FormData): Promise<FacebookPublishResponse> {
    const response = await this.fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: formData,
    });
    const data = await parseFacebookResponse(response);
    const graphApiError = getFacebookGraphApiError(data);

    if (graphApiError) {
      throw createFacebookApiError(graphApiError, response.status);
    }

    if (!response.ok) {
      throw new Error(`Facebook Graph API ha risposto con HTTP ${response.status} ${response.statusText}.`);
    }

    if (!isFacebookPublishResponse(data)) {
      throw new Error('Facebook ha restituito una risposta di pubblicazione senza un ID valido.');
    }

    return data;
  }

  private async cleanupUnpublishedPhotos(config: FacebookConfig, photoIds: string[]): Promise<void> {
    const results = await Promise.allSettled(
      photoIds.map((photoId) => this.deleteUnpublishedPhoto(config, photoId)),
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Impossibile eliminare la foto Facebook non pubblicata ${photoIds[index]}:`, result.reason);
      }
    });
  }
  /** Elimina un media non pubblicato rimasto orfano dopo un upload parziale dell'album. */
  private async deleteUnpublishedPhoto(config: FacebookConfig, photoId: string): Promise<void> {
    const response = await this.fetchWithTimeout(
      `https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(photoId)}`,
      {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams({ access_token: config.pageAccessToken }),
      },
    );

    if (!response.ok) {
      throw new Error(`Facebook non ha eliminato la foto non pubblicata ${photoId} (HTTP ${response.status}).`);
    }
  }
  /**
   * Esegue fetch con AbortController, trasformando timeout e problemi di rete in errori applicativi leggibili.
   */
  private async fetchWithTimeout(endpoint: string, init: RequestInit): Promise<Response> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), FACEBOOK_REQUEST_TIMEOUT_MS);

    try {
      return await fetch(endpoint, { ...init, signal: abortController.signal });
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new Error(`La richiesta a Facebook ha superato il timeout di ${FACEBOOK_REQUEST_TIMEOUT_MS / 1000} secondi.`);
      }

      throw new Error('Impossibile connettersi alla Facebook Graph API.', { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const facebookService = new FacebookService();
