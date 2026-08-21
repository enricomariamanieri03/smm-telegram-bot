import { Context } from "grammy";

// Interfaccia del buffer in memoria per raccogliere gli album
export interface AlbumBuffer {
  timer: NodeJS.Timeout;
  fileIds: string[];
  caption: string;
  ctx: Context;
}