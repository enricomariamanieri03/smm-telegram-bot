import { Context } from 'grammy';
import { deletePendingPost, getPendingPost } from '../services/pending-post.service.js';

const REJECT_NOTIFICATION_LIFETIME_MS = 10_000;
const REJECTED_POST_REMOVAL_DELAY_MS = 5_000;

/** Elimina un'anteprima rifiutata e i media Telegram originali, mantenendo la chat pulita. */
export async function handleRejectCallback(ctx: Context): Promise<void> {
  try {
    const postId = ctx.callbackQuery?.data?.match(/^rifiuta_(\d+)$/)?.[1];
    const pendingPost = postId ? getPendingPost(postId) : undefined;

    if (!postId || !pendingPost) {
      await ctx.answerCallbackQuery({
        text: 'Questa anteprima non è più disponibile.',
        show_alert: true,
      });
      return;
    }

    // Chiude subito lo spinner del pulsante, mentre le cancellazioni proseguono in background.
    await ctx.answerCallbackQuery({ text: 'Post eliminato' });

    const { chatId, previewMessageId, sourceMessageIds } = pendingPost;
    deletePendingPost(postId);

    // Un album contiene più message_id: Set evita di richiedere due cancellazioni per lo stesso messaggio.
    const messageIds = [...new Set([previewMessageId, ...sourceMessageIds])];
    const cleanupTimer = setTimeout(() => {
      void Promise.allSettled(
        messageIds.map((messageId) => ctx.api.deleteMessage(chatId, messageId)),
      ).then((results) => {
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            console.error(`Errore durante l’eliminazione del messaggio Telegram ${messageIds[index]}:`, result.reason);
          }
        });
      });
    }, REJECTED_POST_REMOVAL_DELAY_MS);

    // Il timer non deve mantenere vivo il processo Node.js se il bot viene arrestato nel frattempo.
    cleanupTimer.unref();

    const rejectMessage = await ctx.reply(
      '🗑️ *Post rifiutato.*\n\nL’anteprima e le foto verranno rimosse tra pochi secondi. Se vuoi riprovare, inviami pure una nuova foto!\nQuesto messaggio si auto-distruggerà tra 10 secondi...',
      { parse_mode: 'Markdown' },
    );

    const deletionTimer = setTimeout(() => {
      void ctx.api.deleteMessage(chatId, rejectMessage.message_id).catch((error) => {
        console.error('Errore durante la rimozione del messaggio temporaneo:', error);
      });
    }, REJECT_NOTIFICATION_LIFETIME_MS);

    // Anche questo timer è solo UX e non deve impedire la chiusura ordinata del processo.
    deletionTimer.unref();
  } catch (error) {
    console.error('Errore durante la gestione del rifiuto del post:', error);
  }
}
