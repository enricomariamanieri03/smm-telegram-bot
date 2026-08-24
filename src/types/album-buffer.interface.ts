import { Context } from "grammy";

// Interfaccia del buffer in memoria per raccogliere gli album
export interface AlbumBuffer {
  timer: NodeJS.Timeout;
  fileIds: string[]; //identifica il messaggio nella chat → pulizia della chat Telegram in caso di errore
  messageIds: number[]; //identifica il file sui server Telegram  →  download delle immagini → Facebook / Cloudinary / Instagram
  caption: string;
  ctx: Context;
}
