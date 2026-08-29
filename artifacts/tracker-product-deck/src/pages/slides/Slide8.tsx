import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide8() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>07 / Movement</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Fabrication and galvanizing movement</h2></div>
      <div className="relative z-10 mt-[7vh] grid grid-cols-[1.05fr_.95fr] gap-[6vw] px-[6vw]">
        <div className="relative h-[37vh] pt-[4vh]"><div className="absolute left-[1vw] right-[1vw] top-[12vh] h-[.16vw] bg-accent/35" /><div className="deck-node absolute left-0 top-[6vh] w-[10vw] p-[1.4vw]"><div className="text-[1vw] uppercase tracking-[.15em] text-muted">from</div><div className="deck-display mt-[.7vh] text-[2.4vw] text-accent">RFI</div></div><div className="deck-node-active deck-node absolute left-[13vw] top-[6vh] w-[10vw] p-[1.4vw]"><div className="text-[1vw] uppercase tracking-[.15em] text-muted">through</div><div className="deck-display mt-[.7vh] text-[2.4vw] text-primary">TS</div></div><div className="deck-node absolute right-0 top-[6vh] w-[10vw] p-[1.4vw]"><div className="text-[1vw] uppercase tracking-[.15em] text-muted">to</div><div className="deck-display mt-[.7vh] text-[2.4vw] text-accent">Y / FG</div></div><div className="absolute left-[4vw] top-[19vh] text-[1vw] uppercase tracking-[.16em] text-muted">route-aware transitions / contractor credit / stage completion</div></div>
        <div className="space-y-[2.7vh] text-[1.6vw] leading-[1.2]"><Bullet>Follow marks through activity routes, including semicolon-delimited operations</Bullet><Bullet>Compare contractor movement and stage completion over time</Bullet><Bullet>Distinguish live completion from movement-log stage counts</Bullet><Bullet>Keep contractor scope and category overlays separate from source values</Bullet></div>
      </div>
      <Footer number="08 / 18" />
    </Frame>
  );
}
