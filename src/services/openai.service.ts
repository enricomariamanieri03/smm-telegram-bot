import OpenAI from 'openai';
import { SocialPost } from '../types/social-post.interface.js';
import { Destination } from '../types/destination.enum.js';

//PROMPT PER L'IA
const SOCIAL_POST_INSTRUCTIONS = `
Sei il Social Media Manager e Copywriter ufficiale di "Giuseppe Manieri Autoservizi" (giuseppemanieriautoservizi.it), azienda leader nel noleggio bus turistici, minivan, NCC e viaggi di gruppo (in Basilicata, Venosa).

Il tuo compito è analizzare la foto fornita dall'utente e la descrizione/spunto fornito dall'utente per generare un post social professionale, coinvolgente e d'impatto.

STILE DI SCRITTURA E COPYWRITING (TASSATIVO):
- Scrivi con un tono umano, fresco, dinamico ed entusiasta, come un vero Social Media Manager esperto (includi almeno 2 paragrafi).
- DIVIETO ASSOLUTO di usare frasi fatte e cliché generici da intelligenza artificiale (come "esperienza da vivere", "in totale comfort", "senza pensieri", "viaggio indimenticabile", "raggiungere ogni destinazione").
- Valorizza sempre i dettagli VISIVI reali della foto e uniscili con naturalezza ai punti di forza dell'azienda (sicurezza, puntualità, affidabilità, mezzi moderni).

REGOLE DI ANALISI INPUT:
1. DESTINAZIONE:
   - Se il messaggio Telegram inizia con "/fb", imposta destinazione su "FB"
   - Se inizia con "/ig", imposta destinazione su "IG"
   - Se inizia con "/post" o "/entrambi" (o altro), imposta destinazione su "ENTRAMBI"

2. LUOGO (DESTINAZIONE DEL VIAGGIO):
   - Identifica la città/luogo specifica del viaggio SOLO se è menzionata esplicitamente nel testo/didascalia scritto dall'utente (es. "Gita a Roma", "Viaggia in comodità, Venosa").
   - DIVIETO ASSOLUTO: IGNORA completamente gli hashtag (#Venosa, #Basilicata, #Roma). Il luogo NON deve MAI essere estratto da un hashtag.
   - Se nel testo dell'utente non è specificata alcuna città di destinazione, imposta "luogo": ""

3. TAG E MENZIONI (@):
   - Se presenti (es. @nomeutente), mantienili esattamente come scritti nel testo del post.

FORMATO OUTPUT (TASSATIVO):
Restituisci ESCLUSIVAMENTE un oggetto JSON valido con questa struttura:

{
  "destinazione": "FB",
  "luogo": "Nome città se presente, altrimenti stringa vuota",
  "testo_pulito": "Testo completo del post (con emoji, CTA verso giuseppemanieriautoservizi.it e hashtag finali come #Autoservizi #NoleggioBus #NCC #ViaggiDiGruppo #GiuseppeManieriAutoservizi). NON inserire il pin 📍 e NON inserire la riga luogo all'inizio."
}

Il comando iniziale (/fb, /ig, /post o /entrambi) serve solo a determinare la destinazione e non deve comparire in "testo_pulito".`;

const SOCIAL_POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    destinazione: {
      type: 'string',
      enum: Object.values(Destination),
    },
    luogo: { type: 'string' },
    testo_pulito: { type: 'string' },
  },
  required: ['destinazione', 'luogo', 'testo_pulito'],
};

export async function generateSocialPost(userCaption: string, imageDataUrls: string[]): Promise<SocialPost> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY mancante');

  const openai = new OpenAI({ apiKey });

  // Mappa tutte le foto dell'album per il payload visivo di OpenAI
  const imagePayloads = imageDataUrls.map((url) => ({
    type: 'image_url' as const,
    image_url: { url },
  }));

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: SOCIAL_POST_INSTRUCTIONS,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Didascalia: ${userCaption || 'Nessuna'}` },
          //SPREAD OPERATOR (spacchetta l'array inserendo gli elementi uno a uno)
          ...imagePayloads,
        ]
      }
    ],
    // response_format impone la struttura del JSON mentre il modello genera la risposta.
    // Non è una moderazione del contenuto: con strict: true garantisce campi, tipi ed enum definiti dallo schema.
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'social_post',
        strict: true,
        schema: SOCIAL_POST_SCHEMA,
      },
    },
  });

  const message = response.choices[0]?.message;

  // Un refusal è un rifiuto di sicurezza: il modello non produce il JSON richiesto, quindi non va analizzato.
  if (message?.refusal) {
    throw new Error(`OpenAI ha rifiutato la richiesta: ${message.refusal}`);
  }

  // Preleva la risposta generata dall'IA
  const content = message?.content;
  if (!content) throw new Error('Nessuna risposta da OpenAI');

  return JSON.parse(content) as SocialPost;
}
