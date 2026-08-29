import { Frame, Footer, Kicker, CornerMark } from "../_shared";

export default function Slide5() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>04 / Quality</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Reliable data, not spreadsheet guesswork</h2></div>
      <div className="relative z-10 mt-[8vh] grid grid-cols-2 gap-[1.6vw] px-[6vw]">
        <div className="deck-panel flex min-h-[18vh] items-start gap-[2vw] p-[2.1vw]"><div className="deck-display text-[4.7vw] leading-none text-primary">01</div><div><h3 className="text-[1.8vw] font-semibold">Cross-upload deduplication</h3><p className="mt-[1vh] text-[1.38vw] leading-[1.25] text-muted">prevents repeated rows from inflating balances</p></div></div>
        <div className="deck-panel flex min-h-[18vh] items-start gap-[2vw] p-[2.1vw]"><div className="deck-display text-[4.7vw] leading-none text-primary">02</div><div><h3 className="text-[1.8vw] font-semibold">Stable row identity</h3><p className="mt-[1vh] text-[1.38vw] leading-[1.25] text-muted">supports append-only history and safe reprocessing</p></div></div>
        <div className="deck-panel flex min-h-[18vh] items-start gap-[2vw] p-[2.1vw]"><div className="deck-display text-[4.7vw] leading-none text-primary">03</div><div><h3 className="text-[1.8vw] font-semibold">Critical-column gates</h3><p className="mt-[1vh] text-[1.38vw] leading-[1.25] text-muted">catch incompatible WIP formats early</p></div></div>
        <div className="deck-panel flex min-h-[18vh] items-start gap-[2vw] p-[2.1vw]"><div className="deck-display text-[4.7vw] leading-none text-primary">04</div><div><h3 className="text-[1.8vw] font-semibold">Data Check rules</h3><p className="mt-[1vh] text-[1.38vw] leading-[1.25] text-muted">surface arithmetic, coverage, and movement anomalies</p></div></div>
      </div>
      <div className="relative z-10 mx-[6vw] mt-[7vh] deck-rule" />
      <div className="relative z-10 mx-[6vw] mt-[2vh] text-[1.15vw] uppercase tracking-[.16em] text-accent">Evidence stays attached to the decision</div>
      <Footer number="05 / 18" />
    </Frame>
  );
}
