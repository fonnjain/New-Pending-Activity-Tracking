import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide2() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[10vh]">
        <Kicker>01 / Context</Kicker>
        <h2 className="deck-display mt-[1.8vh] max-w-[63vw] text-[4.7vw] font-bold uppercase leading-[.9] tracking-[-.02em]">The operating challenge</h2>
        <div className="mt-[2.5vh] h-[.22vw] w-[13vw] deck-bar" />
      </div>
      <div className="relative z-10 mt-[9vh] grid grid-cols-[1.05fr_.95fr] gap-[6vw] px-[6vw]">
        <div className="space-y-[3.3vh] text-[1.75vw] leading-[1.22] text-[#e4e3dc]">
          <Bullet>WIP data arrives as spreadsheets, exports, and changing operational snapshots</Bullet>
          <Bullet>Teams need one view across balances, activities, contractors, orders, and finished goods</Bullet>
          <Bullet>Decisions depend on what changed, what is aging, and what is ready next</Bullet>
        </div>
        <div className="relative h-[39vh]">
          <div className="absolute left-[4vw] top-[4vh] h-[28vh] w-[28vh] rounded-full border-[.12vw] border-accent/35" />
          <div className="absolute left-[11vw] top-[11vh] h-[14vh] w-[14vh] rounded-full border-[.16vw] border-primary/70" />
          <div className="absolute left-[18vw] top-[18vh] h-[.18vw] w-[12vw] -rotate-45 deck-bar" />
          <div className="absolute right-0 top-[3vh] deck-display text-[8vw] font-bold leading-none text-accent/20">?</div>
          <div className="absolute bottom-[1vh] left-0 max-w-[17vw] text-[1.15vw] uppercase leading-[1.45] tracking-[.15em] text-muted"><span className="block">One source</span><span className="block">Multiple views</span><span className="block">Decisions under time</span></div>
        </div>
      </div>
      <Footer number="02 / 18" />
    </Frame>
  );
}
