import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide16() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>15 / Trust</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">Designed for trustworthy decisions</h2></div>
      <div className="relative z-10 mt-[6vh] grid grid-cols-[.8fr_1.2fr] gap-[7vw] px-[6vw]">
        <div className="relative h-[38vh]"><div className="absolute left-[3vw] top-[1vh] h-[22vw] w-[18vw] border-[.25vw] border-primary/65 [clip-path:polygon(50%_0,92%_18%,82%_75%,50%_100%,18%_75%,8%_18%)]" /><div className="absolute left-[8.4vw] top-[7.5vh] h-[3.8vw] w-[1.5vw] rotate-45 border-b-[.25vw] border-r-[.25vw] border-accent" /><div className="absolute left-[1vw] bottom-[2vh] text-[1.05vw] uppercase tracking-[.14em] text-muted">bounded / reviewed / attributable</div></div>
        <div className="space-y-[2.8vh] text-[1.68vw] leading-[1.2]"><Bullet>Server-validated page and report metadata</Bullet><Bullet>Activity intervals capped when browser signals disappear</Bullet><Bullet>Calendar-day attribution keeps daily summaries accurate across midnight</Bullet><Bullet>Authenticated, admin-only access for usage reporting</Bullet></div>
      </div>
      <Footer number="16 / 18" />
    </Frame>
  );
}
