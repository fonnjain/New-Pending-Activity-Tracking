import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide12() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>11 / Handoffs</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Exports that preserve the analysis</h2></div>
      <div className="relative z-10 mt-[6vh] grid grid-cols-[.8fr_1.2fr] gap-[7vw] px-[6vw]">
        <div className="space-y-[2.7vh] text-[1.68vw] leading-[1.2]"><Bullet>Download filtered XLSX reports with formatted totals</Bullet><Bullet>Export multi-report ZIP packages for handoffs</Bullet><Bullet>Generate JSON and specialized Order Review workbooks</Bullet><Bullet>Keep filenames, filters, and report-specific columns consistent</Bullet></div>
        <div className="relative h-[39vh]"><div className="absolute left-[4vw] top-[4vh] h-[27vh] w-[25vw] border border-primary/45 bg-[#392e20] p-[1.6vw]"><div className="flex items-center justify-between text-[1vw] uppercase tracking-[.12em] text-primary"><span>export package</span><span>.ZIP</span></div><div className="mt-[3vh] space-y-[1.5vh]"><div className="flex items-center gap-[1vw]"><span className="h-[1.1vw] w-[1.1vw] bg-primary/70" /><span className="text-[1.2vw]">project-wise.xlsx</span></div><div className="flex items-center gap-[1vw]"><span className="h-[1.1vw] w-[1.1vw] bg-accent/70" /><span className="text-[1.2vw]">contractor-wise.xlsx</span></div><div className="flex items-center gap-[1vw]"><span className="h-[1.1vw] w-[1.1vw] bg-accent/40" /><span className="text-[1.2vw]">order-status.xlsx</span></div></div><div className="absolute bottom-[1.6vw] left-[1.6vw] right-[1.6vw] h-[.2vw] deck-bar" /></div><div className="absolute right-0 top-[10vh] h-[13vw] w-[13vw] rounded-full border border-accent/35" /><div className="absolute right-[5.2vw] top-[15.2vh] h-[2.6vw] w-[2.6vw] rounded-full bg-accent" /><div className="absolute right-[5.95vw] top-[15.95vh] h-[1.1vw] w-[1.1vw] rounded-full bg-[#101a22]" /></div>
      </div>
      <Footer number="12 / 18" />
    </Frame>
  );
}
