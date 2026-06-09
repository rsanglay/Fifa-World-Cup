/* Local persistence for career mode: the active run (resume while the server
   session is still alive) + a permanent history of completed careers. */

export interface ActiveCareer {
  sessionId: string;
  team: string;
  teamName: string;
}

export interface CareerRecord {
  team: string;
  teamName: string;
  outcome: string;        // e.g. "Champions", "Quarter-final"
  won: boolean;
  avgRating: number | null;
  achievements: number;
  when: string;           // display label
}

const ACTIVE = "wc26_career_active";
const HISTORY = "wc26_career_history";

export const careerStore = {
  getActive(): ActiveCareer | null {
    try { return JSON.parse(localStorage.getItem(ACTIVE) || "null"); } catch { return null; }
  },
  setActive(a: ActiveCareer) {
    localStorage.setItem(ACTIVE, JSON.stringify(a));
  },
  clearActive() {
    localStorage.removeItem(ACTIVE);
  },
  getHistory(): CareerRecord[] {
    try { return JSON.parse(localStorage.getItem(HISTORY) || "[]"); } catch { return []; }
  },
  addRecord(r: CareerRecord) {
    const h = careerStore.getHistory();
    h.unshift(r);
    localStorage.setItem(HISTORY, JSON.stringify(h.slice(0, 20)));
  },
};
