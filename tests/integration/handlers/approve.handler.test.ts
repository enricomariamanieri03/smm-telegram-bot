import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { handleApproveCallback } from '../../../src/handlers/approve.handler.js';
import {
  deletePendingPost,
  getPendingPost,
  savePendingPost,
  type PendingPost,
} from '../../../src/services/pending-post.service.js';
import { Destination } from '../../../src/types/destination.enum.js';

const mocks = vi.hoisted(() => ({
  deleteImages: vi.fn(),
  publishAlbum: vi.fn(),
  publishCarousel: vi.fn(),
  publishImage: vi.fn(),
  publishPhoto: vi.fn(),
  uploadImage: vi.fn(),
}));

vi.mock('../../../src/services/facebook.service.js', () => ({
  facebookService: {
    publishAlbum: mocks.publishAlbum,
    publishPhoto: mocks.publishPhoto,
  },
}));

vi.mock('../../../src/services/cloudinary.service.js', () => ({
  cloudinaryService: {
    deleteImages: mocks.deleteImages,
    uploadImage: mocks.uploadImage,
  },
}));

vi.mock('../../../src/services/instagram.service.js', () => {
  class InstagramPublicationError extends Error {
    cleanupSafe: boolean;

    constructor(message: string, cleanupSafe: boolean) {
      super(message);
      this.name = 'InstagramPublicationError';
      this.cleanupSafe = cleanupSafe;
    }
  }

  return {
    InstagramPublicationError,
    instagramService: {
      publishCarousel: mocks.publishCarousel,
      publishImage: mocks.publishImage,
    },
  };
});

interface TelegramContextMocks {
  answerCallbackQuery: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  editMessageReplyMarkup: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  getFile: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function createPendingPost(destination: Destination, chatId = 70): Omit<PendingPost, 'expiresAt'> {
  return {
    caption: 'Didascalia di test',
    chatId,
    destination,
    fileIds: ['telegram-file-id'],
    location: 'Roma',
    previewMessageId: 71,
    sourceMessageIds: [69],
    crossPlatformState: destination === Destination.ENTRAMBI
      ? { facebook: 'PENDING', instagram: 'PENDING', retryCount: 0 }
      : undefined,
  };
}

function createContext(callbackData: string): { ctx: Context; telegram: TelegramContextMocks } {
  const telegram: TelegramContextMocks = {
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    getFile: vi.fn().mockResolvedValue({ file_path: 'photos/test.jpg' }),
    reply: vi.fn().mockResolvedValue({ message_id: 90 }),
    sendMessage: vi.fn()
      .mockResolvedValueOnce({ message_id: 80 })
      .mockResolvedValueOnce({ message_id: 81 })
      .mockResolvedValueOnce({ message_id: 82 })
      .mockResolvedValue({ message_id: 83 }),
  };

  const ctx = {
    api: {
      deleteMessage: telegram.deleteMessage,
      editMessageReplyMarkup: telegram.editMessageReplyMarkup,
      editMessageText: telegram.editMessageText,
      getFile: telegram.getFile,
      sendMessage: telegram.sendMessage,
    },
    answerCallbackQuery: telegram.answerCallbackQuery,
    callbackQuery: { data: callbackData },
    editMessageReplyMarkup: telegram.editMessageReplyMarkup,
    reply: telegram.reply,
  } as unknown as Context;

  return { ctx, telegram };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('approve.handler integration', () => {
  /**
   * Simula due callback approva_<postId> ravvicinate: la prima rimane sospesa durante
   * la pubblicazione Facebook, mentre la seconda deve essere bloccata dal Set
   * publicationInProgress senza avviare un post duplicato.
   */
  it('prevents a second rapid approval while the first Facebook publication is running', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    savePendingPost('501', createPendingPost(Destination.FB));

    const publication = deferred<void>();
    mocks.publishPhoto.mockReturnValueOnce(publication.promise);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('image', {
      headers: { 'content-type': 'image/jpeg' },
    })));
    const { ctx, telegram } = createContext('approva_501');

    // Avviamo il primo handler senza await: resta sospeso su publication.promise,
    // mantenendo il post nel Set publicationInProgress mentre simuliamo il secondo click.
    const firstApproval = handleApproveCallback(ctx);
    await vi.waitFor(() => expect(mocks.publishPhoto).toHaveBeenCalledTimes(1));

    await handleApproveCallback(ctx);

    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Pubblicazione già in corso.' });
    expect(mocks.publishPhoto).toHaveBeenCalledTimes(1);

    publication.resolve();
    await firstApproval;
    deletePendingPost('501');
  });
  /**
   * Simula una prima pubblicazione ENTRAMBI in cui Facebook riesce e Instagram fallisce
   * in modo definitivo. Verifica che lo stato venga salvato come PUBLISHED/FAILED e che
   * il successivo callback riprova_<postId> ritenti esclusivamente Instagram, senza duplicare
   * il post Facebook già pubblicato.
   */
  it('retries only the failed Instagram publication for a cross-platform post', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    savePendingPost('502', createPendingPost(Destination.ENTRAMBI));

    mocks.publishPhoto.mockResolvedValue(undefined);
    mocks.uploadImage.mockResolvedValue({
      publicId: 'temporary-image',
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/temporary-image.jpg',
    });
    mocks.deleteImages.mockResolvedValue([]);
    mocks.publishImage
      .mockRejectedValueOnce(new Error('Instagram Graph API error (HTTP 400): invalid image.'))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('image', { headers: { 'content-type': 'image/jpeg' } }))
      .mockResolvedValueOnce(new Response('image', { headers: { 'content-type': 'image/jpeg' } })));
    const { ctx } = createContext('approva_502');

    await handleApproveCallback(ctx);

    expect(getPendingPost('502')?.crossPlatformState).toMatchObject({
      facebook: 'PUBLISHED',
      instagram: 'FAILED',
      retryCount: 0,
    });
    expect(mocks.publishPhoto).toHaveBeenCalledTimes(1);
    expect(mocks.publishImage).toHaveBeenCalledTimes(1);

    // Nel Context reale callbackQuery è readonly; nel mock cambiamo soltanto il payload simulato.
    (ctx as unknown as { callbackQuery: { data: string } }).callbackQuery = { data: 'riprova_502' };
    await handleApproveCallback(ctx);
    //Facebook non viene richiamato: resta a una sola chiamata
    expect(mocks.publishPhoto).toHaveBeenCalledTimes(1);
    //Instagram viene richiamato una seconda volta
    expect(mocks.publishImage).toHaveBeenCalledTimes(2);
    //Entrambe le piattaforme sono PUBLISHED, il post viene rimosso
    expect(getPendingPost('502')).toBeUndefined();
  });
});
