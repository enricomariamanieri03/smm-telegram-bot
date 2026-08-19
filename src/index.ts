import { Bot, Context, NextFunction } from 'grammy';
import dotenv from 'dotenv';

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

// Handler per il comando /start
async function handleStartAndHelpCommand(ctx: Context): Promise<void> {
    const response: string = 
`🚌 <b>Benvenuto nel pannello social di Giuseppe Manieri Autoservizi!</b>

Sono il tuo assistente IA. Per pubblicare un post, inviami una FOTO o un VIDEO e scrivi nella didascalia uno di questi comandi seguiti da una breve descrizione:

🔹 /post [descrizione] -> Pubblica contemporaneamente su Facebook e Instagram.
🔹 /fb [descrizione] -> Pubblica SOLO sulla pagina Facebook.
🔹 /ig [descrizione] -> Pubblica SOLO sul profilo Instagram.

📌 <b>Come aggiungere TAG e LUOGO:</b>
All'interno della descrizione puoi inserire liberamente:
• Un TAG scrivendo la chiocciola seguita dal nome della pagina (es. @agenzia_viaggi, @nome_autista).
N.B: il tag deve essere esattamente uguale o l'automazione taggerà un profilo inesistente.
• Il LUOGO dell'evento o del servizio (es. a Roma, presso il Colosseo).

L'IA si occuperà di formattare tutto perfettamente nel post finale!

<b>Esempio completo:</b>
Invia una foto/video di un bus e scrivi:
"/post Oggi splendido viaggio a Roma con i clienti di @agenziaroma! Comfort e sicurezza prima di tutto. Luogo: Roma, Città del Vaticano"

Se hai bisogno di rivedere questo messaggio, scrivi /help in qualsiasi momento.`;

  await ctx.reply(response, { parse_mode: 'HTML' });
}

// Registrazione Middleware e Comandi
bot.use(authenticateUser);
bot.command('start', handleStartAndHelpCommand);
bot.command('help', handleStartAndHelpCommand);

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
