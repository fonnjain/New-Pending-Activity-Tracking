import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide15() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>14 / Adoption</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Usage Audit: understand adoption</h2></div>
      <div className="relative z-10 mt-[6vh] grid grid-cols-[1.12fr_.88fr] gap-[6vw] px-[6vw]">
        <div className="deck-panel relative h-[38vh] p-[1.6vw]"><div className="flex items-center justify-between text-[1vw] uppercase tracking-[.14em] text-muted"><span>usage activity / admin view</span><span className="text-primary">custom span</span></div><div className="mt-[3vh] grid grid-cols-4 gap-[.8vw]"><div className="deck-panel-warm p-[1vw]"><div className="text-[.95vw] uppercase text-muted">busy</div><div className="deck-display mt-[1vh] text-[2.9vw] text-primary">—</div></div><div className="deck-panel p-[1vw]"><div className="text-[.95vw] uppercase text-muted">idle</div><div className="deck-display mt-[1vh] text-[2.9vw] text-accent">—</div></div><div className="deck-panel p-[1vw]"><div className="text-[.95vw] uppercase text-muted">pages</div><div className="deck-display mt-[1vh] text-[2.9vw] text-accent">—</div></div><div className="deck-panel p-[1vw]"><div className="text-[.95vw] uppercase text-muted">reports</div><div className="deck-display mt-[1vh] text-[2.9vw] text-accent">—</div></div></div><div className="mt-[3vh] flex items-center gap-[1vw] text-[1vw] uppercase tracking-[.12em] text-muted"><span className="h-[1.1vw] w-[1.1vw] border border-primary" /> User filter</div><div className="mt-[1.5vh] h-[3.5vh] border border-accent/20 bg-[#101a22]" /><div className="mt-[2vh] flex gap-[.7vw]"><div className="h-[.8vw] w-[38%] deck-bar" /><div className="h-[.8vw] w-[24%] deck-teal-bar" /><div className="h-[.8vw] w-[13%] bg-accent/35" /></div></div>
        <div className="space-y-[2.8vh] text-[1.56vw] leading-[1.2]"><Bullet>Admin-only view of busy time, idle time, pages visited, and reports generated</Bullet><Bullet>Filter activity by user and custom date span</Bullet><Bullet>Timeline events show approved page and report labels, not sensitive content</Bullet><Bullet>Historical sessions remain visible while unavailable metrics stay unknown</Bullet></div>
      </div>
      <Footer number="15 / 18" />
    </Frame>
  );
}
