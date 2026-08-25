import { Destination } from '../types/destination.enum.js';

const PENDING_POST_TTL_MS = 60 * 60 * 1000;//1 ora

export type PlatformPublicationStatus = 'PENDING' | 'PUBLISHED' | 'FAILED' | 'UNKNOWN';

/** Stato temporaneo del tentativo ENTRAMBI; serve a ritentare una sola volta solo i canali falliti. */
export interface CrossPlatformPublicationState {
  facebook: PlatformPublicationStatus;
  instagram: PlatformPublicationStatus;
  retryCount: 0 | 1;
  facebookStatusMessageId?: number;
  instagramStatusMessageId?: number;
}

export type PendingPostEditingStatus = 'AWAITING_INPUT' | 'PROCESSING';

/** Stato transitorio usato per associare il prossimo messaggio testuale alla sua anteprima (Caso: MODIFICA). */
export interface PendingPostEditingState {
  instructionsMessageId?: number;
  status: PendingPostEditingStatus;
}

/** Dati minimi conservati tra la generazione dell'anteprima e il click di approvazione. */
export interface PendingPost {
  caption: string;
  chatId: number;
  destination: Destination;
  fileIds: string[];
  location: string;
  sourceMessageIds: number[];
  crossPlatformState?: CrossPlatformPublicationState;
  editing?: PendingPostEditingState;
  expiresAt: number;
  previewMessageId: number;
}

/** Tipo callback opzionale invocata alla scadenza dell'anteprima, sincrona o asincrona. */
type PendingPostExpirationHandler = (pendingPost: PendingPost) => void | Promise<void>;

interface StoredPendingPost extends PendingPost {
  onExpire?: PendingPostExpirationHandler;
}

/**
 * Key: postId (callback Telegram); Value: stato completo dell'anteprima in attesa.
 * Store temporaneo in memoria delle anteprime. Non vengono conservati Blob o immagini base64,
 * che verrebbero invece riscaricati da Telegram solo quando l'utente approva la pubblicazione.
 */
const mapPendingPosts = new Map<string, StoredPendingPost>();
/**Key: chatId; Value: postId della sessione attualmente in modalità modifica.
 * Permette all’handler message:text di risalire in O(1), dal chatId,
 * al postId dell’unica anteprima che l’utente sta modificando.
 * Non duplica il PendingPost, che continua a vivere esclusivamente in mapPendingPosts.
 */ 
const editingPostIdsByChat = new Map<number, string>();

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
  editingPostIdsByChat.delete(pendingPost.chatId);
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
    crossPlatformState: post.crossPlatformState ? { ...post.crossPlatformState } : undefined,
    editing: post.editing ? { ...post.editing } : undefined,
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
  const pendingPost = mapPendingPosts.get(postId);
  mapPendingPosts.delete(postId);

  if (pendingPost) {
    editingPostIdsByChat.delete(pendingPost.chatId);
  }
}

/** Attiva la modalità modifica per un solo post alla volta nella stessa chat. */
export function beginPendingPostEditing(postId: string): PendingPost | undefined {
  const pendingPost = getPendingPost(postId);

  if (!pendingPost || editingPostIdsByChat.has(pendingPost.chatId)) {
    return undefined;
  }

  pendingPost.editing = { status: 'AWAITING_INPUT' };
  editingPostIdsByChat.set(pendingPost.chatId, postId);
  return pendingPost;
}

/** Salva l'ID del messaggio istruzioni, necessario per rimuoverlo quando arriva la modifica. */
export function setPendingPostEditingInstructionsMessageId(postId: string, messageId: number): void {
  const pendingPost = mapPendingPosts.get(postId);

  if (pendingPost?.editing) {
    pendingPost.editing.instructionsMessageId = messageId;
  }
}

/** Restituisce il post in attesa di testo per una chat, ignorando richieste duplicate durante il processing. */
export function getPendingPostAwaitingEditInput(chatId: number): { postId: string; pendingPost: PendingPost } | undefined {
  const postId = editingPostIdsByChat.get(chatId);
  const pendingPost = postId ? getPendingPost(postId) : undefined;

  if (!postId || !pendingPost || pendingPost.editing?.status !== 'AWAITING_INPUT') {
    return undefined;
  }

  return { postId, pendingPost };
}

/** Blocca messaggi testuali ulteriori mentre OpenAI rigenera l'anteprima. */
export function markPendingPostEditAsProcessing(postId: string): PendingPost | undefined {
  const pendingPost = mapPendingPosts.get(postId);

  if (!pendingPost?.editing) {
    return undefined;
  }

  pendingPost.editing.status = 'PROCESSING';
  return pendingPost;
}

/** Annulla una modifica non avviata o non completata e libera la chat per un nuovo tentativo. */
export function clearPendingPostEditing(postId: string): void {
  const pendingPost = mapPendingPosts.get(postId);

  if (pendingPost) {
    pendingPost.editing = undefined;
    editingPostIdsByChat.delete(pendingPost.chatId);
  }
}

/** Aggiorna l'anteprima dopo una modifica e chiude la relativa sessione testuale. */
export function updatePendingPostPreview(
  postId: string,
  updates: Pick<PendingPost, 'caption' | 'location' | 'previewMessageId'>,
): PendingPost | undefined {
  const pendingPost = getPendingPost(postId);

  if (!pendingPost) {
    return undefined;
  }

  pendingPost.caption = updates.caption;
  pendingPost.location = updates.location;
  pendingPost.previewMessageId = updates.previewMessageId;
  pendingPost.editing = undefined;
  editingPostIdsByChat.delete(pendingPost.chatId);

  return pendingPost;
}

/** Aggiorna in modo atomico lo stato della pubblicazione congiunta mantenendo la sessione esistente. */
export function updateCrossPlatformState(
  postId: string,
  crossPlatformState: CrossPlatformPublicationState,
): PendingPost | undefined {
  const pendingPost = mapPendingPosts.get(postId);

  if (!pendingPost || pendingPost.expiresAt <= Date.now()) {
    return undefined;
  }

  pendingPost.crossPlatformState = { ...crossPlatformState };
  return pendingPost;
}
