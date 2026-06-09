import { useSearchParams } from "react-router-dom";
import Odds from "./Odds";
import MatchPredictor from "./MatchPredictor";
import Reality from "./Reality";
import { SubTabs } from "./TournamentHub";

const TABS = [
  { key: "odds", label: "Title Odds", el: <Odds /> },
  { key: "match", label: "Match Predictor", el: <MatchPredictor /> },
  { key: "whatif", label: "What-If Lab", el: <Reality /> },
];

export default function PredictHub() {
  const [params, setParams] = useSearchParams();
  const active = params.get("tab") || "odds";
  return (
    <div>
      <SubTabs tabs={TABS} active={active} onChange={(t) => setParams({ tab: t })} />
      {(TABS.find((t) => t.key === active) || TABS[0]).el}
    </div>
  );
}
