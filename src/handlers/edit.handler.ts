import { Context } from 'grammy';
import { generateEditedSocialPost } from '../services/openai.service.js';
import {
  beginPendingPostEditing,
  clearPendingPostEditing,
  getPendingPost,
  getPendingPostAwaitingEditInput,
  markPendingPostEditAsProcessing,
  setPendingPostEditingInstructionsMessageId,
  updatePendingPostPreview,
  type PendingPost,
} from '../services/pending-post.service.js';
import { createPostPreviewKeyboard, sendPostPreview } from '../services/preview.service.js';

const EDIT_INPUT_DELETE_DELAY_MS = 5_000;

const EDIT_INSTRUCTIONS = `✏️ *Modalità Modifica Attiva*

Copia il testo del post qui sopra, modificalo come preferisci e inviamelo qui in chat.

💡 *Nota sulla posizione:*
Il luogo viene mostrato separatamente nell’anteprima e non viene inserito come riga o pin nella didascalia.`;

function logDeletionFailures(results: PromiseSettledResult<unknown>[], messageIds: number[]): void {
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Impossibile eliminare il messaggio Telegram ${messageIds[index]} durante la modifica:`, result.reason);
    }
  });
}

/** Rimuove i riferimenti alla vecchia revisione, senza aspettare la risposta di Telegram. */
function deleteMessagesInBackground(ctx: Context, chatId: number, messageIds: number[]): void {
  void Promise.allSettled(
    [...new Set(messageIds)].map((messageId) => ctx.api.deleteMessage(chatId, messageId)),
  ).then((results) => logDeletionFailures(results, [...new Set(messageIds)]));
}

async function restoreOriginalPreview(ctx: Context, postId: string, pendingPost: PendingPost): Promise<void> {
  try {
    const previewMessage = await sendPostPreview(ctx, {
      caption: pendingPost.caption,
      destination: pendingPost.destination,
      location: pendingPost.location,
      postId,
    });

    updatePendingPostPreview(postId, {
      caption: pendingPost.caption,
      location: pendingPost.location,
      previewMessageId: previewMessage.message_id,
    });
  } catch (error) {
    console.error('Impossibile ripristinare l’anteprima dopo un errore di modifica:', error);
    clearPendingPostEditing(postId);
  }
}

/** Attiva l'attesa del testo dell'utente per modificare un'anteprima esistente. */
export async function handleModifyCallback(ctx: Context): Promise<void> {
  const postId = ctx.callbackQuery?.data?.match(/^modifica_(\d+)$/)?.[1];
  const pendingPost = postId ? getPendingPost(postId) : undefined;

  if (!postId || !pendingPost) {
    await ctx.answerCallbackQuery({ text: 'Questa anteprima non è più disponibile.', show_alert: true });
    return;
  }

  const editingPost = beginPendingPostEditing(postId);

  if (!editingPost) {
    await ctx.answerCallbackQuery({
      text: 'Hai già una modifica in attesa in questa chat.',
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery();
  //Rimozione della tastiera subito dopo la callBack modifica
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch((error) => {
    console.error('Impossibile rimuovere la tastiera dell’anteprima in modifica:', error);
  });

  try {
    const instructionsMessage = await ctx.reply(EDIT_INSTRUCTIONS, { parse_mode: 'Markdown' });
    setPendingPostEditingInstructionsMessageId(postId, instructionsMessage.message_id);
  } catch (error) {
    clearPendingPostEditing(postId);
    await ctx.editMessageReplyMarkup({ reply_markup: createPostPreviewKeyboard(postId) }).catch((restoreError) => {
      console.error('Impossibile ripristinare la tastiera dell’anteprima dopo un errore:', restoreError);
    });
    throw error;
  }
}

/** Rigenera e sostituisce l'anteprima quando la chat invia testo durante la modalità modifica. */
export async function handleEditTextMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const inputMessage = ctx.message;
  const userInstructions = inputMessage?.text?.trim();

  if (!chatId || !inputMessage || !userInstructions || userInstructions.startsWith('/')) {
    return;
  }

  const editingSession = getPendingPostAwaitingEditInput(chatId);

  if (!editingSession) {
    return;
  }

  const { postId, pendingPost } = editingSession;

  if (!markPendingPostEditAsProcessing(postId)) {
    return;
  }

  // L'input è già disponibile in memoria: la vecchia revisione può sparire subito dalla chat.
  // Elimina i messaggi di anteprima e di istruzioni di modifica
  const messagesToDelete = [pendingPost.previewMessageId];
  if (pendingPost.editing?.instructionsMessageId) {
    messagesToDelete.push(pendingPost.editing.instructionsMessageId);
  }
  deleteMessagesInBackground(ctx, chatId, messagesToDelete);

  try {
    const editedPost = await generateEditedSocialPost(pendingPost.caption, userInstructions);
    const previewMessage = await sendPostPreview(ctx, {
      caption: editedPost.testo_pulito,
      destination: pendingPost.destination,
      location: editedPost.luogo,
      postId,
      updated: true,
    });

    if (!updatePendingPostPreview(postId, {
      caption: editedPost.testo_pulito,
      location: editedPost.luogo,
      previewMessageId: previewMessage.message_id,
    })) {
      await ctx.api.deleteMessage(chatId, previewMessage.message_id).catch(() => undefined);
      throw new Error('La sessione di modifica è scaduta prima dell’invio della nuova anteprima.');
    }

    const inputDeletionTimer = setTimeout(() => {
      void ctx.api.deleteMessage(chatId, inputMessage.message_id).catch((error) => {
        console.error('Impossibile eliminare il messaggio di input della modifica:', error);
      });
    }, EDIT_INPUT_DELETE_DELAY_MS);

    inputDeletionTimer.unref();
  } catch (error) {
    console.error('Errore durante la rigenerazione del post:', error);
    await restoreOriginalPreview(ctx, postId, pendingPost);
    await ctx.reply('⚠️ Non sono riuscito ad aggiornare il testo. L’anteprima originale è stata ripristinata.');
  }
}
