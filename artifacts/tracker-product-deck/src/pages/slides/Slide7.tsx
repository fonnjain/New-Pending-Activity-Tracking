import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide7() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>06 / Attention</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Ageing that follows the work</h2></div>
      <div className="relative z-10 mt-[6vh] grid grid-cols-[.95fr_1.05fr] gap-[7vw] px-[6vw]">
        <div className="space-y-[2.9vh] text-[1.68vw] leading-[1.2]"><Bullet>Cutting ageing starts from Assign Date</Bullet><Bullet>Other activities age from the latest production entry</Bullet><Bullet>Future dates resolve to zero; missing dates remain visibly unknown</Bullet><Bullet>Teams can focus attention on work that is actually waiting</Bullet></div>
        <div className="relative h-[38vh] pt-[2vh]"><div className="absolute left-0 right-0 top-[15vh] h-[.2vw] bg-accent/35" /><div className="absolute left-[1vw] top-[12vh] h-[6vw] w-[6vw] rounded-full border-[.25vw] border-accent bg-[#152731] text-center"><span className="deck-display relative top-[1.1vh] text-[2.6vw] text-accent">C</span></div><div className="absolute left-[13vw] top-[12vh] h-[6vw] w-[6vw] rounded-full border-[.25vw] border-primary bg-[#3d3021] text-center"><span className="deck-display relative top-[1.1vh] text-[2.6vw] text-primary">RFI</span></div><div className="absolute right-[1vw] top-[12vh] h-[6vw] w-[6vw] rounded-full border-[.25vw] border-accent bg-[#152731] text-center"><span className="deck-display relative top-[1.1vh] text-[2.6vw] text-accent">AGE</span></div><div className="absolute left-[2vw] top-[4vh] text-[1vw] uppercase tracking-[.14em] text-muted">assign date</div><div className="absolute left-[14.5vw] top-[4vh] text-[1vw] uppercase tracking-[.14em] text-muted">production entry</div><div className="absolute right-[.5vw] top-[4vh] text-[1vw] uppercase tracking-[.14em] text-primary">attention</div></div>
      </div>
      <Footer number="07 / 18" />
    </Frame>
  );
}
