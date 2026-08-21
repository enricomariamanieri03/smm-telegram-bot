import { Context } from 'grammy';

export async function handleRejectCallback(ctx: Context): Promise<void> {
    try {
        // 1. Notifica a Telegram la ricezione del click (rimuove lo stato di caricamento dal pulsante)
        await ctx.answerCallbackQuery({ text: 'Post eliminato' });

        const callbackMessage = ctx.callbackQuery?.message;
        const chatId = callbackMessage?.chat.id;
        const messageId = callbackMessage?.message_id;

        if (chatId === undefined || messageId === undefined) {
            throw new Error('La callback query non contiene un messaggio eliminabile.');
        }

        // 2. La cancellazione parte in background: non ritarda il messaggio di conferma.
        void ctx.api.deleteMessage(chatId, messageId).catch((error) => {
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
