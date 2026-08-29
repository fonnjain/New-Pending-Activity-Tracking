import { Frame, Footer, Kicker, Bullet, CornerMark } from "../_shared";

export default function Slide14() {
  return (
    <Frame>
      <CornerMark />
      <div className="relative z-10 px-[6vw] pt-[9vh]"><Kicker>13 / Governance</Kicker><h2 className="deck-display mt-[1.8vh] text-[4.5vw] font-bold uppercase leading-[.9]">A transparent admin layer</h2></div>
      <div className="relative z-10 mt-[7vh] grid grid-cols-2 gap-[6vw] px-[6vw]">
        <div className="space-y-[2.8vh] text-[1.7vw] leading-[1.2]"><Bullet>Manage users, roles, passwords, and operational settings</Bullet><Bullet>Review source-column watch evidence and deletion history</Bullet></div>
        <div className="space-y-[2.8vh] text-[1.7vw] leading-[1.2]"><Bullet>Recompute derived data when a controlled correction is needed</Bullet><Bullet>Keep administrative actions read-only where the workflow calls for it</Bullet></div>
      </div>
      <div className="relative z-10 mx-[6vw] mt-[8vh] flex items-center gap-[1.5vw] border-t border-accent/20 pt-[2vh] text-[1.1vw] uppercase tracking-[.16em] text-accent"><span className="h-[1.2vw] w-[1.2vw] border border-primary" /> Admin surface / evidence / control</div>
      <Footer number="14 / 18" />
    </Frame>
  );
}
