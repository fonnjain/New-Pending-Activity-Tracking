import { Frame, Footer, Kicker, CornerMark } from "../_shared";

export default function Slide17() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>16 / Operating rhythm</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">The daily operating loop</h2></div>
      <div className="relative z-10 mt-[8vh] grid grid-cols-5 gap-[1vw] px-[6vw]">
        <div className="relative text-center"><div className="mx-auto flex h-[10vw] w-[10vw] items-center justify-center rounded-full border-[.22vw] border-primary bg-[#3d3021]"><span className="deck-display text-[3.2vw] text-primary">01</span></div><div className="mt-[2.5vh] text-[1.35vw] font-semibold leading-[1.12]">Load the latest source files</div></div>
        <div className="relative text-center"><div className="absolute left-[-.5vw] top-[5vw] h-[.16vw] w-[2vw] bg-accent/40" /><div className="mx-auto flex h-[10vw] w-[10vw] items-center justify-center rounded-full border-[.22vw] border-accent bg-[#152731]"><span className="deck-display text-[3.2vw] text-accent">02</span></div><div className="mt-[2.5vh] text-[1.35vw] font-semibold leading-[1.12]">Check data quality and snapshot changes</div></div>
        <div className="relative text-center"><div className="absolute left-[-.5vw] top-[5vw] h-[.16vw] w-[2vw] bg-accent/40" /><div className="mx-auto flex h-[10vw] w-[10vw] items-center justify-center rounded-full border-[.22vw] border-accent bg-[#152731]"><span className="deck-display text-[3.2vw] text-accent">03</span></div><div className="mt-[2.5vh] text-[1.35vw] font-semibold leading-[1.12]">Prioritize balances, ageing, movement, and readiness</div></div>
        <div className="relative text-center"><div className="absolute left-[-.5vw] top-[5vw] h-[.16vw] w-[2vw] bg-accent/40" /><div className="mx-auto flex h-[10vw] w-[10vw] items-center justify-center rounded-full border-[.22vw] border-accent bg-[#152731]"><span className="deck-display text-[3.2vw] text-accent">04</span></div><div className="mt-[2.5vh] text-[1.35vw] font-semibold leading-[1.12]">Share filtered reports with the people who can act</div></div>
        <div className="relative text-center"><div className="absolute left-[-.5vw] top-[5vw] h-[.16vw] w-[2vw] bg-accent/40" /><div className="mx-auto flex h-[10vw] w-[10vw] items-center justify-center rounded-full border-[.22vw] border-primary bg-[#3d3021]"><span className="deck-display text-[3.2vw] text-primary">05</span></div><div className="mt-[2.5vh] text-[1.35vw] font-semibold leading-[1.12]">Repeat with an auditable history behind every decision</div></div>
      </div>
      <Footer number="17 / 18" />
    </Frame>
  );
}
