import { Frame, Footer, Kicker, CornerMark } from "../_shared";

export default function Slide11() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>10 / Reporting</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Reports for every operating conversation</h2></div>
      <div className="relative z-10 mt-[7vh] grid grid-cols-4 gap-[1.2vw] px-[6vw]">
        <div className="deck-panel relative h-[28vh] p-[1.6vw]"><div className="h-[5vw] w-[5vw] rounded-full border-[.28vw] border-primary/70" /><h3 className="mt-[4vh] text-[1.65vw] font-semibold">Project Wise and Contractor Wise reporting</h3></div>
        <div className="deck-panel relative h-[28vh] p-[1.6vw]"><div className="flex h-[5vw] w-[5vw] items-end gap-[.45vw]"><span className="h-[2vw] w-[.8vw] bg-accent/55" /><span className="h-[3.2vw] w-[.8vw] bg-accent/75" /><span className="h-[4.6vw] w-[.8vw] bg-primary" /></div><h3 className="mt-[4vh] text-[1.65vw] font-semibold">Fabrication Load and production movement views</h3></div>
        <div className="deck-panel relative h-[28vh] p-[1.6vw]"><div className="h-[5vw] w-[5vw] border-[.28vw] border-accent/70" /><h3 className="mt-[4vh] text-[1.65vw] font-semibold">Release Balance, completion, dispatch, and order status reports</h3></div>
        <div className="deck-panel relative h-[28vh] p-[1.6vw]"><div className="relative h-[5vw] w-[5vw]"><div className="absolute left-0 top-[2.2vw] h-[.2vw] w-[5vw] bg-primary" /><div className="absolute left-[2.2vw] top-0 h-[5vw] w-[.2vw] bg-primary" /><div className="absolute left-[1.75vw] top-[1.75vw] h-[1.1vw] w-[1.1vw] rounded-full bg-accent" /></div><h3 className="mt-[4vh] text-[1.65vw] font-semibold">Detailed drill-downs support the question behind every total</h3></div>
      </div>
      <Footer number="11 / 18" />
    </Frame>
  );
}
