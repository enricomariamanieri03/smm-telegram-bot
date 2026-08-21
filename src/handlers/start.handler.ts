import { Context } from 'grammy';

export async function handleStartAndHelpCommand(ctx: Context): Promise<void> {
  const response = 
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