const DEFAULT_INSTAGRAM_GRAPH_API_VERSION = 'v26.0';
const INSTAGRAM_REQUEST_TIMEOUT_MS = 15_000;
const INSTAGRAM_CONTAINER_POLL_INTERVAL_MS = 2_000;
const INSTAGRAM_CONTAINER_READY_TIMEOUT_MS = 120_000;
const INSTAGRAM_MAX_CAPTION_LENGTH = 2_200;
const INSTAGRAM_MAX_CAROUSEL_ITEMS = 10;

/** Dati necessari per pubblicare un post Instagram con una sola immagine. */
export interface InstagramPublishOptions {
  caption: string;
  imageUrl: string;
}

/** Dati necessari per pubblicare un carosello Instagram. */
export interface InstagramPublishCarouselOptions {
  caption: string;
  imageUrls: string[];
}

/** Risposta finale di Meta dopo media_publish. */
export interface InstagramPublishResponse {
  id: string;
}

/**
 * Errore di pubblicazione con indicazione esplicita su quando gli asset Cloudinary possono essere rimossi.
 * `cleanupSafe` è true soltanto quando Meta ha confermato che il container non verrà più elaborato.
 */
export class InstagramPublicationError extends Error {
  constructor(message: string, public readonly cleanupSafe: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstagramPublicationError';
  }
}

interface InstagramConfig {
  accessToken: string;
  apiVersion: string;
  instagramBusinessAccountId: string;
}

interface InstagramGraphApiError {
  code?: number;
  errorSubcode?: number;
  fbtraceId?: string;
  message?: string;
  type?: string;
}

type InstagramContainerStatus = 'ERROR' | 'EXPIRED' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
const INSTAGRAM_CONTAINER_STATUSES: readonly InstagramContainerStatus[] = [
  'ERROR',
  'EXPIRED',
  'FINISHED',
  'IN_PROGRESS',
  'PUBLISHED',
];

interface InstagramContainerStatusResponse {
  status: string;
  statusCode: InstagramContainerStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Recupera e valida ID account Instagram, token Meta e versione Graph API. */
function getInstagramConfig(): InstagramConfig {
  const instagramBusinessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID?.trim();
  const accessToken = process.env.META_ACCESS_TOKEN?.trim();
  const apiVersion =
    process.env.IG_GRAPH_API_VERSION?.trim() ||
    process.env.FB_GRAPH_API_VERSION?.trim() ||
    DEFAULT_INSTAGRAM_GRAPH_API_VERSION;

  if (!instagramBusinessAccountId || !accessToken) {
    throw new Error(
      'Variabili d’ambiente Instagram mancanti: INSTAGRAM_BUSINESS_ACCOUNT_ID e/o META_ACCESS_TOKEN.',
    );
  }

  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error('IG_GRAPH_API_VERSION deve avere il formato vNN.NN, ad esempio v26.0.');
  }

  return { accessToken, apiVersion, instagramBusinessAccountId };
}

/**
 * Valida la didascalia prima dell'invio a Meta.
 * Instagram accetta al massimo 2.200 caratteri: invece di troncare silenziosamente
 * il testo generato e mostrato nell'anteprima, il flusso fallisce in modo esplicito.
 */
function validateCaption(caption: unknown): string {
  if (typeof caption !== 'string') {
    throw new Error('La didascalia Instagram deve essere una stringa.');
  }

  if (caption.length > INSTAGRAM_MAX_CAPTION_LENGTH) {
    throw new Error(`La didascalia Instagram supera il limite di ${INSTAGRAM_MAX_CAPTION_LENGTH} caratteri.`);
  }

  return caption;
}

/**
 * Valida l'URL che Meta userà per scaricare autonomamente l'immagine da Cloudinary.
 * Deve essere un URL HTTPS pubblico e pulito: URL relativi, credenziali incorporate
 * o schemi diversi da HTTPS non sono adatti al recupero server-to-server di Instagram.
 */
function validateImageUrl(imageUrl: unknown): string {
  if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
    throw new Error('L’URL dell’immagine Instagram non è valido.');
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(imageUrl);
  } catch (error) {
    throw new Error('L’URL dell’immagine Instagram non è valido.', { cause: error });
  }

  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    throw new Error('L’URL dell’immagine Instagram deve essere HTTPS e non deve contenere credenziali.');
  }

  return parsedUrl.toString();
}

/**
 * Valida l'input di un post con foto singola, applicando sia il limite della
 * didascalia sia i vincoli dell'URL pubblico richiesto da Instagram.
 */
function validatePublishOptions(options: InstagramPublishOptions): { caption: string; imageUrl: string } {
  if (!isRecord(options)) {
    throw new Error('I dati per la pubblicazione Instagram non sono validi.');
  }

  return {
    caption: validateCaption(options.caption),
    imageUrl: validateImageUrl(options.imageUrl),
  };
}

/**
 * Valida l'input di un carosello Instagram. Meta richiede da 2 a 10 elementi:
 * ogni URL viene validato singolarmente perché dovrà essere scaricato dai server Meta.
 */
function validateCarouselOptions(options: InstagramPublishCarouselOptions): { caption: string; imageUrls: string[] } {
  if (
    !isRecord(options) ||
    !Array.isArray(options.imageUrls) ||
    options.imageUrls.length < 2 ||
    options.imageUrls.length > INSTAGRAM_MAX_CAROUSEL_ITEMS
  ) {
    throw new Error(`Un carosello Instagram richiede da 2 a ${INSTAGRAM_MAX_CAROUSEL_ITEMS} immagini.`);
  }

  return {
    caption: validateCaption(options.caption),
    imageUrls: options.imageUrls.map(validateImageUrl),
  };
}

/**
 * Estrae in modo sicuro l'oggetto `error` delle Graph API.
 * Oltre al messaggio conserva type, code, error_subcode e fbtrace_id: gli ultimi due
 * sono fondamentali per distinguere casi Meta specifici e per cercare una richiesta nei log Meta.
 */
function getInstagramGraphApiError(value: unknown): InstagramGraphApiError | undefined {
  if (!isRecord(value) || !isRecord(value.error)) {
    return undefined;
  }

  return {
    code: typeof value.error.code === 'number' ? value.error.code : undefined,
    errorSubcode: typeof value.error.error_subcode === 'number' ? value.error.error_subcode : undefined,
    fbtraceId: typeof value.error.fbtrace_id === 'string' ? value.error.fbtrace_id : undefined,
    message: typeof value.error.message === 'string' ? value.error.message : undefined,
    type: typeof value.error.type === 'string' ? value.error.type : undefined,
  };
}

function createInstagramApiError(status: number, error?: InstagramGraphApiError): InstagramPublicationError {
  const details = [
    `HTTP ${status}`,
    error?.type,
    error?.code !== undefined ? `code ${error.code}` : undefined,
    error?.errorSubcode !== undefined ? `subcode ${error.errorSubcode}` : undefined,
    error?.fbtraceId ? `fbtrace_id ${error.fbtraceId}` : undefined,
  ].filter(Boolean);

  // Una risposta HTTP 4xx ricevuta da Meta è definitiva: non esiste un processing remoto da attendere.
  const cleanupSafe = status >= 400 && status < 500;

  return new InstagramPublicationError(
    `Instagram Graph API error (${details.join(', ')}): ${error?.message || 'Errore non specificato.'}`,
    cleanupSafe,
  );
}

/**
 * Converte la risposta HTTP in JSON senza assumere che Meta abbia risposto correttamente.
 * Legge prima il body per poter segnalare risposte vuote e intercetta JSON malformato,
 * evitando errori TypeScript poco leggibili nelle fasi successive di parsing.
 */
async function parseInstagramResponse(response: Response): Promise<unknown> {
  let body: string;

  try {
    body = await response.text();
  } catch (error) {
    throw new Error(`Impossibile leggere la risposta Instagram (HTTP ${response.status}).`, { cause: error });
  }

  if (!body) {
    throw new Error(`Instagram ha restituito una risposta vuota (HTTP ${response.status}).`);
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`Instagram ha restituito JSON non valido (HTTP ${response.status}).`, { cause: error });
  }
}

function getResponseId(value: unknown, responseName: string): string {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new Error(`Instagram ha restituito ${responseName} senza un ID valido.`);
  }

  return value.id;
}

function getContainerStatus(value: unknown): InstagramContainerStatusResponse {
  if (!isRecord(value) || typeof value.status_code !== 'string') {
    throw new Error('Instagram ha restituito lo stato del container in un formato non valido.');
  }

  if (!INSTAGRAM_CONTAINER_STATUSES.includes(value.status_code as InstagramContainerStatus)) {
    throw new Error(`Instagram ha restituito uno stato container non supportato: ${value.status_code}.`);
  }

  return {
    status: typeof value.status === 'string' ? value.status : '',
    statusCode: value.status_code as InstagramContainerStatus,
  };
}

/**
 * Pubblica immagini e caroselli su un account Instagram professionale.
 * Gli URL devono restare raggiungibili da Meta fino alla conclusione di media_publish.
 */
export class InstagramService {
  /** Crea e pubblica un post Instagram composto da una sola immagine. */
  async publishImage(options: InstagramPublishOptions): Promise<InstagramPublishResponse> {
    const config = getInstagramConfig();
    const { caption, imageUrl } = validatePublishOptions(options);
    const containerId = await this.createImageContainer(config, imageUrl, caption, false);

    await this.waitForContainer(config, containerId);
    return this.publishContainer(config, containerId);
  }

  /** Crea i container figli, li raccoglie in un carosello e pubblica un solo post Instagram. */
  async publishCarousel(options: InstagramPublishCarouselOptions): Promise<InstagramPublishResponse> {
    const config = getInstagramConfig();
    const { caption, imageUrls } = validateCarouselOptions(options);
    // I container figli sono indipendenti: crearli e attenderli in parallelo riduce il tempo totale
    // dalla somma dei singoli processing al tempo del container più lento.
    const childContainerIds = await Promise.all(
      imageUrls.map((imageUrl) => this.createImageContainer(config, imageUrl, '', true)),
    );
    await Promise.all(childContainerIds.map((containerId) => this.waitForContainer(config, containerId)));

    const carouselContainerId = await this.createCarouselContainer(config, caption, childContainerIds);
    await this.waitForContainer(config, carouselContainerId);

    return this.publishContainer(config, carouselContainerId);
  }

  private async createImageContainer(
    config: InstagramConfig,
    imageUrl: string,
    caption: string,
    isCarouselItem: boolean,
  ): Promise<string> {
    const parameters = new URLSearchParams({
      access_token: config.accessToken,
      image_url: imageUrl,
    });

    if (caption) {
      parameters.set('caption', caption);
    }

    if (isCarouselItem) {
      parameters.set('is_carousel_item', 'true');
    }

    return this.postForId(config, `${config.instagramBusinessAccountId}/media`, parameters, 'un container media');
  }

  private async createCarouselContainer(
    config: InstagramConfig,
    caption: string,
    childContainerIds: string[],
  ): Promise<string> {
    const parameters = new URLSearchParams({
      access_token: config.accessToken,
      caption,
      children: childContainerIds.join(','),
      media_type: 'CAROUSEL',
    });

    return this.postForId(config, `${config.instagramBusinessAccountId}/media`, parameters, 'un container carosello');
  }

  private async publishContainer(config: InstagramConfig, containerId: string): Promise<InstagramPublishResponse> {
    const mediaId = await this.postForId(
      config,
      `${config.instagramBusinessAccountId}/media_publish`,
      new URLSearchParams({ access_token: config.accessToken, creation_id: containerId }),
      'un post pubblicato',
    );

    return { id: mediaId };
  }

  /** Attende che Meta termini il download dell’asset Cloudinary prima di pubblicare il container. */
  private async waitForContainer(config: InstagramConfig, containerId: string): Promise<void> {
    const deadline = Date.now() + INSTAGRAM_CONTAINER_READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      // La creazione del container è asincrona: Meta deve prima scaricare e processare l'URL Cloudinary.
      const status = await this.getContainerStatus(config, containerId);

      // Solo FINISHED garantisce che media_publish riceva un container pronto; PUBLISHED copre un retry idempotente.
      if (status.statusCode === 'FINISHED' || status.statusCode === 'PUBLISHED') {
        return;
      }

      // ERROR ed EXPIRED non diventeranno pronti: interrompiamo il polling e conserviamo il dettaglio restituito da Meta.
      if (status.statusCode === 'ERROR' || status.statusCode === 'EXPIRED') {
        throw new InstagramPublicationError(
          `Instagram non ha preparato il container ${containerId}: ${status.status || status.statusCode}.`,
          true,
        );
      }

      // IN_PROGRESS: evitiamo richieste continue alle Graph API attendendo due secondi prima del controllo successivo.
      await new Promise<void>((resolve) => setTimeout(resolve, INSTAGRAM_CONTAINER_POLL_INTERVAL_MS));
    }

    throw new Error('Instagram non ha preparato il media container entro il tempo previsto.');
  }

  /**
   * Legge lo stato asincrono di un media container creato in precedenza.
   *
   * La creazione di `/media` restituisce subito un ID, ma Meta continua in background
   * a scaricare l'immagine dall'URL Cloudinary e a validarla. Questa GET interroga 
   * lo stato di download e validazione degli asset tramite il container ID.
   *
   * È importante non confondere i due livelli di stato restituiti da Meta:
   * - un HTTP 200 significa soltanto che la richiesta di polling è valida e il container
   *   è stato trovato;
   * - `status_code` nel body (`IN_PROGRESS`, `FINISHED`, `ERROR`, `EXPIRED`, ...) descrive
   *   invece l'esito del processing asincrono del media.
   *
   * Per esempio, `{ status_code: 'ERROR' }` con HTTP 200 non è un errore della GET:
   * è Meta che comunica che il container esiste ma non ha potuto processare l'asset.
   * `waitForContainer` interpreta poi questo stato e decide se proseguire il polling,
   * pubblicare o terminare il flusso con cleanup sicuro.
   */
  private async getContainerStatus(
    config: InstagramConfig,
    containerId: string,
  ): Promise<InstagramContainerStatusResponse> {
    // Il polling è una GET separata dai POST di creazione: il token va quindi aggiunto esplicitamente anche qui.
    const endpoint = new URL(this.createEndpoint(config, containerId));
    // Chiediamo esclusivamente lo stato tecnico e la descrizione leggibile del processing.
    endpoint.searchParams.set('fields', 'status_code,status');
    endpoint.searchParams.set('access_token', config.accessToken);

    // Timeout e problemi di rete vengono trasformati in errori applicativi leggibili.
    const response = await this.fetchWithTimeout(endpoint.toString());
    // Anche una risposta HTTP non riuscita può contenere dettagli Meta utili nel body JSON.
    const data = await parseInstagramResponse(response);
    const apiError = getInstagramGraphApiError(data);

    // Questo ramo riguarda un errore della chiamata Graph API, non lo stato interno del container.
    // Per 4xx il cleanup è sicuro; per 5xx l'esito remoto può restare ambiguo.
    if (apiError || !response.ok) {
      throw createInstagramApiError(response.status, apiError);
    }

    // La GET ha avuto successo: restituiamo ora il status_code applicativo che waitForContainer
    // userà per attendere, pubblicare oppure interrompere il flusso.
    return getContainerStatus(data);
  }

  private async postForId(
    config: InstagramConfig,
    path: string,
    parameters: URLSearchParams,
    responseName: string,
  ): Promise<string> {
    const response = await this.fetchWithTimeout(this.createEndpoint(config, path), {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: parameters,
    });
    const data = await parseInstagramResponse(response);
    const apiError = getInstagramGraphApiError(data);

    if (apiError || !response.ok) {
      throw createInstagramApiError(response.status, apiError);
    }

    return getResponseId(data, responseName);
  }

  private createEndpoint(config: InstagramConfig, path: string): string {
    return `https://graph.facebook.com/${config.apiVersion}/${path}`;
  }

  /**
   * Esegue una fetch con un limite massimo di 15 secondi.
   * AbortController passa il proprio signal a fetch; allo scadere del timer `abort()` interrompe
   * la richiesta pendente, evitando che una connessione Meta bloccata fermi il flusso del bot.
   */
  private async fetchWithTimeout(endpoint: string, init?: RequestInit): Promise<Response> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), INSTAGRAM_REQUEST_TIMEOUT_MS);

    try {
      return await fetch(endpoint, { ...init, signal: abortController.signal });
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new Error(`La richiesta a Instagram ha superato il timeout di ${INSTAGRAM_REQUEST_TIMEOUT_MS / 1_000} secondi.`);
      }

      throw new Error('Impossibile connettersi alla Instagram Graph API.', { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const instagramService = new InstagramService();
