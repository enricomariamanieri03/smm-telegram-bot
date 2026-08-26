import { CLOUDINARY_TEMP_INSTAGRAM_TAG, getCloudinaryClient } from './cloudinary.service.js';

const CLOUDINARY_GARBAGE_COLLECTOR_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const CLOUDINARY_GARBAGE_COLLECTOR_EXPRESSION = `tags:${CLOUDINARY_TEMP_INSTAGRAM_TAG} AND created_at < 1d`;
const CLOUDINARY_GARBAGE_COLLECTOR_PAGE_SIZE = 100;

interface CloudinarySearchResource {
  public_id?: unknown;
}

interface CloudinarySearchResponse {
  next_cursor?: unknown;
  resources?: unknown;
}

/**
 * Gestisce gli asset Cloudinary orfani del flusso Instagram.
 * Incapsula Search API, paginazione, cancellazione batch e pianificazione della pulizia.
 */
export class CloudinaryGarbageCollectorService {
  private timer: NodeJS.Timeout | undefined;

  /**
   * Esegue una pulizia all'avvio e ne pianifica una ogni 24 ore.
   * Il timer usa unref() per non mantenere in vita il processo Node.js da solo.
   */
  start(): void {
    if (this.timer) {
      return;
    }

    void this.runOnce();

    this.timer = setInterval(() => {
      void this.runOnce();
    }, CLOUDINARY_GARBAGE_COLLECTOR_INTERVAL_MS);
    this.timer.unref();
  }

  /**
   * Esegue una singola pulizia e restituisce il numero di asset rimossi.
   * Un errore viene solo loggato: il garbage collector non deve mai interrompere il bot Telegram.
   */
  async runOnce(): Promise<number> {
    try {
      const deletedCount = await this.deleteExpiredInstagramImages();
      console.info(`Garbage collector Cloudinary completato: ${deletedCount} asset temporanei rimossi.`);
      return deletedCount;
    } catch (error) {
      console.error('Garbage collector Cloudinary non completato:', error);
      return 0;
    }
  }

  /**
   * Cerca gli asset con tag temp_instagram creati da oltre 24 ore e li elimina a pagine.
   * L'elaborazione paginata evita di superare il limite di risultati della Search API.
   */
  private async deleteExpiredInstagramImages(): Promise<number> {
    const client = getCloudinaryClient();
    let deletedCount = 0;
    let nextCursor: string | undefined;

    do {
      let search = client.search
        .expression(CLOUDINARY_GARBAGE_COLLECTOR_EXPRESSION)
        .sort_by('created_at', 'asc')
        .max_results(CLOUDINARY_GARBAGE_COLLECTOR_PAGE_SIZE);

      if (nextCursor) {
        search = search.next_cursor(nextCursor);
      }

      const result = (await search.execute()) as CloudinarySearchResponse;
      const publicIds = Array.isArray(result.resources)
        ? result.resources
            .filter((resource): resource is CloudinarySearchResource => typeof resource === 'object' && resource !== null)
            .map((resource) => resource.public_id)
            .filter((publicId): publicId is string => typeof publicId === 'string' && publicId.length > 0)
        : [];

      if (publicIds.length > 0) {
        await client.api.delete_resources(publicIds, {
          resource_type: 'image',
          invalidate: true,
        });
        deletedCount += publicIds.length;
      }

      nextCursor = typeof result.next_cursor === 'string' && result.next_cursor ? result.next_cursor : undefined;
    } while (nextCursor);

    return deletedCount;
  }
}

export const cloudinaryGarbageCollector = new CloudinaryGarbageCollectorService();
