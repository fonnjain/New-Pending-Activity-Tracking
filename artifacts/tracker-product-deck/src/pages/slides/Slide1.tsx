import { Frame, Footer, Kicker } from "../_shared";

const base = import.meta.env.BASE_URL;

export default function Slide1() {
  return (
    <Frame className="bg-[#101a22]">
      <img src={base + "fabrication-hero.jpg"} crossOrigin="anonymous" alt="Steel fabrication floor with structural members" className="absolute inset-0 h-full w-full object-cover opacity-60" />
      <div className="absolute inset-0 bg-[#0b141b]/55" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#0b141b] via-[#0b141b]/75 to-transparent" />
      <div className="absolute left-[6vw] top-[14vh] z-10 h-[.35vw] w-[9vw] deck-bar" />
      <div className="absolute right-[9vw] top-[13vh] z-10 h-[48vh] w-[.08vw] bg-accent/30" />
      <div className="absolute right-[9vw] top-[13vh] z-10 h-[.08vw] w-[18vw] bg-accent/30" />
      <div className="relative z-10 flex h-full flex-col justify-center pl-[6vw] pr-[18vw]">
        <Kicker>Steel fabrication operations</Kicker>
        <h1 className="deck-display mt-[2.5vh] max-w-[64vw] text-[7.4vw] font-bold uppercase leading-[.84] tracking-[-.03em] text-text"><span className="block">Balance &amp;</span><span className="block">Activity Tracker</span></h1>
        <p className="deck-body mt-[4vh] max-w-[47vw] text-[2vw] leading-[1.3] text-[#e4e3dc]">A control center for steel-fabrication WIP, production movement, orders, and operational decisions.</p>
        <div className="mt-[7vh] flex items-center gap-[1vw] text-[1.15vw] uppercase tracking-[.2em] text-accent"><span className="h-[.65vw] w-[.65vw] rounded-full bg-primary" /> Operational control / source-to-action</div>
      </div>
      <Footer number="01 / 18" />
    </Frame>
  );
}
