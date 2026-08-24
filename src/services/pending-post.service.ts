import { Destination } from '../types/destination.enum.js';

const PENDING_POST_TTL_MS = 60 * 60 * 1000;//1 ora

/** Dati minimi conservati tra la generazione dell'anteprima e il click di approvazione. */
export interface PendingPost {
  caption: string;
  chatId: number;
  destination: Destination;
  fileIds: string[];
  sourceMessageIds: number[];
  expiresAt: number;
  previewMessageId: number;
}

/** Tipo callback opzionale invocata alla scadenza dell'anteprima, sincrona o asincrona. */
type PendingPostExpirationHandler = (pendingPost: PendingPost) => void | Promise<void>;

interface StoredPendingPost extends PendingPost {
  onExpire?: PendingPostExpirationHandler;
}

/**
 * Store temporaneo in memoria delle anteprime. Non vengono conservati Blob o immagini base64,
 * che verrebbero invece riscaricati da Telegram solo quando l'utente approva la pubblicazione.
 */
const mapPendingPosts = new Map<string, StoredPendingPost>();

/** Esegue l'azione esterna associata alla scadenza senza lasciare rejection non gestite. */
function runExpirationHandler(pendingPost: StoredPendingPost): void {
  if (!pendingPost.onExpire) {
    return;
  }

  void Promise.resolve()
    .then(() => pendingPost.onExpire?.(pendingPost))
    .catch((error) => {
      console.error('Errore durante la gestione della scadenza dell’anteprima:', error);
    });
}

/** Elimina lo stato solo se appartiene ancora alla stessa sessione e ne avvia l'azione di scadenza. */
function expirePendingPost(postId: string, expiresAt: number): void {
  const pendingPost = mapPendingPosts.get(postId);

  // Evita che il timer di una vecchia anteprima agisca su un eventuale ID riutilizzato.
  if (pendingPost?.expiresAt !== expiresAt) {
    return;
  }

  mapPendingPosts.delete(postId);
  runExpirationHandler(pendingPost);
}

/** Registra un'anteprima e pianifica la sua scadenza automatica dopo un'ora. */
export function savePendingPost(
  postId: string,
  post: Omit<PendingPost, 'expiresAt'>,
  onExpire?: PendingPostExpirationHandler,
): void {
  const expiresAt = Date.now() + PENDING_POST_TTL_MS;
  mapPendingPosts.set(postId, {
    ...post,
    fileIds: [...post.fileIds],
    sourceMessageIds: [...post.sourceMessageIds],
    expiresAt,
    onExpire,
  });

  const expirationTimer = setTimeout(() => {
    expirePendingPost(postId, expiresAt);
  }, PENDING_POST_TTL_MS);

  expirationTimer.unref();
}

/** Restituisce l'anteprima se ancora valida, altrimenti la elimina e segnala che non esiste più. */
export function getPendingPost(postId: string): PendingPost | undefined {
  const pendingPost = mapPendingPosts.get(postId);

  if (!pendingPost) {
    return undefined;
  }

  if (pendingPost.expiresAt <= Date.now()) {
    expirePendingPost(postId, pendingPost.expiresAt);
    return undefined;
  }

  return pendingPost;
}

/** Rimuove lo stato quando l'utente approva o rifiuta l'anteprima. */
export function deletePendingPost(postId: string): void {
  mapPendingPosts.delete(postId);
}
