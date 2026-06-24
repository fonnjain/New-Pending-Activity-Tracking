import * as React from "react";
import { Input } from "@/components/ui/input";

type NumberInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange"
> & {
  value: number | "";
  onValueChange: (raw: string) => void;
};

// A controlled numeric input that holds the RAW typed string locally while
// focused. A plain controlled `<input type="number" value={parsedNumber}>`
// feeds the parsed number back on every keystroke; because the browser forbids
// caret restoration on number inputs, React rewriting the DOM string moves the
// caret to the start, so the next digit lands in front (typing 90 yields 09).
// Mirroring the exact DOM string in `draft` means the controlled value always
// matches the DOM during typing, so React never rewrites it and the caret is
// preserved. The parsed/clamped value is reflected back only on blur.
export function NumberInput({
  value,
  onValueChange,
  onFocus,
  onBlur,
  ...rest
}: NumberInputProps) {
  const [focused, setFocused] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  const display = focused ? draft : value === "" ? "" : String(value);

  return (
    <Input
      {...rest}
      value={display}
      onFocus={(e) => {
        setDraft(value === "" ? "" : String(value));
        setFocused(true);
        onFocus?.(e);
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        onValueChange(e.target.value);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
    />
  );
}
