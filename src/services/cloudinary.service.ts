import { v2 as cloudinary } from 'cloudinary';

const CLOUDINARY_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CLOUDINARY_FOLDER = 'smm-telegram-bot/instagram';
export const CLOUDINARY_TEMP_INSTAGRAM_TAG = 'temp_instagram';
const INSTAGRAM_IMAGE_WIDTH = 1_080;
const INSTAGRAM_IMAGE_HEIGHT = 1_350;

/** Immagine binaria da ospitare temporaneamente su Cloudinary. */
export interface CloudinaryImage {
  image: Blob;
  fileName?: string;
}

/** Riferimenti necessari per usare e poi rimuovere un asset ospitato. */
export interface CloudinaryHostedImage {
  publicId: string;
  secureUrl: string;
}

interface CloudinaryConfig {
  apiKey: string;
  apiSecret: string;
  cloudName: string;
  folder: string;
}

interface ValidatedCloudinaryImage {
  image: Blob;
  fileName: string;
}

/** Legge e valida le credenziali Cloudinary senza mai includerle nei messaggi di errore. */
function getCloudinaryConfig(): CloudinaryConfig {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
  const folder = process.env.CLOUDINARY_INSTAGRAM_FOLDER?.trim() || DEFAULT_CLOUDINARY_FOLDER;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      'Variabili d’ambiente Cloudinary mancanti: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e/o CLOUDINARY_API_SECRET.',
    );
  }

  return { cloudName, apiKey, apiSecret, folder };
}

/** Restituisce il client Cloudinary configurato per le service che usano le API server-side. */
export function getCloudinaryClient() {
  const config = getCloudinaryConfig();

  cloudinary.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    secure: true,
  });

  return cloudinary;
}

/** Verifica che l’asset ricevuto da Telegram sia un’immagine non vuota caricabile. */
function validateImage(image: unknown, fileName: unknown): ValidatedCloudinaryImage {
  if (!(image instanceof Blob)) {
    throw new Error('L’immagine Cloudinary deve essere fornita come Blob.');
  }

  if (image.size === 0) {
    throw new Error('L’immagine Cloudinary è vuota.');
  }

  if (!image.type.startsWith('image/')) {
    throw new Error('Il Blob dell’immagine Cloudinary deve avere un MIME type image/*.');
  }

  const normalizedFileName = typeof fileName === 'string' ? fileName.trim() : '';

  return { image, fileName: normalizedFileName || 'telegram-photo.jpg' };
}

/**
 * Gestisce l’hosting temporaneo delle immagini destinate a Instagram.
 * L’SDK ufficiale usa upload firmati: API key e secret restano soltanto nel backend Node.js.
 */
export class CloudinaryService {
  /** Carica un’immagine e restituisce l’URL HTTPS pubblico richiesto da Instagram. */
  async uploadImage(options: CloudinaryImage): Promise<CloudinaryHostedImage> {
    const config = getCloudinaryConfig();
    const image = validateImage(options?.image, options?.fileName);
    const client = getCloudinaryClient();
    const imageBuffer = Buffer.from(await image.image.arrayBuffer());

    return new Promise<CloudinaryHostedImage>((resolve, reject) => {
      const uploadStream = client.uploader.upload_stream(
        {
          folder: config.folder,
          resource_type: 'image',
          // Trasformazione in ingresso: tutti gli asset temporanei rispettano il 4:5 richiesto dai caroselli.
          format: 'jpg',
          transformation: {
            width: INSTAGRAM_IMAGE_WIDTH,
            height: INSTAGRAM_IMAGE_HEIGHT,
            crop: 'pad',
            background: 'auto',
          },
          // Il tag permette al garbage collector di riconoscere soltanto gli asset temporanei Instagram.
          tags: [CLOUDINARY_TEMP_INSTAGRAM_TAG],
          timeout: CLOUDINARY_REQUEST_TIMEOUT_MS,
        },
        (error, result) => {
          if (error) {
            reject(new Error(`Cloudinary non ha caricato l’immagine temporanea: ${error.message}`, { cause: error }));
            return;
          }

          if (!result?.public_id || !result.secure_url) {
            reject(new Error('Cloudinary ha restituito un upload senza public_id o secure_url validi.'));
            return;
          }

          resolve({ publicId: result.public_id, secureUrl: result.secure_url });
        },
      );

      uploadStream.once('error', (error) => {
        reject(new Error('Cloudinary ha interrotto il caricamento dell’immagine temporanea.', { cause: error }));
      });
      uploadStream.end(imageBuffer);
    });
  }

  /**
   * Elimina un’immagine temporanea tramite public ID e invalida la copia CDN.
   * "not found" è considerato successo: il cleanup resta idempotente anche dopo un retry.
  */
  async deleteImage(publicId: string): Promise<void> {
    const normalizedPublicId = publicId.trim();

    if (!normalizedPublicId) {
      throw new Error('Il public_id Cloudinary da eliminare non è valido.');
    }

    try {
      const response = await getCloudinaryClient().uploader.destroy(normalizedPublicId, {
        resource_type: 'image',
        invalidate: true,
      });

      if (response.result !== 'ok' && response.result !== 'not found') {
        throw new Error('Cloudinary non ha confermato l’eliminazione dell’immagine temporanea.');
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Cloudinary non ha eliminato l’immagine temporanea: ${error.message}`, { cause: error });
      }

      throw new Error('Cloudinary non ha eliminato l’immagine temporanea.', { cause: error });
    }
  }

  /** Elimina più asset senza interrompere la pulizia al primo errore. */
  async deleteImages(publicIds: string[]): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(publicIds.map((publicId) => this.deleteImage(publicId)));
  }
}

export const cloudinaryService = new CloudinaryService();
