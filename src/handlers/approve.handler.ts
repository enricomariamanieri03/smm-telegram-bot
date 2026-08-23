import { Context } from 'grammy';
import { facebookService, FacebookImage } from '../services/facebook.service.js';
import { deletePendingPost, getPendingPost } from '../services/pending-post.service.js';
import { Destination } from '../types/destination.enum.js';

//Set che contiene i post già in fase di pubblicazione
const publicationInProgress = new Set<string>();

const FACEBOOK_SUCCESS_MESSAGE =
  '✅ Fantastico! Il post è stato pubblicato con successo sulla tua pagina Facebook!';
const FACEBOOK_ERROR_MESSAGE =
  '⚠️ Attenzione! Si è verificato un errore durante la pubblicazione su Facebook. Riprova tra pochi minuti o contatta Enrico.';

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

/**
 * Pubblica su Facebook l'anteprima approvata. L'azione è protetta da un lock per postId
 * per impedire che due click ravvicinati creino due post identici.
 */
export async function handleApproveCallback(ctx: Context): Promise<void> {
  const callbackData = ctx.callbackQuery?.data;
  const postId = callbackData?.match(/^approva_(\d+)$/)?.[1];
  
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

  // Instagram e la pubblicazione congiunta verranno gestiti da un flusso dedicato.
  if (pendingPost.destination !== Destination.FB) {
    await ctx.answerCallbackQuery();
    return;
  }
 /* PROTEZIONE DAL DOPPIO CLICK (ANTI-SPAM)
  * Verifico prima se il post è in fase di publicazione (Set) altrimenti lo aggiungo
  */
  if (publicationInProgress.has(postId)) {
    await ctx.answerCallbackQuery({ text: 'Pubblicazione Facebook già in corso.' });
    return;
  }

  publicationInProgress.add(postId);

  try {
    // Chiude subito lo spinner Telegram, mentre download e pubblicazione proseguono in background.
    await ctx.answerCallbackQuery({ text: 'Sto preparando la pubblicazione su Facebook...' });

    const images = await Promise.all(
      pendingPost.fileIds.map((fileId, index) => downloadTelegramPhoto(ctx, fileId, index)),
    );

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

    deletePendingPost(postId);
    await ctx.reply(FACEBOOK_SUCCESS_MESSAGE);

    // Rimuove i pulsanti dopo il successo, prevenendo ulteriori azioni sulla stessa anteprima.
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch((error) => {
      console.error(`Impossibile rimuovere la tastiera dell' anteprima pubblicata:`, error);
    });
  } catch (error) {
    console.error('Errore durante la pubblicazione Facebook:', error);
    // L'anteprima resta nello store: l'utente può ritentare dopo un errore transitorio.
    await ctx.reply(FACEBOOK_ERROR_MESSAGE);
  } finally {
    publicationInProgress.delete(postId);
  }
}
