import { Bot, Context, NextFunction } from 'grammy';
import dotenv from 'dotenv';
import {
  handleApproveCallback,
  handleRejectCallback,
  handleStartAndHelpCommand,
  handlePhotoMessage,
} from './handlers/index.js';

// Caricamento variabili dall'env e inserimento nell'oggetto globale process
dotenv.config();

const botToken: string | undefined = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  throw new Error('TELEGRAM_BOT_TOKEN non è definito nel file .env');
}

const bot: Bot = new Bot(botToken);

// Funzione helper per il parsing degli ID
function parseAllowedUsers(rawUsers: string | undefined): number[] {
  if (!rawUsers) {
    return [];
  }
  
  return rawUsers.split(',').map(function (id: string): number {
    return Number(id.trim());
  });
}

const allowedUsers: number[] = parseAllowedUsers(process.env.ALLOWED_USERS);

// Middleware d'autenticazione
async function authenticateUser(ctx: Context, next: NextFunction): Promise<void> {
  const userId: number | undefined = ctx.from?.id;

  if (!userId || !allowedUsers.includes(userId)) {
    console.log(`[SECURITY] Accesso negato per ID: ${userId}`);
    await ctx.reply('⛔ Non sei autorizzato a usare questo bot.');
    return;
  }
  //Utente autorizzato può continuare la chat
  await next();
}

// Registrazione Middleware
bot.use(authenticateUser);
// Registrazione Comandi
bot.command(['start', 'help'], handleStartAndHelpCommand);
// Registrazione Media
bot.on('message:photo', handlePhotoMessage);
// Gestione regex del pulsante "Rifiuta" con callback data nel formato rifiuta_<postId>
bot.callbackQuery(/^rifiuta_\d+$/, handleRejectCallback);
// Gestione del pulsante "Approva e Pubblica" per le anteprime destinate a Facebook.
bot.callbackQuery(/^approva_\d+$/, handleApproveCallback);

// Avvio applicazione
async function startApplication() {
    try {
        await bot.api.deleteWebhook();
        console.log('🧹 Webhook precedente rimosso con successo.');
        console.log('🚀 Bot in ascolto...');
        //LONG POLLING APRE LA CONNESSIONE CON IL BOT TELEGRAM
        await bot.start();
    } catch(error){
        console.log('Errore durante l avvio del bot:', error);
    }
}

startApplication();
