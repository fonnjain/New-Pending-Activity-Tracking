import { Frame, Footer, Kicker } from "../_shared";

export default function Slide18() {
  return (
    <Frame>
      <div className="absolute left-[6vw] top-[13vh] z-10 h-[.35vw] w-[9vw] deck-bar" />
      <div className="absolute right-[9vw] top-[13vh] z-10 h-[48vh] w-[.08vw] bg-accent/30" />
      <div className="relative z-10 flex h-full flex-col justify-center px-[6vw]">
        <Kicker>Balance &amp; Activity Tracker</Kicker>
        <h2 className="deck-display mt-[2.5vh] max-w-[77vw] text-[6.4vw] font-bold uppercase leading-[.86] tracking-[-.025em]"><span className="block">From spreadsheet snapshots</span><span className="block">to operational control</span></h2>
        <div className="mt-[5vh] h-[.22vw] w-[21vw] deck-bar" />
        <p className="deck-body mt-[3.5vh] max-w-[59vw] text-[2.05vw] leading-[1.24] text-[#e4e3dc]">One workspace connects source data, production reality, order commitments, and accountable action.</p>
      </div>
      <Footer number="18 / 18" />
    </Frame>
  );
}
