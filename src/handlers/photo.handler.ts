import { Context } from 'grammy';
import { generateSocialPost } from '../services/openai.service.js';
import { savePendingPost } from '../services/pending-post.service.js';
import { sendPostPreview } from '../services/preview.service.js';
import { Destination } from '../types/destination.enum.js';
import { AlbumBuffer } from '../types/album-buffer.interface.js';

// Helper per la pausa di 3 secondi
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Alla scadenza conserva l'anteprima come riferimento, ma rimuove le azioni non piu valide
 * e informa l'utente con un nuovo messaggio nella stessa chat.
 */
async function expirePreview(ctx: Context, chatId: number, previewMessageId: number): Promise<void> {
  try {
    await ctx.api.editMessageReplyMarkup(chatId, previewMessageId, {
      reply_markup: { inline_keyboard: [] },
    });
  } catch (error) {
    console.error(`Errore durante la rimozione della tastiera dell'anteprima scaduta:`, error);
  }

  try {
    await ctx.api.sendMessage(chatId, '⏱️ Sessione scaduta. Riprova con nuove foto.');
  } catch (error) {
    console.error(`Errore durante l'invio della notifica di sessione scaduta:`, error);
  }
}

async function getPhotoDataUrl(filePath: string): Promise<string> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        throw new Error('TELEGRAM_BOT_TOKEN non esiste.');
    }

    const photoUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const photoResponse = await fetch(photoUrl);

    if (!photoResponse.ok) {
        throw new Error(`Impossibile scaricare la foto da Telegram (HTTP ${photoResponse.status}).`);
    }

    let contentType = photoResponse.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    // Telegram restituisce spesso 'application/octet-stream'.
    // Se l'header non inizia con 'image/', forziamo un MIME type valido per OpenAI Vision.
    if (!contentType || !contentType.startsWith('image/')) {
        contentType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    }
    const photoBase64 = Buffer.from(await photoResponse.arrayBuffer()).toString('base64');

    return `data:${contentType};base64,${photoBase64}`;
}

/**
 * Buffer in memoria per la gestione della concorrenza nei caroselli (album Telegram).
 * Isola gli invii dei diversi utenti e gestisce la finestra di debounce prima della chiamata ad OpenAI.
 * Key: media_group_id (stringa univoca fornita da Telegram per l'album)
 */
const albumBuffers = new Map<string, AlbumBuffer>();

/**
 * GESTORE FOTO E CAROSELLI (Single & Album Media Handler)
 * Intercetta le foto inviate dall'utente su Telegram.
 * 
 * - Foto singola: elaborazione immediata.
 * - Carosello (Album): buffering in memoria con debounce di 800ms
 *   per raggruppare i file prima della chiamata multimodale ad OpenAI.
 */
export async function handlePhotoMessage(ctx: Context): Promise<void> {
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    // Recupera la variante a risoluzione più alta della foto corrente
    const highestPhoto = photos[photos.length - 1];
    const mediaGroupId = ctx.message?.media_group_id;
   /*Recupera l'id della prima foto inviata dall'utente inserendola nel buffer
    *Utile nella successiva elminazione del messaggio in caso di errore
    */
    const sourceMessageId = ctx.message?.message_id;

    if (!sourceMessageId) return;

    // 1. Gestione Foto Singola
    if (!mediaGroupId) {
        await processPhotos(ctx, [highestPhoto.file_id], ctx.message?.caption?.trim() || '', [sourceMessageId]);
        return;
    }

    /**
     * GESTIONE CAROSELLO - FOTO SUCCESSIVE (stesso mediaGroupId):
     * Aggiorna il buffer esistente, aggiunge la nuova foto e resetta il timer (debounce).
     * 
     * @asynchronous_behavior 
     * clearTimeout annulla il vecchio timer e setTimeout ne alloca uno nuovo 
     * nell'Event Loop senza bloccare l'esecuzione.
     */
    const existingBuffer = albumBuffers.get(mediaGroupId);

    if (existingBuffer) {
        clearTimeout(existingBuffer.timer);
        existingBuffer.fileIds.push(highestPhoto.file_id);
        existingBuffer.messageIds.push(sourceMessageId);

        // Mantiene la didascalia se presente su una delle foto dell'album
        if (ctx.message?.caption?.trim()) {
            existingBuffer.caption = ctx.message.caption.trim();
        }

        existingBuffer.timer = setTimeout(() => {
        const buffer = albumBuffers.get(mediaGroupId);
        if (buffer) {
            albumBuffers.delete(mediaGroupId);
            processPhotos(buffer.ctx, buffer.fileIds, buffer.caption, buffer.messageIds);
        }
        }, 800);
    } else {
       /**
        * GESTIONE CAROSELLO - PRIMA FOTO (Inizializzazione Buffer, nuovo mediaGroupId):
        * Registra il primo file dell'album nel buffer in memoria.
        * 
        * @asynchronous_behavior 
        * setTimeout alloca la callback nell'Event Loop senza sospendere la funzione.
        * L'istruzione albumBuffers.set() viene eseguita immediatamente dopo (0ms),
        * garantendo che quando la callback scatterà dopo 800ms, la Map conterrà già
        * l'oggetto AlbumBuffer corretto.
        */
        const timer = setTimeout(() => {
        const buffer = albumBuffers.get(mediaGroupId);
        if (buffer) {
            albumBuffers.delete(mediaGroupId);
            processPhotos(buffer.ctx, buffer.fileIds, buffer.caption, buffer.messageIds);
        }
        }, 800);

        albumBuffers.set(mediaGroupId, {
        timer,
        fileIds: [highestPhoto.file_id],
        messageIds: [sourceMessageId],
        caption: ctx.message?.caption?.trim() || '',
        ctx,
        });
    }
}

// Funzione principale di elaborazione (gestisce 1 o N immagini)
async function processPhotos(
  ctx: Context,
  fileIds: string[],
  caption: string,
  sourceMessageIds: number[],
): Promise<void> {
  let statusMessage: Awaited<ReturnType<typeof ctx.reply>> | null = null;

  try {
    const countText = fileIds.length > 1 ? `Carosello di ${fileIds.length} foto` : 'Foto';

    statusMessage = await ctx.reply(
      `⏳ 🔄 ${countText} ricevuta! Sto elaborando il testo con l'Intelligenza Artificiale...`,
    );

    // Scarica tutte le immagini in parallelo
    const imageDataUrls = await Promise.all(
      fileIds.map(async (fileId) => {
        const file = await ctx.api.getFile(fileId);
        if (!file.file_path) {
          throw new Error('Telegram non ha restituito il percorso del file.');
        }
        return await getPhotoDataUrl(file.file_path);
      })
    );

    // Chiamata a OpenAI passando l'array di immagini
    const socialPost = await generateSocialPost(caption, imageDataUrls);
    console.log('Post generato con successo:', socialPost);

    const postId = Date.now();

    const previewMessage = await sendPostPreview(ctx, {
      caption: socialPost.testo_pulito,
      destination: socialPost.destinazione,
      location: socialPost.luogo,
      postId: String(postId),
    });

    // Salviamo l'anteprima in attesa di Approva/Modifica/Rifiuta.
    // La callback finale adatta la firma di onExpire: riceve il PendingPost
    // scaduto e passa a expirePreview i suoi chatId e previewMessageId.
    savePendingPost(String(postId), {
      caption: socialPost.testo_pulito,
      chatId: previewMessage.chat.id,
      destination: socialPost.destinazione,
      fileIds,
      location: socialPost.luogo,
      sourceMessageIds,
      crossPlatformState: socialPost.destinazione === Destination.ENTRAMBI
        ? { facebook: 'PENDING', instagram: 'PENDING', retryCount: 0 }
        : undefined,
      previewMessageId: previewMessage.message_id,
    }, (expiredPost) => expirePreview(ctx, expiredPost.chatId, expiredPost.previewMessageId));

    // Pausa di 5 secondi
    await sleep(5000);

    // Eliminazione del messaggio di attesa
    if (statusMessage && ctx.chat) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
    }

  } catch (error) {
    console.error('Errore durante la gestione del messaggio:', error);

    if (statusMessage && ctx.chat) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {});
    }

    await ctx.reply(
      '⚠️ Ciao! Al momento non riesco ad analizzare la tua foto perché i server di OpenAI sono temporaneamente sovraccarichi oppure hai esaurito il credito iniziale.\n\n' +
      'Il bot è stato temporaneamente disattivato per sicurezza. Per favore, riprova più tardi o contatta Enrico!'
    );
  }
}
