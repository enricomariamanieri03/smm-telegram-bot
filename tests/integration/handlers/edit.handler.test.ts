import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import {
  handleEditTextMessage,
  handleModifyCallback,
} from '../../../src/handlers/edit.handler.js';
import {
  deletePendingPost,
  getPendingPost,
  getPendingPostAwaitingEditInput,
  savePendingPost,
  type PendingPost,
} from '../../../src/services/pending-post.service.js';
import { Destination } from '../../../src/types/destination.enum.js';

const mocks = vi.hoisted(() => ({
  createPostPreviewKeyboard: vi.fn(),
  generateEditedSocialPost: vi.fn(),
  sendPostPreview: vi.fn(),
}));

vi.mock('../../../src/services/openai.service.js', () => ({
  generateEditedSocialPost: mocks.generateEditedSocialPost,
}));

vi.mock('../../../src/services/preview.service.js', () => ({
  createPostPreviewKeyboard: mocks.createPostPreviewKeyboard,
  sendPostPreview: mocks.sendPostPreview,
}));

function createPendingPost(): Omit<PendingPost, 'expiresAt'> {
  return {
    caption: 'Testo originale',
    chatId: 50,
    destination: Destination.IG,
    fileIds: ['file-id'],
    location: 'Roma',
    previewMessageId: 51,
    sourceMessageIds: [49],
  };
}

afterEach(() => {
  deletePendingPost('701');
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('edit.handler integration', () => {
  /**
   * Verifica il flusso completo Modifica: callback, istruzioni, testo utente, rigenerazione
   * OpenAI mockata e sostituzione dell'anteprima. Alla fine la chat non resta in modalità
   * editing e il messaggio dell'utente viene eliminato dopo il ritardo UX previsto.
   */
  it('regenerates the preview and closes the editing session after receiving user instructions', async () => {
    vi.useFakeTimers();
    savePendingPost('701', createPendingPost());
    mocks.generateEditedSocialPost.mockResolvedValue({
      testo_pulito: 'Testo aggiornato',
      luogo: 'Milano',
    });
    mocks.sendPostPreview.mockResolvedValue({ message_id: 54 });

    const telegram = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      reply: vi.fn().mockResolvedValue({ message_id: 52 }),
    };
    const callbackCtx = {
      answerCallbackQuery: telegram.answerCallbackQuery,
      callbackQuery: { data: 'modifica_701' },
      editMessageReplyMarkup: telegram.editMessageReplyMarkup,
      reply: telegram.reply,
    } as unknown as Context;

    await handleModifyCallback(callbackCtx);

    // Il callback apre la sessione e conserva l'ID del messaggio istruzioni,
    // necessario per rimuoverlo quando l'utente invierà le sue correzioni.
    expect(getPendingPostAwaitingEditInput(50)?.pendingPost.editing).toMatchObject({
      status: 'AWAITING_INPUT',
      instructionsMessageId: 52,
    });

    const inputCtx = {
      api: { deleteMessage: telegram.deleteMessage },
      chat: { id: 50 },
      message: { message_id: 53, text: 'Sostituisci Roma con Milano.' },
      reply: telegram.reply,
    } as unknown as Context;

    await handleEditTextMessage(inputCtx);

    // L'handler passa all'LLM sia la caption originale sia il testo della correzione.
    expect(mocks.generateEditedSocialPost).toHaveBeenCalledWith(
      'Testo originale',
      'Sostituisci Roma con Milano.',
    );
    // La nuova anteprima usa il contenuto rigenerato e segnala graficamente l'aggiornamento.
    expect(mocks.sendPostPreview).toHaveBeenCalledWith(inputCtx, {
      caption: 'Testo aggiornato',
      destination: Destination.IG,
      location: 'Milano',
      postId: '701',
      updated: true,
    });
    // Il record esistente viene aggiornato: non viene creata una seconda sessione PendingPost.
    expect(getPendingPost('701')).toMatchObject({
      caption: 'Testo aggiornato',
      location: 'Milano',
      previewMessageId: 54,
      editing: undefined,
    });
    // La sessione chatId -> postId è liberata: futuri messaggi non sono più istruzioni di modifica.
    expect(getPendingPostAwaitingEditInput(50)).toBeUndefined();
    // La vecchia anteprima e il messaggio istruzioni vengono rimossi senza bloccare la rigenerazione.
    expect(telegram.deleteMessage).toHaveBeenCalledWith(50, 51);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(50, 52);

    await vi.advanceTimersByTimeAsync(5_000);
    // L'input utente resta visibile brevemente, poi viene eliminato dal timer UX.
    expect(telegram.deleteMessage).toHaveBeenCalledWith(50, 53);
  });
});
