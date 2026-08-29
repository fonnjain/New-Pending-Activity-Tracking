import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide4() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>03 / Intake</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Start with the files teams already use</h2></div>
      <div className="relative z-10 mt-[6vh] grid grid-cols-[.9fr_1.1fr] gap-[7vw] px-[6vw]">
        <div className="relative h-[40vh]">
          <div className="absolute left-[3vw] top-[4vh] h-[23vh] w-[20vw] rotate-[-7deg] border border-accent/30 bg-[#1b2b33] p-[1.5vw]"><div className="h-[.6vh] w-[8vw] bg-accent/50" /><div className="mt-[3vh] space-y-[1.2vh]"><div className="h-[.9vh] w-[13vw] bg-accent/20" /><div className="h-[.9vh] w-[10vw] bg-accent/20" /><div className="h-[.9vh] w-[15vw] bg-accent/20" /></div></div>
          <div className="absolute left-[6vw] top-[10vh] h-[23vh] w-[20vw] rotate-[4deg] border border-primary/45 bg-[#392e20] p-[1.5vw]"><div className="h-[.6vh] w-[9vw] bg-primary/75" /><div className="mt-[3vh] grid grid-cols-4 gap-[.7vw]"><div className="h-[11vh] bg-primary/15" /><div className="h-[11vh] bg-primary/25" /><div className="h-[11vh] bg-primary/15" /><div className="h-[11vh] bg-primary/25" /></div></div>
          <div className="absolute bottom-[0vh] left-[1vw] text-[1.1vw] uppercase tracking-[.16em] text-primary">WIP / Order Review</div>
        </div>
        <div className="space-y-[3vh] pt-[1vh] text-[1.68vw] leading-[1.23]"><Bullet>Upload WIP and Order Review workbooks through the Data workspace</Bullet><Bullet>Select report dates and enforce per-date upload uniqueness</Bullet><Bullet>Detect structural format issues before they affect reporting</Bullet><Bullet>Preserve source evidence and import summaries for auditability</Bullet></div>
      </div>
      <Footer number="04 / 18" />
    </Frame>
  );
}
