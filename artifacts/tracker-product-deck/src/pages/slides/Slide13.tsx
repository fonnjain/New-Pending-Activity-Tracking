import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide13() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>12 / Assurance</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Data checks built into the workflow</h2></div>
      <div className="relative z-10 mt-[6vh] grid grid-cols-[.92fr_1.08fr] gap-[6vw] px-[6vw]">
        <div className="space-y-[2.8vh] text-[1.68vw] leading-[1.2]"><Bullet>Validate source structure before ingest</Bullet><Bullet>Compare balance and progress arithmetic across snapshots</Bullet><Bullet>Flag missing classifications, regressions, and movement gaps</Bullet><Bullet>Show evidence so users can investigate instead of guessing</Bullet></div>
        <div className="deck-panel relative h-[38vh] p-[1.7vw]"><div className="flex items-center justify-between text-[1vw] uppercase tracking-[.14em] text-muted"><span>data check / evidence</span><span className="text-primary">review</span></div><div className="mt-[3vh] space-y-[1.4vh]"><div className="flex items-center gap-[1vw] border-b border-accent/15 pb-[1.2vh]"><span className="h-[1vw] w-[1vw] rounded-full bg-accent" /><span className="flex-1 text-[1.2vw]">source structure</span><span className="text-[1vw] uppercase text-accent">pass</span></div><div className="flex items-center gap-[1vw] border-b border-accent/15 pb-[1.2vh]"><span className="h-[1vw] w-[1vw] rounded-full bg-accent" /><span className="flex-1 text-[1.2vw]">balance arithmetic</span><span className="text-[1vw] uppercase text-accent">pass</span></div><div className="flex items-center gap-[1vw] border-b border-primary/25 pb-[1.2vh]"><span className="h-[1vw] w-[1vw] rounded-full bg-primary" /><span className="flex-1 text-[1.2vw]">movement gap</span><span className="text-[1vw] uppercase text-primary">review</span></div><div className="flex items-center gap-[1vw]"><span className="h-[1vw] w-[1vw] rounded-full bg-primary" /><span className="flex-1 text-[1.2vw]">classification coverage</span><span className="text-[1vw] uppercase text-primary">review</span></div></div><div className="absolute bottom-[1.7vw] left-[1.7vw] right-[1.7vw] text-[.95vw] uppercase tracking-[.14em] text-muted">a finding is a starting point, not a silent correction</div></div>
      </div>
      <Footer number="13 / 18" />
    </Frame>
  );
}
