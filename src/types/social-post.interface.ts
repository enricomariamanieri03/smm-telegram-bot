import { Destination } from "./destination.enum.js";

export interface SocialPost {
  destinazione: Destination;
  luogo: string;
  testo_pulito: string;
}