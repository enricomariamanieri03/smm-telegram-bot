import { Context, InlineKeyboard } from 'grammy';
import { cloudinaryService, type CloudinaryHostedImage } from '../services/cloudinary.service.js';
import { facebookService, FacebookImage } from '../services/facebook.service.js';
import { InstagramPublicationError, instagramService } from '../services/instagram.service.js';
import {
  deletePendingPost,
  getPendingPost,
  updateCrossPlatformState,
  type CrossPlatformPublicationState,
  type PendingPost,
  type PlatformPublicationStatus,
} from '../services/pending-post.service.js';
import { Destination } from '../types/destination.enum.js';

//Set che contiene i post già in fase di pubblicazione
const publicationInProgress = new Set<string>();

const FACEBOOK_SUCCESS_MESSAGE =
  '✅ Fantastico! Il post è stato pubblicato con successo sulla tua pagina Facebook!';
const FACEBOOK_ERROR_MESSAGE =
  '⚠️ Attenzione! Si è verificato un errore durante la pubblicazione su Facebook. Riprova tra pochi minuti o contatta Enrico.';
const INSTAGRAM_SUCCESS_MESSAGE =
  '✅ Fantastico! Il post è stato pubblicato con successo sul tuo profilo Instagram!';
const INSTAGRAM_ERROR_MESSAGE =
  '⚠️ Attenzione! Si è verificato un errore durante la pubblicazione su Instagram. Riprova tra pochi minuti o contatta Enrico.';
const INSTAGRAM_PROGRESS_MESSAGE =
  '⏳ Sto pubblicando il post su Instagram.\nPotrebbero volerci alcuni secondi...';
const CROSS_PLATFORM_PROGRESS_MESSAGE =
  '⏳ Sto pubblicando il post su Facebook e Instagram.\nPotrebbero volerci alcuni secondi...';
const FACEBOOK_RETRY_MESSAGE =
  '⚠️ La pubblicazione su Facebook non è stata completata. Puoi riprovare una sola volta.';
const INSTAGRAM_RETRY_MESSAGE =
  '⚠️ La pubblicazione su Instagram non è stata completata. Puoi riprovare una sola volta.';
const FACEBOOK_CONTACT_MESSAGE =
  '⚠️ La pubblicazione su Facebook non è stata completata. Contatta Enrico.';
const INSTAGRAM_CONTACT_MESSAGE =
  '⚠️ La pubblicazione su Instagram non è stata completata. Contatta Enrico.';
const FACEBOOK_UNKNOWN_MESSAGE =
  '⚠️ Non è possibile confermare la pubblicazione su Facebook. Contatta Enrico.';
const INSTAGRAM_UNKNOWN_MESSAGE =
  '⚠️ Non è possibile confermare la pubblicazione su Instagram. Contatta Enrico.';
const ERROR_NOTIFICATION_LIFETIME_MS = 10_000;

/** Scarica un'immagine originale da Telegram e la converte nel Blob richiesto dalla Facebook Graph API. */
async function downloadTelegramPhoto(ctx: Context, fileId: string, index: number): Promise<FacebookImage> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN mancante durante la pubblicazione Facebook.');
  }

  const file = await ctx.api.getFile(fileId);

  if (!file.file_path) {
    throw new Error('Telegram non ha restituito il percorso della foto da pubblicare.');
  }

  const response = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${encodeURI(file.file_path)}`,
  );

  if (!response.ok) {
    throw new Error(`Impossibile scaricare la foto da Telegram (HTTP ${response.status}).`);
  }

  const responseContentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const contentType = responseContentType?.startsWith('image/') ? responseContentType : 'image/jpeg';
  const extension = contentType === 'image/png' ? 'png' : 'jpg';

  return {
    image: new Blob([await response.arrayBuffer()], { type: contentType }),
    fileName: `telegram-photo-${index + 1}.${extension}`,
  };
}

/** Registra gli errori di cleanup senza trasformare un post Instagram già pubblicato in un fallimento. */
async function cleanupCloudinaryImages(images: CloudinaryHostedImage[]): Promise<void> {
  const results = await cloudinaryService.deleteImages(images.map((image) => image.publicId));

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Impossibile eliminare l'immagine Cloudinary temporanea ${images[index].publicId}:`, result.reason);
    }
  });
}

/**
 * Rimuove la preview e tutti i messaggi media che l'hanno originata.
 */
async function cleanupFailedPublicationMessages(ctx: Context, pendingPost: PendingPost): Promise<void> {
  const messageIds = [...new Set([pendingPost.previewMessageId, ...pendingPost.sourceMessageIds])];
  const results = await Promise.allSettled(
    messageIds.map((messageId) => ctx.api.deleteMessage(pendingPost.chatId, messageId)),
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Impossibile eliminare il messaggio Telegram ${messageIds[index]} dopo un errore di pubblicazione:`, result.reason);
    }
  });

  const previewIndex = messageIds.indexOf(pendingPost.previewMessageId);
  //Se la preview non può essere eliminata, prova almeno a rimuovere la sua inline keyboard.
  if (previewIndex >= 0 && results[previewIndex]?.status === 'rejected') {
    await ctx.api.editMessageReplyMarkup(pendingPost.chatId, pendingPost.previewMessageId, {
      reply_markup: { inline_keyboard: [] },
    }).catch((error) => {
      console.error('Impossibile rimuovere la tastiera dell’anteprima dopo un errore di pubblicazione:', error);
    });
  }
}

/**
 * Mostra l'errore sul messaggio di avanzamento, se presente; altrimenti ne invia uno nuovo.
 * In entrambi i casi la notifica si auto-elimina, mantenendo la chat pulita dopo dieci secondi.
 */
async function sendTemporaryPublicationError(
  ctx: Context,
  pendingPost: PendingPost,
  errorMessage: string,
  progressMessageId?: number,
): Promise<void> {
  let notificationMessageId = progressMessageId;

  if (notificationMessageId) {
    try {
      await ctx.api.editMessageText(pendingPost.chatId, notificationMessageId, errorMessage);
    } catch (error) {
      console.error('Impossibile aggiornare il messaggio di avanzamento con l’errore:', error);
      notificationMessageId = undefined;
    }
  }

  if (!notificationMessageId) {
    const notification = await ctx.api.sendMessage(pendingPost.chatId, errorMessage);
    notificationMessageId = notification.message_id;
  }

  const deletionTimer = setTimeout(() => {
    void ctx.api.deleteMessage(pendingPost.chatId, notificationMessageId).catch((error) => {
      console.error('Impossibile eliminare la notifica temporanea di errore:', error);
    });
  }, ERROR_NOTIFICATION_LIFETIME_MS);

  deletionTimer.unref();
}

/** Aggiorna il messaggio di avanzamento con il successo, senza trasformare un post già pubblicato in un errore UX. */
async function showInstagramPublicationSuccess(
  ctx: Context,
  pendingPost: PendingPost,
  progressMessageId: number,
): Promise<void> {
  try {
    await ctx.api.editMessageText(pendingPost.chatId, progressMessageId, INSTAGRAM_SUCCESS_MESSAGE);
  } catch (error) {
    console.error('Impossibile aggiornare il messaggio di avanzamento con il successo:', error);
    //Se non riesce ne invia uno nuovo di successo
    await ctx.api.sendMessage(pendingPost.chatId, INSTAGRAM_SUCCESS_MESSAGE).catch((sendError) => {
      console.error('Impossibile inviare la notifica di successo Instagram:', sendError);
    });
  }
}

/**
 * Carica le foto su Cloudinary, le pubblica su Instagram e rimuove gli asset solo dopo media_publish.
 * Se l'upload Cloudinary fallisce prima di contattare Instagram, elimina best effort gli asset già caricati.
 */
async function publishToInstagram(
  images: FacebookImage[],
  caption: string,
): Promise<void> {
  const hostedImages: CloudinaryHostedImage[] = [];
  let instagramPublishingStarted = false;

  try {
    // Upload sequenziale: in caso di errore sappiamo esattamente quali asset temporanei ripulire.
    for (const image of images) {
      const hostedImage = await cloudinaryService.uploadImage(image);
      hostedImages.push(hostedImage);
      console.info(`Immagine temporanea Cloudinary caricata: ${hostedImage.publicId}`);
    }

    instagramPublishingStarted = true;

    if (hostedImages.length === 1) {
      await instagramService.publishImage({
        caption,
        imageUrl: hostedImages[0].secureUrl,
      });
    } else {
      await instagramService.publishCarousel({
        caption,
        imageUrls: hostedImages.map((image) => image.secureUrl),
      });
    }
  } catch (error) {
    const cleanupSafeAfterInstagramError =
      error instanceof InstagramPublicationError && error.cleanupSafe;

    if ((!instagramPublishingStarted || cleanupSafeAfterInstagramError) && hostedImages.length > 0) {
      await cleanupCloudinaryImages(hostedImages);
    }

    // Dopo l'avvio della pubblicazione l'esito può essere ambiguo in caso di timeout Meta:
    // gli asset restano disponibili per non interrompere un eventuale processing ancora in corso.
    throw error;
  }

  // Il post esiste già su Instagram: ora le sorgenti temporanee non sono più necessarie.
  await cleanupCloudinaryImages(hostedImages);
}

async function publishToFacebook(images: FacebookImage[], caption: string): Promise<void> {
  if (images.length === 1) {
    await facebookService.publishPhoto({ caption, ...images[0] });
    return;
  }

  await facebookService.publishAlbum({ caption, images });
}

function getPublicationStatus(error: unknown): PlatformPublicationStatus {
  if (error instanceof InstagramPublicationError) {
    return error.cleanupSafe ? 'FAILED' : 'UNKNOWN';
  }

  // Le risposte 4xx sono definitive; timeout, rete e 5xx restano volutamente ambigui.
  return error instanceof Error && /HTTP 4\d\d/.test(error.message) ? 'FAILED' : 'UNKNOWN';
}

async function upsertStatusMessage(
  ctx: Context,
  pendingPost: PendingPost,
  messageId: number | undefined,
  text: string,
): Promise<number | undefined> {
  if (messageId) {
    try {
      await ctx.api.editMessageText(pendingPost.chatId, messageId, text);
      return messageId;
    } catch (error) {
      console.error('Impossibile aggiornare il messaggio di stato della pubblicazione:', error);
    }
  }

  try {
    return (await ctx.api.sendMessage(pendingPost.chatId, text)).message_id;
  } catch (error) {
    console.error('Impossibile inviare il messaggio di stato della pubblicazione:', error);
    return undefined;
  }
}
/**Helper che riceve dall'esterno piattaforma, stato dell'anteprima, numero di tentavi del riprova
 * Imposta il messaggio da inviare in base alle condizioni ottenute tramite parametri
 */ 
function getPlatformStatusMessage(
  platform: 'facebook' | 'instagram',
  status: PlatformPublicationStatus,
  retryAvailable: boolean,
): string {
  if (status === 'PUBLISHED') {
    return platform === 'facebook' ? FACEBOOK_SUCCESS_MESSAGE : INSTAGRAM_SUCCESS_MESSAGE;
  }

  if (status === 'UNKNOWN') {
    return platform === 'facebook' ? FACEBOOK_UNKNOWN_MESSAGE : INSTAGRAM_UNKNOWN_MESSAGE;
  }

  if (status === 'FAILED' && retryAvailable) {
    return platform === 'facebook' ? FACEBOOK_RETRY_MESSAGE : INSTAGRAM_RETRY_MESSAGE;
  }

  return platform === 'facebook' ? FACEBOOK_CONTACT_MESSAGE : INSTAGRAM_CONTACT_MESSAGE;
}

/** Pubblica entrambe le destinazioni in parallelo; un eventuale retry esegue solo i canali FAILED. */
async function publishToBothPlatforms(
  ctx: Context,
  postId: string,
  pendingPost: PendingPost,
  isRetry: boolean,
): Promise<void> {
  const currentState = pendingPost.crossPlatformState;

  if (!currentState) {
    throw new Error('Stato della pubblicazione congiunta non disponibile.');
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch((error) => {
    console.error('Impossibile rimuovere la tastiera durante la pubblicazione congiunta:', error);
  });

  const progressMessage = await ctx.api.sendMessage(pendingPost.chatId, CROSS_PLATFORM_PROGRESS_MESSAGE);
  const images = await Promise.all(
    pendingPost.fileIds.map((fileId, index) => downloadTelegramPhoto(ctx, fileId, index)),
  );
  const nextState: CrossPlatformPublicationState = {
    ...currentState,
    retryCount: isRetry ? 1 : currentState.retryCount,
  };
  const operations: Array<{ platform: 'facebook' | 'instagram'; run: () => Promise<void> }> = [];

  if (currentState.facebook === (isRetry ? 'FAILED' : 'PENDING')) {
    operations.push({ platform: 'facebook', run: () => publishToFacebook(images, pendingPost.caption) });
  }

  if (currentState.instagram === (isRetry ? 'FAILED' : 'PENDING')) {
    operations.push({ platform: 'instagram', run: () => publishToInstagram(images, pendingPost.caption) });
  }

  const results = await Promise.allSettled(operations.map((operation) => operation.run()));

  results.forEach((result, index) => {
    const platform = operations[index].platform;
    nextState[platform] = result.status === 'fulfilled' ? 'PUBLISHED' : getPublicationStatus(result.reason);

    if (result.status === 'rejected') {
      console.error(`Errore durante la pubblicazione ${platform}:`, result.reason);
    }
  });

  const retryAvailable = nextState.retryCount === 0 &&
    (nextState.facebook === 'FAILED' || nextState.instagram === 'FAILED');

  nextState.facebookStatusMessageId = await upsertStatusMessage(
    ctx,
    pendingPost,
    nextState.facebookStatusMessageId,
    getPlatformStatusMessage('facebook', nextState.facebook, retryAvailable),
  );
  nextState.instagramStatusMessageId = await upsertStatusMessage(
    ctx,
    pendingPost,
    nextState.instagramStatusMessageId,
    getPlatformStatusMessage('instagram', nextState.instagram, retryAvailable),
  );

  await ctx.api.deleteMessage(pendingPost.chatId, progressMessage.message_id).catch((error) => {
    console.error('Impossibile eliminare il messaggio di avanzamento congiunto:', error);
  });

  if (retryAvailable) {
    updateCrossPlatformState(postId, nextState);
    const retryKeyboard = new InlineKeyboard()
      .text('🔄 Riprova', `riprova_${postId}`)
      .text('❌ Rifiuta', `rifiuta_${postId}`);
    await ctx.api.editMessageReplyMarkup(pendingPost.chatId, pendingPost.previewMessageId, {
      reply_markup: retryKeyboard,
    });
    return;
  }

  deletePendingPost(postId);
}

/**
 * Pubblica su Facebook, Instagram o cross-platform l'anteprima approvata. L'azione è protetta da un lock per postId
 * per impedire che due click ravvicinati creino due post identici.
 */
export async function handleApproveCallback(ctx: Context): Promise<void> {
  const callbackData = ctx.callbackQuery?.data;
  const callbackMatch = callbackData?.match(/^(approva|riprova)_(\d+)$/);
  const action = callbackMatch?.[1];
  const postId = callbackMatch?.[2];
  
  if (!postId) {
    await ctx.answerCallbackQuery({ text: 'Anteprima non valida.', show_alert: true });
    return;
  }
  //Anteprima scaduta
  const pendingPost = getPendingPost(postId);
  if (!pendingPost) {
    await ctx.answerCallbackQuery({ text: 'Questa anteprima non è più disponibile.', show_alert: true });
    return;
  }

  // Il retry è valido solo per una sessione ENTRAMBI e viene concesso una sola volta.
  if (action === 'riprova' && pendingPost.destination !== Destination.ENTRAMBI) {
    await ctx.answerCallbackQuery({ text: 'Questo tentativo non è più disponibile.', show_alert: true });
    return;
  }

  if (
    action === 'riprova' &&
    (!pendingPost.crossPlatformState || pendingPost.crossPlatformState.retryCount === 1)
  ) {
    await ctx.answerCallbackQuery({ text: 'Il tentativo di riprova non è più disponibile.', show_alert: true });
    return;
  }
 /* PROTEZIONE DAL DOPPIO CLICK (ANTI-SPAM)
  * Verifico prima se il post è in fase di publicazione (Set) altrimenti lo aggiungo
  */
  if (publicationInProgress.has(postId)) {
    await ctx.answerCallbackQuery({ text: 'Pubblicazione già in corso.' });
    return;
  }

  publicationInProgress.add(postId);
  let instagramProgressMessageId: number | undefined;

  try {
    if (pendingPost.destination === Destination.ENTRAMBI) {
      await publishToBothPlatforms(ctx, postId, pendingPost, action === 'riprova');
      return;
    }

    const isFacebookPost = pendingPost.destination === Destination.FB;

    // Chiude subito lo spinner Telegram, mentre download, hosting e pubblicazione proseguono in background.
    if (isFacebookPost) {
      await ctx.answerCallbackQuery({ text: 'Sto preparando la pubblicazione su Facebook...' });
    } else {
      await ctx.answerCallbackQuery();
    }

    // Rimuove subito tutte le azioni dall'anteprima: durante upload e pubblicazione l'utente non può avviare altri flussi.
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch((error) => {
      console.error(`Impossibile rimuovere la tastiera dell'anteprima durante la pubblicazione:`, error);
    });

    if (!isFacebookPost) {
      const progressMessage = await ctx.api.sendMessage(pendingPost.chatId, INSTAGRAM_PROGRESS_MESSAGE);
      instagramProgressMessageId = progressMessage.message_id;
    }

    const images = await Promise.all(
      pendingPost.fileIds.map((fileId, index) => downloadTelegramPhoto(ctx, fileId, index)),
    );

    if (isFacebookPost) {
      if (images.length === 1) {
        await facebookService.publishPhoto({
          caption: pendingPost.caption,
          ...images[0],
        });
      } else {
        await facebookService.publishAlbum({
          caption: pendingPost.caption,
          images,
        });
      }
    } else {
      await publishToInstagram(images, pendingPost.caption);
    }
    //Rimuove dopo il successo il pendingPost
    deletePendingPost(postId);

    if (isFacebookPost) {
      await ctx.reply(FACEBOOK_SUCCESS_MESSAGE).catch((notificationError) => {
        console.error('Impossibile inviare la notifica di successo Facebook:', notificationError);
      });
    } else if (instagramProgressMessageId) {
      await showInstagramPublicationSuccess(ctx, pendingPost, instagramProgressMessageId);
    }
  } catch (error) {
    if (pendingPost.destination === Destination.ENTRAMBI) {
      // Gli esiti Facebook/Instagram sono già gestiti separatamente da publishToBothPlatforms.
      // Qui possono arrivare solo errori tecnici esterni alle due operazioni, ad esempio Telegram.
      console.error('Errore inatteso durante la preparazione della pubblicazione congiunta:', error);
      return;
    }

    const isFacebookPost = pendingPost.destination === Destination.FB;
    console.error(`Errore durante la pubblicazione ${isFacebookPost ? 'Facebook' : 'Instagram'}:`, error);
    // L'anteprima non è più riutilizzabile: eliminiamo stato e messaggi per far ripartire l'utente da un nuovo invio.
    deletePendingPost(postId);
    await cleanupFailedPublicationMessages(ctx, pendingPost);
    await sendTemporaryPublicationError(
      ctx,
      pendingPost,
      isFacebookPost ? FACEBOOK_ERROR_MESSAGE : INSTAGRAM_ERROR_MESSAGE,
      instagramProgressMessageId,
    );
  } finally {
    publicationInProgress.delete(postId);
  }
}
