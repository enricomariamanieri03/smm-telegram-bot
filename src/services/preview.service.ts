import { Context, InlineKeyboard } from 'grammy';
import { Destination } from '../types/destination.enum.js';

export interface PostPreviewOptions {
  caption: string;
  destination: Destination;
  location: string;
  postId: string;
  updated?: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getDestinationLabel(destination: Destination): string {
  if (destination === Destination.FB) {
    return 'Facebook';
  }

  if (destination === Destination.IG) {
    return 'Instagram';
  }

  return 'Instagram & Facebook';
}

/** Crea le azioni disponibili per un'anteprima ancora modificabile/pubblicabile. */
export function createPostPreviewKeyboard(postId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Approva e Pubblica', `approva_${postId}`)
    .text('✏️ Modifica Testo', `modifica_${postId}`)
    .text('❌ Rifiuta', `rifiuta_${postId}`);
}

/** Invia un'anteprima con le azioni coerenti con lo stato corrente del post. */
export async function sendPostPreview(ctx: Context, options: PostPreviewOptions) {
  const keyboard = createPostPreviewKeyboard(options.postId);
  const header = options.updated ? '✏️ ANTEPRIMA AGGIORNATA' : '📝 ANTEPRIMA DEL TUO POST';
  const locationText = options.location ? `\n📍 ${escapeHtml(options.location)}` : '';

  return ctx.reply(
    `<b>${header}</b>\n` +
    `<i>📱 Destinazione: ${getDestinationLabel(options.destination)}</i>${locationText}\n\n` +
    `<blockquote>${escapeHtml(options.caption)}</blockquote>\n\n` +
    '<b>👇 Cosa vuoi fare adesso?</b>',
    {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    },
  );
}
