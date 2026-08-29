import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide10() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>09 / Ownership</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Inventory organized for action</h2></div>
      <div className="relative z-10 mt-[6vh] grid grid-cols-[1.05fr_.95fr] gap-[6vw] px-[6vw]">
        <div className="deck-panel relative h-[38vh] p-[1.6vw]"><div className="text-[1vw] uppercase tracking-[.15em] text-muted">Inventory lens / MFC batch</div><div className="mt-[3vh] grid grid-cols-5 gap-[.7vw]"><div className="h-[19vh] bg-accent/15" /><div className="h-[25vh] bg-primary/50" /><div className="h-[14vh] bg-accent/25" /><div className="h-[22vh] bg-primary/25" /><div className="h-[17vh] bg-accent/30" /></div><div className="absolute bottom-[1.6vw] left-[1.6vw] right-[1.6vw] flex items-center justify-between text-[.95vw] uppercase tracking-[.12em] text-muted"><span>in-house</span><span className="h-[.8vw] w-[.8vw] rounded-full bg-primary" /><span>out-vendor</span><span className="h-[.8vw] w-[.8vw] rounded-full bg-accent" /><span>project / structure / mark</span></div></div>
        <div className="space-y-[2.7vh] text-[1.62vw] leading-[1.2]"><Bullet>View inventory by project, MFC batch, structure, and mark</Bullet><Bullet>Separate in-house and out-vendor responsibility where required</Bullet><Bullet>Use global MFC view modes to change the operational lens</Bullet><Bullet>Apply manual batch colors to make priority and ownership easier to scan</Bullet></div>
      </div>
      <Footer number="10 / 18" />
    </Frame>
  );
}
