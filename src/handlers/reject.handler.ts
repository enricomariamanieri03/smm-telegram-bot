import { Context } from 'grammy';
import { deletePendingPost, getPendingPost } from '../services/pending-post.service.js';

export async function handleRejectCallback(ctx: Context): Promise<void> {
    try {
        // 1. Notifica a Telegram la ricezione del click (rimuove lo stato di caricamento dal pulsante)
        await ctx.answerCallbackQuery({ text: 'Post eliminato' });

        const postId = ctx.callbackQuery?.data?.match(/^rifiuta_(\d+)$/)?.[1];
        const pendingPost = postId ? getPendingPost(postId) : undefined;

        if (!postId || !pendingPost) {
            throw new Error(`L’anteprima da rifiutare non é più disponibile.`);
        }
        //Destrutturazione dell' oggetto prendendo i valori dei due corrispettivi campi
        const { chatId, previewMessageId } = pendingPost;
        deletePendingPost(postId);

        // 2. La cancellazione parte in background: non ritarda il messaggio di conferma.
        void ctx.api.deleteMessage(chatId, previewMessageId).catch((error) => {
            console.error('Errore durante l’eliminazione dell’anteprima:', error);
        });

        // 3. Invia il messaggio temporaneo di conferma
        const rejectMsg = await ctx.reply(
        '🗑️ *Post rifiutato e rimosso con successo.*\n\nSe vuoi riprovare, inviami pure una nuova foto!\nQuesto messaggio si auto-distruggerà tra 10 secondi...',
        { parse_mode: 'Markdown' },
        );

        // 4. Timer 10s di autodistruzione del messaggio di conferma
        setTimeout(() => {
            void ctx.api.deleteMessage(chatId, rejectMsg.message_id).catch((error) => {
                console.error('Errore durante la rimozione del messaggio temporaneo:', error);
            });
        }, 10000);
    } catch (error) {
        console.error('Errore durante la gestione del rifiuto del post:', error);
  }
}
