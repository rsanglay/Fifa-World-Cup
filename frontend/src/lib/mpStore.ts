/* Local persistence for multiplayer: room code + manager token, so a refresh
   (or accidental tab close) drops you straight back into your tournament. */

export interface MPSession {
  code: string;
  token: string;
  name: string;
  team: string;
}

const KEY = "wc26_mp_session";

export const mpStore = {
  get(): MPSession | null {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
  },
  set(s: MPSession) {
    localStorage.setItem(KEY, JSON.stringify(s));
  },
  clear() {
    localStorage.removeItem(KEY);
  },
};
