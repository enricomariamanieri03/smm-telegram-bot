import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { handleRejectCallback } from '../../../src/handlers/reject.handler.js';
import {
  getPendingPost,
  savePendingPost,
  type PendingPost,
} from '../../../src/services/pending-post.service.js';
import { Destination } from '../../../src/types/destination.enum.js';

function createPendingPost(): Omit<PendingPost, 'expiresAt'> {
  return {
    caption: 'Didascalia da rifiutare',
    chatId: 40,
    destination: Destination.FB,
    fileIds: ['file-id'],
    location: '',
    previewMessageId: 41,
    // Il duplicato della preview verifica anche la deduplicazione tramite Set.
    sourceMessageIds: [39, 41],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('reject.handler integration', () => {
  /**
   * Verifica che Rifiuta elimini subito l'anteprima tra i PendingPost, 
   * ma lasci visibili il messaggio di anteprima e media per cinque secondi; 
   * successivamente li rimuove e, dopo altri dieci
   * secondi, anche elimina anche il messaggio temporaneo di rifiuto.
   */
  it('cleans the pending state and deletes preview, source media and notification on their timers', async () => {
    vi.useFakeTimers();
    savePendingPost('601', createPendingPost());
    const telegram = {
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
      reply: vi.fn().mockResolvedValue({ message_id: 42 }),
    };
    const ctx = {
      api: { deleteMessage: telegram.deleteMessage },
      answerCallbackQuery: telegram.answerCallbackQuery,
      callbackQuery: { data: 'rifiuta_601' },
      reply: telegram.reply,
    } as unknown as Context;

    await handleRejectCallback(ctx);

    expect(getPendingPost('601')).toBeUndefined();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Post eliminato' });
    expect(telegram.deleteMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(telegram.deleteMessage).toHaveBeenCalledTimes(2);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(40, 41);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(40, 39);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(telegram.deleteMessage).toHaveBeenCalledWith(40, 42);
  });
});
