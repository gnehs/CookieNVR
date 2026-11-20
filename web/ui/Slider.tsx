import { Slider as Base } from "@base-ui/react/slider";

export interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-valuetext"?: string;
}

/** 滑桿：Base UI Slider，外觀在 `ui/slider.css`。填色到目前位置，拇指夠大好拖 */
export function Slider({ value, onChange, min = 0, max = 100, step = 1, className, ...aria }: SliderProps) {
  return (
    <Base.Root className={className ? `slider ${className}` : "slider"} value={value} onValueChange={onChange} min={min} max={max} step={step}>
      <Base.Control className="slider-control">
        <Base.Track className="slider-track">
          <Base.Indicator className="slider-indicator" />
          <Base.Thumb className="slider-thumb" {...aria} />
        </Base.Track>
      </Base.Control>
    </Base.Root>
  );
}
