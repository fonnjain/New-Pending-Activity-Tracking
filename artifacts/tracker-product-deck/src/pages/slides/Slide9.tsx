import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide9() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>08 / Commitments</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Order status with history</h2></div>
      <div className="relative z-10 mt-[6vh] grid grid-cols-[.9fr_1.1fr] gap-[6vw] px-[6vw]">
        <div className="space-y-[2.6vh] text-[1.62vw] leading-[1.2]"><Bullet>Load Order Review snapshots with report-date context</Bullet><Bullet>Track work orders, balances, progress, finished goods, and dispatch</Bullet><Bullet>Compare cumulative snapshots for corrections, reductions, and cancellations</Bullet><Bullet>Keep the latest dated review authoritative without erasing prior evidence</Bullet></div>
        <div className="deck-panel relative h-[37vh] p-[1.6vw]"><div className="flex items-center justify-between text-[1vw] uppercase tracking-[.14em] text-muted"><span>Order Review / dated snapshots</span><span className="text-primary">latest</span></div><div className="mt-[3vh] space-y-[1.2vh]"><div className="grid grid-cols-4 gap-[.6vw] text-[.9vw] uppercase tracking-[.1em] text-accent"><span>Project</span><span>WO</span><span>Progress</span><span>FG</span></div><div className="grid grid-cols-4 gap-[.6vw] border-t border-accent/15 pt-[1.2vh] text-[1.15vw]"><span>Zone A</span><span className="text-muted">01</span><span className="h-[1.3vh] bg-primary/65" /><span className="text-muted">—</span></div><div className="grid grid-cols-4 gap-[.6vw] border-t border-accent/15 pt-[1.2vh] text-[1.15vw]"><span>Zone B</span><span className="text-muted">02</span><span className="h-[1.3vh] bg-accent/55" /><span className="text-muted">—</span></div><div className="grid grid-cols-4 gap-[.6vw] border-t border-accent/15 pt-[1.2vh] text-[1.15vw]"><span>Zone C</span><span className="text-muted">03</span><span className="h-[1.3vh] bg-accent/35" /><span className="text-muted">—</span></div></div><div className="absolute bottom-[1.6vw] left-[1.6vw] right-[1.6vw] flex justify-between text-[.95vw] uppercase tracking-[.12em] text-muted"><span>history retained</span><span className="text-primary">dated / auditable</span></div></div>
      </div>
      <Footer number="09 / 18" />
    </Frame>
  );
}
