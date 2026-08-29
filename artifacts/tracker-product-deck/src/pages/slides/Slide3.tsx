import { Frame, Footer, Kicker, CornerMark } from "../_shared";

export default function Slide3() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[10vh]"><Kicker>02 / System</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9] tracking-[-.02em]">One system for the full WIP lifecycle</h2></div>
      <div className="relative z-10 mt-[10vh] grid grid-cols-4 gap-[1.3vw] px-[6vw]">
        <div className="deck-panel relative min-h-[29vh] p-[2vw]"><div className="deck-display text-[4vw] text-accent/50">01</div><div className="mt-[8vh] text-[1.65vw] font-semibold leading-[1.15]">Import current WIP and Order Review workbooks</div><div className="absolute bottom-[2vw] left-[2vw] right-[2vw] h-[.25vw] deck-teal-bar" /></div>
        <div className="deck-panel relative min-h-[29vh] p-[2vw]"><div className="deck-display text-[4vw] text-accent/50">02</div><div className="mt-[8vh] text-[1.65vw] font-semibold leading-[1.15]">Normalize and retain an auditable record history</div><div className="absolute bottom-[2vw] left-[2vw] right-[2vw] h-[.25vw] deck-teal-bar" /></div>
        <div className="deck-panel relative min-h-[29vh] p-[2vw]"><div className="deck-display text-[4vw] text-accent/50">03</div><div className="mt-[8vh] text-[1.65vw] font-semibold leading-[1.15]">Turn raw rows into live balances, movement, ageing, and readiness views</div><div className="absolute bottom-[2vw] left-[2vw] right-[2vw] h-[.25vw] deck-bar" /></div>
        <div className="deck-panel relative min-h-[29vh] p-[2vw]"><div className="deck-display text-[4vw] text-accent/50">04</div><div className="mt-[8vh] text-[1.65vw] font-semibold leading-[1.15]">Export decision-ready workbooks without losing filters or totals</div><div className="absolute bottom-[2vw] left-[2vw] right-[2vw] h-[.25vw] deck-bar" /></div>
      </div>
      <div className="relative z-10 mx-[6vw] mt-[7vh] flex items-center gap-[1vw] text-[1.2vw] uppercase tracking-[.18em] text-muted"><span className="h-[.7vw] w-[.7vw] bg-primary" /> Source → history → control → action</div>
      <Footer number="03 / 18" />
    </Frame>
  );
}
