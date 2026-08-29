import { Frame, Footer, Kicker, CornerMark } from "../_shared";

export default function Slide6() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>05 / Visibility</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">See what is in hand right now</h2></div>
      <div className="relative z-10 mt-[6vh] grid grid-cols-[1.2fr_.8fr] gap-[1.5vw] px-[6vw]">
        <div className="deck-panel p-[1.5vw]"><div className="flex items-center justify-between border-b border-accent/20 pb-[1.4vh] text-[1.05vw] uppercase tracking-[.15em] text-muted"><span>Live balance / current lens</span><span className="text-primary">MFC batch</span></div><div className="mt-[2vh] grid grid-cols-3 gap-[1vw]"><div className="deck-panel-warm p-[1.4vw]"><div className="text-[1.15vw] text-muted">Fabrication</div><div className="deck-display mt-[1vh] text-[4.2vw] leading-none text-primary">WIP</div><div className="mt-[2vh] h-[.65vw] w-[75%] deck-bar" /></div><div className="deck-panel p-[1.4vw]"><div className="text-[1.15vw] text-muted">Galvanizing</div><div className="deck-display mt-[1vh] text-[4.2vw] leading-none text-accent">Y</div><div className="mt-[2vh] h-[.65vw] w-[54%] deck-teal-bar" /></div><div className="deck-panel p-[1.4vw]"><div className="text-[1.15vw] text-muted">Dispatch</div><div className="deck-display mt-[1vh] text-[4.2vw] leading-none text-accent">FG</div><div className="mt-[2vh] h-[.65vw] w-[36%] deck-teal-bar" /></div></div><div className="mt-[3vh] grid grid-cols-5 gap-[.5vw] text-[.9vw] uppercase tracking-[.1em] text-muted"><span>Project</span><span>Structure</span><span>Mark</span><span>Activity</span><span>MFC batch</span></div><div className="mt-[1.5vh] space-y-[1.1vh]"><div className="h-[1.8vh] w-[93%] bg-accent/15" /><div className="h-[1.8vh] w-[82%] bg-accent/10" /><div className="h-[1.8vh] w-[88%] bg-accent/15" /></div></div>
        <div className="space-y-[2.4vh] pt-[1vh] text-[1.55vw] leading-[1.22]"><div className="flex gap-[1vw]"><span className="mt-[.65vh] h-[.7vw] w-[.7vw] bg-accent" /><span>Live balances grouped by project, structure, mark, activity, and MFC batch</span></div><div className="flex gap-[1vw]"><span className="mt-[.65vh] h-[.7vw] w-[.7vw] bg-accent" /><span>Separate fabrication, galvanizing, finished goods, and dispatch views</span></div><div className="flex gap-[1vw]"><span className="mt-[.65vh] h-[.7vw] w-[.7vw] bg-accent" /><span>Copy-aware quantities preserve the workbook's operational meaning</span></div><div className="flex gap-[1vw]"><span className="mt-[.65vh] h-[.7vw] w-[.7vw] bg-accent" /><span>Filters stay consistent across screen totals and exports</span></div></div>
      </div>
      <Footer number="06 / 18" />
    </Frame>
  );
}
