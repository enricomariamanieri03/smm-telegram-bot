import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginPendingPostEditing,
  getPendingPost,
  getPendingPostAwaitingEditInput,
  markPendingPostEditAsProcessing,
  savePendingPost,
  updateCrossPlatformState,
  updatePendingPostPreview,
  type PendingPost,
} from '../../../src/services/pending-post.service.js';
import { Destination } from '../../../src/types/destination.enum.js';

function createPost(chatId = 1): Omit<PendingPost, 'expiresAt'> {
  return {
    caption: 'Caption',
    chatId,
    destination: Destination.ENTRAMBI,
    fileIds: ['file-id'],
    location: 'Roma',
    previewMessageId: 10,
    sourceMessageIds: [5],
    crossPlatformState: { facebook: 'PENDING', instagram: 'PENDING', retryCount: 0 },
  };
}

afterEach(() => vi.useRealTimers());

describe('pending-post.service', () => {
  /**
   * Verifica che savePendingPost protegge lo stato interno da modifiche accidentali fatte fuori dalla Map.
   */
  it('copies mutable arrays and cross-platform state on save', () => {
    const post = createPost();
    savePendingPost('pending-copy', post);
    //Modifichiamo l'oggetto esterno non quello salvato nella Map
    post.fileIds.push('mutated');
    post.crossPlatformState!.facebook = 'PUBLISHED';

    expect(getPendingPost('pending-copy')).toMatchObject({
      fileIds: ['file-id'],
      crossPlatformState: { facebook: 'PENDING' },
    });
  });
  /**
   * Verifica che beginPendingPostEditing imposti lo stato editing su AWAITING_INPUT
   * e permetta una sola sessione di modifica attiva per chat.
   * Verifica inoltre che il passaggio a PROCESSING rimuova l'indice chatId → postId,
   * così ulteriori messaggi testuali non vengono associati alla modifica in corso.
   */
  it('tracks one edit session per chat and blocks additional text while processing', () => {
    //stessa chat, post diversi
    savePendingPost('edit-one', createPost(10));
    savePendingPost('edit-two', createPost(10));

    expect(beginPendingPostEditing('edit-one')?.editing?.status).toBe('AWAITING_INPUT');
    expect(beginPendingPostEditing('edit-two')).toBeUndefined();
    expect(getPendingPostAwaitingEditInput(10)?.postId).toBe('edit-one');

    markPendingPostEditAsProcessing('edit-one');
    expect(getPendingPostAwaitingEditInput(10)).toBeUndefined();
  });
  /**
   * Verifica che updatePendingPostPreview aggiorni i dati della nuova anteprima
   * e chiuda la modalità modifica, liberando l'indice chatId → postId.
   */
  it('updates the edited preview and releases the chat editing index', () => {
    savePendingPost('edit-preview', createPost(20));
    beginPendingPostEditing('edit-preview');

    updatePendingPostPreview('edit-preview', {
      caption: 'Caption aggiornata',
      location: 'Milano',
      previewMessageId: 99,
    });

    expect(getPendingPost('edit-preview')).toMatchObject({
      caption: 'Caption aggiornata',
      location: 'Milano',
      previewMessageId: 99,
      editing: undefined,
    });
    expect(getPendingPostAwaitingEditInput(20)).toBeUndefined();
  });
  
  /**
   * Verifica che updateCrossPlatformState aggiorni in modo mirato lo stato
   * di pubblicazione del PendingPost, senza alterarne le altre proprietà.
  */
  it('updates cross-platform state without changing the rest of the pending post', () => {
    savePendingPost('cross-state', createPost(30));
    updateCrossPlatformState('cross-state', {
      facebook: 'PUBLISHED',
      instagram: 'FAILED',
      retryCount: 0,
      facebookStatusMessageId: 101,
    });

    expect(getPendingPost('cross-state')).toMatchObject({
      caption: 'Caption',
      crossPlatformState: { facebook: 'PUBLISHED', instagram: 'FAILED', facebookStatusMessageId: 101 },
    });
  });

  // Simuliamo il TTL di un'ora: allo scadere il service rimuove prima il post
  // dalla Map e poi invoca una sola volta la callback delegata al cleanup Telegram.
  //Flusso: savePendingPost -> expirePendingPost 
  //        -> runExpirationHandler(pendingPost) 
  //        -> onExpire(pendingPost)
  it('expires a session after one hour and invokes its expiration handler once', async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    savePendingPost('expires', createPost(40), onExpire);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    //l'asserzione si aspetta che il post è stato rimosso dalla mappa
    expect(getPendingPost('expires')).toBeUndefined();
    //funzione onExpire implementata in photoHandler tramite una callBack con all'interno expirePreview
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
