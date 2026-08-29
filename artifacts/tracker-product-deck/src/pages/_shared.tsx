import React from "react";

export function Frame({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={"relative w-screen h-screen overflow-hidden deck-grid " + className}>{children}</div>;
}

export function Kicker({ children }: { children: React.ReactNode }) {
  return <div className="deck-kicker relative z-10">{children}</div>;
}

export function Footer({ number }: { number: string }) {
  return (
    <div className="deck-footer" aria-hidden="true">
      <span>Balance &amp; Activity Tracker</span>
      <span className="deck-footer-line" />
      <span>{number}</span>
    </div>
  );
}

export function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-[1vw]">
      <span className="mt-[.75vh] h-[.7vw] w-[.7vw] shrink-0 bg-accent" />
      <span>{children}</span>
    </div>
  );
}

export function CornerMark() {
  return <div className="absolute right-[6vw] top-[5vh] z-10 h-[2.2vw] w-[2.2vw] border-r border-t border-accent/60" aria-hidden="true" />;
}