import { useSearchParams } from "react-router-dom";
import Groups from "./Groups";
import Fixtures from "./Fixtures";
import Teams from "./Teams";

const TABS = [
  { key: "groups", label: "Groups", el: <Groups /> },
  { key: "fixtures", label: "Fixtures", el: <Fixtures /> },
  { key: "teams", label: "Teams", el: <Teams /> },
];

export default function TournamentHub() {
  const [params, setParams] = useSearchParams();
  const active = params.get("tab") || "groups";
  return (
    <div>
      <SubTabs tabs={TABS} active={active} onChange={(t) => setParams({ tab: t })} />
      {(TABS.find((t) => t.key === active) || TABS[0]).el}
    </div>
  );
}

export function SubTabs({ tabs, active, onChange }: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (t: string) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-white/10 pb-3">
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${
            active === t.key ? "bg-gold text-ink" : "text-white/70 hover:bg-white/10"}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
